// Adaptiv Athletics — Railway Automation Hub
//
// Scope so far:
//   - Writes a Daily CEO Brief into the Notion "Daily Briefs" database.
//   - Stripe Revenue Agent (read-only): pulls Stripe subscription data,
//     writes a report row into the Notion "Sales" database, creates a
//     Notion "Approvals" item when subscriptions are past due, and can
//     fold a live sales summary into the Daily Brief.
//   - Railway Health Agent (read-only): checks the frontend/backend
//     services and the backend health endpoint via Railway's public API,
//     writes a row into the Notion "Railway Health" database, creates a
//     Notion "Approvals" item when something looks wrong, and can fold a
//     live health summary into the Daily Brief.
//   - Google Doc + Email Delivery (OAuth, never a password): after
//     /run-full-brief writes to Notion, it also creates/updates a Google
//     Doc with the full brief and emails a short summary to FOUNDER_EMAIL.
//     Delivery is additive — a missing Google setup or a delivery failure
//     never blocks the Notion brief from being created (see Step 5J in
//     lib/googleDeliveryAgent.js).
//   - SMS Summary (Twilio, opt-in via SMS_ENABLED): after Google delivery,
//     sends a short text summary of the brief to FOUNDER_PHONE_NUMBER only.
//     Additive like Google delivery — disabled, unconfigured, or failed SMS
//     never blocks the Notion brief or the rest of /run-full-brief (see
//     Step 6G in lib/smsDeliveryAgent.js).
// Still NOT in scope:
//   - Social channels
//   - Anything that writes to Stripe (read-only: no charges, no refunds,
//     no subscription cancellations, no customer updates)
//   - Anything that changes Railway (read-only: no restarts, no redeploys,
//     no variable changes, no deletions)
//   - Emailing anyone other than FOUNDER_EMAIL

require('dotenv').config();

const express = require('express');
const { Client } = require('@notionhq/client');
const Stripe = require('stripe');
const stripeRevenueAgent = require('./lib/stripeRevenueAgent');
const railwayHealthAgent = require('./lib/railwayHealthAgent');
const googleDeliveryAgent = require('./lib/googleDeliveryAgent');
const smsDeliveryAgent = require('./lib/smsDeliveryAgent');
const productBugAgent = require('./lib/productBugAgent');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Environment variable validation
// ---------------------------------------------------------------------------
// Never hardcode secrets. Everything sensitive comes from Railway env vars.
// Each route declares only the vars it actually needs, so e.g. Stripe being
// unconfigured doesn't block the Daily Brief route from working.
const DAILY_BRIEF_REQUIRED_ENV_VARS = ['NOTION_API_KEY', 'NOTION_DATABASE_DAILY_BRIEFS'];

const REVENUE_SYNC_REQUIRED_ENV_VARS = [
  'NOTION_API_KEY',
  'NOTION_DATABASE_SALES',
  'NOTION_DATABASE_APPROVALS',
  'STRIPE_RESTRICTED_KEY',
  'STRIPE_PRICE_ATHLETE',
  'STRIPE_PRICE_COACH_SCHOOL',
  'STRIPE_PRICE_COACH_TEAM',
];

// Deliberately does NOT include RAILWAY_PROJECT_NAME. The Railway Health
// Agent resolves its project/environment straight from the project token
// (see lib/railwayHealthAgent.js), so RAILWAY_PROJECT_NAME is never used in
// an API call and can't break this route even if it's misspelled.
const RAILWAY_HEALTH_REQUIRED_ENV_VARS = [
  'NOTION_API_KEY',
  'NOTION_DATABASE_RAILWAY_HEALTH',
  'NOTION_DATABASE_APPROVALS',
  'RAILWAY_API_TOKEN',
  'RAILWAY_FRONTEND_SERVICE',
  'RAILWAY_BACKEND_SERVICE',
  'BACKEND_HEALTH_URL',
];

// Step 7: Product/Bug Agent. NOTION_DATABASE_TASKS / NOTION_DATABASE_APPROVALS
// are deliberately NOT required here — task/approval creation is additive
// (see writeBugRecords below), so /submit-bug still works before those two
// vars are wired up, same additive philosophy as Google/SMS delivery.
const PRODUCT_BUG_REQUIRED_ENV_VARS = ['NOTION_API_KEY', 'NOTION_DATABASE_PRODUCT_BUGS'];
const FEEDBACK_REQUIRED_ENV_VARS = ['NOTION_API_KEY', 'NOTION_DATABASE_BETA_FEEDBACK'];
const PRODUCT_TRIAGE_REQUIRED_ENV_VARS = [
  'NOTION_API_KEY',
  'NOTION_DATABASE_PRODUCT_BUGS',
  'NOTION_DATABASE_BETA_FEEDBACK',
];

// Deliberately does NOT include the Step 7 vars — the Product/Bug section of
// /run-full-brief is additive (see the productBugSummary block in that
// route), so a full brief still runs even before Step 7's Notion databases
// are wired up in Railway.
const FULL_BRIEF_REQUIRED_ENV_VARS = [
  ...new Set([
    ...DAILY_BRIEF_REQUIRED_ENV_VARS,
    ...REVENUE_SYNC_REQUIRED_ENV_VARS,
    ...RAILWAY_HEALTH_REQUIRED_ENV_VARS,
  ]),
];

function getMissingEnvVars(requiredVars) {
  return requiredVars.filter((key) => !process.env[key] || process.env[key].trim() === '');
}

const missingOnBoot = getMissingEnvVars(FULL_BRIEF_REQUIRED_ENV_VARS);
if (missingOnBoot.length > 0) {
  // Don't crash on boot — /health should still respond so Railway can report
  // the service as up while surfacing the config problem. The affected
  // routes will refuse to run until these are set.
  console.warn(
    `[startup] Missing environment variables: ${missingOnBoot.join(', ')}. ` +
      'Any route that depends on a missing variable will return an error until it is set in Railway.'
  );
}

// ---------------------------------------------------------------------------
// API clients
// ---------------------------------------------------------------------------
// Only construct clients if we have a key — avoids throwing on boot when env
// vars are still being wired up.
const notion = process.env.NOTION_API_KEY
  ? new Client({ auth: process.env.NOTION_API_KEY })
  : null;

// STRIPE_RESTRICTED_KEY must be a *restricted* key (rk_live_/rk_test_), read
// access only, on: Customers, Subscriptions, Checkout Sessions, Invoices,
// Prices, Products, Balance Transactions. No write scopes. See README for
// the exact setup steps. This service never writes to Stripe.
const stripe = process.env.STRIPE_RESTRICTED_KEY ? new Stripe(process.env.STRIPE_RESTRICTED_KEY) : null;

const planPriceIds = {
  athlete: process.env.STRIPE_PRICE_ATHLETE,
  coachSchool: process.env.STRIPE_PRICE_COACH_SCHOOL,
  coachTeam: process.env.STRIPE_PRICE_COACH_TEAM,
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /health
// Lightweight liveness check. No dependencies, no external calls.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// POST /run-daily-brief
// Creates one test Daily CEO Brief page in the Notion Daily Briefs database.
// No Stripe data — see /run-full-brief for a brief with a live sales section.
app.post('/run-daily-brief', async (req, res) => {
  const missing = getMissingEnvVars(DAILY_BRIEF_REQUIRED_ENV_VARS);
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Missing required environment variables',
      missing,
    });
  }

  try {
    const brief = buildDailyBriefContent();
    const page = await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_DAILY_BRIEFS },
      properties: brief.properties,
      children: brief.children,
    });

    return res.status(201).json({
      status: 'ok',
      message: 'Daily brief created in Notion.',
      notionPageId: page.id,
      notionPageUrl: page.url,
    });
  } catch (err) {
    return handleNotionError(res, err);
  }
});

// POST /run-revenue-sync
// Stripe Revenue Agent. Fetches subscription data from Stripe (read-only),
// writes one row into the Notion Sales database, and — if any subscriptions
// are currently past_due — creates a "Draft failed-payment follow-up"
// approval item in the Notion Approvals database. Never writes to Stripe.
app.post('/run-revenue-sync', async (req, res) => {
  const missing = getMissingEnvVars(REVENUE_SYNC_REQUIRED_ENV_VARS);
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Missing required environment variables',
      missing,
    });
  }

  let metrics;
  try {
    metrics = await stripeRevenueAgent.gatherRevenueMetrics(stripe, planPriceIds);
  } catch (err) {
    return handleStripeError(res, err);
  }

  try {
    const { salesPage, approvalPage } = await writeRevenueRecords(metrics);
    return res.status(201).json({
      status: 'ok',
      message: 'Revenue sync complete.',
      metrics,
      salesPageUrl: salesPage.url,
      approvalCreated: Boolean(approvalPage),
      approvalPageUrl: approvalPage ? approvalPage.url : null,
    });
  } catch (err) {
    return handleNotionError(res, err);
  }
});

// POST /run-railway-health
// Railway Health Agent. Checks the frontend/backend services (found +
// latest deployment status) via Railway's public API, and checks
// BACKEND_HEALTH_URL directly. Writes one row into the Notion Railway
// Health database, and creates Notion Approval item(s) when something
// looks wrong (backend outage, slow backend, missing service mapping,
// failed deploy). Never restarts, redeploys, or changes anything in Railway.
app.post('/run-railway-health', async (req, res) => {
  const missing = getMissingEnvVars(RAILWAY_HEALTH_REQUIRED_ENV_VARS);
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Missing required environment variables',
      missing,
    });
  }

  let health;
  try {
    health = await railwayHealthAgent.gatherRailwayHealth({
      railwayToken: process.env.RAILWAY_API_TOKEN,
      frontendServiceName: process.env.RAILWAY_FRONTEND_SERVICE,
      backendServiceName: process.env.RAILWAY_BACKEND_SERVICE,
      backendHealthUrl: process.env.BACKEND_HEALTH_URL,
    });
  } catch (err) {
    return handleRailwayError(res, err);
  }

  try {
    const { healthPage, approvalPages } = await writeRailwayHealthRecords(health);
    return res.status(201).json({
      status: 'ok',
      message: 'Railway health check complete.',
      health,
      healthPageUrl: healthPage.url,
      approvalsCreated: approvalPages.map((p) => p.url),
    });
  } catch (err) {
    return handleNotionError(res, err);
  }
});

// POST /submit-bug
// Step 7. Records one bug/feature-request/UX-issue/etc. into the Notion
// Product Bugs database. Computes a Priority Score from severity + the
// blocks-signup/payment/etc. flags (see lib/productBugAgent.js). For
// Critical or High severity, also creates a Notion Tasks row. For Critical
// severity only, also creates a Notion Approvals row ("Needs Approval").
// Never changes app code, never closes a bug, never deploys anything —
// Status is always written as "New".
app.post('/submit-bug', async (req, res) => {
  const missing = getMissingEnvVars(PRODUCT_BUG_REQUIRED_ENV_VARS);
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Missing required environment variables',
      missing,
    });
  }

  const validation = productBugAgent.validateBugInput(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: 'Invalid bug submission', details: validation.errors });
  }

  try {
    const result = await writeBugRecords(validation.normalized);
    return res.status(201).json({
      status: 'ok',
      message: 'Bug recorded in Product Bugs.',
      priorityScore: result.priorityScore,
      bugPageUrl: result.bugPage.url,
      taskCreated: Boolean(result.taskPage),
      taskPageUrl: result.taskPage ? result.taskPage.url : null,
      approvalCreated: Boolean(result.approvalPage),
      approvalPageUrl: result.approvalPage ? result.approvalPage.url : null,
    });
  } catch (err) {
    return handleNotionError(res, err);
  }
});

// POST /submit-feedback
// Step 7. Records one beta-tester/coach/athlete feedback item into the
// Notion Beta Feedback database. If 3+ open feedback items now share the
// same Area, the response includes a read-only recommendation to fix that
// area — no Notion row is created for the recommendation itself.
app.post('/submit-feedback', async (req, res) => {
  const missing = getMissingEnvVars(FEEDBACK_REQUIRED_ENV_VARS);
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Missing required environment variables',
      missing,
    });
  }

  const validation = productBugAgent.validateFeedbackInput(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: 'Invalid feedback submission', details: validation.errors });
  }

  try {
    const feedbackPage = await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_BETA_FEEDBACK },
      properties: productBugAgent.buildFeedbackRowProperties(validation.normalized),
    });

    let recommendation = null;
    if (validation.normalized.area) {
      try {
        const existing = await notion.databases.query({
          database_id: process.env.NOTION_DATABASE_BETA_FEEDBACK,
          page_size: 100,
        });
        const sameAreaCount = existing.results.filter((page) => {
          const areaProp = page.properties['Area'];
          return areaProp && areaProp.select && areaProp.select.name === validation.normalized.area;
        }).length;
        if (sameAreaCount >= 3) {
          recommendation = `${sameAreaCount} beta feedback items now mention "${validation.normalized.area}" — recommend a UX fix for this area.`;
        }
      } catch (err) {
        // Non-fatal — the feedback row above already saved successfully.
        // The repeat-check is a nice-to-have, not required for this route
        // to succeed.
        console.error('[product bug agent] Repeat-feedback check failed (non-fatal):', err.body || err.message || err);
      }
    }

    return res.status(201).json({
      status: 'ok',
      message: 'Feedback recorded in Beta Feedback.',
      feedbackPageUrl: feedbackPage.url,
      recommendation,
    });
  } catch (err) {
    return handleNotionError(res, err);
  }
});

// POST /run-product-triage
// Step 7. Read-only report: queries the current open state of Product Bugs
// + Beta Feedback, ranks open bugs by Priority Score, and returns the same
// Green/Yellow/Red status + counts used in the Daily Brief. Does not close
// bugs, does not create Tasks/Approvals, does not change anything — use
// /submit-bug for that.
app.post('/run-product-triage', async (req, res) => {
  const missing = getMissingEnvVars(PRODUCT_TRIAGE_REQUIRED_ENV_VARS);
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Missing required environment variables',
      missing,
    });
  }

  try {
    const summary = await productBugAgent.gatherProductBugSummary(notion, {
      productBugsDbId: process.env.NOTION_DATABASE_PRODUCT_BUGS,
      betaFeedbackDbId: process.env.NOTION_DATABASE_BETA_FEEDBACK,
    });

    return res.status(200).json({
      status: 'ok',
      message: 'Product/Bug triage complete. Read-only — no bugs closed, no code changed, nothing created by this route.',
      productStatus: summary.status,
      criticalBugs: summary.criticalBugs,
      highBugs: summary.highBugs,
      filmAIBlockers: summary.filmAIBlockers,
      newFeedbackCount: summary.newFeedbackCount,
      recommendedFixToday: summary.recommendedFixToday,
      rankedOpenBugs: summary.rankedOpenBugs,
      repeatedFeedbackAreas: summary.repeatedAreas,
    });
  } catch (err) {
    return handleNotionError(res, err);
  }
});

// POST /run-full-brief
// Runs the Stripe revenue sync and the Railway health check (each writing
// their own Sales/Railway Health rows and any Approval items), then creates
// a Daily Brief that includes real "Sales Summary" and "Railway Health"
// sections built from that same data. If the numbers here look wrong, check
// the Stripe price-ID mapping or the Railway service name mapping before
// adding anything else — per the Step 3E / 4E test plans.
app.post('/run-full-brief', async (req, res) => {
  const missing = getMissingEnvVars(FULL_BRIEF_REQUIRED_ENV_VARS);
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Missing required environment variables',
      missing,
    });
  }

  let metrics;
  try {
    metrics = await stripeRevenueAgent.gatherRevenueMetrics(stripe, planPriceIds);
  } catch (err) {
    return handleStripeError(res, err);
  }

  let health;
  try {
    health = await railwayHealthAgent.gatherRailwayHealth({
      railwayToken: process.env.RAILWAY_API_TOKEN,
      frontendServiceName: process.env.RAILWAY_FRONTEND_SERVICE,
      backendServiceName: process.env.RAILWAY_BACKEND_SERVICE,
      backendHealthUrl: process.env.BACKEND_HEALTH_URL,
    });
  } catch (err) {
    return handleRailwayError(res, err);
  }

  // Step 7: Product/Bug summary. Additive like Google/SMS delivery — a
  // missing NOTION_DATABASE_PRODUCT_BUGS/BETA_FEEDBACK or a Notion read
  // failure here never blocks the rest of the brief. tasksCreatedCount stays
  // 0 here since this route only reads open bugs/feedback; task creation
  // only happens from /submit-bug.
  let productBugSummary = null;
  if (getMissingEnvVars(PRODUCT_TRIAGE_REQUIRED_ENV_VARS).length === 0) {
    try {
      productBugSummary = await productBugAgent.gatherProductBugSummary(notion, {
        productBugsDbId: process.env.NOTION_DATABASE_PRODUCT_BUGS,
        betaFeedbackDbId: process.env.NOTION_DATABASE_BETA_FEEDBACK,
      });
    } catch (err) {
      console.error('[product bug agent] Failed to gather summary for daily brief (non-fatal):', err.body || err.message || err);
    }
  }

  try {
    const { salesPage, approvalPage } = await writeRevenueRecords(metrics);
    const { healthPage, approvalPages, approvalDrafts } = await writeRailwayHealthRecords(health);

    const brief = buildDailyBriefContent({
      salesMetrics: metrics,
      railwayHealth: health,
      railwayApprovals: approvalDrafts,
      productBugSummary,
    });
    const briefPage = await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_DAILY_BRIEFS },
      properties: brief.properties,
      children: brief.children,
    });

    // Step 5: Google Doc + email delivery. This never throws and never
    // blocks this response — a missing Google setup or a delivery failure
    // just gets recorded on the Notion row below instead (Step 5J).
    const delivery = await googleDeliveryAgent.deliverDailyBrief({
      dateLabel: brief.dateLabel,
      displayDate: brief.displayDate,
      statusLabel: brief.statusLabel,
      topPriorities: brief.topPriorities,
      salesMetrics: metrics,
      railwayHealth: health,
      missingDataSources: brief.missingDataSources,
      founderTodos: brief.founderTodos,
      approvalRequests: brief.approvalRequests,
    });

    // Step 6: SMS summary. Also never throws and never blocks this
    // response — disabled/unconfigured/failed SMS just gets recorded on
    // the Notion row below (Step 6G). Runs after Google delivery so it can
    // include the Google Doc link when available.
    const sms = await smsDeliveryAgent.deliverSms({
      statusLabel: brief.statusLabel,
      salesMetrics: metrics,
      railwayHealth: health,
      approvalRequests: brief.approvalRequests,
      topPriorities: brief.topPriorities,
      docUrl: delivery.docUrl,
    });

    try {
      await notion.pages.update({
        page_id: briefPage.id,
        properties: { ...buildDeliveryProperties(delivery), ...buildSmsProperties(sms) },
      });
    } catch (err) {
      // Doc/email/SMS may have already succeeded — don't fail the request
      // over this follow-up write. Log it so it's visible in Railway logs
      // (Step 5J: "email works, Notion fails -> log error").
      console.error(
        '[notion error] Failed to write delivery status back to the Daily Brief row:',
        err.body || err.message || err
      );
    }

    return res.status(201).json({
      status: 'ok',
      message: 'Revenue sync + Railway health + daily brief + delivery + SMS complete.',
      metrics,
      salesPageUrl: salesPage.url,
      approvalCreated: Boolean(approvalPage),
      approvalPageUrl: approvalPage ? approvalPage.url : null,
      health,
      healthPageUrl: healthPage.url,
      railwayApprovalsCreated: approvalPages.map((p) => p.url),
      productBugSummary,
      dailyBriefUrl: briefPage.url,
      delivery,
      sms,
    });
  } catch (err) {
    return handleNotionError(res, err);
  }
});

// GET /auth/google
// Step 5G: one-time setup route. Redirects the founder to Google's OAuth
// consent screen. Visit this in a browser, not curl — it's a redirect meant
// for a human to click through.
app.get('/auth/google', (req, res) => {
  const missing = googleDeliveryAgent.getMissingEnvVars(googleDeliveryAgent.OAUTH_SETUP_REQUIRED_ENV_VARS);
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Missing required environment variables',
      missing,
    });
  }

  return res.redirect(googleDeliveryAgent.getAuthUrl());
});

// GET /oauth2callback
// Step 5G: Google redirects here after consent, with a one-time ?code=.
// Exchanges it for tokens and shows the refresh token ONCE so it can be
// copied into Railway as GOOGLE_REFRESH_TOKEN. This route is the setup
// flow itself, so displaying the token here is intentional — no other
// route in this service ever exposes it.
app.get('/oauth2callback', async (req, res) => {
  const missing = googleDeliveryAgent.getMissingEnvVars(googleDeliveryAgent.OAUTH_SETUP_REQUIRED_ENV_VARS);
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Missing required environment variables',
      missing,
    });
  }

  const code = req.query.code;
  if (!code) {
    return res.status(400).json({ error: 'Missing ?code= from Google OAuth redirect.' });
  }

  try {
    const tokens = await googleDeliveryAgent.exchangeCodeForTokens(code);

    if (tokens.refresh_token) {
      console.log('[google oauth setup] Refresh token (copy this into Railway as GOOGLE_REFRESH_TOKEN):');
      console.log(tokens.refresh_token);
    } else {
      console.warn(
        '[google oauth setup] No refresh_token in the response — Google only issues one on first consent. ' +
          'If you already authorized this app before, revoke access at https://myaccount.google.com/permissions ' +
          'and visit /auth/google again.'
      );
    }

    return res.status(200).json({
      status: 'ok',
      message: tokens.refresh_token
        ? 'Authorization complete. Copy refreshToken below into Railway as GOOGLE_REFRESH_TOKEN, then redeploy. Keep it private.'
        : 'Authorization complete, but no refresh token was issued (already authorized before). Revoke access at https://myaccount.google.com/permissions and try /auth/google again to force a new one.',
      refreshToken: tokens.refresh_token || null,
    });
  } catch (err) {
    return handleGoogleError(res, err);
  }
});

// POST /create-test-doc
// Step 5H. Creates a small test Google Doc so you can confirm OAuth +
// Docs/Drive scopes work before relying on /run-full-brief.
app.post('/create-test-doc', async (req, res) => {
  const missing = googleDeliveryAgent.getMissingEnvVars(googleDeliveryAgent.DELIVERY_REQUIRED_ENV_VARS);
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Missing required environment variables',
      missing,
    });
  }

  try {
    const auth = googleDeliveryAgent.getAuthorizedClient();
    const result = await googleDeliveryAgent.createOrUpdateDoc({
      auth,
      title: `Adaptiv Automation Hub — Test Doc — ${new Date().toISOString()}`,
      sections: googleDeliveryAgent.buildDocSections({
        displayDate: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
        statusLabel: 'Test',
        topPriorities: ['This is a test document from POST /create-test-doc.'],
        salesMetrics: null,
        railwayHealth: null,
        missingDataSources: ['N/A — this is a connectivity test, not a real brief.'],
        founderTodos: ['Confirm this document appeared in Google Drive, then delete it.'],
        approvalRequests: ['None — test document.'],
      }),
      folderId: process.env.GOOGLE_DOC_FOLDER_ID || null,
    });

    return res.status(201).json({ status: 'ok', message: 'Test Google Doc created.', docUrl: result.docUrl });
  } catch (err) {
    return handleGoogleError(res, err);
  }
});

// POST /send-test-email
// Step 5H. Sends a test email to FOUNDER_EMAIL only — confirms Gmail send
// scope works before relying on /run-full-brief.
app.post('/send-test-email', async (req, res) => {
  const missing = googleDeliveryAgent.getMissingEnvVars(googleDeliveryAgent.DELIVERY_REQUIRED_ENV_VARS);
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Missing required environment variables',
      missing,
    });
  }

  try {
    const auth = googleDeliveryAgent.getAuthorizedClient();
    await googleDeliveryAgent.sendBriefEmail({
      auth,
      subject: 'Adaptiv Automation Hub — Test Email',
      bodyText:
        'This is a test email from the Adaptiv Automation Hub (POST /send-test-email).\n\n' +
        'If you got this, Gmail send + OAuth are working correctly.',
    });

    return res.status(200).json({ status: 'ok', message: `Test email sent to ${process.env.FOUNDER_EMAIL}.` });
  } catch (err) {
    return handleGoogleError(res, err);
  }
});

// POST /send-test-sms
// Step 6D. Sends a short test SMS to FOUNDER_PHONE_NUMBER only — confirms
// Twilio credentials + the from-number work before relying on
// /run-full-brief. Respects SMS_ENABLED like the real delivery path: if
// SMS is disabled, this route says so instead of silently sending anyway.
app.post('/send-test-sms', async (req, res) => {
  if (!smsDeliveryAgent.isSmsEnabled()) {
    return res.status(200).json({
      status: 'disabled',
      message: 'SMS_ENABLED is not set to "true" — no test SMS was sent. Set SMS_ENABLED=true in Railway to enable.',
    });
  }

  const missing = smsDeliveryAgent.getMissingEnvVars(smsDeliveryAgent.SMS_REQUIRED_ENV_VARS);
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Missing required environment variables',
      missing,
    });
  }

  try {
    await smsDeliveryAgent.sendSms(
      'Adaptiv Automation Hub — Test SMS. If you got this, Twilio + FOUNDER_PHONE_NUMBER are working correctly.'
    );
    return res.status(200).json({ status: 'ok', message: `Test SMS sent to ${process.env.FOUNDER_PHONE_NUMBER}.` });
  } catch (err) {
    return handleTwilioError(res, err);
  }
});

// Fallback 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Centralized error handler for anything that throws synchronously
app.use((err, req, res, next) => {
  console.error('[unhandled error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Shared by /run-revenue-sync and /run-full-brief: writes the Sales row and,
// if any subscriptions are past_due, the Approvals row. Both writes are
// Notion operations, so callers should catch with handleNotionError.
async function writeRevenueRecords(metrics) {
  const salesPage = await notion.pages.create({
    parent: { database_id: process.env.NOTION_DATABASE_SALES },
    properties: stripeRevenueAgent.buildSalesRowProperties(metrics),
  });

  let approvalPage = null;
  if (metrics.pastDueCount > 0) {
    approvalPage = await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_APPROVALS },
      properties: stripeRevenueAgent.buildApprovalProperties(metrics),
    });
  }

  return { salesPage, approvalPage };
}

// Shared by /run-railway-health and /run-full-brief: writes the Railway
// Health row and any Approval rows determineApprovals() decided are needed.
// Both writes are Notion operations, so callers should catch with
// handleNotionError. Returns approvalDrafts (the plain objects, used to
// render the Daily Brief's "Approval Needed" section) alongside the created
// Notion pages.
async function writeRailwayHealthRecords(health) {
  const healthPage = await notion.pages.create({
    parent: { database_id: process.env.NOTION_DATABASE_RAILWAY_HEALTH },
    properties: railwayHealthAgent.buildRailwayHealthRowProperties(health),
  });

  const approvalDrafts = railwayHealthAgent.determineApprovals(health);
  const approvalPages = [];
  for (const draft of approvalDrafts) {
    const page = await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_APPROVALS },
      properties: draft.properties,
    });
    approvalPages.push(page);
  }

  return { healthPage, approvalPages, approvalDrafts };
}

// Used by /submit-bug: writes the Product Bugs row, and — additively —
// a Tasks row (Critical/High severity) and an Approvals row (Critical
// severity only). Task/Approval creation is skipped, not failed, when the
// relevant NOTION_DATABASE_TASKS / NOTION_DATABASE_APPROVALS var isn't set
// yet, so /submit-bug still works while Step 7's env vars are being wired
// up in Railway. All writes are Notion operations, so callers should catch
// with handleNotionError.
async function writeBugRecords(bug) {
  const priorityScore = productBugAgent.computePriorityScore(bug.severity, bug.flags);

  const bugPage = await notion.pages.create({
    parent: { database_id: process.env.NOTION_DATABASE_PRODUCT_BUGS },
    properties: productBugAgent.buildBugRowProperties(bug, priorityScore),
  });

  let taskPage = null;
  if ((bug.severity === 'Critical' || bug.severity === 'High') && process.env.NOTION_DATABASE_TASKS) {
    taskPage = await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_TASKS },
      properties: productBugAgent.buildBugTaskProperties(bug),
    });
  }

  let approvalPage = null;
  if (bug.severity === 'Critical' && process.env.NOTION_DATABASE_APPROVALS) {
    approvalPage = await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_APPROVALS },
      properties: productBugAgent.buildCriticalApprovalProperties(bug),
    });
  }

  return { bugPage, priorityScore, taskPage, approvalPage };
}

// Builds the Notion page payload for the Daily Brief.
//
// The "Daily Briefs" database currently has four properties:
//   Name (title), Status (status: Red/Yellow/Green), Date (date),
//   Top Priority (rich text)
//
// The richer sections (top 3 priorities, missing data sources, founder
// to-do list, approval requests, sales summary) don't have dedicated
// columns yet, so they're written into the page body as content blocks.
//
// When called with no arguments, this produces the original structural
// test brief (all placeholder data, title suffixed "(test)"). When called
// with { salesMetrics }, it swaps in a real Sales Summary section built
// from live Stripe data and drops "Stripe" from the missing-data list. When
// called with { railwayHealth, railwayApprovals }, it swaps in a real
// Railway Health section and drops the Railway placeholder line too — both
// used by /run-full-brief.
function buildDailyBriefContent({ salesMetrics, railwayHealth, railwayApprovals, productBugSummary } = {}) {
  const today = new Date();
  const dateLabel = today.toISOString().split('T')[0]; // YYYY-MM-DD
  const displayDate = today.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const topPriorities = [
    'Connect Notion to Railway Automation Hub',
    'Missing data sources — see below',
    'Confirm daily brief format with founder',
  ];

  const missingDataSources = [
    'Social channels (Instagram, TikTok, YouTube, X — not connected)',
    'Coach/school sales pipeline data',
  ];
  if (!railwayHealth) {
    missingDataSources.splice(1, 0, 'Railway health metrics (not wired up in this test run)');
  }
  if (!salesMetrics) {
    missingDataSources.unshift('Stripe (not connected in this test run)');
  }
  if (!productBugSummary) {
    missingDataSources.push('Product/Bug Agent (Notion Product Bugs / Beta Feedback not wired up yet)');
  }

  const founderTodos = [
    'Review this brief for format and tone',
    'Confirm which data sources to connect next',
    'Approve moving to the next automation phase',
  ];

  const approvalRequests = [];
  if (salesMetrics && salesMetrics.pastDueCount > 0) {
    approvalRequests.push(
      `${salesMetrics.pastDueCount} subscription(s) past due — see Approvals database for the failed-payment follow-up request.`
    );
  }
  if (railwayApprovals && railwayApprovals.length > 0) {
    for (const approval of railwayApprovals) {
      approvalRequests.push(`${approval.properties.Action.title[0].text.content} — see Approvals database.`);
    }
  }
  if (approvalRequests.length === 0) {
    approvalRequests.push('None yet — no items currently need founder approval.');
  }

  const titleSuffix = salesMetrics || railwayHealth ? '' : ' (test)';
  const statusLabel = 'Yellow';

  const bodyBlocks = [
    heading(`Company Status: ${statusLabel}`),
    paragraph(
      salesMetrics || railwayHealth
        ? `Daily brief generated by the Railway Automation Hub on ${displayDate}, including live data from the connected agents below.`
        : `This is a test brief generated by the Railway Automation Hub on ${displayDate}. ` +
            'No live data sources are connected yet — all content below is structural placeholder data.'
    ),
  ];

  if (salesMetrics) {
    bodyBlocks.push(...stripeRevenueAgent.buildSalesSummaryBlocks(salesMetrics));
  }

  if (railwayHealth) {
    bodyBlocks.push(...railwayHealthAgent.buildHealthSummaryBlocks(railwayHealth, railwayApprovals || []));
  }

  if (productBugSummary) {
    // tasksCreatedCount is always 0 here — /run-full-brief only reads open
    // bugs/feedback for this section; task creation happens on /submit-bug.
    bodyBlocks.push(...productBugAgent.buildProductBugSummaryBlocks(productBugSummary, 0));
  }

  bodyBlocks.push(
    heading('Top 3 Priorities'),
    numberedList(topPriorities),
    heading('Missing Data Sources'),
    bulletedList(missingDataSources),
    heading('Founder To-Do List'),
    bulletedList(founderTodos),
    heading('Approval Requests'),
    bulletedList(approvalRequests)
  );

  return {
    properties: {
      Name: {
        title: [{ text: { content: `Daily Brief — ${dateLabel}${titleSuffix}` } }],
      },
      Status: {
        status: { name: statusLabel },
      },
      Date: {
        date: { start: dateLabel },
      },
      'Top Priority': {
        rich_text: [{ text: { content: topPriorities[0] } }],
      },
    },
    children: flattenChildren(bodyBlocks),
    // Plain-value ingredients (not Notion-shaped) — used by
    // googleDeliveryAgent.deliverDailyBrief() in /run-full-brief so the
    // Google Doc and email stay in sync with the Notion page without
    // recomputing this content twice.
    dateLabel,
    displayDate,
    statusLabel,
    topPriorities,
    missingDataSources,
    founderTodos,
    approvalRequests,
    productBugSummary: productBugSummary || null,
  };
}

function handleStripeError(res, err) {
  console.error('[stripe error]', err.raw || err.message || err);

  if (err.type === 'StripeAuthenticationError') {
    return res.status(401).json({
      error: 'Stripe rejected the request as unauthorized. Check STRIPE_RESTRICTED_KEY.',
    });
  }

  if (err.type === 'StripePermissionError') {
    return res.status(403).json({
      error:
        'Stripe key is valid but missing a required permission. Confirm the restricted key has ' +
        'read access to Customers, Subscriptions, Checkout Sessions, Invoices, Prices, Products, ' +
        'and Balance Transactions.',
      details: err.message,
    });
  }

  if (err.type === 'StripeRateLimitError') {
    return res.status(429).json({
      error: 'Hit Stripe rate limits while gathering revenue metrics. Try again shortly.',
    });
  }

  return res.status(502).json({
    error: 'Unexpected error fetching data from Stripe.',
    details: err.message || String(err),
  });
}

function handleRailwayError(res, err) {
  console.error('[railway error]', err.railwayBody || err.railwayErrors || err.message || err);

  if (err.railwayStatus === 401 || err.railwayStatus === 403) {
    return res.status(401).json({
      error: 'Railway rejected the request as unauthorized. Check RAILWAY_API_TOKEN — it must be a valid, unexpired project token for this project.',
    });
  }

  if (err.railwayStatus === 429) {
    return res.status(429).json({
      error: 'Hit Railway API rate limits while checking service health. Try again shortly.',
    });
  }

  if (err.railwayErrors) {
    return res.status(502).json({
      error: 'Railway API returned a GraphQL error while checking service health.',
      details: err.railwayErrors,
    });
  }

  return res.status(502).json({
    error: 'Unexpected error fetching data from Railway.',
    details: err.message || String(err),
  });
}

function handleGoogleError(res, err) {
  console.error('[google error]', (err.response && err.response.data) || err.message || err);

  const status = err.code || (err.response && err.response.status);

  if (status === 401 || status === 403) {
    return res.status(401).json({
      error:
        'Google rejected the request as unauthorized. Check GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / ' +
        'GOOGLE_REDIRECT_URI / GOOGLE_REFRESH_TOKEN — the refresh token may need to be regenerated via /auth/google.',
      details: (err.response && err.response.data) || err.message,
    });
  }

  if (status === 429) {
    return res.status(429).json({
      error: 'Hit Google API rate limits. Try again shortly.',
    });
  }

  return res.status(502).json({
    error: 'Unexpected error from Google (Docs/Drive/Gmail).',
    details: (err.response && err.response.data) || err.message || String(err),
  });
}

// Step 5F: maps a deliverDailyBrief() result onto the 4 Notion Daily Brief
// properties. docError (if the doc failed but email didn't) is folded into
// Email Error too, since there's no separate "Doc Error" column.
function buildDeliveryProperties(delivery) {
  const errorText = delivery.emailError || (delivery.docError ? `Doc error: ${delivery.docError}` : '');
  return {
    'Google Doc': { url: delivery.docUrl || null },
    'Email Sent': { checkbox: Boolean(delivery.emailSent) },
    'Email Error': { rich_text: [{ text: { content: errorText } }] },
    'Delivery Status': { select: { name: delivery.deliveryStatus } },
  };
}

function handleTwilioError(res, err) {
  console.error('[twilio error]', (err.moreInfo && err) || err.message || err);

  // Twilio SDK errors carry a numeric `status` (HTTP) and `code` (Twilio
  // error code, e.g. 21211 invalid "to" number, 21608 unverified trial
  // number, 20003 auth failure).
  if (err.status === 401 || err.code === 20003) {
    return res.status(401).json({
      error: 'Twilio rejected the request as unauthorized. Check TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN.',
      details: err.message,
    });
  }

  if (err.code === 21211 || err.code === 21608 || err.code === 21606) {
    return res.status(400).json({
      error:
        'Twilio rejected the phone number. Check that TWILIO_FROM_NUMBER and FOUNDER_PHONE_NUMBER are both ' +
        'valid E.164 numbers, and that FOUNDER_PHONE_NUMBER is verified if this is a Twilio trial account.',
      details: err.message,
    });
  }

  if (err.status === 429) {
    return res.status(429).json({
      error: 'Hit Twilio rate limits while sending SMS. Try again shortly.',
    });
  }

  return res.status(502).json({
    error: 'Unexpected error from Twilio while sending SMS.',
    details: err.message || String(err),
  });
}

// Step 6F: maps a deliverSms() result onto the 3 Notion Daily Brief SMS
// properties.
function buildSmsProperties(sms) {
  return {
    'SMS Sent': { checkbox: Boolean(sms.smsSent) },
    'SMS Error': { rich_text: [{ text: { content: sms.smsError || '' } }] },
    'SMS Status': { select: { name: sms.smsStatus } },
  };
}

function handleNotionError(res, err) {
  console.error('[notion error]', err.body || err.message || err);

  // Notion client errors carry a `code` and `status`
  if (err.code === 'unauthorized') {
    return res.status(401).json({
      error: 'Notion rejected the request as unauthorized. Check NOTION_API_KEY.',
    });
  }

  if (err.code === 'object_not_found') {
    return res.status(404).json({
      error:
        'Notion database not found, or the integration does not have access to it. ' +
        'Check the relevant NOTION_DATABASE_* variable and confirm the integration is shared with the page.',
    });
  }

  if (err.code === 'validation_error') {
    return res.status(400).json({
      error: 'Notion rejected the page payload (validation error). This usually means a property name or type mismatch.',
      details: err.message,
    });
  }

  return res.status(502).json({
    error: 'Unexpected error writing to Notion.',
    details: err.message || String(err),
  });
}

// ---------------------------------------------------------------------------
// Notion block builders (tiny helpers to keep buildDailyBriefContent readable)
// ---------------------------------------------------------------------------

function heading(text) {
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

// Notion's `children` array must be a flat array of blocks. bulletedList/
// numberedList return arrays, and buildSalesSummaryBlocks returns a flat
// array too, so flatten one level before sending.
function flattenChildren(children) {
  return children.flat();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Adaptiv Automation Hub listening on port ${PORT}`);
});
