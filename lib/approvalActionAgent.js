// Adaptiv Athletics — Approval Action Agent
//
// Step 11. This is the first module that is allowed to take a real,
// external, irreversible-ish action — but ONLY after a human has already
// approved that exact action in Notion. Every other agent in this codebase
// (Steps 3-10) only reads data and drafts/recommends; nothing before this
// module has ever sent a message, created an outside record, or changed a
// CRM field on its own.
//
// Flow: recommend -> draft -> approval request (Notion Approvals row,
// Status = "Needs Approval") -> a human reviews and flips Status to
// "Approved" directly in Notion -> POST /run-approved-actions scans for
// Status = "Approved" rows and, only for the six whitelisted action types
// below, executes the action and writes the result back to Notion
// (Status -> "Executed" or "Failed", Result / Error / Executed At filled
// in). No agent may directly post/email/text/restart/redeploy/refund/
// delete/change billing/change DB data/change secrets unless the specific
// action was explicitly approved AND is in SUPPORTED_ACTION_TYPES below.
//
// SAFETY RULES (Step 11 — do not remove or weaken). These are enforced IN
// CODE, not just documented, by the functions named alongside each rule:
//   1. Never execute a row whose Status isn't exactly "Approved"
//      -> runApprovedActions() only queries Status = "Approved"; executeApprovedAction()
//         re-checks Status defensively before doing anything.
//   2. Never execute a Critical-risk action, ever
//      -> checkRiskAllowed() hard-blocks "Critical" unconditionally.
//   3. Never execute a High-risk action unless explicitly enabled
//      -> there is no v1 enable flag for High risk, so checkRiskAllowed()
//         blocks "High" unconditionally too (see ALLOWED_RISK_LEVELS).
//   4. Never refund a payment, cancel a subscription, delete data, modify
//      Stripe, change production env vars, post to social, or DM anyone
//      automatically
//      -> SUPPORTED_ACTION_TYPES is a closed whitelist of exactly 6 action
//         types (none of the above); resolveActionType() rejects anything
//         not in that whitelist before any executor runs, regardless of
//         what Risk/Tool the approval row claims.
//   5. Never send an email/SMS to anyone except the recipient inside the
//      approved payload (and for founder-only actions, never anyone but
//      the founder)
//      -> executeSendFounderEmail()/executeSendFounderSms() always send to
//         process.env.FOUNDER_EMAIL / FOUNDER_PHONE_NUMBER, ignoring any
//         "to" field a payload might contain. executeSendCoachEmail() uses
//         the payload's "to" address and nothing else (no CC/BCC support).
//   6. Log every execution result back to Notion; on failure mark
//      Status = "Failed" and write Error
//      -> executeApprovedAction() always calls markExecuted()/markFailed()
//         before returning, even when an executor throws.
//   7. Unknown/unsupported action types must never execute
//      -> resolveActionType() returns null for anything outside
//         SUPPORTED_ACTION_TYPES; executeApprovedAction() marks those rows
//         Failed with an explicit "Unsupported action type" error and never
//         calls an executor.
//   8. Master + per-tool kill switches
//      -> isApprovalActionsEnabled() requires both APPROVAL_ACTIONS_ENABLED
//         = "true" and APPROVAL_EXECUTION_MODE = "manual-safe"; each action
//         type also requires its own ENABLE_*_ACTIONS flag = "true"
//         (checked in executeApprovedAction() via SUPPORTED_ACTION_TYPES[...].flagVar).
//         ENABLE_RAILWAY_ACTIONS / ENABLE_STRIPE_ACTIONS / ENABLE_SOCIAL_ACTIONS
//         are read but never referenced by any executor in this file — there
//         is no Railway/Stripe/Social action type in v1, by design.
//
// Notion databases used:
//   - Approvals (read + write): Action (title), Agent (select), Risk (select),
//     Status (select), Tool (select), Payload (rich_text, JSON string),
//     "Approved By" (rich_text), "Approved At" (date), "Executed At" (date),
//     Result (rich_text), Error (rich_text)
//   - Tasks (write, CREATE_NOTION_TASK only): Name (title), Status (select),
//     Priority (select), "Source Item" (rich_text), Created (date)
//   - Coach CRM (write, UPDATE_COACH_CRM_STATUS only): Stage (select),
//     "Next Follow-Up" (date)
//   - Coach Outreach (write, MARK_OUTREACH_SENT only): Status (select),
//     "Sent Date" (date)
//
// Step 11B rulebook — the ONLY action types allowed to execute in v1:
//   CREATE_NOTION_TASK, SEND_FOUNDER_EMAIL, SEND_FOUNDER_SMS,
//   SEND_COACH_EMAIL, UPDATE_COACH_CRM_STATUS, MARK_OUTREACH_SENT.
// Explicitly NOT enabled yet: Railway restart/redeploy, Stripe actions,
// Social actions. Keep ENABLE_RAILWAY_ACTIONS / ENABLE_STRIPE_ACTIONS /
// ENABLE_SOCIAL_ACTIONS set to "false" in Railway until this has run safely
// for a while — see README.

const { google } = require('googleapis');
const googleDeliveryAgent = require('./googleDeliveryAgent');
const smsDeliveryAgent = require('./smsDeliveryAgent');
const coachSalesAgent = require('./coachSalesAgent');

// ---------------------------------------------------------------------------
// Valid select-field values (must match the live Notion Approvals schema)
// ---------------------------------------------------------------------------
const VALID_TOOLS = [
  'Notion',
  'Gmail',
  'Twilio',
  'Railway',
  'Stripe',
  'Google Docs',
  'Social',
  'Coach CRM',
  'Product/Bug',
  'Film AI',
];
const VALID_RISKS = ['Low', 'Medium', 'High', 'Critical'];
const VALID_STATUSES = ['Needs Approval', 'Approved', 'Rejected', 'Executed', 'Failed', 'Cancelled'];

// v1 hard cap: nothing above Medium may execute automatically, no matter what
// the approval row's Risk select says and no matter what an action type's
// own baseline risk is. There is no env var that raises this in v1 — raising
// it requires a code change, on purpose.
const ALLOWED_RISK_LEVELS = ['Low', 'Medium'];
const RISK_ORDER = { Low: 1, Medium: 2, High: 3, Critical: 4 };

// ---------------------------------------------------------------------------
// Kill switches
// ---------------------------------------------------------------------------
const APPROVAL_ACTIONS_REQUIRED_ENV_VARS = ['APPROVAL_ACTIONS_ENABLED', 'APPROVAL_EXECUTION_MODE'];

function isApprovalActionsEnabled() {
  const masterOn = (process.env.APPROVAL_ACTIONS_ENABLED || '').trim().toLowerCase() === 'true';
  const modeOk = (process.env.APPROVAL_EXECUTION_MODE || '').trim().toLowerCase() === 'manual-safe';
  return masterOn && modeOk;
}

function isFlagEnabled(envVarName) {
  return (process.env[envVarName] || '').trim().toLowerCase() === 'true';
}

// ---------------------------------------------------------------------------
// Whitelist of executable action types (Step 11B/11D)
// ---------------------------------------------------------------------------
// Each entry: tool (must match the row's Tool select for a clean audit
// trail — mismatches are logged but do not block execution, since Tool is
// informational), baseline risk (used defensively even if the row's own
// Risk field is wrong/missing), and the per-tool env flag that must be
// "true" for this action type to run.
const SUPPORTED_ACTION_TYPES = {
  CREATE_NOTION_TASK: { tool: 'Notion', risk: 'Low', flagVar: 'ENABLE_NOTION_ACTIONS' },
  SEND_FOUNDER_EMAIL: { tool: 'Gmail', risk: 'Low', flagVar: 'ENABLE_EMAIL_ACTIONS' },
  SEND_FOUNDER_SMS: { tool: 'Twilio', risk: 'Medium', flagVar: 'ENABLE_SMS_ACTIONS' },
  SEND_COACH_EMAIL: { tool: 'Gmail', risk: 'Medium', flagVar: 'ENABLE_EMAIL_ACTIONS' },
  UPDATE_COACH_CRM_STATUS: { tool: 'Coach CRM', risk: 'Low', flagVar: 'ENABLE_NOTION_ACTIONS' },
  MARK_OUTREACH_SENT: { tool: 'Coach CRM', risk: 'Low', flagVar: 'ENABLE_NOTION_ACTIONS' },
};

// Payload shapes expected for each action type (documented here so
// /create-test-approval callers and Notion-side approval requesters know
// exactly what JSON to put in the Payload field):
//   CREATE_NOTION_TASK       { type, name, notes?, priority? }
//   SEND_FOUNDER_EMAIL       { type, subject, body }
//   SEND_FOUNDER_SMS         { type, message }
//   SEND_COACH_EMAIL         { type, to, subject, body }
//   UPDATE_COACH_CRM_STATUS  { type, leadId, stage, nextFollowUp? }
//   MARK_OUTREACH_SENT       { type, outreachId }

// ---------------------------------------------------------------------------
// Notion read helpers (pages.query()/pages.retrieve() property shape)
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
function readDate(prop) {
  return prop && prop.date ? prop.date.start : null;
}

function todayIso() {
  return new Date().toISOString().split('T')[0];
}
function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// /create-test-approval — Step 11E/11F test helper. Creates one Approvals
// row directly with whatever Action/Agent/Risk/Status/Tool/Payload is
// passed in, so the safe-action and blocked-critical-action test plans can
// be run end to end without hand-editing Notion. This route never executes
// anything itself — it only ever creates a row (which may already be
// Status = "Approved", the way a human's approval would leave it).
// ---------------------------------------------------------------------------
function validateTestApprovalInput(body) {
  const errors = [];
  const b = body || {};

  if (!b.action || typeof b.action !== 'string' || !b.action.trim()) {
    errors.push('action is required (short title for the Approvals row).');
  }
  if (!b.risk || !VALID_RISKS.includes(b.risk)) {
    errors.push(`risk is required and must be one of: ${VALID_RISKS.join(', ')}`);
  }
  if (!b.tool || !VALID_TOOLS.includes(b.tool)) {
    errors.push(`tool is required and must be one of: ${VALID_TOOLS.join(', ')}`);
  }
  if (b.status && !VALID_STATUSES.includes(b.status)) {
    errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  if (!b.payload || typeof b.payload !== 'object' || Array.isArray(b.payload)) {
    errors.push('payload is required and must be a JSON object.');
  } else if (!b.payload.type || typeof b.payload.type !== 'string') {
    errors.push('payload.type is required (the action type, e.g. "CREATE_NOTION_TASK").');
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    normalized: {
      action: b.action.trim(),
      agent: b.agent || 'Manual Test',
      risk: b.risk,
      tool: b.tool,
      status: b.status || 'Approved',
      payload: b.payload,
      approvedBy: b.approvedBy || 'Founder (manual test)',
    },
  };
}

function buildTestApprovalProperties(input) {
  const properties = {
    Action: { title: [{ text: { content: input.action } }] },
    Agent: { select: { name: input.agent } },
    Risk: { select: { name: input.risk } },
    Tool: { select: { name: input.tool } },
    Status: { select: { name: input.status } },
    Payload: { rich_text: [{ text: { content: JSON.stringify(input.payload) } }] },
  };

  if (input.status === 'Approved') {
    properties['Approved By'] = { rich_text: [{ text: { content: input.approvedBy } }] };
    properties['Approved At'] = { date: { start: nowIso() } };
  }

  return properties;
}

// ---------------------------------------------------------------------------
// Result write-back helpers
// ---------------------------------------------------------------------------
async function markExecuted(notion, pageId, resultText) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      Status: { select: { name: 'Executed' } },
      'Executed At': { date: { start: nowIso() } },
      Result: { rich_text: [{ text: { content: (resultText || '').slice(0, 1900) } }] },
      Error: { rich_text: [] },
    },
  });
}

async function markFailed(notion, pageId, errorText) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      Status: { select: { name: 'Failed' } },
      'Executed At': { date: { start: nowIso() } },
      Error: { rich_text: [{ text: { content: (errorText || '').slice(0, 1900) } }] },
    },
  });
}

// ---------------------------------------------------------------------------
// Executors — one per supported action type. Each returns a short result
// string on success and throws on failure (executeApprovedAction() catches
// and writes the failure back to Notion).
// ---------------------------------------------------------------------------

async function executeCreateNotionTask(notion, payload, env) {
  if (!env.tasksDbId) throw new Error('NOTION_DATABASE_TASKS is not configured.');
  if (!payload.name || typeof payload.name !== 'string') {
    throw new Error('Payload missing required "name" field for CREATE_NOTION_TASK.');
  }

  const page = await notion.pages.create({
    parent: { database_id: env.tasksDbId },
    properties: {
      Name: { title: [{ text: { content: payload.name } }] },
      Status: { select: { name: 'To Do' } },
      Priority: { select: { name: payload.priority || 'Medium' } },
      'Source Item': {
        rich_text: [{ text: { content: payload.notes || 'Created by Approval Action Agent (Step 11).' } }],
      },
      Created: { date: { start: todayIso() } },
    },
  });

  return `Created Notion task "${payload.name}" (${page.url}).`;
}

// Self-contained Gmail sender (reuses the OAuth client googleDeliveryAgent
// already builds from GOOGLE_REFRESH_TOKEN, but does not depend on that
// module's fixed brief-email body/shape).
function base64UrlEncode(str) {
  return Buffer.from(str, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildRawEmail({ to, subject, bodyText }) {
  const message = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset="UTF-8"', '', bodyText].join(
    '\n'
  );
  return base64UrlEncode(message);
}

async function sendGmail({ to, subject, bodyText }) {
  const auth = googleDeliveryAgent.getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildRawEmail({ to, subject, bodyText });
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// Safety rule: always sends to FOUNDER_EMAIL — the payload cannot override
// the recipient, even if it includes a "to" field.
async function executeSendFounderEmail(notion, payload, env) {
  const missing = googleDeliveryAgent.getMissingEnvVars(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'GOOGLE_REFRESH_TOKEN', 'FOUNDER_EMAIL']);
  if (missing.length > 0) throw new Error(`Missing Google/founder email env vars: ${missing.join(', ')}`);
  if (!payload.subject || !payload.body) throw new Error('Payload missing required "subject"/"body" for SEND_FOUNDER_EMAIL.');

  await sendGmail({ to: process.env.FOUNDER_EMAIL, subject: payload.subject, bodyText: payload.body });
  return `Sent email to founder (${process.env.FOUNDER_EMAIL}): "${payload.subject}".`;
}

// Safety rule: always sends to FOUNDER_PHONE_NUMBER via smsDeliveryAgent.sendSms,
// which itself never accepts a recipient override.
async function executeSendFounderSms(notion, payload, env) {
  if (!isFlagEnabled('SMS_ENABLED')) {
    throw new Error('SMS_ENABLED is not "true" — SMS delivery is globally disabled, independent of approval actions.');
  }
  const missing = smsDeliveryAgent.getMissingEnvVars(smsDeliveryAgent.SMS_REQUIRED_ENV_VARS);
  if (missing.length > 0) throw new Error(`Missing Twilio env vars: ${missing.join(', ')}`);
  if (!payload.message || typeof payload.message !== 'string') {
    throw new Error('Payload missing required "message" field for SEND_FOUNDER_SMS.');
  }

  await smsDeliveryAgent.sendSms(payload.message);
  return `Sent SMS to founder (${process.env.FOUNDER_PHONE_NUMBER}).`;
}

// Safety rule: the recipient comes strictly from the approved payload's "to"
// field — nothing else. No CC/BCC, no reading a recipient from Notion.
async function executeSendCoachEmail(notion, payload, env) {
  const missing = googleDeliveryAgent.getMissingEnvVars(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'GOOGLE_REFRESH_TOKEN']);
  if (missing.length > 0) throw new Error(`Missing Google env vars: ${missing.join(', ')}`);
  if (!payload.to || typeof payload.to !== 'string' || !payload.to.includes('@')) {
    throw new Error('Payload missing a valid "to" email address for SEND_COACH_EMAIL.');
  }
  if (!payload.subject || !payload.body) {
    throw new Error('Payload missing required "subject"/"body" for SEND_COACH_EMAIL.');
  }

  await sendGmail({ to: payload.to, subject: payload.subject, bodyText: payload.body });
  return `Sent email to coach (${payload.to}): "${payload.subject}".`;
}

// Updates a Coach CRM lead's Stage / Next Follow-Up. Never allowed to set
// Stage to "Won" — same manual-only rule as lib/coachSalesAgent.js Step 9,
// applied again here since this is a second path that writes to Coach CRM.
async function executeUpdateCoachCrmStatus(notion, payload, env) {
  if (!env.coachCrmDbId) throw new Error('NOTION_DATABASE_COACH_CRM is not configured.');
  if (!payload.leadId || typeof payload.leadId !== 'string') {
    throw new Error('Payload missing required "leadId" for UPDATE_COACH_CRM_STATUS.');
  }
  if (!payload.stage || !coachSalesAgent.VALID_STAGES.includes(payload.stage)) {
    throw new Error(`Payload "stage" must be one of: ${coachSalesAgent.VALID_STAGES.join(', ')}`);
  }
  if (payload.stage === 'Won') {
    throw new Error('Stage cannot be set to "Won" through an approved action — that remains a manual Notion edit.');
  }

  const properties = { Stage: { select: { name: payload.stage } } };
  if (payload.nextFollowUp) {
    properties['Next Follow-Up'] = { date: { start: payload.nextFollowUp } };
  }

  await notion.pages.update({ page_id: payload.leadId, properties });
  return `Updated Coach CRM lead ${payload.leadId} to Stage "${payload.stage}"${payload.nextFollowUp ? ` (Next Follow-Up: ${payload.nextFollowUp})` : ''}.`;
}

// Marks a Coach Outreach row as sent. Status/Sent Date are fixed by this
// executor, not caller-controlled — "mark outreach as sent" only ever means
// exactly that.
async function executeMarkOutreachSent(notion, payload, env) {
  if (!env.coachOutreachDbId) throw new Error('NOTION_DATABASE_COACH_OUTREACH is not configured.');
  if (!payload.outreachId || typeof payload.outreachId !== 'string') {
    throw new Error('Payload missing required "outreachId" for MARK_OUTREACH_SENT.');
  }

  await notion.pages.update({
    page_id: payload.outreachId,
    properties: {
      Status: { select: { name: 'Sent' } },
      'Sent Date': { date: { start: todayIso() } },
    },
  });
  return `Marked Coach Outreach row ${payload.outreachId} as Sent.`;
}

const EXECUTORS = {
  CREATE_NOTION_TASK: executeCreateNotionTask,
  SEND_FOUNDER_EMAIL: executeSendFounderEmail,
  SEND_FOUNDER_SMS: executeSendFounderSms,
  SEND_COACH_EMAIL: executeSendCoachEmail,
  UPDATE_COACH_CRM_STATUS: executeUpdateCoachCrmStatus,
  MARK_OUTREACH_SENT: executeMarkOutreachSent,
};

// ---------------------------------------------------------------------------
// Risk gate (Step 11 hard safety rules #2/#3) — defense in depth, checked
// independently of the SUPPORTED_ACTION_TYPES whitelist above.
// ---------------------------------------------------------------------------
function checkRiskAllowed(declaredRisk, actionTypeRisk) {
  const declaredRank = RISK_ORDER[declaredRisk] || 0;
  const typeRank = RISK_ORDER[actionTypeRisk] || 0;
  const effectiveRisk = declaredRank >= typeRank ? declaredRisk : actionTypeRisk;

  if (!ALLOWED_RISK_LEVELS.includes(effectiveRisk)) {
    if (effectiveRisk === 'Critical') {
      return { allowed: false, effectiveRisk, reason: 'Critical actions are blocked and can never execute automatically.' };
    }
    return {
      allowed: false,
      effectiveRisk,
      reason: `${effectiveRisk}-risk actions are blocked in v1 — no ENABLE flag exists to raise this yet.`,
    };
  }

  return { allowed: true, effectiveRisk, reason: null };
}

// ---------------------------------------------------------------------------
// Main per-row dispatcher
// ---------------------------------------------------------------------------
async function executeApprovedAction(notion, approvalPage, env) {
  const pageId = approvalPage.id;
  const action = readTitle(approvalPage.properties.Action) || '(untitled)';
  const status = readSelect(approvalPage.properties.Status);
  const declaredRisk = readSelect(approvalPage.properties.Risk) || 'Low';
  const payloadText = readRichText(approvalPage.properties.Payload);

  const base = { pageId, action, url: approvalPage.url };

  // Rule #1 — defensive re-check even though the caller already filtered by
  // Status = "Approved".
  if (status !== 'Approved') {
    return { ...base, outcome: 'skipped', reason: `Status is "${status}", not "Approved".` };
  }

  // Master + mode kill switch (rule #8).
  if (!isApprovalActionsEnabled()) {
    const reason = 'Approval actions are disabled (APPROVAL_ACTIONS_ENABLED / APPROVAL_EXECUTION_MODE not set to enabled + "manual-safe").';
    await markFailed(notion, pageId, reason);
    return { ...base, outcome: 'failed', reason };
  }

  // Rules #2/#3 — risk gate on the row's OWN declared Risk, checked before
  // we even look at the payload. A Critical (or High) approval must never
  // execute no matter what action type it claims to be — this is what lets
  // a blocked-critical-action test prove the system doesn't blindly obey
  // approvals, rather than that test merely tripping the whitelist check.
  const declaredRiskCheck = checkRiskAllowed(declaredRisk, 'Low');
  if (!declaredRiskCheck.allowed) {
    await markFailed(notion, pageId, declaredRiskCheck.reason);
    return { ...base, outcome: 'blocked', reason: declaredRiskCheck.reason };
  }

  // Parse payload JSON safely.
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch (err) {
    const reason = `Invalid payload JSON: ${err.message}`;
    await markFailed(notion, pageId, reason);
    return { ...base, outcome: 'failed', reason };
  }

  const actionType = payload && payload.type;
  const spec = actionType ? SUPPORTED_ACTION_TYPES[actionType] : null;

  // Rule #7 — whitelist-only execution.
  if (!spec) {
    const reason = `Unsupported action type "${actionType || '(missing)'}" — only the following may execute: ${Object.keys(SUPPORTED_ACTION_TYPES).join(', ')}.`;
    await markFailed(notion, pageId, reason);
    return { ...base, outcome: 'failed', reason };
  }

  // Rules #2/#3 again — this time combining the row's declared Risk with the
  // action type's own baseline risk (defense in depth; a no-op for all 6
  // whitelisted v1 types today since none of them are High/Critical, but it
  // means a future action type can never quietly ship Low-risk labeled while
  // actually being High/Critical without this catching it).
  const riskCheck = checkRiskAllowed(declaredRisk, spec.risk);
  if (!riskCheck.allowed) {
    await markFailed(notion, pageId, riskCheck.reason);
    return { ...base, outcome: 'blocked', reason: riskCheck.reason };
  }

  // Per-tool flag (rule #8).
  if (!isFlagEnabled(spec.flagVar)) {
    const reason = `${spec.flagVar} is not "true" — ${actionType} is disabled.`;
    await markFailed(notion, pageId, reason);
    return { ...base, outcome: 'failed', reason };
  }

  // Execute. Any thrown error (including bad payload shape) is caught and
  // written back as Status = "Failed" + Error (rule #6).
  try {
    const executor = EXECUTORS[actionType];
    const resultText = await executor(notion, payload, env);
    await markExecuted(notion, pageId, resultText);
    return { ...base, outcome: 'executed', actionType, result: resultText };
  } catch (err) {
    const reason = err.message || String(err);
    console.error(`[approval action agent] Execution failed for "${action}" (${actionType}):`, err);
    await markFailed(notion, pageId, reason);
    return { ...base, outcome: 'failed', actionType, reason };
  }
}

// ---------------------------------------------------------------------------
// Batch runner — POST /run-approved-actions
// ---------------------------------------------------------------------------
async function runApprovedActions(notion, env) {
  const response = await notion.databases.query({
    database_id: env.approvalsDbId,
    filter: { property: 'Status', select: { equals: 'Approved' } },
    page_size: 50,
  });

  const results = [];
  for (const page of response.results) {
    // Sequential on purpose — avoids racing multiple Notion writes to the
    // same page and keeps Railway logs easy to read top-to-bottom.
    // eslint-disable-next-line no-await-in-loop
    const result = await executeApprovedAction(notion, page, env);
    results.push(result);
  }

  return {
    total: results.length,
    executedCount: results.filter((r) => r.outcome === 'executed').length,
    failedCount: results.filter((r) => r.outcome === 'failed').length,
    blockedCount: results.filter((r) => r.outcome === 'blocked').length,
    skippedCount: results.filter((r) => r.outcome === 'skipped').length,
    results,
  };
}

// ---------------------------------------------------------------------------
// Read-only summary — Step 11G Daily Brief section + /run-full-brief.
// Never executes anything; just reads current Approvals state.
// ---------------------------------------------------------------------------
async function gatherApprovalActionSummary(notion, approvalsDbId) {
  const response = await notion.databases.query({ database_id: approvalsDbId, page_size: 100 });
  const today = todayIso();

  const rows = response.results.map((page) => ({
    id: page.id,
    url: page.url,
    action: readTitle(page.properties.Action),
    status: readSelect(page.properties.Status),
    risk: readSelect(page.properties.Risk),
    tool: readSelect(page.properties.Tool),
    error: readRichText(page.properties.Error),
    executedAt: readDate(page.properties['Executed At']),
  }));

  const executedToday = rows.filter((r) => r.status === 'Executed' && r.executedAt && r.executedAt.slice(0, 10) === today);
  const failed = rows.filter((r) => r.status === 'Failed');
  const waiting = rows.filter((r) => r.status === 'Needs Approval');
  const blockedForSafety = failed.filter((r) => (r.error || '').toLowerCase().includes('blocked'));
  const highRiskWaiting = waiting.filter((r) => r.risk === 'High' || r.risk === 'Critical');

  const recommendedFounderReview = [
    ...highRiskWaiting.map((r) => `${r.action} (${r.risk} risk, awaiting approval)`),
    ...failed.slice(0, 5).map((r) => `${r.action} (Failed — ${r.error || 'no error detail'})`),
  ].slice(0, 8);

  let status = 'Green';
  if (highRiskWaiting.length > 0 || failed.length >= 2 || blockedForSafety.length > 0) {
    status = 'Red';
  } else if (waiting.length > 0 || failed.length === 1) {
    status = 'Yellow';
  }

  return {
    status,
    executedTodayCount: executedToday.length,
    failedCount: failed.length,
    waitingCount: waiting.length,
    blockedForSafetyCount: blockedForSafety.length,
    recommendedFounderReview,
  };
}

// Notion blocks for the "Approval Action Agent" section of the Daily Brief.
function buildApprovalActionSummaryBlocks(summary) {
  return [
    heading2('Approval Action Agent'),
    paragraph(`Status: ${summary.status}`),
    paragraph(
      `Executed today: ${summary.executedTodayCount} — Failed: ${summary.failedCount} — Waiting for approval: ${summary.waitingCount} — Blocked for safety: ${summary.blockedForSafetyCount}`
    ),
    boldParagraph('Recommended Founder Review:'),
    ...bulletedList(
      summary.recommendedFounderReview.length > 0
        ? summary.recommendedFounderReview
        : ['Nothing needs review right now.']
    ),
  ];
}

// ---------------------------------------------------------------------------
// Minimal Notion block builders (same self-contained pattern as the other
// lib/*Agent.js modules)
// ---------------------------------------------------------------------------
function heading2(text) {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: text } }] } };
}
function paragraph(text) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: text } }] } };
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
  VALID_TOOLS,
  VALID_RISKS,
  VALID_STATUSES,
  ALLOWED_RISK_LEVELS,
  SUPPORTED_ACTION_TYPES,
  APPROVAL_ACTIONS_REQUIRED_ENV_VARS,
  isApprovalActionsEnabled,
  isFlagEnabled,
  validateTestApprovalInput,
  buildTestApprovalProperties,
  checkRiskAllowed,
  executeApprovedAction,
  runApprovedActions,
  gatherApprovalActionSummary,
  buildApprovalActionSummaryBlocks,
};
