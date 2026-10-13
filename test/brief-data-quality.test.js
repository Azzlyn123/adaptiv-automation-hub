const test = require('node:test');
const assert = require('node:assert/strict');
const { queryAllDatabasePages } = require('../lib/notionPages');
const { gatherApprovalActionSummary } = require('../lib/approvalActionAgent');
const { gatherProductBugSummary } = require('../lib/productBugAgent');
const { gatherCoachSalesSummary } = require('../lib/coachSalesAgent');
const { gatherSocialMediaSummary } = require('../lib/socialMediaAgent');
const { buildDocSections, buildEmailBody } = require('../lib/googleDeliveryAgent');
const { buildDailyBriefContent } = require('../server');
const { gatherWeeklyContext, computeOverallStatus, generateIdeas } = require('../lib/weeklyStrategyAgent');

const title = (value) => ({ title: [{ plain_text: value }] });
const rich = (value) => ({ rich_text: [{ plain_text: value }] });
const select = (value) => ({ select: { name: value } });
const number = (value) => ({ number: value });

function notionWithPages(pagesByDatabase) {
  return {
    databases: {
      async query({ database_id, start_cursor }) {
        const pages = pagesByDatabase[database_id] || [];
        const offset = start_cursor ? Number(start_cursor) : 0;
        const results = pages.slice(offset, offset + 100);
        const nextOffset = offset + results.length;
        return {
          results,
          has_more: nextOffset < pages.length,
          next_cursor: nextOffset < pages.length ? String(nextOffset) : null,
        };
      },
    },
  };
}

function approval(id, action, agent, risk = 'Low', notes = '', status = 'Needs Approval') {
  return {
    id,
    properties: {
      Action: title(action),
      Agent: select(agent),
      Risk: select(risk),
      Tool: select('Notion'),
      Status: select(status),
      Notes: rich(notes),
    },
  };
}

function bug(overrides = {}) {
  return {
    id: overrides.id || 'reported-bug',
    properties: {
      'Bug / Issue': title('Signup fails in mobile browser'),
      Type: select('Bug'),
      Severity: select('Critical'),
      Status: select(overrides.status || 'New'),
      Source: select('Beta Tester'),
      'Priority Score': number(140),
      'Repro Steps': rich(overrides.reproSteps || ''),
      Expected: rich(overrides.expected || ''),
      Actual: rich(overrides.actual || ''),
      Notes: rich(overrides.notes || ''),
    },
  };
}

test('Notion reads every page rather than silently stopping at 100', async () => {
  const pages = Array.from({ length: 121 }, (_, i) => ({ id: String(i) }));
  const actual = await queryAllDatabasePages(notionWithPages({ approvals: pages }), 'approvals');
  assert.equal(actual.length, 121);
});

test('approval summary excludes manual tests and groups only known recurring requests', async () => {
  const pages = [];
  for (let i = 0; i < 13; i++) {
    pages.push(approval(`strategy-discount-${i}`, 'Decide: coach discount', 'Weekly Strategy Agent'));
    pages.push(approval(`strategy-privacy-${i}`, 'Decide: privacy wording', 'Weekly Strategy Agent'));
    pages.push(approval(`strategy-film-${i}`, 'Decide: film rollout', 'Weekly Strategy Agent'));
    pages.push(approval(`deploy-${i}`, 'Review failed deploy logs', 'Railway Health Agent', 'Medium', 'backend failed'));
  }
  pages.push(approval('bug-review', 'Review critical product issue', 'Product/Bug Agent', 'High'));
  pages.push(approval('manual-test', 'Refund angry customer', 'Manual Test', 'Critical', '', 'Failed'));

  const summary = await gatherApprovalActionSummary(notionWithPages({ approvals: pages }), 'approvals');
  assert.equal(summary.waitingRowCount, 53);
  assert.equal(summary.waitingCount, 5);
  assert.equal(summary.repeatedWaitingCount, 48);
  assert.equal(summary.testRowCount, 1);
  assert.equal(summary.failedCount, 0);
  assert.equal(summary.status, 'Yellow');
  assert.equal(summary.recommendedFounderReview.length, 1);
  assert.match(summary.recommendedFounderReview[0], /verify reproduction/);
});

test('customer-specific approvals with identical titles remain separate', async () => {
  const pages = [
    approval('customer-1', 'Contact customer', 'Customer Success Agent'),
    approval('customer-2', 'Contact customer', 'Customer Success Agent'),
  ];
  const summary = await gatherApprovalActionSummary(notionWithPages({ approvals: pages }), 'approvals');
  assert.equal(summary.waitingRowCount, 2);
  assert.equal(summary.waitingCount, 2);
});

test('undocumented critical report is unverified; documented QA report can become verified', async () => {
  const unverified = await gatherProductBugSummary(
    notionWithPages({ bugs: [bug()], feedback: [] }),
    { productBugsDbId: 'bugs', betaFeedbackDbId: 'feedback' }
  );
  assert.equal(unverified.status, 'Unverified');
  assert.equal(unverified.unverifiedCriticalBugs.length, 1);
  assert.equal(unverified.verifiedCriticalBugs.length, 0);
  assert.match(unverified.recommendedFixToday, /^Verify report:/);

  const brief = buildDailyBriefContent({ productBugSummary: unverified });
  assert.equal(brief.statusLabel, 'Yellow');
  assert.deepEqual(brief.releaseBlockers, []);
  assert.match(JSON.stringify(brief.children), /reproduction and QA evidence/);

  const verified = await gatherProductBugSummary(
    notionWithPages({
      bugs: [bug({ status: 'Triaged', reproSteps: 'Open signup and submit', expected: 'Continue', actual: 'Blocked', notes: '[VERIFIED] QA reproduced on device' })],
      feedback: [],
    }),
    { productBugsDbId: 'bugs', betaFeedbackDbId: 'feedback' }
  );
  assert.equal(verified.status, 'Red');
  assert.equal(verified.verifiedCriticalBugs.length, 1);
  assert.equal(buildDailyBriefContent({ productBugSummary: verified }).statusLabel, 'Red');
});

test('known demo coach and outreach rows do not become sales pipeline', async () => {
  const demoLead = {
    id: 'sample-lead',
    properties: { 'Lead Name': title('Test Coach'), 'School / Program': rich('Phoenix Test High School') },
  };
  const demoOutreach = {
    id: 'sample-outreach',
    properties: { Message: title('Outreach to Test Coach — 2026-10-13'), Status: select('Needs Approval') },
  };
  const summary = await gatherCoachSalesSummary(
    notionWithPages({ crm: [demoLead], outreach: [demoOutreach] }),
    { crmDbId: 'crm', outreachDbId: 'outreach' }
  );
  assert.equal(summary.totalLeads, 0);
  assert.equal(summary.outreachDraftCount, 0);
  assert.equal(summary.excludedTestCount, 2);
  assert.equal(summary.status, 'Unverified');
});

test('test reel and unsourced manual row do not produce claimed social views', async () => {
  const testReel = {
    id: 'sample-reel',
    properties: { Post: title('Founder story test reel'), 'Views': number(1200) },
  };
  const unsourced = {
    id: 'unsourced',
    properties: { Post: title('Instagram'), 'Views': number(200) },
  };
  const summary = await gatherSocialMediaSummary(
    notionWithPages({ metrics: [testReel, unsourced], calendar: [], inbox: [] }),
    { metricsDbId: 'metrics', calendarDbId: 'calendar', inboxDbId: 'inbox' }
  );
  assert.equal(summary.totalPosts, 0);
  assert.equal(summary.totalViews, null);
  assert.equal(summary.excludedTestPostCount, 1);
  assert.equal(summary.unverifiedPostCount, 1);
  assert.equal(summary.status, 'Unverified');
});

test('Google document and email retain source cautions instead of promoting reports to facts', () => {
  const brief = {
    displayDate: 'October 13, 2026',
    statusLabel: 'Yellow',
    releaseBlockers: [],
    featureGates: ['Real athlete video remains gated.'],
    sourceCautions: ['A reported Critical bug has no reproduction on file.'],
    topPriorities: ['Verify the bug report'],
    missingDataSources: [],
    founderTodos: [],
    approvalRequests: [],
    productBugSummary: {
      status: 'Unverified',
      verifiedCriticalBugs: [],
      unverifiedCriticalBugs: [bug()],
      highBugs: [],
      newFeedbackCount: 0,
      recommendedFixToday: 'Verify report: Signup fails',
      repeatedAreas: [],
    },
  };
  const sections = buildDocSections(brief);
  assert.ok(sections.some((section) => section.text === 'Source Verification'));
  assert.match(JSON.stringify(sections), /no reproduction on file/);
  const email = buildEmailBody(brief);
  assert.match(email, /no reproduction on file/);
  assert.match(email, /unverified critical reports: 1/);
  assert.doesNotMatch(email, /No product data source connected yet/);
});

test('weekly strategy proposals cannot become verified daily priorities', () => {
  const brief = buildDailyBriefContent({
    weeklyStrategySummary: {
      week: '2026-W42',
      status: 'Red',
      topPriorities: 'Target 10 Phoenix volleyball coaches this week | Offer founding coach discount',
      decisionsNeeded: '',
      risks: '',
    },
  });
  assert.equal(brief.statusLabel, 'Yellow');
  assert.equal(brief.topPriorities.length, 1);
  assert.match(brief.topPriorities[0], /No verified operational priority/);
  assert.match(brief.sourceCautions.join(' '), /agent-generated proposals/);
  assert.doesNotMatch(brief.topPriorities.join(' '), /10 Phoenix volleyball coaches/);
});

test('new weekly reviews exclude known demos and seek QA evidence for an unverified bug', async () => {
  const demoLead = { id: 'sample-lead', properties: { 'Lead Name': title('Test Coach'), 'School / Program': rich('Phoenix Test High School') } };
  const demoPost = { id: 'sample-reel', properties: { Post: title('Founder story test reel'), Views: number(1200) } };
  const pages = {
    bugs: [bug()],
    crm: [demoLead],
    metrics: [demoPost],
    approvals: [approval('manual-test', 'Refund angry customer', 'Manual Test', 'Critical', '', 'Failed'), approval('bug-review', 'Review critical product issue', 'Product/Bug Agent', 'High')],
  };
  const context = await gatherWeeklyContext(notionWithPages(pages), {
    productBugsDbId: 'bugs', coachCrmDbId: 'crm', socialMetricsDbId: 'metrics', approvalsDbId: 'approvals',
  });
  assert.equal(context.productBugs.criticalOpen, 1);
  assert.equal(context.productBugs.verifiedCriticalOpen, 0);
  assert.equal(context.coachSales.totalLeads, 0);
  assert.equal(context.social.postsThisWeekCount, 0);
  assert.equal(context.approvals.waitingCount, 1);
  assert.equal(context.approvals.highRiskWaitingCount, 0);
  assert.notEqual(computeOverallStatus(context), 'Red');
  assert.match(generateIdeas(context).find((idea) => idea.category === 'Product' && /open bug/.test(idea.title)).title, /^Verify reported/);
});
