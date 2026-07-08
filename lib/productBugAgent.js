// Adaptiv Athletics — Product / Bug Agent
//
// Step 7. Collects and ranks bugs, beta feedback, app store issues,
// onboarding confusion, coach/athlete complaints, feature requests, and
// Film AI prep tasks. Writes structured rows into the Notion "Product Bugs"
// and "Beta Feedback" databases, creates a Notion "Tasks" row for
// Critical/High severity bugs, and creates a Notion "Approvals" row for
// Critical severity bugs. Also builds the "Product / Bug Agent" section of
// the Daily Brief from whatever is currently open in those two databases.
//
// Rules (per Step 7C spec — enforced by what this module does NOT do):
//   - Never changes app code.
//   - Never closes/resolves a bug automatically (Status is always left at
//     "New" on write — a human moves it through Triaged/In Progress/etc.).
//   - Never deploys anything.
//   - Never deletes user feedback.
//   - Only ever creates Tasks/Approvals — recommendations, not actions.
//   - Never includes private user data in SMS (this module doesn't touch
//     SMS directly; server.js only folds the Notion-safe summary text
//     built here into the brief, same as Sales/Railway sections).

// ---------------------------------------------------------------------------
// Priority score formula (Step 7C)
// ---------------------------------------------------------------------------
const SEVERITY_BASE_SCORES = {
  Critical: 100,
  High: 75,
  Medium: 40,
  Low: 15,
};

const FLAG_MODIFIERS = {
  blocksSignup: 25,
  blocksPayment: 25,
  blocksCoachDashboard: 20,
  blocksWorkoutCompletion: 15,
  blocksOnboarding: 15,
  affectsMultipleUsers: 15,
  appStoreRisk: 25,
  filmAIBlocker: 20,
};

const VALID_SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
const VALID_TYPES = [
  'Bug',
  'Feature Request',
  'UX Issue',
  'App Store Issue',
  'Film AI Task',
  'Coach Feedback',
  'Athlete Feedback',
];
const VALID_SOURCES = ['Founder', 'Beta Tester', 'Coach', 'Athlete', 'App Store', 'Google Play', 'Railway', 'Daily Brief'];
const VALID_USER_ROLES = ['Athlete', 'Coach', 'Admin', 'Unknown'];

const VALID_FEEDBACK_ROLES = ['Athlete', 'Coach', 'Admin', 'Beta Tester'];
const VALID_PAIN_LEVELS = ['Low', 'Medium', 'High'];

function computePriorityScore(severity, flags = {}) {
  const base = SEVERITY_BASE_SCORES[severity] ?? 0;
  let modifierTotal = 0;
  for (const [flagName, modifier] of Object.entries(FLAG_MODIFIERS)) {
    if (flags && flags[flagName]) modifierTotal += modifier;
  }
  return base + modifierTotal;
}

function activeFlagNames(flags = {}) {
  return Object.keys(FLAG_MODIFIERS).filter((name) => flags && flags[name]);
}

// ---------------------------------------------------------------------------
// Validation (no external dependency — this service has no Zod, matching
// the rest of adaptiv-automation-hub's existing routes)
// ---------------------------------------------------------------------------
function validateBugInput(body) {
  const errors = [];
  const b = body || {};

  if (!b.title || typeof b.title !== 'string' || !b.title.trim()) {
    errors.push('title is required.');
  }
  if (!b.severity || !VALID_SEVERITIES.includes(b.severity)) {
    errors.push(`severity is required and must be one of: ${VALID_SEVERITIES.join(', ')}.`);
  }
  if (b.type && !VALID_TYPES.includes(b.type)) {
    errors.push(`type must be one of: ${VALID_TYPES.join(', ')}.`);
  }
  if (b.source && !VALID_SOURCES.includes(b.source)) {
    errors.push(`source must be one of: ${VALID_SOURCES.join(', ')}.`);
  }
  if (b.userRole && !VALID_USER_ROLES.includes(b.userRole)) {
    errors.push(`userRole must be one of: ${VALID_USER_ROLES.join(', ')}.`);
  }
  if (b.flags && typeof b.flags !== 'object') {
    errors.push('flags must be an object of booleans.');
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    normalized: {
      title: b.title.trim(),
      type: b.type || 'Bug',
      severity: b.severity,
      source: b.source || 'Founder',
      screen: b.screen || '',
      userRole: b.userRole || 'Unknown',
      reproSteps: b.reproSteps || '',
      expected: b.expected || '',
      actual: b.actual || '',
      notes: b.notes || '',
      flags: b.flags || {},
    },
  };
}

function validateFeedbackInput(body) {
  const errors = [];
  const b = body || {};

  if (!b.feedback || typeof b.feedback !== 'string' || !b.feedback.trim()) {
    errors.push('feedback is required.');
  }
  if (b.role && !VALID_FEEDBACK_ROLES.includes(b.role)) {
    errors.push(`role must be one of: ${VALID_FEEDBACK_ROLES.join(', ')}.`);
  }
  if (b.painLevel && !VALID_PAIN_LEVELS.includes(b.painLevel)) {
    errors.push(`painLevel must be one of: ${VALID_PAIN_LEVELS.join(', ')}.`);
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    normalized: {
      feedback: b.feedback.trim(),
      user: b.user || '',
      role: b.role || 'Athlete',
      area: b.area || '',
      painLevel: b.painLevel || 'Medium',
      actionNeeded: b.actionNeeded || '',
    },
  };
}

// ---------------------------------------------------------------------------
// Notion row builders — write shape (used with notion.pages.create)
// ---------------------------------------------------------------------------

// Product Bugs database row. Status is always written as "New" — this
// module never advances or closes a bug automatically.
function buildBugRowProperties(bug, priorityScore) {
  const dateLabel = new Date().toISOString().split('T')[0];
  const flagsText = activeFlagNames(bug.flags).join(', ');
  const notes = [bug.notes, flagsText ? `Flags: ${flagsText}` : ''].filter(Boolean).join(' | ');

  const properties = {
    'Bug / Issue': { title: [{ text: { content: bug.title } }] },
    Type: { select: { name: bug.type } },
    Severity: { select: { name: bug.severity } },
    Status: { select: { name: 'New' } },
    Source: { select: { name: bug.source } },
    Screen: { rich_text: [{ text: { content: bug.screen } }] },
    'User Role': { select: { name: bug.userRole } },
    'Repro Steps': { rich_text: [{ text: { content: bug.reproSteps } }] },
    Expected: { rich_text: [{ text: { content: bug.expected } }] },
    Actual: { rich_text: [{ text: { content: bug.actual } }] },
    'Priority Score': { number: priorityScore },
    Created: { date: { start: dateLabel } },
    Notes: { rich_text: [{ text: { content: notes || 'None' } }] },
  };

  return properties;
}

// Beta Feedback database row. Status is always written as "New".
function buildFeedbackRowProperties(feedback) {
  const dateLabel = new Date().toISOString().split('T')[0];

  return {
    Feedback: { title: [{ text: { content: feedback.feedback } }] },
    User: { rich_text: [{ text: { content: feedback.user } }] },
    Role: { select: { name: feedback.role } },
    Area: feedback.area ? { select: { name: feedback.area } } : { select: null },
    'Pain Level': { select: { name: feedback.painLevel } },
    Status: { select: { name: 'New' } },
    'Action Needed': { rich_text: [{ text: { content: feedback.actionNeeded } }] },
    Created: { date: { start: dateLabel } },
  };
}

// Tasks database row. Only ever created for Critical/High severity bugs
// (Step 7C item 8). Status starts at "To Do" — a human moves it forward.
function buildBugTaskProperties(bug) {
  const dateLabel = new Date().toISOString().split('T')[0];

  return {
    Name: { title: [{ text: { content: `Fix: ${bug.title}` } }] },
    Status: { select: { name: 'To Do' } },
    Priority: { select: { name: bug.severity } },
    'Source Item': { rich_text: [{ text: { content: `${bug.type} — ${bug.title} (Product/Bug Agent)` } }] },
    Created: { date: { start: dateLabel } },
  };
}

// Approvals database row. Only ever created for Critical severity bugs
// (Step 7C item 9) — same shape as the Revenue/Railway agents' approvals.
function buildCriticalApprovalProperties(bug) {
  const flagsText = activeFlagNames(bug.flags).join(', ');
  const notes =
    `Critical product issue: "${bug.title}" (${bug.type}, source: ${bug.source}).` +
    (bug.screen ? ` Screen: ${bug.screen}.` : '') +
    (flagsText ? ` Flags: ${flagsText}.` : '') +
    ' Generated by Product/Bug Agent — no code changed, no deploy performed.';

  return {
    Action: { title: [{ text: { content: 'Review critical product issue' } }] },
    Agent: { select: { name: 'Product/Bug Agent' } },
    Risk: { select: { name: 'High' } },
    Status: { select: { name: 'Needs Approval' } },
    Notes: { rich_text: [{ text: { content: notes } }] },
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

function readNumber(prop) {
  return prop && typeof prop.number === 'number' ? prop.number : null;
}

function readRichText(prop) {
  if (!prop || !prop.rich_text || prop.rich_text.length === 0) return '';
  return prop.rich_text.map((t) => t.plain_text || '').join('');
}

// ---------------------------------------------------------------------------
// Triage / daily-brief summary — read-only. Queries the current state of
// Product Bugs + Beta Feedback and produces the Step 7F/7G summary. Never
// writes anything itself (ranking + recommendations only, per the rules).
// ---------------------------------------------------------------------------
const OPEN_BUG_STATUSES = ['New', 'Triaged', 'In Progress', 'Blocked'];
const REPEAT_FEEDBACK_THRESHOLD = 3;

async function gatherProductBugSummary(notion, { productBugsDbId, betaFeedbackDbId }) {
  const [bugsResponse, feedbackResponse] = await Promise.all([
    notion.databases.query({ database_id: productBugsDbId, page_size: 100 }),
    notion.databases.query({ database_id: betaFeedbackDbId, page_size: 100 }),
  ]);

  const bugs = bugsResponse.results.map((page) => ({
    id: page.id,
    url: page.url,
    title: readTitle(page.properties['Bug / Issue']),
    type: readSelect(page.properties['Type']),
    severity: readSelect(page.properties['Severity']),
    status: readSelect(page.properties['Status']),
    source: readSelect(page.properties['Source']),
    priorityScore: readNumber(page.properties['Priority Score']) ?? 0,
  }));

  const feedbackItems = feedbackResponse.results.map((page) => ({
    id: page.id,
    url: page.url,
    feedback: readTitle(page.properties['Feedback']),
    area: readSelect(page.properties['Area']),
    painLevel: readSelect(page.properties['Pain Level']),
    status: readSelect(page.properties['Status']),
  }));

  const openBugs = bugs.filter((b) => OPEN_BUG_STATUSES.includes(b.status));
  const criticalBugs = openBugs.filter((b) => b.severity === 'Critical');
  const highBugs = openBugs.filter((b) => b.severity === 'High');
  const filmAIBlockers = openBugs.filter((b) => b.type === 'Film AI Task');
  const newFeedback = feedbackItems.filter((f) => f.status === 'New');

  // Rank open bugs by priority score, highest first (Step 7C item 10).
  const rankedOpenBugs = [...openBugs].sort((a, b) => b.priorityScore - a.priorityScore);

  // Repeated-feedback detection (Step 7E): if 3+ open feedback items share
  // the same Area, recommend a UX fix for that area instead of just the
  // single highest-priority bug.
  const areaCounts = {};
  for (const f of feedbackItems) {
    if (!f.area) continue;
    areaCounts[f.area] = (areaCounts[f.area] || 0) + 1;
  }
  const repeatedAreas = Object.entries(areaCounts)
    .filter(([, count]) => count >= REPEAT_FEEDBACK_THRESHOLD)
    .sort((a, b) => b[1] - a[1]);

  let recommendedFixToday = 'Nothing urgent open — no Critical/High bugs and no repeated feedback pattern.';
  if (rankedOpenBugs.length > 0 && rankedOpenBugs[0].priorityScore >= SEVERITY_BASE_SCORES.High) {
    recommendedFixToday = `${rankedOpenBugs[0].title} (Priority Score ${rankedOpenBugs[0].priorityScore}, ${rankedOpenBugs[0].severity})`;
  } else if (repeatedAreas.length > 0) {
    recommendedFixToday = `Recurring UX pain in "${repeatedAreas[0][0]}" — ${repeatedAreas[0][1]} beta feedback items so far.`;
  }

  // Status rules (Step 7F).
  const hasBlockerSignal = criticalBugs.some(
    (b) => b.type === 'App Store Issue' || (b.title || '').toLowerCase().match(/payment|signup|sign up|outage/)
  );
  let status = 'Green';
  if (criticalBugs.length > 0 || hasBlockerSignal) {
    status = 'Red';
  } else if (highBugs.length > 0 || repeatedAreas.length > 0) {
    status = 'Yellow';
  }

  return {
    status,
    criticalBugs,
    highBugs,
    filmAIBlockers,
    newFeedbackCount: newFeedback.length,
    recommendedFixToday,
    rankedOpenBugs,
    repeatedAreas,
  };
}

// Step 7F: Notion blocks for the "Product / Bug Agent" section of the Daily
// Brief. tasksCreatedCount is passed in by the caller (server.js) since only
// it knows how many Tasks rows were created during this specific run.
function buildProductBugSummaryBlocks(summary, tasksCreatedCount = 0) {
  return [
    heading2('Product / Bug Agent'),
    paragraph(`Status: ${summary.status}`),
    boldParagraph('Critical Bugs:'),
    ...bulletedList(summary.criticalBugs.length > 0 ? summary.criticalBugs.map((b) => `${b.title} (Score ${b.priorityScore})`) : ['None']),
    boldParagraph('High Priority Bugs:'),
    ...bulletedList(summary.highBugs.length > 0 ? summary.highBugs.map((b) => `${b.title} (Score ${b.priorityScore})`) : ['None']),
    paragraph(`New Feedback: ${summary.newFeedbackCount}`),
    paragraph(`Recommended Fix Today: ${summary.recommendedFixToday}`),
    boldParagraph('Film AI Blockers:'),
    ...bulletedList(summary.filmAIBlockers.length > 0 ? summary.filmAIBlockers.map((b) => b.title) : ['None']),
    paragraph(`Tasks Created: ${tasksCreatedCount}`),
  ];
}

// ---------------------------------------------------------------------------
// Minimal Notion block builders (same self-contained pattern as
// railwayHealthAgent.js / stripeRevenueAgent.js)
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
  SEVERITY_BASE_SCORES,
  FLAG_MODIFIERS,
  VALID_SEVERITIES,
  VALID_TYPES,
  VALID_SOURCES,
  VALID_USER_ROLES,
  VALID_FEEDBACK_ROLES,
  VALID_PAIN_LEVELS,
  computePriorityScore,
  validateBugInput,
  validateFeedbackInput,
  buildBugRowProperties,
  buildFeedbackRowProperties,
  buildBugTaskProperties,
  buildCriticalApprovalProperties,
  gatherProductBugSummary,
  buildProductBugSummaryBlocks,
};
