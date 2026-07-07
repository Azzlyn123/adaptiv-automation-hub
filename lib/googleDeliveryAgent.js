// Adaptiv Athletics — Google Doc + Email Delivery Agent
//
// Turns a computed Daily Brief into a Google Doc (Docs API) and a short
// summary email (Gmail API), using OAuth — never the founder's Google
// password. Scopes are deliberately narrow:
//   - documents          create/update the brief doc
//   - drive.file         only files this app creates/opens (not full Drive)
//   - gmail.send         send mail as the authorized account (not full Gmail)
//
// Failure isolation (Step 5J): Google delivery is always optional relative
// to the Notion brief. If Google env vars are missing, or doc creation
// fails, or email sending fails, this module reports what happened instead
// of throwing — server.js writes that result back into the Notion Daily
// Brief row (Google Doc / Email Sent / Email Error / Delivery Status) and
// the request still succeeds. Nothing here ever blocks or fails the core
// /run-full-brief response.

const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/gmail.send',
];

// Env vars needed to actually attempt Google delivery. Deliberately NOT
// added to server.js's FULL_BRIEF_REQUIRED_ENV_VARS — per Step 5J, a
// missing/incomplete Google setup should degrade to "Not Sent", not break
// /run-full-brief.
const DELIVERY_REQUIRED_ENV_VARS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'GOOGLE_REFRESH_TOKEN',
  'FOUNDER_EMAIL',
];

// Env vars needed just to start the OAuth consent flow (no refresh token
// yet — that's what the flow produces).
const OAUTH_SETUP_REQUIRED_ENV_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];

function getMissingEnvVars(requiredVars) {
  return requiredVars.filter((key) => !process.env[key] || process.env[key].trim() === '');
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

function buildOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// Step 5G: the URL the founder visits once to grant consent. offline +
// prompt=consent guarantees a refresh_token comes back (Google only issues
// one on the first consent, or when consent is forced again).
function getAuthUrl() {
  const oauth2Client = buildOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

// GET /oauth2callback: exchanges the one-time code for tokens. Returns the
// refresh_token so the route can display/log it once for setup — this
// function is only ever called from that one-time setup flow.
async function exchangeCodeForTokens(code) {
  const oauth2Client = buildOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens; // { access_token, refresh_token, scope, token_type, expiry_date }
}

// Runtime client used by every delivery call. Uses the long-lived
// GOOGLE_REFRESH_TOKEN to mint short-lived access tokens automatically —
// nothing else needs to know or store an access token.
function getAuthorizedClient() {
  const oauth2Client = buildOAuthClient();
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return oauth2Client;
}

// ---------------------------------------------------------------------------
// Google Doc content — plain-text sections shared by createOrUpdateDoc.
// Kept self-contained (same pattern as stripeRevenueAgent.js /
// railwayHealthAgent.js) rather than importing server.js's Notion block
// builders, since Docs API formatting works completely differently.
// ---------------------------------------------------------------------------

function buildSalesLines(metrics) {
  if (!metrics) return ['Stripe not connected in this run.'];
  return [
    `MRR: $${metrics.mrrDollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `Active subs — Athlete: ${metrics.athleteSubs}, Coach/School: ${metrics.coachSchoolSubs}, Coach/Team: ${metrics.coachTeamSubs}`,
    `New subs (last ${metrics.windowHours}h): ${metrics.newSubs}`,
    `Canceled subs (last ${metrics.windowHours}h): ${metrics.canceledSubs}`,
    `Past due (live): ${metrics.pastDueCount}${metrics.pastDueCount > 0 ? ' — approval item created' : ''}`,
  ];
}

function buildRailwayLines(health) {
  if (!health) return ['Railway health not connected in this run.'];
  const capitalize = (w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w);
  return [
    `Overall Status: ${capitalize(health.overallColor)}`,
    `Frontend (${health.frontend.name}): ${health.frontend.found ? capitalize(health.frontend.color) : 'Missing'}${health.frontend.deployStatus ? ` (${health.frontend.deployStatus})` : ''}`,
    `Backend (${health.backend.name}): ${health.backend.found ? capitalize(health.backend.color) : 'Missing'}${health.backend.deployStatus ? ` (${health.backend.deployStatus})` : ''}`,
    `Database: ${capitalize(health.database.color)} (monitoring not wired up yet)`,
    `Health check: ${!health.healthCheck.checked ? 'Not checked' : health.healthCheck.ok ? `OK (HTTP ${health.healthCheck.statusCode}, ${health.healthCheck.responseTimeMs}ms)` : `Failed (${health.healthCheck.error})`}`,
    ...(health.errors.length > 0 ? health.errors : []),
  ];
}

// Builds the full Google Doc content as an ordered list of simple blocks.
// { type: 'heading', text } | { type: 'paragraph', text } | { type: 'bullets', items: [...] }
function buildDocSections({
  displayDate,
  statusLabel,
  topPriorities,
  salesMetrics,
  railwayHealth,
  missingDataSources,
  founderTodos,
  approvalRequests,
}) {
  return [
    { type: 'heading', text: 'Adaptiv Daily CEO Brief' },
    { type: 'paragraph', text: `${displayDate} — Company Status: ${statusLabel}` },
    { type: 'heading', text: 'Top 3 Priorities' },
    { type: 'bullets', items: topPriorities },
    { type: 'heading', text: 'Sales Summary (Stripe)' },
    { type: 'bullets', items: buildSalesLines(salesMetrics) },
    { type: 'heading', text: 'Railway Health' },
    { type: 'bullets', items: buildRailwayLines(railwayHealth) },
    { type: 'heading', text: 'Product' },
    { type: 'bullets', items: ['No product data source connected yet.'] },
    { type: 'heading', text: 'Missing Data Sources' },
    { type: 'bullets', items: missingDataSources },
    { type: 'heading', text: 'Founder To-Do List' },
    { type: 'bullets', items: founderTodos },
    { type: 'heading', text: 'Approval Requests' },
    { type: 'bullets', items: approvalRequests },
  ];
}

// Converts sections into a single plain-text blob plus the index ranges
// that need heading / bullet formatting, per the Docs API's index-based
// batchUpdate model. Indices are 1-based; index 1 is the very start of the
// document body.
function buildDocRequestPlan(sections) {
  let text = '';
  const headingRanges = [];
  const bulletRanges = [];

  for (const section of sections) {
    if (section.type === 'heading') {
      const start = 1 + text.length;
      text += `${section.text}\n`;
      headingRanges.push({ startIndex: start, endIndex: start + section.text.length });
    } else if (section.type === 'paragraph') {
      text += `${section.text}\n`;
    } else if (section.type === 'bullets') {
      const items = section.items.length > 0 ? section.items : ['None'];
      const groupStart = 1 + text.length;
      for (const item of items) {
        text += `${item}\n`;
      }
      const groupEnd = 1 + text.length; // covers through the final item's trailing newline
      bulletRanges.push({ startIndex: groupStart, endIndex: groupEnd });
    }
  }

  return { text, headingRanges, bulletRanges };
}

// ---------------------------------------------------------------------------
// Google Doc create/update (Docs API + Drive API)
// ---------------------------------------------------------------------------

async function findExistingDocId(drive, title, folderId) {
  let query = `name = '${title.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.document' and trashed = false`;
  if (folderId) {
    query += ` and '${folderId}' in parents`;
  }
  const res = await drive.files.list({ q: query, fields: 'files(id, name)', pageSize: 1 });
  return res.data.files && res.data.files.length > 0 ? res.data.files[0].id : null;
}

async function clearDocument(docs, documentId) {
  const doc = await docs.documents.get({ documentId });
  const endIndex = doc.data.body.content[doc.data.body.content.length - 1].endIndex;
  // Docs won't let you delete the document's final newline — stop one
  // short of endIndex. Nothing to clear on a brand-new empty doc.
  if (endIndex > 2) {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } }],
      },
    });
  }
}

async function writeDocContent(docs, documentId, sections) {
  const { text, headingRanges, bulletRanges } = buildDocRequestPlan(sections);

  // Insert all text first, in its own call — guarantees the doc has the
  // full brief content even if the formatting call below has a bad index
  // and fails.
  await docs.documents.batchUpdate({
    documentId,
    requestBody: { requests: [{ insertText: { location: { index: 1 }, text } }] },
  });

  const formattingRequests = [
    ...headingRanges.map((range) => ({
      updateParagraphStyle: {
        range,
        paragraphStyle: { namedStyleType: 'HEADING_2' },
        fields: 'namedStyleType',
      },
    })),
    ...bulletRanges.map((range) => ({
      createParagraphBullets: { range, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' },
    })),
  ];

  if (formattingRequests.length > 0) {
    try {
      await docs.documents.batchUpdate({ documentId, requestBody: { requests: formattingRequests } });
    } catch (err) {
      // Content is already in the doc — formatting is a nice-to-have per
      // the Step 5E spec ("format cleanly ... if practical"). Don't fail
      // the whole delivery over a formatting-only error.
      console.warn('[google delivery] Doc formatting failed, content is still present:', err.message || err);
    }
  }
}

async function moveToFolder(drive, fileId, folderId) {
  const file = await drive.files.get({ fileId, fields: 'parents' });
  const previousParents = (file.data.parents || []).join(',');
  await drive.files.update({
    fileId,
    addParents: folderId,
    removeParents: previousParents,
    fields: 'id, parents',
  });
}

// create-or-update a Google Doc titled "Adaptiv Daily CEO Brief - YYYY-MM-DD".
// Re-running on the same day updates the existing doc instead of creating a
// duplicate.
async function createOrUpdateDoc({ auth, title, sections, folderId }) {
  const docs = google.docs({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });

  let documentId = await findExistingDocId(drive, title, folderId);

  if (documentId) {
    await clearDocument(docs, documentId);
  } else {
    const created = await docs.documents.create({ requestBody: { title } });
    documentId = created.data.documentId;
    if (folderId) {
      try {
        await moveToFolder(drive, documentId, folderId);
      } catch (err) {
        // Doc still exists at Drive root — not fatal, just not filed where
        // expected. Surface as a warning rather than failing delivery.
        console.warn('[google delivery] Could not move doc into GOOGLE_DOC_FOLDER_ID:', err.message || err);
      }
    }
  }

  await writeDocContent(docs, documentId, sections);

  return { docId: documentId, docUrl: `https://docs.google.com/document/d/${documentId}/edit` };
}

// ---------------------------------------------------------------------------
// Gmail send
// ---------------------------------------------------------------------------

function base64UrlEncode(str) {
  return Buffer.from(str, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildRawMessage({ to, subject, bodyText }) {
  const message = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset="UTF-8"', '', bodyText].join(
    '\n'
  );
  return base64UrlEncode(message);
}

// Step 5I email body — short, links out to the full Doc for detail.
function buildEmailBody({ displayDate, statusLabel, topPriorities, salesMetrics, railwayHealth, approvalRequests, docUrl }) {
  const lines = [
    'Adaptiv Daily CEO Brief',
    `Status: ${statusLabel}`,
    '',
    'Top 3 Priorities:',
    ...topPriorities.map((p, i) => `${i + 1}. ${p}`),
    '',
    'Sales:',
    ...(salesMetrics
      ? [`- MRR $${salesMetrics.mrrDollars.toFixed(2)}, ${salesMetrics.pastDueCount} past due`]
      : ['- Not connected in this run']),
    '',
    'Railway:',
    ...(railwayHealth
      ? [`- Overall: ${railwayHealth.overallColor}${railwayHealth.errors.length > 0 ? ` — ${railwayHealth.errors[0]}` : ''}`]
      : ['- Not connected in this run']),
    '',
    'Product:',
    '- No product data source connected yet.',
    '',
    'Approvals Needed:',
    ...approvalRequests.map((a) => `- ${a}`),
    '',
    'Full Google Doc:',
    docUrl || 'Not available (doc creation failed this run — see Railway logs).',
  ];
  return lines.join('\n');
}

// Only ever sends to FOUNDER_EMAIL — this agent never emails anyone else.
async function sendBriefEmail({ auth, subject, bodyText }) {
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildRawMessage({ to: process.env.FOUNDER_EMAIL, subject, bodyText });
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// ---------------------------------------------------------------------------
// Orchestrator — Step 5J failure isolation lives here.
// ---------------------------------------------------------------------------

// Returns a result object describing what happened; never throws. Callers
// (server.js) use this to update the Notion Daily Brief row and decide
// whether the overall request still succeeds (it always does — Google
// delivery is additive, never load-bearing for /run-full-brief).
async function deliverDailyBrief(brief) {
  const missing = getMissingEnvVars(DELIVERY_REQUIRED_ENV_VARS);
  if (missing.length > 0) {
    return {
      attempted: false,
      docUrl: null,
      docError: null,
      emailSent: false,
      emailError: null,
      deliveryStatus: 'Not Sent',
      missing,
    };
  }

  const auth = getAuthorizedClient();
  const title = `Adaptiv Daily CEO Brief - ${brief.dateLabel}`;
  const sections = buildDocSections(brief);

  let docUrl = null;
  let docError = null;
  try {
    const result = await createOrUpdateDoc({
      auth,
      title,
      sections,
      folderId: process.env.GOOGLE_DOC_FOLDER_ID || null,
    });
    docUrl = result.docUrl;
  } catch (err) {
    docError = err.message || String(err);
    console.error('[google delivery] Doc creation/update failed:', err);
  }

  let emailSent = false;
  let emailError = null;
  try {
    const subject = `Adaptiv Daily CEO Brief — ${brief.displayDate}`;
    const bodyText = buildEmailBody({ ...brief, docUrl });
    await sendBriefEmail({ auth, subject, bodyText });
    emailSent = true;
  } catch (err) {
    emailError = err.message || String(err);
    console.error('[google delivery] Email send failed:', err);
  }

  let deliveryStatus;
  if (docUrl && emailSent) deliveryStatus = 'Sent';
  else if (!docUrl && !emailSent) deliveryStatus = 'Failed';
  else deliveryStatus = 'Partial';

  return { attempted: true, docUrl, docError, emailSent, emailError, deliveryStatus };
}

module.exports = {
  SCOPES,
  DELIVERY_REQUIRED_ENV_VARS,
  OAUTH_SETUP_REQUIRED_ENV_VARS,
  getMissingEnvVars,
  getAuthUrl,
  exchangeCodeForTokens,
  getAuthorizedClient,
  createOrUpdateDoc,
  sendBriefEmail,
  buildEmailBody,
  buildDocSections,
  deliverDailyBrief,
};
