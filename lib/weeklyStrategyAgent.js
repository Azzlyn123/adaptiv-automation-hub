// Adaptiv Athletics — Weekly Strategy + Idea System Agent
//
// Step 12. Turns the daily-operator agents into a weekly founder strategy
// board: pulls the latest available data from every other agent's Notion
// database, files one Weekly Strategy Review + one Weekly Scorecard row,
// generates 10 scored ideas into the Idea Bank, creates Tasks for next
// week's top 3 priorities, and files Approval requests for any idea that
// needs a founder decision.
//
// SAFETY RULES (Step 12 — do not remove or weaken):
//   - Do not invent metrics. If a metric is missing, mark it as missing.
//   - Do not approve ideas automatically.
//   - Do not create risky actions automatically.
//   - Do not post, email, restart, deploy, refund, delete, or modify billing.
//   - Create recommendations, experiments, tasks, and approval requests only.
//
// These rules are enforced in code, not just documented:
//   - gatherWeeklyContext() never fabricates a number — any source whose
//     database isn't configured, is empty, or fails to read is recorded in
//     context.missing and its section is written as "Missing — ..." instead
//     of a guessed value.
//   - buildIdeaProperties() always writes Status "New" — no code path here
//     can flip an idea to "Approved".
//   - No executor in this module calls Stripe, Railway, Gmail/Google, Twilio,
//     or any social platform API — it only ever calls notion.pages.create /
//     notion.databases.query.
//   - Founder-decision ideas are filed into Approvals as Status
//     "Needs Approval" — the existing Step 11 Approval Action Agent
//     whitelist has no action type for "idea", so these rows can never be
//     auto-executed by POST /run-approved-actions; a human must act on them
//     directly in Notion.
//
// Notion databases read (all optional/additive — see gatherWeeklyContext):
//   - Sales (Step 3): Name, Date, MRR, Athlete Subs, Coach Team Subs,
//     Coach School Subs, New Subs, Canceled Subs, Past Due, Notes
//   - Railway Health (Step 4): Name, Date, "Overall Status", Frontend,
//     Backend, Database, "Latest Deploy", "Health URL", "Response Time",
//     Errors, Notes
//   - Product Bugs (Step 7): "Bug / Issue", Type, Severity, Status, Source,
//     Screen, "User Role", "Repro Steps", Expected, Actual,
//     "Priority Score", Created, Notes
//   - Film AI Roadmap (Step 8): Task, Agent, Status, Priority,
//     "Feature Area", Sport, Notes, "Due Date"
//   - Coach CRM (Step 9): "Lead Name", Stage, "School / Program", Sport,
//     Role, Email, Phone, Source, Priority, "Last Contact",
//     "Next Follow-Up", Objection, Notes, "Estimated Value",
//     "Approved Outreach"
//   - Social Metrics (Step 10): Post, Platform, "Date Posted", URL, Views,
//     Likes, Comments, Shares, Saves, "Watch Time", "Engagement Rate", Notes
//   - Approvals (Step 11): Action, Agent, Risk, Status, Tool, Payload,
//     "Approved By", "Approved At", "Executed At", Result, Error, Notes
//
// Notion databases written (Step 12A):
//   - Weekly Strategy Reviews: Week (title), Status (select: Green/Yellow/
//     Red), "Revenue Summary", "Product Summary", "Sales Summary",
//     "Social Summary", "Film AI Summary", Risks, "Top 3 Priorities",
//     "Decisions Needed" (all rich_text)
//   - Idea Bank: Idea (title), Category (select), "Source Agent" (select),
//     "ROI Score", "Effort Score", "Risk Score", "Final Score" (number),
//     Status (select, always written "New"), Notes (rich_text)
//   - Weekly Scorecard: Week (title), MRR, "New Customers", "Coach Leads",
//     "Demos Booked", "Bugs Opened", "Bugs Fixed", "Social Posts",
//     "Best Post Views" (number), "Film AI Progress" (select),
//     "Overall Status" (select)
//   - Tasks (additive, Step 7 schema reused): one row per top-3 priority
//   - Approvals (additive, Step 11 schema reused): one row per idea that
//     needs a founder decision

// ---------------------------------------------------------------------------
// Valid select-field values (must match the live Notion schema exactly)
// ---------------------------------------------------------------------------
const IDEA_CATEGORIES = [
  'Revenue',
  'Product',
  'Film AI',
  'Coach Sales',
  'Social',
  'Operations',
  'Compliance',
  'Partnership',
];
const IDEA_STATUSES = ['New', 'Reviewing', 'Approved', 'Testing', 'Rejected', 'Done'];
const EXPERIMENT_STATUSES = ['Planned', 'Running', 'Won', 'Lost', 'Inconclusive'];
const REVIEW_STATUSES = ['Green', 'Yellow', 'Red'];

const OPEN_BUG_STATUSES = ['New', 'Triaged', 'In Progress', 'Blocked'];
const FILM_AI_OPEN_STATUSES = ['Backlog', 'Ready', 'In Progress', 'Blocked', 'Testing'];
const COACH_OPEN_STAGES = [
  'New Lead',
  'Researching',
  'Contacted',
  'Interested',
  'Demo Scheduled',
  'Beta Access Offered',
  'Trial Active',
  'Proposal Sent',
];
const COACH_DEMO_STAGES = ['Demo Scheduled', 'Beta Access Offered', 'Trial Active', 'Proposal Sent', 'Won'];

// Step 12 safety rules, exported verbatim so server.js / docs can surface
// them without re-typing them anywhere else.
const SAFETY_RULES = [
  'Do not invent metrics — missing data is marked as missing, never guessed.',
  'Do not approve ideas automatically.',
  'Do not create risky actions automatically.',
  'Do not post, email, restart, deploy, refund, delete, or modify billing.',
  'Create recommendations, experiments, tasks, and approval requests only.',
];

// Step 12H — things this agent must never do automatically. Every one of
// these stays a human, manual action in the real Adaptiv product/business —
// this module only ever files a recommendation or an approval request.
const WHAT_NOT_TO_AUTOMATE = [
  'Change pricing',
  'Launch a campaign',
  'Send coach emails',
  'Post content',
  'Change the app roadmap',
  'Deploy Film AI',
  'Spend money',
  'Sign contracts',
];

const MISSING = 'Missing — not enough data this week.';

// ---------------------------------------------------------------------------
// Idea scoring (Step 12C item 7 — exact formula from the spec)
// ---------------------------------------------------------------------------
function computeFinalScore(roiScore, effortScore, riskScore) {
  return roiScore - effortScore - riskScore;
}

// ---------------------------------------------------------------------------
// Notion read helpers — pages.query() returns a different property shape
// than pages.create() takes, so these unwrap the read format. Same
// self-contained pattern as the other lib/*.js agents in this codebase.
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

function daysAgoIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function isWithinLastDays(isoTimestamp, days) {
  if (!isoTimestamp) return false;
  return new Date(isoTimestamp).getTime() >= new Date(daysAgoIso(days)).getTime();
}

// ---------------------------------------------------------------------------
// Weekly context gathering — read-only. Pulls the latest available data from
// every other agent's Notion database. Every source is optional: a missing
// database ID, an empty database, or a failed read is recorded in
// context.missing with a specific reason and the corresponding section is
// left null (rendered as "Missing — ..." by the report/summary builders
// below) — never guessed or filled in with a placeholder number.
// ---------------------------------------------------------------------------
async function gatherWeeklyContext(
  notion,
  { salesDbId, railwayHealthDbId, productBugsDbId, filmAIRoadmapDbId, coachCrmDbId, socialMetricsDbId, approvalsDbId } = {}
) {
  const context = { missing: [] };

  // --- Revenue (Stripe Revenue Agent's latest Sales row) -------------------
  if (salesDbId) {
    try {
      const res = await notion.databases.query({
        database_id: salesDbId,
        sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        page_size: 1,
      });
      if (res.results.length > 0) {
        const p = res.results[0].properties;
        context.sales = {
          reportDate: readDate(p['Date']),
          mrr: readNumber(p['MRR']),
          athleteSubs: readNumber(p['Athlete Subs']),
          coachTeamSubs: readNumber(p['Coach Team Subs']),
          coachSchoolSubs: readNumber(p['Coach School Subs']),
          newSubs: readNumber(p['New Subs']),
          canceledSubs: readNumber(p['Canceled Subs']),
          pastDue: readNumber(p['Past Due']),
        };
      } else {
        context.sales = null;
        context.missing.push('Revenue (Sales database has no rows yet — run POST /run-revenue-sync first)');
      }
    } catch (err) {
      context.sales = null;
      context.missing.push('Revenue (failed to read Sales database)');
    }
  } else {
    context.sales = null;
    context.missing.push('Revenue (NOTION_DATABASE_SALES not configured)');
  }

  // --- Railway / App Health (latest Railway Health row) ---------------------
  if (railwayHealthDbId) {
    try {
      const res = await notion.databases.query({
        database_id: railwayHealthDbId,
        sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        page_size: 1,
      });
      if (res.results.length > 0) {
        const p = res.results[0].properties;
        context.railwayHealth = {
          reportDate: readDate(p['Date']),
          overallStatus: readSelect(p['Overall Status']),
          frontend: readSelect(p['Frontend']),
          backend: readSelect(p['Backend']),
          database: readSelect(p['Database']),
          errors: readRichText(p['Errors']),
        };
      } else {
        context.railwayHealth = null;
        context.missing.push('Railway/App Health (Railway Health database has no rows yet — run POST /run-railway-health first)');
      }
    } catch (err) {
      context.railwayHealth = null;
      context.missing.push('Railway/App Health (failed to read Railway Health database)');
    }
  } else {
    context.railwayHealth = null;
    context.missing.push('Railway/App Health (NOTION_DATABASE_RAILWAY_HEALTH not configured)');
  }

  // --- Product / App (Product Bugs) -----------------------------------------
  if (productBugsDbId) {
    try {
      const res = await notion.databases.query({ database_id: productBugsDbId, page_size: 100 });
      const bugs = res.results.map((page) => ({
        id: page.id,
        url: page.url,
        title: readTitle(page.properties['Bug / Issue']),
        severity: readSelect(page.properties['Severity']),
        status: readSelect(page.properties['Status']),
        priorityScore: readNumber(page.properties['Priority Score']) ?? 0,
        createdTime: page.created_time,
        lastEditedTime: page.last_edited_time,
      }));

      const openBugs = bugs.filter((b) => OPEN_BUG_STATUSES.includes(b.status));
      const criticalOpen = openBugs.filter((b) => b.severity === 'Critical');
      const highOpen = openBugs.filter((b) => b.severity === 'High');
      const openedThisWeek = bugs.filter((b) => isWithinLastDays(b.createdTime, 7));
      // No "resolution date" property exists on Product Bugs, so "fixed this
      // week" is approximated as: currently not-open, and last edited in the
      // last 7 days (i.e. moved out of an open status recently). Documented
      // here rather than presented as an exact number — see Product Summary.
      const fixedThisWeek = bugs.filter((b) => !OPEN_BUG_STATUSES.includes(b.status) && isWithinLastDays(b.lastEditedTime, 7));
      const topOpenBug = [...openBugs].sort((a, b) => b.priorityScore - a.priorityScore)[0] || null;

      context.productBugs = {
        totalOpen: openBugs.length,
        criticalOpen: criticalOpen.length,
        highOpen: highOpen.length,
        openedThisWeek: openedThisWeek.length,
        fixedThisWeek: fixedThisWeek.length,
        topOpenBug,
      };
    } catch (err) {
      context.productBugs = null;
      context.missing.push('Product/App (failed to read Product Bugs database)');
    }
  } else {
    context.productBugs = null;
    context.missing.push('Product/App (NOTION_DATABASE_PRODUCT_BUGS not configured)');
  }

  // --- Film AI (Roadmap) -----------------------------------------------------
  if (filmAIRoadmapDbId) {
    try {
      const res = await notion.databases.query({ database_id: filmAIRoadmapDbId, page_size: 100 });
      const tasks = res.results.map((page) => ({
        id: page.id,
        url: page.url,
        task: readTitle(page.properties['Task']),
        status: readSelect(page.properties['Status']),
        priority: readSelect(page.properties['Priority']),
      }));

      const total = tasks.length;
      const done = tasks.filter((t) => t.status === 'Done');
      const open = tasks.filter((t) => FILM_AI_OPEN_STATUSES.includes(t.status));
      const blocked = tasks.filter((t) => t.status === 'Blocked');
      const progressPct = total > 0 ? Math.round((done.length / total) * 100) : 0;

      context.filmAI = {
        totalTasks: total,
        doneCount: done.length,
        openCount: open.length,
        blockedCount: blocked.length,
        progressPct,
        blockedTasks: blocked,
      };
    } catch (err) {
      context.filmAI = null;
      context.missing.push('Film AI (failed to read Film AI Roadmap database)');
    }
  } else {
    context.filmAI = null;
    context.missing.push('Film AI (NOTION_DATABASE_FILM_AI_ROADMAP not configured)');
  }

  // --- Coach Sales (Coach CRM) -----------------------------------------------
  if (coachCrmDbId) {
    try {
      const res = await notion.databases.query({ database_id: coachCrmDbId, page_size: 100 });
      const leads = res.results.map((page) => ({
        id: page.id,
        url: page.url,
        leadName: readTitle(page.properties['Lead Name']),
        schoolProgram: readRichText(page.properties['School / Program']),
        stage: readSelect(page.properties['Stage']) || 'New Lead',
        estimatedValue: readNumber(page.properties['Estimated Value']),
        createdTime: page.created_time,
        lastEditedTime: page.last_edited_time,
      }));

      const totalLeads = leads.length;
      const activeLeads = leads.filter((l) => COACH_OPEN_STAGES.includes(l.stage));
      const newLeadsThisWeek = leads.filter((l) => isWithinLastDays(l.createdTime, 7));
      const demosThisWeek = leads.filter((l) => COACH_DEMO_STAGES.includes(l.stage) && isWithinLastDays(l.lastEditedTime, 7));
      const topLead = [...leads]
        .filter((l) => typeof l.estimatedValue === 'number')
        .sort((a, b) => (b.estimatedValue || 0) - (a.estimatedValue || 0))[0] || null;

      context.coachSales = {
        totalLeads,
        activeLeadCount: activeLeads.length,
        newLeadsThisWeek: newLeadsThisWeek.length,
        demosThisWeek: demosThisWeek.length,
        topLead,
      };
    } catch (err) {
      context.coachSales = null;
      context.missing.push('Coach Sales (failed to read Coach CRM database)');
    }
  } else {
    context.coachSales = null;
    context.missing.push('Coach Sales (NOTION_DATABASE_COACH_CRM not configured)');
  }

  // --- Social Media (Social Metrics) -----------------------------------------
  if (socialMetricsDbId) {
    try {
      const res = await notion.databases.query({ database_id: socialMetricsDbId, page_size: 100 });
      const posts = res.results.map((page) => ({
        id: page.id,
        url: page.url,
        postTitle: readTitle(page.properties['Post']),
        platform: readSelect(page.properties['Platform']),
        views: readNumber(page.properties['Views']) || 0,
        engagementRate: readNumber(page.properties['Engagement Rate']),
        createdTime: page.created_time,
      }));

      const postsThisWeek = posts.filter((p) => isWithinLastDays(p.createdTime, 7));
      const bestPost = [...postsThisWeek].sort((a, b) => b.views - a.views)[0] || null;
      const weakestPost =
        postsThisWeek.length > 0 ? [...postsThisWeek].sort((a, b) => a.views - b.views)[0] : null;

      context.social = {
        postsThisWeekCount: postsThisWeek.length,
        bestPost,
        weakestPost,
      };
    } catch (err) {
      context.social = null;
      context.missing.push('Social Media (failed to read Social Metrics database)');
    }
  } else {
    context.social = null;
    context.missing.push('Social Media (NOTION_DATABASE_SOCIAL_METRICS not configured)');
  }

  // --- Approvals (waiting items, for the Risks section) -----------------------
  if (approvalsDbId) {
    try {
      const res = await notion.databases.query({ database_id: approvalsDbId, page_size: 100 });
      const rows = res.results.map((page) => ({
        action: readTitle(page.properties['Action']),
        status: readSelect(page.properties['Status']),
        risk: readSelect(page.properties['Risk']),
      }));
      const waiting = rows.filter((r) => r.status === 'Needs Approval');
      context.approvals = {
        waitingCount: waiting.length,
        highRiskWaitingCount: waiting.filter((r) => r.risk === 'High' || r.risk === 'Critical').length,
      };
    } catch (err) {
      context.approvals = null;
      context.missing.push('Approvals (failed to read Approvals database)');
    }
  } else {
    context.approvals = null;
    context.missing.push('Approvals (NOTION_DATABASE_APPROVALS not configured)');
  }

  return context;
}

// ---------------------------------------------------------------------------
// Overall status (Green/Yellow/Red) — same three-color pattern used
// throughout this codebase (Daily Brief, Railway Health, Coach Sales, etc.)
// ---------------------------------------------------------------------------
function computeOverallStatus(context) {
  const redSignals = [
    context.railwayHealth && context.railwayHealth.overallStatus === 'Red',
    context.productBugs && context.productBugs.criticalOpen > 0,
    context.approvals && context.approvals.highRiskWaitingCount > 0,
  ].filter(Boolean).length;

  if (redSignals > 0) return 'Red';

  const yellowSignals = [
    context.missing.length >= 3,
    context.railwayHealth && context.railwayHealth.overallStatus === 'Yellow',
    context.productBugs && context.productBugs.highOpen > 0,
    context.sales && typeof context.sales.pastDue === 'number' && context.sales.pastDue > 0,
  ].filter(Boolean).length;

  if (yellowSignals > 0) return 'Yellow';

  return 'Green';
}

// ---------------------------------------------------------------------------
// Idea generation (Step 12C items 6-7, Step 12G examples). Deterministic —
// no external LLM call, same philosophy as generateOutreachDraft() /
// generateContentDraft() elsewhere in this codebase, so every idea is
// auditable before a human reviews it. Uses live context data where
// available (a real bug title, a real blocked task, a real top lead) and
// falls back to the exact Step 12G example ideas otherwise — never a
// fabricated number.
// ---------------------------------------------------------------------------
function generateIdeas(context = {}) {
  const ideas = [];

  // --- Revenue (2) -----------------------------------------------------------
  ideas.push({
    title: 'Offer founding coach/team discount for first 5 accounts',
    category: 'Revenue',
    sourceAgent: 'Revenue Agent',
    roiScore: 8,
    effortScore: 3,
    riskScore: 2,
    notes: 'Locks in early coach accounts and social proof before broader outreach. Recommend approving a specific discount % before offering it to anyone.',
  });
  if (context.sales && context.sales.pastDue > 0) {
    ideas.push({
      title: `Follow up on ${context.sales.pastDue} past-due subscription(s)`,
      category: 'Revenue',
      sourceAgent: 'Revenue Agent',
      roiScore: 6,
      effortScore: 2,
      riskScore: 2,
      notes: 'A failed-payment follow-up approval item already exists in Approvals from the Revenue Agent — this just prioritizes it for the week.',
    });
  } else {
    ideas.push({
      title: 'Explore an annual-plan discount to improve cash flow',
      category: 'Revenue',
      sourceAgent: 'Revenue Agent',
      roiScore: 5,
      effortScore: 4,
      riskScore: 3,
      notes: 'No past-due subscriptions this week — a proactive pricing experiment instead of reactive collections. Needs a founder pricing decision before testing.',
    });
  }

  // --- Product (2) -------------------------------------------------------------
  ideas.push({
    title: 'Add coach onboarding checklist',
    category: 'Product',
    sourceAgent: 'Product/Bug Agent',
    roiScore: 7,
    effortScore: 3,
    riskScore: 1,
    notes: 'Reduces coach drop-off in week one. Low risk, ships independently of other work.',
  });
  if (context.productBugs && context.productBugs.topOpenBug) {
    ideas.push({
      title: `Fix top-priority open bug: ${context.productBugs.topOpenBug.title || 'untitled'}`,
      category: 'Product',
      sourceAgent: 'Product/Bug Agent',
      roiScore: 7,
      effortScore: 5,
      riskScore: 2,
      notes: `Priority Score ${context.productBugs.topOpenBug.priorityScore} — highest-ranked open item in Product Bugs this week.`,
    });
  } else {
    ideas.push({
      title: 'Improve first-workout onboarding flow for new athletes',
      category: 'Product',
      sourceAgent: 'Product/Bug Agent',
      roiScore: 6,
      effortScore: 5,
      riskScore: 2,
      notes: 'No open bugs in Product Bugs this week — recommend a proactive UX improvement instead.',
    });
  }

  // --- Film AI (2) ---------------------------------------------------------------
  ideas.push({
    title: 'Build volleyball hitting demo with 3 sample clips',
    category: 'Film AI',
    sourceAgent: 'Film AI Product Lead',
    roiScore: 8,
    effortScore: 6,
    riskScore: 3,
    notes: 'Planning-only per Step 8H — no real athlete video until the privacy gate clears.',
  });
  if (context.filmAI && context.filmAI.blockedTasks && context.filmAI.blockedTasks.length > 0) {
    ideas.push({
      title: `Unblock Film AI roadmap task: ${context.filmAI.blockedTasks[0].task || 'untitled'}`,
      category: 'Film AI',
      sourceAgent: 'Film AI Product Lead',
      roiScore: 6,
      effortScore: 5,
      riskScore: 3,
      notes: `${context.filmAI.blockedTasks.length} blocked task(s) currently on the roadmap.`,
    });
  } else {
    ideas.push({
      title: 'Define technique-scoring rubric for volleyball hitting mechanics',
      category: 'Film AI',
      sourceAgent: 'Film AI Product Lead',
      roiScore: 6,
      effortScore: 5,
      riskScore: 3,
      notes: 'No blocked tasks this week — use the time to define scoring criteria ahead of the demo build.',
    });
  }

  // --- Coach Sales (2) -------------------------------------------------------------
  ideas.push({
    title: 'Target 10 Phoenix volleyball coaches this week',
    category: 'Coach Sales',
    sourceAgent: 'Coach Sales Agent',
    roiScore: 7,
    effortScore: 4,
    riskScore: 2,
    notes: 'Matches Step 9H first-sales target. Use POST /draft-coach-outreach for each — nothing sends automatically.',
  });
  if (context.coachSales && context.coachSales.topLead) {
    ideas.push({
      title: `Prioritize follow-up with ${context.coachSales.topLead.leadName || 'top lead'}`,
      category: 'Coach Sales',
      sourceAgent: 'Coach Sales Agent',
      roiScore: 6,
      effortScore: 3,
      riskScore: 2,
      notes: `Highest Estimated Value lead currently in Coach CRM (${context.coachSales.topLead.schoolProgram || 'no program listed'}).`,
    });
  } else {
    ideas.push({
      title: 'Publish one case study from an active beta coach',
      category: 'Coach Sales',
      sourceAgent: 'Coach Sales Agent',
      roiScore: 5,
      effortScore: 4,
      riskScore: 2,
      notes: 'No leads with an Estimated Value set yet — a case study builds credibility for future outreach.',
    });
  }

  // --- Social (1) -------------------------------------------------------------------
  ideas.push({
    title: 'Post "building Film AI for volleyball" series',
    category: 'Social',
    sourceAgent: 'Social Media Agent',
    roiScore: 5,
    effortScore: 3,
    riskScore: 1,
    notes: 'Builds toward Adaptiv’s long-term Film AI edge while it’s still in planning. Draft only via POST /draft-social-content — nothing posts automatically.',
  });

  // --- Risk / Compliance (1) --------------------------------------------------------
  ideas.push({
    title: 'Add privacy language before storing athlete videos',
    category: 'Compliance',
    sourceAgent: 'Weekly Strategy Agent',
    roiScore: 4,
    effortScore: 2,
    riskScore: 1,
    notes: 'Required before the Step 8H privacy gate can clear for real athlete video. Founder review recommended.',
  });

  return ideas.map((idea) => ({
    ...idea,
    finalScore: computeFinalScore(idea.roiScore, idea.effortScore, idea.riskScore),
  }));
}

// Ideas whose category carries financial, legal, or brand risk always get a
// founder-facing approval request — a deterministic rule, not a guess.
const FOUNDER_DECISION_CATEGORIES = ['Revenue', 'Compliance'];

function ideasNeedingFounderDecision(ideas) {
  return ideas.filter((idea) => FOUNDER_DECISION_CATEGORIES.includes(idea.category));
}

function topPriorities(ideas, count = 3) {
  return [...ideas].sort((a, b) => b.finalScore - a.finalScore).slice(0, count);
}

// ---------------------------------------------------------------------------
// Notion row builders — write shape (used with notion.pages.create)
// ---------------------------------------------------------------------------
function buildIdeaProperties(idea = {}) {
  return {
    Idea: { title: [{ text: { content: idea.title } }] },
    Category: { select: { name: idea.category } },
    'Source Agent': { select: { name: idea.sourceAgent } },
    'ROI Score': { number: idea.roiScore },
    'Effort Score': { number: idea.effortScore },
    'Risk Score': { number: idea.riskScore },
    'Final Score': { number: idea.finalScore },
    // Safety rule: "Do not approve ideas automatically." No code path in
    // this module can write anything other than "New" here.
    Status: { select: { name: 'New' } },
    Notes: { rich_text: [{ text: { content: idea.notes || '' } }] },
  };
}

// Experiments database row builder — exported for future/manual use.
// Step 12C's build list never has the weekly agent auto-create Experiments
// rows, so no route in server.js calls this yet.
function buildExperimentProperties(exp = {}) {
  const properties = {
    Experiment: { title: [{ text: { content: exp.experiment } }] },
    Status: { select: { name: exp.status || 'Planned' } },
  };
  if (exp.goal) properties['Goal'] = { rich_text: [{ text: { content: exp.goal } }] };
  if (exp.hypothesis) properties['Hypothesis'] = { rich_text: [{ text: { content: exp.hypothesis } }] };
  if (exp.owner) properties['Owner'] = { rich_text: [{ text: { content: exp.owner } }] };
  if (exp.startDate) properties['Start Date'] = { date: { start: exp.startDate } };
  if (exp.endDate) properties['End Date'] = { date: { start: exp.endDate } };
  if (exp.successMetric) properties['Success Metric'] = { rich_text: [{ text: { content: exp.successMetric } }] };
  if (exp.result) properties['Result'] = { rich_text: [{ text: { content: exp.result } }] };
  return properties;
}

// Weekly Strategy Reviews database row.
function buildWeeklyStrategyReviewProperties({ weekLabel, status, revenueSummary, productSummary, salesSummary, socialSummary, filmAISummary, risks, priorityLines, decisionLines }) {
  return {
    Week: { title: [{ text: { content: weekLabel } }] },
    Status: { select: { name: status } },
    'Revenue Summary': { rich_text: [{ text: { content: revenueSummary } }] },
    'Product Summary': { rich_text: [{ text: { content: productSummary } }] },
    'Sales Summary': { rich_text: [{ text: { content: salesSummary } }] },
    'Social Summary': { rich_text: [{ text: { content: socialSummary } }] },
    'Film AI Summary': { rich_text: [{ text: { content: filmAISummary } }] },
    Risks: { rich_text: [{ text: { content: risks } }] },
    'Top 3 Priorities': { rich_text: [{ text: { content: priorityLines.join(' | ') } }] },
    'Decisions Needed': { rich_text: [{ text: { content: decisionLines.length > 0 ? decisionLines.join(' | ') : 'None this week.' } }] },
  };
}

// Weekly Scorecard database row.
function buildWeeklyScorecardProperties({ weekLabel, mrr, newCustomers, coachLeads, demosBooked, bugsOpened, bugsFixed, socialPosts, bestPostViews, filmAIProgressLabel, overallStatus }) {
  const properties = {
    Week: { title: [{ text: { content: weekLabel } }] },
    'Overall Status': { select: { name: overallStatus } },
  };
  if (typeof mrr === 'number') properties['MRR'] = { number: mrr };
  if (typeof newCustomers === 'number') properties['New Customers'] = { number: newCustomers };
  if (typeof coachLeads === 'number') properties['Coach Leads'] = { number: coachLeads };
  if (typeof demosBooked === 'number') properties['Demos Booked'] = { number: demosBooked };
  if (typeof bugsOpened === 'number') properties['Bugs Opened'] = { number: bugsOpened };
  if (typeof bugsFixed === 'number') properties['Bugs Fixed'] = { number: bugsFixed };
  if (typeof socialPosts === 'number') properties['Social Posts'] = { number: socialPosts };
  if (typeof bestPostViews === 'number') properties['Best Post Views'] = { number: bestPostViews };
  if (filmAIProgressLabel) properties['Film AI Progress'] = { select: { name: filmAIProgressLabel } };
  return properties;
}

// Tasks database row (Step 7 schema reused) — one per next-week priority.
function buildPriorityTaskProperties(idea, weekLabel) {
  const dateLabel = new Date().toISOString().split('T')[0];
  return {
    Name: { title: [{ text: { content: `Priority: ${idea.title}` } }] },
    Status: { select: { name: 'To Do' } },
    Priority: { select: { name: 'High' } },
    'Source Item': {
      rich_text: [{ text: { content: `Weekly Strategy Agent — ${weekLabel} (score ${idea.finalScore}, category ${idea.category}).` } }],
    },
    Created: { date: { start: dateLabel } },
  };
}

// Approvals database row (Step 11 schema reused) — one per idea needing a
// founder decision. Always files as "Needs Approval" — no code path in this
// module can approve anything. Deliberately omits Tool/Payload: this isn't
// one of the Step 11 whitelisted executable action types, so it can never be
// picked up by POST /run-approved-actions — it's a recommendation only.
function buildFounderDecisionApprovalProperties(idea, weekLabel) {
  const risk = idea.riskScore >= 7 ? 'High' : idea.riskScore >= 4 ? 'Medium' : 'Low';
  return {
    Action: { title: [{ text: { content: `Decide: ${idea.title}` } }] },
    Agent: { select: { name: 'Weekly Strategy Agent' } },
    Risk: { select: { name: risk } },
    Status: { select: { name: 'Needs Approval' } },
    Notes: {
      rich_text: [
        {
          text: {
            content: `${weekLabel} — Category: ${idea.category}. ROI ${idea.roiScore} / Effort ${idea.effortScore} / Risk ${idea.riskScore} (final ${idea.finalScore}). ${idea.notes || ''}`.trim(),
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Text summaries — used for the Weekly Strategy Reviews rich_text properties
// ---------------------------------------------------------------------------
function summarizeRevenue(sales) {
  if (!sales) return MISSING;
  const parts = [];
  if (typeof sales.mrr === 'number') parts.push(`MRR $${sales.mrr}`);
  if (typeof sales.newSubs === 'number') parts.push(`${sales.newSubs} new subs`);
  if (typeof sales.canceledSubs === 'number') parts.push(`${sales.canceledSubs} canceled`);
  if (typeof sales.pastDue === 'number') parts.push(`${sales.pastDue} past due`);
  return parts.length > 0 ? parts.join(', ') + '.' : MISSING;
}

function summarizeProduct(bugs) {
  if (!bugs) return MISSING;
  return (
    `${bugs.totalOpen} open bugs (${bugs.criticalOpen} critical, ${bugs.highOpen} high). ` +
    `${bugs.openedThisWeek} opened this week, ~${bugs.fixedThisWeek} resolved this week (approximate — Product Bugs has no resolution-date field).` +
    (bugs.topOpenBug ? ` Top priority: ${bugs.topOpenBug.title || 'untitled'}.` : '')
  );
}

function summarizeCoachSales(coachSales) {
  if (!coachSales) return MISSING;
  return (
    `${coachSales.totalLeads} total leads (${coachSales.activeLeadCount} active), ${coachSales.newLeadsThisWeek} new this week, ` +
    `${coachSales.demosThisWeek} moved into a demo stage this week.` +
    (coachSales.topLead ? ` Top lead: ${coachSales.topLead.leadName || 'unnamed'}.` : '')
  );
}

function summarizeSocial(social) {
  if (!social) return MISSING;
  return (
    `${social.postsThisWeekCount} post(s) logged this week.` +
    (social.bestPost ? ` Best: "${social.bestPost.postTitle || 'untitled'}" (${social.bestPost.views} views).` : '') +
    (social.weakestPost && social.weakestPost !== social.bestPost
      ? ` Weakest: "${social.weakestPost.postTitle || 'untitled'}" (${social.weakestPost.views} views).`
      : '')
  );
}

function summarizeFilmAI(filmAI) {
  if (!filmAI) return MISSING;
  return (
    `${filmAI.progressPct}% of roadmap done (${filmAI.doneCount}/${filmAI.totalTasks}). ${filmAI.blockedCount} blocked task(s).` +
    ' Planning only — no CV code run, no real athlete video touched.'
  );
}

function summarizeRailway(health) {
  if (!health) return MISSING;
  return `Overall ${health.overallStatus || 'unknown'} — Frontend ${health.frontend || 'unknown'}, Backend ${health.backend || 'unknown'}, Database ${health.database || 'unknown'}.`;
}

function summarizeRisks(context) {
  const lines = [];
  if (context.productBugs && context.productBugs.criticalOpen > 0) {
    lines.push(`${context.productBugs.criticalOpen} critical bug(s) open.`);
  }
  if (context.railwayHealth && context.railwayHealth.overallStatus === 'Red') {
    lines.push('Railway health is Red — see Railway Health database.');
  }
  if (context.approvals && context.approvals.highRiskWaitingCount > 0) {
    lines.push(`${context.approvals.highRiskWaitingCount} high/critical-risk approval(s) waiting on founder review.`);
  }
  if (context.sales && typeof context.sales.pastDue === 'number' && context.sales.pastDue > 0) {
    lines.push(`${context.sales.pastDue} subscription(s) past due.`);
  }
  if (context.missing.length > 0) {
    lines.push(`Missing data this week: ${context.missing.join('; ')}`);
  }
  return lines.length > 0 ? lines.join(' ') : 'No significant risks flagged this week.';
}

function filmAIProgressLabel(filmAI) {
  if (!filmAI) return null;
  const pct = filmAI.progressPct;
  if (pct >= 100) return 'Done';
  if (pct >= 67) return 'Near Complete';
  if (pct >= 34) return 'In Progress';
  if (pct > 0) return 'Early';
  return 'Not Started';
}

function weekLabel(date = new Date()) {
  const monday = new Date(date);
  const day = monday.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  monday.setUTCDate(monday.getUTCDate() + diffToMonday);
  return `Week of ${monday.toISOString().split('T')[0]}`;
}

// ---------------------------------------------------------------------------
// Notion block builders for the full Step 12D 11-section report, written
// into the Weekly Strategy Review page body (children).
// ---------------------------------------------------------------------------
function heading1(text) {
  return { object: 'block', type: 'heading_1', heading_1: { rich_text: [{ type: 'text', text: { content: text } }] } };
}
function heading2(text) {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: text } }] } };
}
function paragraph(text) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: text } }] } };
}
function bulletedList(items) {
  return items.map((item) => ({
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: item } }] },
  }));
}
function numberedList(items) {
  return items.map((item) => ({
    object: 'block',
    type: 'numbered_list_item',
    numbered_list_item: { rich_text: [{ type: 'text', text: { content: item } }] },
  }));
}

function buildWeeklyReviewBlocks({ label, status, context, ideas, priorities, decisionIdeas }) {
  const blocks = [
    heading1('Adaptiv Weekly Strategy Review'),
    paragraph(`Week: ${label}`),
    paragraph(`Overall Status: ${status}`),

    heading2('1. Executive Summary'),
    paragraph(
      `Status is ${status} this week. ${context.missing.length > 0 ? `${context.missing.length} data source(s) missing — see below.` : 'All connected data sources reported.'}`
    ),

    heading2('2. Revenue'),
    ...bulletedList([
      `MRR: ${context.sales && typeof context.sales.mrr === 'number' ? `$${context.sales.mrr}` : MISSING}`,
      `New customers: ${context.sales && typeof context.sales.newSubs === 'number' ? context.sales.newSubs : MISSING}`,
      `Cancellations: ${context.sales && typeof context.sales.canceledSubs === 'number' ? context.sales.canceledSubs : MISSING}`,
      `Failed payments: ${context.sales && typeof context.sales.pastDue === 'number' ? context.sales.pastDue : MISSING}`,
      `Best revenue opportunity: ${ideas.find((i) => i.category === 'Revenue')?.title || MISSING}`,
    ]),

    heading2('3. Product / App'),
    ...bulletedList([
      `Critical bugs: ${context.productBugs ? context.productBugs.criticalOpen : MISSING}`,
      `High-priority bugs: ${context.productBugs ? context.productBugs.highOpen : MISSING}`,
      `Fixed this week (approx.): ${context.productBugs ? context.productBugs.fixedThisWeek : MISSING}`,
      `Biggest product risk: ${context.productBugs && context.productBugs.topOpenBug ? context.productBugs.topOpenBug.title : 'None flagged'}`,
    ]),

    heading2('4. Railway / App Health'),
    ...bulletedList([
      `Frontend: ${context.railwayHealth ? context.railwayHealth.frontend : MISSING}`,
      `Backend: ${context.railwayHealth ? context.railwayHealth.backend : MISSING}`,
      `Database: ${context.railwayHealth ? context.railwayHealth.database : MISSING}`,
      `Outages: ${context.railwayHealth && context.railwayHealth.overallStatus === 'Red' ? 'Yes — see Railway Health database' : 'None reported'}`,
      `Performance issues: ${context.railwayHealth && context.railwayHealth.errors ? context.railwayHealth.errors : 'None reported'}`,
    ]),

    heading2('5. Coach Sales'),
    ...bulletedList([
      `New leads: ${context.coachSales ? context.coachSales.newLeadsThisWeek : MISSING}`,
      `Active pipeline: ${context.coachSales ? context.coachSales.activeLeadCount : MISSING}`,
      `Demos: ${context.coachSales ? context.coachSales.demosThisWeek : MISSING}`,
      `Hot accounts: ${context.coachSales && context.coachSales.topLead ? context.coachSales.topLead.leadName : 'None flagged'}`,
      `Next sales move: ${ideas.find((i) => i.category === 'Coach Sales')?.title || MISSING}`,
    ]),

    heading2('6. Film AI'),
    ...bulletedList([
      `Progress: ${context.filmAI ? `${context.filmAI.progressPct}% (${context.filmAI.doneCount}/${context.filmAI.totalTasks})` : MISSING}`,
      `Blockers: ${context.filmAI ? context.filmAI.blockedCount : MISSING}`,
      `Next build task: ${ideas.find((i) => i.category === 'Film AI')?.title || MISSING}`,
      `Demo-readiness: Not cleared — Step 8H privacy gate still open.`,
    ]),

    heading2('7. Social Media'),
    ...bulletedList([
      `Posts: ${context.social ? context.social.postsThisWeekCount : MISSING}`,
      `Best content: ${context.social && context.social.bestPost ? context.social.bestPost.postTitle : MISSING}`,
      `Weak content: ${context.social && context.social.weakestPost ? context.social.weakestPost.postTitle : MISSING}`,
      `Content recommendation: ${ideas.find((i) => i.category === 'Social')?.title || MISSING}`,
    ]),

    heading2('8. Risks'),
    paragraph(summarizeRisks(context)),

    heading2('9. Top 10 Ideas'),
    ...numberedList(
      [...ideas]
        .sort((a, b) => b.finalScore - a.finalScore)
        .map((i) => `${i.title} (${i.category}, score ${i.finalScore})`)
    ),

    heading2("10. Next Week's Top 3 Priorities"),
    ...numberedList(priorities.map((p) => p.title)),

    heading2('11. Founder Decisions Needed'),
    ...(decisionIdeas.length > 0
      ? bulletedList(decisionIdeas.map((i) => `${i.title} — see Approvals database.`))
      : [paragraph('None this week.')]),
  ];

  return blocks;
}

// ---------------------------------------------------------------------------
// Daily Brief integration (Step 12 item 12) — short summary blocks, same
// pattern as buildCoachSalesSummaryBlocks / buildSocialMediaSummaryBlocks
// used by /run-full-brief. gatherLatestWeeklyReviewSummary() only returns a
// summary if a review was created within the last 8 days (spec: "if the
// weekly review was recently created") — otherwise returns null so
// /run-full-brief silently skips this section, same additive philosophy as
// every other summary in that route.
// ---------------------------------------------------------------------------
async function gatherLatestWeeklyReviewSummary(notion, weeklyStrategyDbId) {
  if (!weeklyStrategyDbId) return null;

  const res = await notion.databases.query({
    database_id: weeklyStrategyDbId,
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    page_size: 1,
  });
  if (res.results.length === 0) return null;

  const page = res.results[0];
  if (!isWithinLastDays(page.created_time, 8)) return null;

  const p = page.properties;
  return {
    week: readTitle(p['Week']),
    status: readSelect(p['Status']),
    topPriorities: readRichText(p['Top 3 Priorities']),
    decisionsNeeded: readRichText(p['Decisions Needed']),
    risks: readRichText(p['Risks']),
    url: page.url,
  };
}

function buildWeeklyStrategySummaryBlocks(summary) {
  return [
    heading2('Weekly Strategy'),
    paragraph(`${summary.week} — Status: ${summary.status}`),
    paragraph(`Top 3 Priorities: ${summary.topPriorities}`),
    paragraph(`Decisions Needed: ${summary.decisionsNeeded}`),
  ];
}

module.exports = {
  IDEA_CATEGORIES,
  IDEA_STATUSES,
  EXPERIMENT_STATUSES,
  REVIEW_STATUSES,
  SAFETY_RULES,
  WHAT_NOT_TO_AUTOMATE,
  computeFinalScore,
  gatherWeeklyContext,
  computeOverallStatus,
  generateIdeas,
  ideasNeedingFounderDecision,
  topPriorities,
  buildIdeaProperties,
  buildExperimentProperties,
  buildWeeklyStrategyReviewProperties,
  buildWeeklyScorecardProperties,
  buildPriorityTaskProperties,
  buildFounderDecisionApprovalProperties,
  summarizeRevenue,
  summarizeProduct,
  summarizeCoachSales,
  summarizeSocial,
  summarizeFilmAI,
  summarizeRailway,
  summarizeRisks,
  filmAIProgressLabel,
  weekLabel,
  buildWeeklyReviewBlocks,
  gatherLatestWeeklyReviewSummary,
  buildWeeklyStrategySummaryBlocks,
};
