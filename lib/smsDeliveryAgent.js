// Adaptiv Athletics — SMS Delivery Agent (Twilio)
//
// Sends a short SMS summary of the Daily CEO Brief to the founder's phone
// after Notion, Google Doc, and email delivery. Twilio only. Deliberately
// narrow:
//   - Only ever sends to FOUNDER_PHONE_NUMBER — this agent never sends to
//     any other number, regardless of what's passed in.
//   - Summary only — never the full report body. The full report already
//     lives in Notion, the Google Doc, and the email (Step 6C).
//   - Optional/toggleable via SMS_ENABLED — set to anything other than
//     "true" to skip SMS entirely without touching Twilio.
//
// Failure isolation (Step 6G): SMS delivery is always optional relative to
// the rest of /run-full-brief.
//   SMS_ENABLED is not "true"        -> smsStatus: 'Disabled'
//   Required Twilio env var missing  -> smsStatus: 'Failed'
//   Twilio API call fails            -> smsStatus: 'Failed', smsError set
//   Twilio API call succeeds         -> smsStatus: 'Sent', smsSent: true
// This module never throws — server.js writes the result back into the
// Notion Daily Brief row (SMS Sent / SMS Error / SMS Status) and the
// /run-full-brief request still succeeds regardless of what happens here.

const twilio = require('twilio');

// Env vars needed to actually attempt SMS delivery. Deliberately NOT added
// to server.js's FULL_BRIEF_REQUIRED_ENV_VARS — a missing/incomplete Twilio
// setup should degrade the SMS step to "Failed", not break /run-full-brief.
const SMS_REQUIRED_ENV_VARS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'FOUNDER_PHONE_NUMBER',
];

function getMissingEnvVars(requiredVars) {
  return requiredVars.filter((key) => !process.env[key] || process.env[key].trim() === '');
}

// SMS_ENABLED is a plain string env var ("true"/"false") — anything other
// than the literal string "true" (case-insensitive) is treated as disabled,
// including it being unset.
function isSmsEnabled() {
  return (process.env.SMS_ENABLED || '').trim().toLowerCase() === 'true';
}

function buildTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// ---------------------------------------------------------------------------
// SMS body — short summary only (Step 6C). Kept self-contained (same
// pattern as stripeRevenueAgent.js / railwayHealthAgent.js /
// googleDeliveryAgent.js) rather than importing server.js's Notion block
// builders.
// ---------------------------------------------------------------------------

function buildSmsSummary({ statusLabel, salesMetrics, railwayHealth, approvalRequests, topPriorities, docUrl }) {
  const revenue =
    salesMetrics && typeof salesMetrics.mrrDollars === 'number'
      ? `$${salesMetrics.mrrDollars.toLocaleString('en-US', { maximumFractionDigits: 0 })} MRR`
      : 'not connected';

  const backendColor = railwayHealth && railwayHealth.backend ? railwayHealth.backend.color : null;
  const appStatus = !railwayHealth
    ? 'Not connected.'
    : backendColor === 'GREEN'
      ? 'Backend healthy.'
      : `Backend ${backendColor ? backendColor.toLowerCase() : 'unknown'}.`;

  const noApprovalsPlaceholder = 'None yet — no items currently need founder approval.';
  const approvalCount =
    approvalRequests && approvalRequests.length > 0 && approvalRequests[0] !== noApprovalsPlaceholder
      ? approvalRequests.length
      : 0;

  const topTask = topPriorities && topPriorities.length > 0 ? topPriorities[0] : 'None set';

  const lines = [
    `Adaptiv Brief: ${statusLabel}.`,
    `Revenue: ${revenue}.`,
    `App: ${appStatus}`,
    `Approvals: ${approvalCount}.`,
    `Top task: ${topTask}.`,
  ];

  if (docUrl) {
    lines.push(`Doc: ${docUrl}`);
  }

  let message = lines.join(' ');

  // Hard safety cap — this is a summary, not the report (Step 6C: "under
  // roughly 300 characters"). If a long top-priority string pushes it over,
  // truncate rather than send an oversized text.
  const MAX_LENGTH = 320;
  if (message.length > MAX_LENGTH) {
    message = `${message.slice(0, MAX_LENGTH - 1)}…`;
  }

  return message;
}

// Sends one SMS via Twilio. Only ever sends to FOUNDER_PHONE_NUMBER — no
// caller can override the recipient.
async function sendSms(body) {
  const client = buildTwilioClient();
  return client.messages.create({
    to: process.env.FOUNDER_PHONE_NUMBER,
    from: process.env.TWILIO_FROM_NUMBER,
    body,
  });
}

// ---------------------------------------------------------------------------
// Orchestrator — Step 6G failure isolation lives here.
// ---------------------------------------------------------------------------
//
// Returns a result object describing what happened; never throws. Callers
// (server.js) use this to update the Notion Daily Brief row and decide
// whether the overall request still succeeds (it always does — SMS
// delivery is additive, never load-bearing for /run-full-brief).
async function deliverSms(brief) {
  if (!isSmsEnabled()) {
    return { attempted: false, smsSent: false, smsError: null, smsStatus: 'Disabled' };
  }

  const missing = getMissingEnvVars(SMS_REQUIRED_ENV_VARS);
  if (missing.length > 0) {
    return {
      attempted: false,
      smsSent: false,
      smsError: `Missing required environment variables: ${missing.join(', ')}`,
      smsStatus: 'Failed',
      missing,
    };
  }

  try {
    const body = buildSmsSummary(brief);
    await sendSms(body);
    return { attempted: true, smsSent: true, smsError: null, smsStatus: 'Sent' };
  } catch (err) {
    console.error('[sms delivery] Send failed:', err);
    return {
      attempted: true,
      smsSent: false,
      smsError: err.message || String(err),
      smsStatus: 'Failed',
    };
  }
}

module.exports = {
  SMS_REQUIRED_ENV_VARS,
  getMissingEnvVars,
  isSmsEnabled,
  buildSmsSummary,
  sendSms,
  deliverSms,
};
