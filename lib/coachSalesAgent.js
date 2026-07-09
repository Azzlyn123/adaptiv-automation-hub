// Adaptiv Athletics — Coach Sales CRM Agent
//
// Step 9. Tracks coach/school/club leads for the Adaptiv launch plan
// (soft outreach to 10-15 Phoenix-area coaches, onboard 2-3 beta coaches,
// close 5+ paid coach accounts). This module scores and ranks leads, drafts
// outreach copy, and reports pipeline status — it never contacts anyone or
// closes a deal on its own.
//
// SAFETY RULES (Step 9 — do not remove or weaken):
//   - Do not send emails automatically.
//   - Do not send texts automatically.
//   - Do not DM anyone automatically.
//   - Do not mark a deal as Won automatically.
//   - All external outreach requires approval.
//   - Create drafts, tasks, and recommendations only.
//   - Never include private student-athlete data in outreach.
//   - Rank leads by likelihood to convert and strategic value.
//
// These rules are enforced in code, not just documented:
//   - buildCoachLeadProperties() always writes "Approved Outreach": false —
//     no code path in this module can flip it to true.
//   - buildOutreachDraftProperties() always writes Status "Needs Approval"
//     and "Approved": false — no code path in this module can mark a draft
//     Approved or Sent.
//   - validateLeadInput() rejects any request that tries to set Stage to
//     "Won" — moving a deal to Won is a manual, human-only action in Notion.
//   - generateOutreachDraft() never accepts or references athlete-specific
//     data (injuries, grades, PRs, etc.) — only coach/program-level context.
//
// Notion databases used:
//   - Coach CRM: Lead Name (title), School / Program (rich_text),
//     Sport (select), Role (select), Email (email), Phone (phone_number),
//     Source (select), Stage (select), Priority (select),
//     Last Contact (date), Next Follow-Up (date), Objection (rich_text),
//     Notes (rich_text), Estimated Value (number),
//     Approved Outreach (checkbox)
//   - Coach Outreach: Message (title), Lead (relation -> Coach CRM),
//     Channel (select), Status (select), Draft (rich_text),
//     Approved (checkbox), Sent Date (date), Follow-Up Date (date)
//   - Tasks: reused from Step 7 (Name, Status, Priority, Source Item,
//     Created) — used here only for follow-up reminders, never to log
//     an actual send.

// ---------------------------------------------------------------------------
// Valid select-field values (must match the live Notion schema exactly)
// ---------------------------------------------------------------------------
const VALID_ROLES = [
  'Head Coach',
  'Assistant Coach',
  'Athletic Director',
  'Club Director',
  'Trainer',
  'Parent Organizer',
  'Other',
];

const VALID_SPORTS = [
  'Volleyball',
  'Football',
  'Basketball',
  'Soccer',
  'Baseball/Softball',
  'Track & Field',
  'All Sports',
  'Other',
];

const VALID_SOURCES = ['Founder/Referral', 'Cold Outreach', 'Inbound', 'Event', 'Instagram', 'Other'];

const VALID_STAGES = [
  'New Lead',
  'Researching',
  'Contacted',
  'Interested',
  'Demo Scheduled',
  'Beta Access Offered',
  'Trial Active',
  'Proposal Sent',
  'Won',
  'Lost',
  'Dormant',
];

const VALID_PRIORITIES = ['High', 'Medium', 'Low'];

const VALID_CHANNELS = ['Email', 'Instagram DM', 'Text', 'Phone Call', 'In Person', 'LinkedIn'];

const VALID_OUTREACH_STATUSES = [
  'Draft',
  'Needs Approval',
  'Approved',
  'Sent',
  'Replied',
  'Follow-Up Needed',
  'Closed',
];

// Pipeline groupings used by the summary/scoring logic below.
const OPEN_STAGES = [
  'New Lead',
  'Researching',
  'Contacted',
  'Interested',
  'Demo Scheduled',
  'Beta Access Offered',
  'Trial Active',
  'Proposal Sent',
];
const CONVERSATION_STAGES = [
  'Contacted',
  'Interested',
  'Demo Scheduled',
  'Beta Access Offered',
  'Trial Active',
  'Proposal Sent',
  'Won',
];
const DEMO_STAGES = ['Demo Scheduled', 'Beta Access Offered', 'Trial Active', 'Proposal Sent', 'Won'];

// Step 9 safety rules, exported verbatim so server.js / docs can surface
// them without re-typing them anywhere else.
const SAFETY_RULES = [
  'Do not send emails automatically.',
  'Do not send texts automatically.',
  'Do not DM anyone automatically.',
  'Do not mark a deal as Won automatically.',
  'All external outreach requires approval.',
  'Create drafts, tasks, and recommendations only.',
  'Never include private student-athlete data in outreach.',
  'Rank leads by likelihood to convert and strategic value.',
];

// ---------------------------------------------------------------------------
// Lead scoring (Step 9 — exact formula from the spec)
// ---------------------------------------------------------------------------
const LEAD_SCORE_WEIGHTS = {
  athleticDirector: 25,
  headCoach: 20,
  phoenixTempeArea: 20,
  volleyball: 15,
  referral: 25,
  interestedOrReplied: 30,
  demoScheduled: 40,
  trialActive: 50,
  budgetLikely: 20,
  noResponseAfter3Touches: -20,
  lost: -100,
};

// input: { role, schoolProgram, sport, source, stage, replied, budgetLikely,
//          touchesWithNoResponse }
// All fields optional — missing fields simply score 0 for that line item.
function computeLeadScore(input = {}) {
  let score = 0;
  const reasons = [];

  if (input.role === 'Athletic Director') {
    score += LEAD_SCORE_WEIGHTS.athleticDirector;
    reasons.push(`Athletic Director (+${LEAD_SCORE_WEIGHTS.athleticDirector})`);
  }
  if (input.role === 'Head Coach') {
    score += LEAD_SCORE_WEIGHTS.headCoach;
    reasons.push(`Head Coach (+${LEAD_SCORE_WEIGHTS.headCoach})`);
  }

  const area = (input.schoolProgram || input.location || '').toLowerCase();
  if (area.includes('phoenix') || area.includes('tempe')) {
    score += LEAD_SCORE_WEIGHTS.phoenixTempeArea;
    reasons.push(`Phoenix/Tempe area (+${LEAD_SCORE_WEIGHTS.phoenixTempeArea})`);
  }

  if (input.sport === 'Volleyball') {
    score += LEAD_SCORE_WEIGHTS.volleyball;
    reasons.push(`Volleyball (+${LEAD_SCORE_WEIGHTS.volleyball})`);
  }

  if (input.source === 'Founder/Referral') {
    score += LEAD_SCORE_WEIGHTS.referral;
    reasons.push(`Known relationship/referral (+${LEAD_SCORE_WEIGHTS.referral})`);
  }

  if (input.stage === 'Interested' || input.replied) {
    score += LEAD_SCORE_WEIGHTS.interestedOrReplied;
    reasons.push(`Interested/replied (+${LEAD_SCORE_WEIGHTS.interestedOrReplied})`);
  }
  if (input.stage === 'Demo Scheduled') {
    score += LEAD_SCORE_WEIGHTS.demoScheduled;
    reasons.push(`Demo scheduled (+${LEAD_SCORE_WEIGHTS.demoScheduled})`);
  }
  if (input.stage === 'Trial Active') {
    score += LEAD_SCORE_WEIGHTS.trialActive;
    reasons.push(`Trial active (+${LEAD_SCORE_WEIGHTS.trialActive})`);
  }

  if (input.budgetLikely) {
    score += LEAD_SCORE_WEIGHTS.budgetLikely;
    reasons.push(`School/team budget likely (+${LEAD_SCORE_WEIGHTS.budgetLikely})`);
  }

  if ((input.touchesWithNoResponse || 0) >= 3) {
    score += LEAD_SCORE_WEIGHTS.noResponseAfter3Touches;
    reasons.push(`No response after 3 touches (${LEAD_SCORE_WEIGHTS.noResponseAfter3Touches})`);
  }

  if (input.stage === 'Lost') {
    score += LEAD_SCORE_WEIGHTS.lost;
    reasons.push(`Lost (${LEAD_SCORE_WEIGHTS.lost})`);
  }

  return { score, reasons };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function validateLeadInput(body) {
  const errors = [];
  const b = body || {};

  if (!b.leadName || typeof b.leadName !== 'string' || !b.leadName.trim()) {
    errors.push('leadName is required.');
  }
  if (b.role && !VALID_ROLES.includes(b.role)) {
    errors.push(`role must be one of: ${VALID_ROLES.join(', ')}`);
  }
  if (b.sport && !VALID_SPORTS.includes(b.sport)) {
    errors.push(`sport must be one of: ${VALID_SPORTS.join(', ')}`);
  }
  if (b.source && !VALID_SOURCES.includes(b.source)) {
    errors.push(`source must be one of: ${VALID_SOURCES.join(', ')}`);
  }
  if (b.stage && !VALID_STAGES.includes(b.stage)) {
    errors.push(`stage must be one of: ${VALID_STAGES.join(', ')}`);
  }
  // Safety rule: "Do not mark a deal as Won automatically." Marking Won is a
  // manual, human-only edit made directly in Notion — never through this API.
  if (b.stage === 'Won') {
    errors.push(
      'Stage cannot be set to "Won" through this endpoint — marking a deal Won is a manual review step in Notion, not an automated action.'
    );
  }
  if (b.priority && !VALID_PRIORITIES.includes(b.priority)) {
    errors.push(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`);
  }
  if (b.estimatedValue !== undefined && typeof b.estimatedValue !== 'number') {
    errors.push('estimatedValue must be a number.');
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    normalized: {
      leadName: b.leadName.trim(),
      schoolProgram: b.schoolProgram || '',
      sport: b.sport || '',
      role: b.role || '',
      email: b.email || '',
      phone: b.phone || '',
      source: b.source || '',
      stage: b.stage || 'New Lead',
      priority: b.priority || '',
      lastContact: b.lastContact || '',
      nextFollowUp: b.nextFollowUp || '',
      objection: b.objection || '',
      notes: b.notes || '',
      estimatedValue: typeof b.estimatedValue === 'number' ? b.estimatedValue : null,
    },
  };
}

// Safety rule: never include private student-athlete data. Reject the
// request outright if the caller tries to pass athlete-specific fields —
// this endpoint only accepts coach/program-level context.
const FORBIDDEN_OUTREACH_KEYS = ['athleteName', 'athleteData', 'injury', 'medicalInfo', 'grades', 'studentData'];

function validateOutreachInput(body) {
  const errors = [];
  const b = body || {};

  if (!b.leadPageId || typeof b.leadPageId !== 'string' || !b.leadPageId.trim()) {
    errors.push('leadPageId is required (the Notion page ID of the lead in Coach CRM).');
  }
  if (!b.channel || !VALID_CHANNELS.includes(b.channel)) {
    errors.push(`channel is required and must be one of: ${VALID_CHANNELS.join(', ')}`);
  }
  for (const key of FORBIDDEN_OUTREACH_KEYS) {
    if (b[key] !== undefined) {
      errors.push(`"${key}" is not allowed — outreach drafts may never include student-athlete data.`);
    }
  }
  if (b.context !== undefined && typeof b.context !== 'string') {
    errors.push('context must be a string.');
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    normalized: {
      leadPageId: b.leadPageId.trim(),
      leadName: b.leadName || '',
      schoolProgram: b.schoolProgram || '',
      role: b.role || '',
      channel: b.channel,
      context: b.context || '',
    },
  };
}

// ---------------------------------------------------------------------------
// Outreach draft generator
// ---------------------------------------------------------------------------
// Requirements (Step 9 spec): short, coach-friendly, not hype-heavy, focused
// on saving coaches time and helping athletes train smarter, mentions Adaptiv
// as an app + training system, includes one clear call to action, and never
// claims guaranteed performance results. Deliberately deterministic (no LLM
// call here) so every draft is auditable before a human approves it.
function generateOutreachDraft({ leadName, schoolProgram, role, context } = {}) {
  const firstName = leadName ? leadName.trim().split(/\s+/)[0] : 'Coach';
  const programClause = schoolProgram ? ` for ${schoolProgram}` : '';
  const contextLine = context && typeof context === 'string' ? context.trim() : '';

  const lines = [
    `Hi ${firstName},`,
    '',
    `I'm reaching out from Adaptiv — an app and training system built to save coaches time on programming` +
      ` while giving athletes personalized workouts, PR tracking, and check-in visibility in one place.`,
    '',
    `We're piloting it with a few coaches in the Phoenix area${programClause ? ` and thought it could be a fit${programClause}` : ''}.` +
      (contextLine ? ` ${contextLine}` : ''),
    '',
    `Would you be open to a quick 15-minute call this week to see if it's useful for your program?`,
    '',
    '— Adaptiv Athletics',
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Notion row builders — write shape (used with notion.pages.create)
// ---------------------------------------------------------------------------

// Coach CRM database row.
function buildCoachLeadProperties(lead = {}) {
  const properties = {
    'Lead Name': { title: [{ text: { content: lead.leadName } }] },
    Stage: { select: { name: lead.stage || 'New Lead' } },
    // Safety rule: "All external outreach requires approval." No code path
    // in this module ever sets this true — approval is a manual Notion edit.
    'Approved Outreach': { checkbox: false },
  };

  if (lead.schoolProgram) {
    properties['School / Program'] = { rich_text: [{ text: { content: lead.schoolProgram } }] };
  }
  if (lead.sport) properties['Sport'] = { select: { name: lead.sport } };
  if (lead.role) properties['Role'] = { select: { name: lead.role } };
  if (lead.email) properties['Email'] = { email: lead.email };
  if (lead.phone) properties['Phone'] = { phone_number: lead.phone };
  if (lead.source) properties['Source'] = { select: { name: lead.source } };
  if (lead.priority) properties['Priority'] = { select: { name: lead.priority } };
  if (lead.lastContact) properties['Last Contact'] = { date: { start: lead.lastContact } };
  if (lead.nextFollowUp) properties['Next Follow-Up'] = { date: { start: lead.nextFollowUp } };
  if (lead.objection) properties['Objection'] = { rich_text: [{ text: { content: lead.objection } }] };
  if (lead.notes) properties['Notes'] = { rich_text: [{ text: { content: lead.notes } }] };
  if (typeof lead.estimatedValue === 'number') {
    properties['Estimated Value'] = { number: lead.estimatedValue };
  }

  return properties;
}

// Coach Outreach database row. Always files as "Needs Approval" / not
// Approved — this module never sends anything and never marks a draft sent.
function buildOutreachDraftProperties({ leadPageId, leadName, channel, draftText } = {}) {
  const dateLabel = new Date().toISOString().split('T')[0];

  const properties = {
    Message: { title: [{ text: { content: `Outreach to ${leadName || 'Lead'} — ${dateLabel}` } }] },
    Channel: { select: { name: channel } },
    // Safety rules: "All external outreach requires approval." /
    // "Create drafts, tasks, and recommendations only." Status always
    // starts at "Needs Approval" and Approved always starts false — no
    // code path in this module can change either.
    Status: { select: { name: 'Needs Approval' } },
    Draft: { rich_text: [{ text: { content: draftText } }] },
    Approved: { checkbox: false },
  };

  if (leadPageId) {
    properties['Lead'] = { relation: [{ id: leadPageId }] };
  }

  return properties;
}

// Optional Tasks row — a human-facing reminder to follow up with a lead.
// Never used to record that outreach was actually sent.
function buildFollowUpTaskProperties({ leadName, dueDate, notes } = {}) {
  const dateLabel = new Date().toISOString().split('T')[0];

  return {
    Name: { title: [{ text: { content: `Follow up with ${leadName || 'lead'}` } }] },
    Status: { select: { name: 'To Do' } },
    Priority: { select: { name: 'Medium' } },
    'Source Item': {
      rich_text: [{ text: { content: notes || `Coach Sales Agent follow-up reminder${dueDate ? ` (due ${dueDate})` : ''}.` } }],
    },
    Created: { date: { start: dateLabel } },
  };
}

// ---------------------------------------------------------------------------
// Notion read helpers — pages.query() returns a different property shape
// than pages.create() takes, so these unwrap the read format.
// ---------------------------------------------------------------------------
function readTitle(prop) {
  if (!prop || !prop.title || prop.title.length === 0) return '';
  return prop.title.map((t) => t.plain_text || '').join('');
}

function readSelect(prop) {
  return prop && prop.select ? prop.select.name : null;
}

function readRichText(prop) {
  if (!prop || !prop.rich_text || prop.rich_text.length === 0) return '';
  return prop.rich_text.map((t) => t.plain_text || '').join('');
}

function readNumber(prop) {
  return prop && typeof prop.number === 'number' ? prop.number : null;
}

function readDate(prop) {
  return prop && prop.date ? prop.date.start : null;
}

function readCheckbox(prop) {
  return Boolean(prop && prop.checkbox);
}

// ---------------------------------------------------------------------------
// Pipeline summary — read-only. Queries Coach CRM (+ Coach Outreach, if a
// database ID is provided), scores/ranks leads, and rolls the pipeline up
// into a status against the Step 9H "first real sales target" (25 leads,
// 10 outreach drafts, 3 conversations, 1 demo booked). Never writes
// anything itself.
// ---------------------------------------------------------------------------
const FIRST_SALES_TARGET = { leads: 25, outreachDrafts: 10, conversations: 3, demos: 1 };

async function gatherCoachSalesSummary(notion, { crmDbId, outreachDbId }) {
  const crmResponse = await notion.databases.query({ database_id: crmDbId, page_size: 100 });

  const leads = crmResponse.results.map((page) => ({
    id: page.id,
    url: page.url,
    leadName: readTitle(page.properties['Lead Name']),
    schoolProgram: readRichText(page.properties['School / Program']),
    sport: readSelect(page.properties['Sport']),
    role: readSelect(page.properties['Role']),
    source: readSelect(page.properties['Source']),
    stage: readSelect(page.properties['Stage']) || 'New Lead',
    priority: readSelect(page.properties['Priority']),
    estimatedValue: readNumber(page.properties['Estimated Value']),
    objection: readRichText(page.properties['Objection']),
    nextFollowUp: readDate(page.properties['Next Follow-Up']),
    approvedOutreach: readCheckbox(page.properties['Approved Outreach']),
  }));

  const scoredLeads = leads
    .map((lead) => {
      const { score, reasons } = computeLeadScore({
        role: lead.role,
        schoolProgram: lead.schoolProgram,
        sport: lead.sport,
        source: lead.source,
        stage: lead.stage,
        // Approximation: an Estimated Value has been filled in at all is
        // treated as "budget likely". No literal "budget likely" field
        // exists in the Coach CRM schema.
        budgetLikely: typeof lead.estimatedValue === 'number' && lead.estimatedValue > 0,
      });
      return { ...lead, score, scoreReasons: reasons };
    })
    .sort((a, b) => b.score - a.score);

  const totalLeads = leads.length;
  const activeLeads = leads.filter((l) => OPEN_STAGES.includes(l.stage));
  const conversations = leads.filter((l) => CONVERSATION_STAGES.includes(l.stage));
  const demosBooked = leads.filter((l) => DEMO_STAGES.includes(l.stage));
  const wonLeads = leads.filter((l) => l.stage === 'Won');
  const lostLeads = leads.filter((l) => l.stage === 'Lost');

  let outreachDraftCount = 0;
  let outreachNeedsApprovalCount = 0;
  if (outreachDbId) {
    const outreachResponse = await notion.databases.query({ database_id: outreachDbId, page_size: 100 });
    outreachDraftCount = outreachResponse.results.length;
    outreachNeedsApprovalCount = outreachResponse.results.filter(
      (page) => readSelect(page.properties['Status']) === 'Needs Approval'
    ).length;
  }

  // Green/Yellow/Red: Red if the pipeline is empty, Yellow if leads exist
  // but nothing has moved past outreach yet, Green once there's an active
  // conversation and at least one outreach draft on file.
  let status = 'Red';
  if (totalLeads > 0 && outreachDraftCount > 0 && conversations.length > 0) {
    status = 'Green';
  } else if (totalLeads > 0) {
    status = 'Yellow';
  }

  return {
    status,
    totalLeads,
    activeLeadCount: activeLeads.length,
    conversationCount: conversations.length,
    demoCount: demosBooked.length,
    wonCount: wonLeads.length,
    lostCount: lostLeads.length,
    outreachDraftCount,
    outreachNeedsApprovalCount,
    topLeads: scoredLeads.slice(0, 5),
    target: FIRST_SALES_TARGET,
  };
}

// Notion blocks for the "Coach Sales" section of the Daily Brief.
function buildCoachSalesSummaryBlocks(summary) {
  const t = summary.target;

  return [
    heading2('Coach Sales'),
    paragraph(`Status: ${summary.status}`),
    paragraph(
      `Pipeline: ${summary.totalLeads} total leads / ${summary.activeLeadCount} active / ${summary.wonCount} won / ${summary.lostCount} lost`
    ),
    paragraph(
      `First sales target progress: ${summary.totalLeads}/${t.leads} leads, ${summary.outreachDraftCount}/${t.outreachDrafts} outreach drafts, ` +
        `${summary.conversationCount}/${t.conversations} conversations, ${summary.demoCount}/${t.demos} demo booked`
    ),
    boldParagraph('Top Ranked Leads:'),
    ...bulletedList(
      summary.topLeads.length > 0
        ? summary.topLeads.map(
            (l) => `${l.leadName || 'Unnamed lead'} (${l.schoolProgram || 'no program listed'}) — score ${l.score}, stage: ${l.stage}`
          )
        : ['None yet — use POST /add-coach-lead to start the pipeline.']
    ),
    paragraph(
      `Outreach drafts awaiting approval: ${summary.outreachNeedsApprovalCount} — nothing is sent automatically. Review and approve in Notion.`
    ),
  ];
}

// Builds the read-only sales-report summary text used for an Agent Reports
// row (POST /run-coach-sales-review).
function buildCoachSalesReportSummary(summary) {
  const t = summary.target;
  const lines = [
    `Coach Sales status: ${summary.status}.`,
    `${summary.totalLeads} total leads (${summary.activeLeadCount} active, ${summary.wonCount} won, ${summary.lostCount} lost).`,
    `Progress toward first sales target: ${summary.totalLeads}/${t.leads} leads, ${summary.outreachDraftCount}/${t.outreachDrafts} outreach drafts, ` +
      `${summary.conversationCount}/${t.conversations} conversations, ${summary.demoCount}/${t.demos} demo booked.`,
    summary.topLeads.length > 0
      ? `Top leads: ${summary.topLeads.map((l) => `${l.leadName || 'Unnamed lead'} (score ${l.score})`).join('; ')}.`
      : 'No leads yet.',
    `${summary.outreachNeedsApprovalCount} outreach draft(s) awaiting human approval — nothing sent automatically.`,
  ];
  return lines.join(' ');
}

// ---------------------------------------------------------------------------
// Minimal Notion block builders (same self-contained pattern as
// productBugAgent.js / railwayHealthAgent.js / filmAIPlanningAgent.js)
// ---------------------------------------------------------------------------
function heading2(text) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function paragraph(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function boldParagraph(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text }, annotations: { bold: true } }] },
  };
}

function bulletedList(items) {
  return items.map((item) => ({
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: item } }] },
  }));
}

module.exports = {
  VALID_ROLES,
  VALID_SPORTS,
  VALID_SOURCES,
  VALID_STAGES,
  VALID_PRIORITIES,
  VALID_CHANNELS,
  VALID_OUTREACH_STATUSES,
  SAFETY_RULES,
  LEAD_SCORE_WEIGHTS,
  FIRST_SALES_TARGET,
  computeLeadScore,
  validateLeadInput,
  validateOutreachInput,
  generateOutreachDraft,
  buildCoachLeadProperties,
  buildOutreachDraftProperties,
  buildFollowUpTaskProperties,
  gatherCoachSalesSummary,
  buildCoachSalesSummaryBlocks,
  buildCoachSalesReportSummary,
};
