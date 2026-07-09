// Adaptiv Athletics — Film AI Build Team (Planning Agent)
//
// Step 8. PLANNING ONLY. This module does not run any computer vision,
// does not touch real athlete video, and does not connect to production
// user data. Its entire job is to stand up the roadmap/task infrastructure
// for the volleyball-hitting MVP pipeline (upload -> detect movement ->
// analyze hitting mechanics -> score technique -> generate report ->
// suggest drills -> save to athlete profile/Notion/database) so a human
// build team can execute against it, and to report on the state of that
// roadmap from Notion.
//
// Hard rules (Step 8H — do not remove or weaken):
//   - No real athlete video uploads or storage until a privacy review,
//     file size limits, video deletion policy, terms language, coach/
//     athlete consent, and a secure storage plan are all in place. Film AI
//     touches FERPA-flagged data per Adaptiv's business strategy — this is
//     a standing compliance gate, not a one-time checkbox.
//   - Never creates deployment actions.
//   - Never writes to a "real" video storage bucket — there isn't one
//     configured, and this module has no code path that could reach one.
//   - Only ever creates/reads Notion rows (Film AI Roadmap, Agent Reports).
//     No app code changes, no model training, no inference.
//
// Notion databases used:
//   - Film AI Roadmap: Task (title), Agent (select), Status (select),
//     Priority (select), Feature Area (select), Sport (select),
//     Notes (rich_text), Due Date (date)
//   - Agent Reports: Name (title), Agent (select), Date (date),
//     Summary (rich_text)
//   - Film AI Test Clips exists as a schema for the eventual QA/demo phase
//     (Clip, Sport, Skill, Angle, Lighting, Result, Confidence, Notes) but
//     is intentionally never written to by this module — no clip has been
//     reviewed for privacy compliance yet.

// ---------------------------------------------------------------------------
// Valid select-field values (must match the live Notion schema exactly)
// ---------------------------------------------------------------------------
const VALID_AGENTS = [
  'Film AI Product Lead',
  'Computer Vision Engineer',
  'Volleyball Technique Analyst',
  'Film AI QA Agent',
  'Film AI Demo Agent',
];

const VALID_STATUSES = ['Backlog', 'Ready', 'In Progress', 'Blocked', 'Testing', 'Done'];
const VALID_PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
const VALID_FEATURE_AREAS = [
  'Upload',
  'Pose Detection',
  'Technique Scoring',
  'Report Generation',
  'Database Save',
  'Coach View',
  'Athlete View',
  'Demo',
];
const VALID_SPORTS = ['Volleyball', 'All Sports'];

const OPEN_STATUSES = ['Backlog', 'Ready', 'In Progress', 'Blocked', 'Testing'];

// ---------------------------------------------------------------------------
// MVP task set (Step 8F) — one task per stage of the volleyball hitting
// pipeline: upload -> detect movement -> analyze hitting mechanics ->
// score technique -> generate report -> suggest drills -> save results.
// This is planning scaffolding only — none of these tasks are "done" by
// this module. A human build team executes them; this module just files
// and tracks them in Notion.
// ---------------------------------------------------------------------------
const MVP_TASKS = [
  {
    task: 'Build clip upload flow (web + mobile)',
    agent: 'Film AI Product Lead',
    priority: 'Critical',
    featureArea: 'Upload',
    sport: 'Volleyball',
    notes:
      'Athlete/coach selects a short volleyball hitting clip and starts an upload. ' +
      'Acceptance: file-size cap enforced client-side and server-side; only video ' +
      'MIME types accepted; upload shows progress + clear success/error state; no ' +
      'clip is stored anywhere until the privacy gate below is cleared. ' +
      'BLOCKER: privacy review, consent language (coach + athlete, and parent/guardian ' +
      'for minors), video deletion policy, and secure storage plan must all be signed ' +
      'off before this task can move past "Ready" — see Step 8H.',
  },
  {
    task: 'Detect athlete movement / pose in clip',
    agent: 'Computer Vision Engineer',
    priority: 'Critical',
    featureArea: 'Pose Detection',
    sport: 'Volleyball',
    notes:
      'Run pose/movement detection across the clip to isolate the hitting sequence ' +
      '(approach, plant, jump, arm swing, contact, landing). Acceptance: pipeline ' +
      'design doc names the specific pose-detection approach and evaluation dataset; ' +
      'a "Clip Quality" (Good/Medium/Poor) and numeric confidence output are defined. ' +
      'BLOCKER: depends on Task 1 (upload) being cleared for real clips; can be ' +
      'prototyped against synthetic/consented test footage only until then.',
  },
  {
    task: 'Analyze hitting mechanics (approach, plant, jump, arm swing, contact, landing)',
    agent: 'Volleyball Technique Analyst',
    priority: 'Critical',
    featureArea: 'Technique Scoring',
    sport: 'Volleyball',
    notes:
      'Define the volleyball-specific mechanics checklist and what "good"/"needs work" ' +
      'looks like at each of the six phases. Acceptance: written rubric reviewed by a ' +
      'volleyball coach/SME for each phase, feeding directly into the report\'s ' +
      '"Key Mechanics" section.',
  },
  {
    task: 'Score technique (0-100 + confidence)',
    agent: 'Volleyball Technique Analyst',
    priority: 'High',
    featureArea: 'Technique Scoring',
    sport: 'Volleyball',
    notes:
      'Turn the mechanics rubric into a single 0-100 Technique Score plus a 0-100 ' +
      'confidence value, tied to Clip Quality. Acceptance: scoring formula documented ' +
      'and reproducible from the mechanics checklist; low Clip Quality caps max ' +
      'confidence so the report never overstates certainty from a bad angle.',
  },
  {
    task: 'Generate Film AI Report',
    agent: 'Film AI Product Lead',
    priority: 'High',
    featureArea: 'Report Generation',
    sport: 'Volleyball',
    notes:
      'Produce the report in the fixed template: Sport, Skill, Clip Quality, ' +
      'Confidence, Technique Score, What Looked Good, What Needs Work, Key Mechanics, ' +
      'Suggested Drills, Coach Notes, Disclaimer. Acceptance: template renders ' +
      'correctly with placeholder data end-to-end; disclaimer line ("This is a ' +
      'development tool, not a medical or injury diagnosis.") is always present and ' +
      'cannot be omitted by any code path.',
  },
  {
    task: 'Suggest drills (1-3 per report)',
    agent: 'Volleyball Technique Analyst',
    priority: 'Medium',
    featureArea: 'Report Generation',
    sport: 'Volleyball',
    notes:
      'Map each "What Needs Work" finding to 1-3 concrete, safe practice drills. ' +
      'Acceptance: drill library covers every mechanics-checklist failure mode from ' +
      'Task 3; no drill recommends anything requiring medical clearance to attempt.',
  },
  {
    task: 'Save results to athlete profile / Notion / database',
    agent: 'Computer Vision Engineer',
    priority: 'High',
    featureArea: 'Database Save',
    sport: 'Volleyball',
    notes:
      'Design the schema for persisting a Film AI Report against an athlete profile ' +
      '(Adaptiv Postgres via Prisma) and optionally logging a summary row in Notion ' +
      'for coach visibility. Acceptance: schema/migration reviewed; includes a ' +
      'deletion path for the underlying clip per the retention policy. ' +
      'BLOCKER: no real athlete video or report may be persisted until the privacy ' +
      'gate (Step 8H) is cleared — this task builds the schema/plumbing only, using ' +
      'synthetic test data.',
  },
];

// ---------------------------------------------------------------------------
// Notion row builders — write shape (used with notion.pages.create)
// ---------------------------------------------------------------------------

// Film AI Roadmap database row.
function buildRoadmapTaskProperties(taskDef, { status = 'Backlog', dueDate = null } = {}) {
  const properties = {
    Task: { title: [{ text: { content: taskDef.task } }] },
    Agent: { select: { name: taskDef.agent } },
    Status: { select: { name: status } },
    Priority: { select: { name: taskDef.priority } },
    'Feature Area': { select: { name: taskDef.featureArea } },
    Sport: { select: { name: taskDef.sport } },
    Notes: { rich_text: [{ text: { content: taskDef.notes } }] },
  };

  if (dueDate) {
    properties['Due Date'] = { date: { start: dueDate } };
  }

  return properties;
}

// Agent Reports database row. Used any time a Film AI sub-agent files a
// read-only report (e.g. POST /run-film-ai-planning).
function buildAgentReportProperties({ agent, summary }) {
  const dateLabel = new Date().toISOString().split('T')[0];

  return {
    Name: { title: [{ text: { content: `${agent} — ${dateLabel}` } }] },
    Agent: { select: { name: agent } },
    Date: { date: { start: dateLabel } },
    Summary: { rich_text: [{ text: { content: summary } }] },
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

// ---------------------------------------------------------------------------
// Planning summary — read-only. Queries the current state of Film AI
// Roadmap and produces a status rollup. Never writes anything itself.
// ---------------------------------------------------------------------------
async function gatherFilmAISummary(notion, { roadmapDbId }) {
  const roadmapResponse = await notion.databases.query({ database_id: roadmapDbId, page_size: 100 });

  const tasks = roadmapResponse.results.map((page) => ({
    id: page.id,
    url: page.url,
    task: readTitle(page.properties['Task']),
    agent: readSelect(page.properties['Agent']),
    status: readSelect(page.properties['Status']),
    priority: readSelect(page.properties['Priority']),
    featureArea: readSelect(page.properties['Feature Area']),
  }));

  const openTasks = tasks.filter((t) => OPEN_STATUSES.includes(t.status));
  const blockedTasks = tasks.filter((t) => t.status === 'Blocked');
  const doneTasks = tasks.filter((t) => t.status === 'Done');
  const criticalOpen = openTasks.filter((t) => t.priority === 'Critical');

  const tasksByAgent = {};
  for (const t of openTasks) {
    if (!t.agent) continue;
    tasksByAgent[t.agent] = (tasksByAgent[t.agent] || 0) + 1;
  }

  let nextUp = 'No open MVP tasks — run POST /create-film-ai-mvp-plan to seed the roadmap.';
  if (criticalOpen.length > 0) {
    nextUp = criticalOpen[0].task;
  } else if (openTasks.length > 0) {
    nextUp = openTasks[0].task;
  }

  let status = 'Green';
  if (blockedTasks.length > 0 && criticalOpen.length > 0) {
    status = 'Red';
  } else if (blockedTasks.length > 0 || criticalOpen.length > 0) {
    status = 'Yellow';
  }

  return {
    status,
    totalTasks: tasks.length,
    openCount: openTasks.length,
    blockedCount: blockedTasks.length,
    doneCount: doneTasks.length,
    criticalOpen,
    blockedTasks,
    tasksByAgent,
    nextUp,
    privacyGateCleared: false, // Hard-coded false — no code path in this module flips this.
  };
}

// Notion blocks for the "Film AI Build Team" section of the Daily Brief.
function buildFilmAISummaryBlocks(summary) {
  return [
    heading2('Film AI Build Team'),
    paragraph(`Status: ${summary.status} (planning only — no CV model running yet)`),
    paragraph(`Roadmap: ${summary.doneCount} done / ${summary.openCount} open / ${summary.totalTasks} total`),
    boldParagraph('Blocked Tasks:'),
    ...bulletedList(summary.blockedTasks.length > 0 ? summary.blockedTasks.map((t) => t.task) : ['None']),
    boldParagraph('Critical Open Tasks:'),
    ...bulletedList(summary.criticalOpen.length > 0 ? summary.criticalOpen.map((t) => t.task) : ['None']),
    paragraph(`Next Up: ${summary.nextUp}`),
    paragraph('Privacy gate cleared for real athlete video: No — see Step 8H checklist before any production use.'),
  ];
}

// Builds the read-only planning-report summary text used for an Agent
// Reports row (POST /run-film-ai-planning). Kept separate from the Notion
// property builder so server.js can log/inspect the plain string too.
function buildPlanningReportSummary(summary) {
  const lines = [
    `Film AI roadmap status: ${summary.status}.`,
    `${summary.doneCount} done, ${summary.openCount} open, ${summary.totalTasks} total tasks.`,
    summary.blockedTasks.length > 0
      ? `Blocked: ${summary.blockedTasks.map((t) => t.task).join('; ')}.`
      : 'No blocked tasks.',
    summary.criticalOpen.length > 0
      ? `Critical open: ${summary.criticalOpen.map((t) => t.task).join('; ')}.`
      : 'No open Critical-priority tasks.',
    `Next up: ${summary.nextUp}`,
    'No CV model, deployment, or real athlete video was touched by this report — planning/read-only only.',
  ];
  return lines.join(' ');
}

// ---------------------------------------------------------------------------
// Minimal Notion block builders (same self-contained pattern as
// productBugAgent.js / railwayHealthAgent.js / stripeRevenueAgent.js)
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
  VALID_AGENTS,
  VALID_STATUSES,
  VALID_PRIORITIES,
  VALID_FEATURE_AREAS,
  VALID_SPORTS,
  MVP_TASKS,
  buildRoadmapTaskProperties,
  buildAgentReportProperties,
  gatherFilmAISummary,
  buildFilmAISummaryBlocks,
  buildPlanningReportSummary,
};
