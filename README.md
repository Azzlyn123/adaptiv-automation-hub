# Adaptiv Automation Hub

Adaptiv Athletics Railway Automation Hub. Currently does eight things:
1. **Daily Brief writer** — writes a Daily CEO Brief into the Notion "Daily Briefs" database.
2. **Stripe Revenue Agent** (read-only) — pulls subscription data from Stripe, writes a report row into the Notion "Sales" database, and files a Notion "Approvals" item when subscriptions are past due.
3. **Railway Health Agent** (read-only) — checks the frontend/backend Railway services and the backend health endpoint, writes a report row into the Notion "Railway Health" database, and files a Notion "Approvals" item when something looks wrong.
4. **Google Doc + Email Delivery** (OAuth) — after `/run-full-brief` writes to Notion, it also creates/updates a Google Doc with the full brief and emails a short summary to `FOUNDER_EMAIL`, with the Doc link in both Notion and the email.
5. **SMS Summary** (Twilio, opt-in) — after Google delivery, sends a short text summary of the brief to `FOUNDER_PHONE_NUMBER`. Disabled by default — set `SMS_ENABLED=true` to turn it on.
6. **Product/Bug Agent** — collects bugs, beta feedback, app store issues, and feature requests into the Notion "Product Bugs" and "Beta Feedback" databases, scores each bug's priority, files a Notion "Tasks" row for Critical/High severity bugs and a Notion "Approvals" row for Critical severity bugs, and folds a live Product/Bug summary into `/run-full-brief`.
7. **Film AI Build Team** (PLANNING ONLY) — seeds a 7-task MVP roadmap for volleyball hitting analysis into the Notion "Film AI Roadmap" database, reports on its status into the Notion "Agent Reports" database, and folds a live Film AI roadmap summary into `/run-full-brief`. Never runs computer vision, never touches real athlete video, never deploys anything — see Step 8 below.
8. **Coach Sales CRM Agent** — tracks coach/school/club leads in the Notion "Coach CRM" database, scores and ranks them, drafts (never sends) approval-gated outreach copy into the Notion "Coach Outreach" database, reports pipeline status into "Agent Reports", and folds a live Coach Sales summary into `/run-full-brief`. Never emails/texts/DMs a coach, never marks a deal Won, never includes student-athlete data in outreach — see Step 9 below.

Explicitly out of scope:
- No social channel connections
- **No writes to Stripe, ever.** This service only reads Stripe data. It never creates charges, never issues refunds, never cancels subscriptions, and never updates customers.
- **No writes to Railway, ever.** This service only reads Railway service/deployment status. It never restarts a service, never triggers a redeploy, never changes a variable, and never deletes anything. If something needs action, it files a Notion Approval item instead — a human decides and acts from there.
- **No Google password, ever.** Google delivery uses OAuth only. This service and this assistant never see or handle a live Google account password.
- **Only emails `FOUNDER_EMAIL`.** The Gmail send agent never emails anyone else.
- **Only texts `FOUNDER_PHONE_NUMBER`.** The SMS agent never texts anyone else, and the SMS body is always a short summary — never the full report.
- **No automatic code changes, deploys, bug closures, or feedback deletions.** The Product/Bug Agent only ever creates rows and recommendations — a human triages, fixes, and closes everything.
- **No computer vision, no real athlete video, ever (yet).** The Film AI Build Team only creates/reads Notion planning rows. No CV model runs, no video is uploaded, processed, or stored, and nothing gets deployed. Real athlete video stays off-limits until the Step 8H privacy gate (review, consent, deletion policy, secure storage plan) is cleared — Film AI data is flagged as a FERPA compliance risk in Adaptiv's business strategy.
- **No automatic outreach to coaches, ever.** The Coach Sales CRM Agent only ever creates lead rows, outreach drafts, tasks, and recommendations — it never sends an email, text, or DM, and it never marks a deal Won. A human reviews and approves every outreach draft in Notion, then sends it themselves. See Step 9's `SAFETY_RULES` in `lib/coachSalesAgent.js`.

## File structure

```
adaptiv-automation-hub/
├── server.js              Express app: routes + Notion writes + error handling
├── lib/
│   ├── stripeRevenueAgent.js   Stripe reads + metric calculations + Notion payload builders
│   ├── railwayHealthAgent.js   Railway GraphQL reads + status rules + Notion payload builders
│   ├── googleDeliveryAgent.js  OAuth + Google Docs/Drive/Gmail delivery + failure-isolation logic
│   ├── smsDeliveryAgent.js     Twilio SMS summary + failure-isolation logic
│   ├── productBugAgent.js      Priority scoring + validation + Notion payload builders for bugs/feedback
│   ├── filmAIPlanningAgent.js  MVP task definitions + Notion payload builders for the Film AI roadmap (planning only)
│   └── coachSalesAgent.js      Lead scoring + validation + outreach drafting + Notion payload builders for Coach CRM/Outreach
├── package.json
├── .env.example            Copy to .env for local dev — never commit real .env
├── .gitignore
└── README.md                This file
```

## Local setup

1. Install dependencies:
   ```
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in the values you need. At minimum, for the Daily Brief route:
   ```
   NOTION_API_KEY=ntn_...
   NOTION_DATABASE_DAILY_BRIEFS=771a8a200ddb4d33a748541e922c9439
   ```
   For the Stripe Revenue Agent routes, also set:
   ```
   NOTION_DATABASE_SALES=da173b9e87cf474f92782e7bc0d2090c
   NOTION_DATABASE_APPROVALS=f66c3c3db71a4187abff3d70b79aa34d
   STRIPE_RESTRICTED_KEY=rk_live_... (or rk_test_...)
   STRIPE_PRICE_ATHLETE=price_...
   STRIPE_PRICE_COACH_SCHOOL=price_...
   STRIPE_PRICE_COACH_TEAM=price_...
   ```
   For the Railway Health Agent routes, also set:
   ```
   NOTION_DATABASE_RAILWAY_HEALTH=435348e677f04a31acec1bf828b5b36d
   RAILWAY_API_TOKEN=... (a PROJECT token — see Step 4A)
   RAILWAY_FRONTEND_SERVICE=adaptive-athletics-frontend
   RAILWAY_BACKEND_SERVICE=adaptive-athletics-backend
   BACKEND_HEALTH_URL=https://api.adaptivathletics.com/api/health
   ```
   For Google Doc + Email Delivery, also set:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback (or your Railway URL — see Step 5B)
   GOOGLE_REFRESH_TOKEN=... (produced by visiting /auth/google once — see Step 5G)
   GOOGLE_DOC_FOLDER_ID=... (optional — leave blank to create docs at Drive root)
   FOUNDER_EMAIL=azzlynpotts@gmail.com
   ```
   For the SMS Summary (optional — leave `SMS_ENABLED` unset/false to skip), also set:
   ```
   SMS_ENABLED=true
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_FROM_NUMBER=+1... (your Twilio number, E.164 format — see Step 6A)
   FOUNDER_PHONE_NUMBER=+1... (your phone, E.164 format)
   ```
   For the Product/Bug Agent (`/submit-bug`, `/submit-feedback`, `/run-product-triage`), also set:
   ```
   NOTION_DATABASE_PRODUCT_BUGS=381dc6bf887d4851a63354038bc63244
   NOTION_DATABASE_BETA_FEEDBACK=397bbbc7383680eeb090cf87176d03e8
   NOTION_DATABASE_TASKS=e57e68cc9940495bb60253d19ef557ed
   ```
   (`NOTION_DATABASE_TASKS` and `NOTION_DATABASE_APPROVALS` are additive — see Step 7B.)
   For the Film AI Build Team (`/create-film-ai-mvp-plan`, `/run-film-ai-planning`) — PLANNING ONLY, also set:
   ```
   NOTION_DATABASE_FILM_AI_ROADMAP=436780aff5f843da809600d25b361d6e
   NOTION_DATABASE_AGENT_REPORTS=e00abb4ab7ba431ea6f0714d498db031
   ```
   (`NOTION_DATABASE_AGENT_REPORTS` is only required by `/run-film-ai-planning` — see Step 8B.)
   For the Coach Sales CRM Agent (`/add-coach-lead`, `/draft-coach-outreach`, `/run-coach-sales-review`), also set:
   ```
   NOTION_DATABASE_COACH_CRM=8c3de570b4434d34b416f6179c0c4075
   NOTION_DATABASE_COACH_OUTREACH=398bbbc738368052adb0f2bbe47b2b1c
   ```
   (`NOTION_DATABASE_AGENT_REPORTS` from Step 8 is reused here — only required by `/run-coach-sales-review` — see Step 9B.)
3. Run it:
   ```
   npm start
   ```
4. Test locally:
   ```
   curl http://localhost:3000/health
   curl -X POST http://localhost:3000/run-daily-brief
   curl -X POST http://localhost:3000/run-revenue-sync
   curl -X POST http://localhost:3000/run-railway-health
   curl -X POST http://localhost:3000/create-test-doc
   curl -X POST http://localhost:3000/send-test-email
   curl -X POST http://localhost:3000/send-test-sms
   curl -X POST http://localhost:3000/run-full-brief
   curl -X POST http://localhost:3000/submit-bug -H "Content-Type: application/json" -d "{\"title\":\"Test bug\",\"severity\":\"Low\"}"
   curl -X POST http://localhost:3000/submit-feedback -H "Content-Type: application/json" -d "{\"feedback\":\"Test feedback\"}"
   curl -X POST http://localhost:3000/run-product-triage
   curl -X POST http://localhost:3000/create-film-ai-mvp-plan
   curl -X POST http://localhost:3000/run-film-ai-planning
   curl -X POST http://localhost:3000/add-coach-lead -H "Content-Type: application/json" -d "{\"leadName\":\"Test Coach\",\"schoolProgram\":\"Phoenix Test High School\",\"role\":\"Head Coach\",\"sport\":\"Volleyball\",\"source\":\"Founder/Referral\",\"estimatedValue\":99}"
   curl -X POST http://localhost:3000/run-coach-sales-review
   ```

## Step 3A — Create a restricted Stripe key

Do this yourself in the Stripe dashboard — this service, and this assistant, should never see or handle a live Stripe secret.

1. Stripe Dashboard → Developers → API keys → Restricted keys → **Create restricted key**.
2. Name it `adaptiv-revenue-agent-readonly`.
3. Give **Read** access to:
   - Customers
   - Subscriptions
   - Checkout Sessions
   - Invoices
   - Prices
   - Products
   - Balance transactions
4. Leave everything else at **None**. In particular, do **not** grant: Refunds, Cancel subscriptions, Create charges, Update customers, Create payouts, or any delete permission.
5. Copy the `rk_live_...` (or `rk_test_...` while testing) value and paste it directly into Railway yourself (see Step 3B). Don't paste it into chat, a doc, or anywhere else.

## Step 3B — Railway environment variables

On the `adaptiv-automation-hub` Railway service, set:
```
STRIPE_RESTRICTED_KEY=
STRIPE_PRICE_ATHLETE=
STRIPE_PRICE_COACH_SCHOOL=
STRIPE_PRICE_COACH_TEAM=
NOTION_DATABASE_SALES=
NOTION_DATABASE_APPROVALS=
```
The `STRIPE_PRICE_*` and `NOTION_DATABASE_*` values are safe to store as plain env vars — only the Stripe key itself needs the careful handling above.

If a `STRIPE_SECRET_KEY` variable exists on the service from an earlier setup pass, remove it once `STRIPE_RESTRICTED_KEY` is confirmed working — this codebase only reads `STRIPE_RESTRICTED_KEY` now.

## Routes

### `GET /health`
Returns `{ "status": "ok" }`. No dependencies, no external calls — this should always respond as long as the process is up.

### `POST /run-daily-brief`
Creates one page in the `NOTION_DATABASE_DAILY_BRIEFS` database with placeholder structural content (no Stripe data). Properties: Name (title), Status = Yellow, Date = today, Top Priority (text). See `/run-full-brief` for a brief that includes real sales numbers.

### `POST /run-revenue-sync`
The Stripe Revenue Agent. For each run:
1. Fetches active subscriptions from Stripe and groups them by price ID.
2. Calculates:
   - Active Athlete / Coach-School / Coach-Team subscription counts
   - Estimated MRR (normalized across billing intervals — daily/weekly/monthly/yearly all roll up correctly)
   - New subscriptions in the last 24 hours
   - Canceled subscriptions in the last 24 hours
   - Past-due subscriptions (live snapshot, not time-windowed)
3. Writes one row into the Notion Sales database.
4. If any subscriptions are past due, creates an item in the Notion Approvals database: Action = "Draft failed-payment follow-up", Agent = "Revenue Agent", Risk = "Medium", Status = "Needs Approval", with the affected subscription/customer IDs in Notes. This only drafts an approval request — it never contacts the customer or touches Stripe.

Returns `201` with the computed metrics and the new Notion page URL(s). Returns a `4xx`/`5xx` if:
- Required env vars are missing (Notion or Stripe)
- The Stripe key is invalid, unauthorized, or missing a needed read scope
- Stripe rate-limits the request
- A Notion database ID is wrong, not shared with the integration, or a property name/type doesn't match

### `POST /run-railway-health`
The Railway Health Agent. For each run:
1. Resolves the Railway project/environment directly from the `RAILWAY_API_TOKEN` project token (never looks anything up by `RAILWAY_PROJECT_NAME`).
2. Finds the frontend and backend services by name (`RAILWAY_FRONTEND_SERVICE` / `RAILWAY_BACKEND_SERVICE`) and checks each one's latest deployment status.
3. Checks `BACKEND_HEALTH_URL` directly (status code + response time, 10s timeout).
4. Writes one row into the Notion Railway Health database.
5. Files Notion Approval item(s) when something looks wrong: backend health check failed (High risk), backend slow — over 2s but still responding (Medium), a service name doesn't match anything in the Railway project (Medium), or a service's latest deployment failed/crashed (Medium). Only drafts the request — never restarts, redeploys, or changes anything in Railway.

Returns `201` with the computed health data and the new Notion page URL(s). Returns a `4xx`/`5xx` if:
- Required env vars are missing (Notion or Railway)
- The Railway token is invalid, expired, or not a project token
- Railway rate-limits the request
- A Notion database ID is wrong, not shared with the integration, or a property name/type doesn't match

### `POST /run-full-brief`
Runs the Stripe revenue sync and the Railway health check, then creates a Daily Brief that includes real **Sales Summary** and **Railway Health** sections built from that same data, instead of listing Stripe/Railway as missing data sources. Also reads the current Product Bugs + Beta Feedback state (Step 7) and, if `NOTION_DATABASE_PRODUCT_BUGS`/`NOTION_DATABASE_BETA_FEEDBACK` are set, folds a **Product / Bug Agent** section into the brief too — additive, same as the rest of this route: a missing var or a failed Notion read here never blocks the brief. Also reads the current Film AI Roadmap state (Step 8) and, if `NOTION_DATABASE_FILM_AI_ROADMAP` is set, folds a **Film AI Build Team** section into the brief too — same additive pattern, read-only, never runs CV code or touches video. Then attempts Google Doc + email delivery (Step 5), then an SMS summary (Step 6), and writes the results (Google Doc URL / Email Sent / Email Error / Delivery Status, plus SMS Sent / SMS Error / SMS Status) back onto the same Daily Brief row. Neither Google delivery nor SMS ever blocks this response — if either is not configured or fails, the Notion brief is still created; `delivery.deliveryStatus` comes back as `Not Sent` / `Partial` / `Failed` and `sms.smsStatus` comes back as `Disabled` / `Failed` / `Sent`. Returns `201` with the metrics, health data, `productBugSummary`, `filmAISummary`, the Sales/Railway Health/Approvals page URLs (as applicable), the Daily Brief page URL, the `delivery` result, and the `sms` result.

### `GET /auth/google`
Step 5G one-time setup route. Visit this **in a browser** (not curl) to start the OAuth consent flow — redirects to Google's consent screen for the scopes in Step 5C.

### `GET /oauth2callback`
Google redirects here after you approve consent. Exchanges the one-time code for tokens and returns the refresh token **once**, to be copied into Railway as `GOOGLE_REFRESH_TOKEN`. No other route in this service ever exposes it.

### `POST /create-test-doc`
Step 5H. Creates a small test Google Doc to confirm OAuth + Docs/Drive scopes work. Returns `201` with the doc URL.

### `POST /send-test-email`
Step 5H. Sends a test email to `FOUNDER_EMAIL` only, to confirm Gmail send scope works. Returns `200` on success.

### `POST /send-test-sms`
Step 6D. Sends a short test SMS to `FOUNDER_PHONE_NUMBER` only, to confirm Twilio credentials + the from-number work. Returns `200` with `status: "disabled"` (no send attempted) if `SMS_ENABLED` isn't `"true"`, or `200` with `status: "ok"` on success.

### `POST /submit-bug`
Step 7. Records one bug/feature-request/UX-issue/app-store-issue/Film-AI-task/coach-or-athlete-feedback item into the Notion Product Bugs database. Body:
```json
{
  "title": "", "type": "Bug", "severity": "High", "source": "Founder",
  "screen": "", "userRole": "Athlete", "reproSteps": "", "expected": "", "actual": "", "notes": "",
  "flags": {
    "blocksSignup": false, "blocksPayment": false, "blocksCoachDashboard": false,
    "blocksWorkoutCompletion": false, "blocksOnboarding": false, "affectsMultipleUsers": false,
    "appStoreRisk": false, "filmAIBlocker": false
  }
}
```
Only `title` and `severity` are required — everything else defaults sensibly (`type` → Bug, `source` → Founder, `userRole` → Unknown, all flags → false). Computes a Priority Score (see Step 7C), writes the row with `Status: New`, and — additively — creates a Notion Tasks row for Critical/High severity and a Notion Approvals row for Critical severity only (skipped, not failed, if `NOTION_DATABASE_TASKS`/`NOTION_DATABASE_APPROVALS` aren't set yet). Returns `201` with `priorityScore`, `bugPageUrl`, `taskCreated`/`taskPageUrl`, `approvalCreated`/`approvalPageUrl`. Returns `400` if `title`/`severity` are missing or any field doesn't match its allowed values.

### `POST /submit-feedback`
Step 7. Records one beta-tester/coach/athlete feedback item into the Notion Beta Feedback database. Body:
```json
{ "feedback": "", "user": "", "role": "Athlete", "area": "", "painLevel": "Medium", "actionNeeded": "" }
```
Only `feedback` is required. Writes the row with `Status: New`. If 3+ feedback items now share the same `area`, the JSON response includes a `recommendation` string suggesting a UX fix for that area — no extra Notion row is created for it. Returns `201` with `feedbackPageUrl` and `recommendation` (or `null`).

### `POST /run-product-triage`
Step 7. Read-only report. Queries every row currently in Product Bugs + Beta Feedback, ranks open bugs (`New`/`Triaged`/`In Progress`/`Blocked`) by Priority Score, and returns the same Green/Yellow/Red status used in the Daily Brief plus `criticalBugs`, `highBugs`, `filmAIBlockers`, `newFeedbackCount`, `recommendedFixToday`, `rankedOpenBugs`, and `repeatedFeedbackAreas`. Never closes a bug, never creates a Task/Approval, never changes anything — use `/submit-bug` for writes.

### `POST /create-film-ai-mvp-plan`
Step 8. PLANNING ONLY. Writes the 7 volleyball-hitting-analysis MVP tasks (see Step 8F) into the Notion Film AI Roadmap database, each starting at `Status: Backlog`. Never runs computer vision, never touches real athlete video, never deploys anything, never writes to a video storage bucket — there isn't one configured. Safe to call more than once; each call files a fresh set of 7 rows rather than deduplicating, so only run it when you actually want to (re)seed the roadmap. Returns `201` with `tasksCreated` (task name + Notion page URL for each of the 7 rows).

### `POST /run-film-ai-planning`
Step 8. Read-only report. Queries the current state of the Film AI Roadmap, rolls it up into a Green/Yellow/Red status (`gatherFilmAISummary()` in `lib/filmAIPlanningAgent.js`), and files one summary row into the Notion Agent Reports database. Does not create or modify a Roadmap task, does not run any CV code, does not touch video. Returns `201` with `filmAIStatus`, `totalTasks`/`openCount`/`blockedCount`/`doneCount`, `criticalOpen`, `blockedTasks`, `tasksByAgent`, `nextUp`, `privacyGateCleared` (always `false` — no code path in this service flips it), and `reportPageUrl`.

### `POST /add-coach-lead`
Step 9. Records one coach/school/club lead into the Notion Coach CRM database. Body:
```json
{
  "leadName": "", "schoolProgram": "", "role": "Head Coach", "sport": "Volleyball",
  "email": "", "phone": "", "source": "Founder/Referral", "stage": "New Lead",
  "priority": "", "lastContact": "", "nextFollowUp": "", "objection": "", "notes": "",
  "estimatedValue": 0
}
```
Only `leadName` is required — everything else defaults sensibly (`stage` → New Lead). `Approved Outreach` is always written as `false` — no code path in this route can pre-approve outreach. Rejects (`400`) any request that tries to set `stage: "Won"` — marking a deal Won is a manual, human-only edit in Notion, never an automated one (see `SAFETY_RULES` in `lib/coachSalesAgent.js`). Returns `201` with `leadPageUrl`, `leadPageId`, `leadScore`, and `leadScoreReasons` (see Step 9C for the scoring formula).

### `POST /draft-coach-outreach`
Step 9. Generates a short, coach-friendly outreach draft (deterministic template — no LLM call, so every draft is auditable before a human approves it) and files it into the Notion Coach Outreach database. Body:
```json
{
  "leadPageId": "", "leadName": "", "schoolProgram": "", "role": "Head Coach",
  "channel": "Email", "context": ""
}
```
`leadPageId` (the Notion page ID of the lead in Coach CRM) and `channel` are required. Rejects (`400`) any request that includes an athlete-specific field (`athleteName`, `athleteData`, `injury`, `medicalInfo`, `grades`, `studentData`) — outreach drafts may never include student-athlete data. `Status` is always written as `"Needs Approval"` and `Approved` is always `false` — no code path in this route can mark a draft Approved or Sent, and **nothing is ever sent**. A human reviews the draft in Notion, edits if needed, and sends it themselves. Returns `201` with `draftPageUrl` and the generated `draftText`.

### `POST /run-coach-sales-review`
Step 9. Read-only report. Queries Coach CRM (+ Coach Outreach), scores and ranks every lead (Step 9C formula), rolls the pipeline up into a Green/Yellow/Red status against the first-sales target (Step 9E), and files one summary row into the Notion Agent Reports database. Never creates or edits a lead or an outreach draft. Returns `201` with `coachSalesStatus`, `totalLeads`/`activeLeadCount`/`conversationCount`/`demoCount`/`wonCount`/`lostCount`, `outreachDraftCount`/`outreachNeedsApprovalCount`, `topLeads` (top 5, ranked by score), `target`, and `reportPageUrl`.

## Step 3D — Notion Sales database fields

Already set up on the Sales database:

| Property | Type |
|---|---|
| Date | Date |
| MRR | Number |
| Athlete Subs | Number |
| Coach Team Subs | Number |
| Coach School Subs | Number |
| New Subs | Number |
| Canceled Subs | Number |
| Past Due | Number |
| Notes | Text |

(`Name` is the database's built-in title property — every row is titled "Revenue Report — YYYY-MM-DD".)

The Notion Approvals database was already set up in Step 1/2 with Action, Agent, Risk, Status, Tool, Created, and Notes — no changes needed there. "Revenue Agent" is added as a new Agent option automatically the first time `/run-revenue-sync` files an approval.

## Step 3E — Test it

After deploying:
```
curl https://<your-railway-domain>/health
```
Then:
```
curl -X POST https://<your-railway-domain>/run-revenue-sync
```
Expected: a new row appears in Notion → Sales. If any subscriptions are past due, a new row also appears in Notion → Approvals.

Then:
```
curl -X POST https://<your-railway-domain>/run-full-brief
```
Expected: a new Daily Brief appears in Notion with a "Sales Summary" section.

**If the numbers look wrong, stop and fix the Stripe price-ID mapping (`STRIPE_PRICE_ATHLETE` / `STRIPE_PRICE_COACH_SCHOOL` / `STRIPE_PRICE_COACH_TEAM`) before adding anything else.** The MRR and per-plan counts in `lib/stripeRevenueAgent.js` (`computeMrrAndPlanCounts`) are only as correct as those three price IDs.

## Step 4A — Create a Railway project token

Do this yourself in the Railway dashboard — this service, and this assistant, should never see or handle a live Railway token.

1. Railway Dashboard → `adaptiv-athletics` project → Settings → Tokens → **Create Token**.
2. Choose a **Project Token** (scoped to this one project + environment), not an account/workspace token.
3. Name it `adaptiv-health-agent-readonly`.
4. Give it the most limited scope available for this project/environment.
5. Copy the token value and paste it directly into Railway yourself, on the `adaptiv-automation-hub` service, as `RAILWAY_API_TOKEN` (see Step 4B). Don't paste it into chat, a doc, or anywhere else.

Project tokens authenticate with a `Project-Access-Token` header — not `Authorization: Bearer`, which is for account/workspace tokens. `lib/railwayHealthAgent.js` already uses the correct header.

## Step 4B — Railway environment variables

On the `adaptiv-automation-hub` Railway service, set:
```
RAILWAY_API_TOKEN=
RAILWAY_FRONTEND_SERVICE=adaptive-athletics-frontend
RAILWAY_BACKEND_SERVICE=adaptive-athletics-backend
BACKEND_HEALTH_URL=
NOTION_DATABASE_RAILWAY_HEALTH=
NOTION_DATABASE_APPROVALS=
```
`RAILWAY_FRONTEND_SERVICE` / `RAILWAY_BACKEND_SERVICE` / `BACKEND_HEALTH_URL` / `NOTION_DATABASE_*` are safe to store as plain env vars — only the token itself needs the careful handling above.

Note: `RAILWAY_PROJECT_NAME` is **not** required by this agent. It resolves its project/environment straight from the project token, so a mismatched or misspelled `RAILWAY_PROJECT_NAME` (if one exists on the service from an earlier setup pass) can't break this route.

## Step 4C — Notion Railway Health database fields

Already set up on the Railway Health database:

| Property | Type |
|---|---|
| Date | Date |
| Overall Status | Select (Green / Yellow / Red / Missing / Unknown) |
| Frontend | Select (Green / Yellow / Red / Missing / Unknown) |
| Backend | Select (Green / Yellow / Red / Missing / Unknown) |
| Database | Select (Green / Yellow / Red / Missing / Unknown) |
| Latest Deploy | Text |
| Health URL | URL |
| Response Time | Number |
| Errors | Text |
| Notes | Text |

(`Name` is the database's built-in title property — every row is titled "Railway Health — YYYY-MM-DD".)

## Step 4E — Test it

After deploying:
```
curl https://<your-railway-domain>/health
```
Then:
```
curl -X POST https://<your-railway-domain>/run-railway-health
```
Expected: a new row appears in Notion → Railway Health. If something looks wrong (backend down, slow, missing service, or failed deploy), a new row also appears in Notion → Approvals.

Then:
```
curl -X POST https://<your-railway-domain>/run-full-brief
```
Expected: a new Daily Brief appears in Notion with both a "Sales Summary" section and a "Railway Health" section.

## Step 4G — Status rules

- **Green**: frontend found with a successful latest deploy, backend found with a successful latest deploy, and the health URL responds under 750ms.
- **Yellow**: one metric is missing/unknown, the health URL responds slow (750ms–2000ms), or the database status is unknown (Railway database monitoring isn't wired up in this build — always reports Unknown).
- **Red**: backend health check fails outright, a service's latest deployment failed/crashed, or a mapped service isn't found in the Railway project (Missing collapses into Red at the Overall Status level).

Response time thresholds: Green under 750ms, Yellow 750–2000ms, Red over 2000ms or failed.

## Step 4H — Approval rules

- Backend health check failed → **Investigate backend outage** (High risk)
- Backend responded, but over 2 seconds → **Review backend performance** (Medium risk)
- Frontend or backend service name not found in the Railway project → **Verify Railway service mapping** (Medium risk)
- A service's latest deployment status looks bad (FAILED/CRASHED) → **Review failed deploy logs** (Medium risk)

**This agent never auto-restarts or redeploys anything.** Every one of the items above only files a Notion Approval request — a human reviews and acts on it. Restart/redeploy automation stays locked until the reporting system has proven stable over time.

## Step 5A — Create a Google Cloud project

Do this yourself in the Google Cloud Console — this service, and this assistant, should never see or handle a live Google password.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project named `Adaptiv Automation Hub`.
3. Enable these APIs for that project (APIs & Services → Library):
   - Google Docs API
   - Google Drive API
   - Gmail API

## Step 5B — Create OAuth credentials

1. APIs & Services → Credentials → Create Credentials → **OAuth client ID**.
2. Application type: **Web application**. Name: `Adaptiv Automation Hub`.
3. Add an authorized redirect URI:
   ```
   https://YOUR-AUTOMATION-HUB-URL.up.railway.app/oauth2callback
   ```
   (Use your actual Railway domain — the one you got from Settings → Networking in Step 4.)
4. Also add the local testing URI:
   ```
   http://localhost:3000/oauth2callback
   ```
5. Download the OAuth client info, but **do not paste it into chat or a doc**. You need `Client ID` and `Client secret` from it for Railway (Step 5D).

## Step 5C — Scopes

This app requests only:
- `https://www.googleapis.com/auth/documents` — create/update the brief doc
- `https://www.googleapis.com/auth/drive.file` — only files this app creates or opens, not full Drive access
- `https://www.googleapis.com/auth/gmail.send` — send mail as the authorized account, not full Gmail access

These are hardcoded in `lib/googleDeliveryAgent.js` (`SCOPES`) — no broader scopes are ever requested.

## Step 5D — Railway environment variables

On the `adaptiv-automation-hub` Railway service, set:
```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://YOUR-AUTOMATION-HUB-URL.up.railway.app/oauth2callback
GOOGLE_REFRESH_TOKEN=
FOUNDER_EMAIL=azzlynpotts@gmail.com
GOOGLE_DOC_FOLDER_ID=
```
`GOOGLE_REFRESH_TOKEN` doesn't exist yet at this point — it's produced by the OAuth flow in Step 5G, after this code is deployed. Leave it blank for now and come back to it.

## Step 5F — Notion Daily Briefs properties

Add these 4 properties to the Notion Daily Briefs database:

| Property | Type |
|---|---|
| Google Doc | URL |
| Email Sent | Checkbox |
| Email Error | Text |
| Delivery Status | Select (Not Sent / Sent / Partial / Failed) |

## Step 5G — Deploy and authorize Google

After this code is deployed to Railway with `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` set:

1. Open `https://YOUR-AUTOMATION-HUB-URL.up.railway.app/auth/google` in your browser.
2. Sign in with the Google account you want the hub to send from, and approve the requested scopes.
3. You'll land on `/oauth2callback`, which shows a `refreshToken` value once — copy it.
4. Add it to Railway as `GOOGLE_REFRESH_TOKEN`, then redeploy.

Keep the refresh token private — it's a long-lived credential. If you ever need a new one (e.g. you revoked access), visit `/auth/google` again; if Google doesn't return a fresh refresh token because this app was already authorized before, revoke access first at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and retry.

## Step 5H — Test Google delivery

```
curl -X POST https://YOUR-AUTOMATION-HUB-URL.up.railway.app/create-test-doc
```
Expected: a Google Doc appears in your Drive (or in `GOOGLE_DOC_FOLDER_ID` if set).

If that works:
```
curl -X POST https://YOUR-AUTOMATION-HUB-URL.up.railway.app/send-test-email
```
Expected: an email arrives at `FOUNDER_EMAIL`.

Then:
```
curl -X POST https://YOUR-AUTOMATION-HUB-URL.up.railway.app/run-full-brief
```
Expected: Notion Daily Brief row created, Google Doc created, email sent, Google Doc URL saved on the Notion row.

## Step 5I — Email format

Subject: `Adaptiv Daily CEO Brief — <display date>`. Body is short (Status, Top 3 Priorities, one-line Sales/Railway/Product summaries, Approvals Needed, then the Google Doc link) — the full report lives in the Doc, not the email. See `buildEmailBody()` in `lib/googleDeliveryAgent.js`.

## Step 5J — Failure rules

- Notion works, Google Doc fails → Notion brief is still created; `Delivery Status` = `Failed` or `Partial`, `Email Error` (or a folded-in doc error) explains why.
- Google Doc works, email fails → the Doc link is still saved on the Notion row, `Email Error` is populated, `Delivery Status` = `Partial`.
- Email works, Notion's follow-up write fails → the doc/email already succeeded; the failure is logged to Railway logs (no automatic retry task yet — noted as a known limitation below).
- All delivery fails → `Delivery Status` = `Failed`, full error detail in Railway logs. The core Notion Daily Brief itself is unaffected either way — `/run-full-brief` always completes as long as Notion, Stripe, and Railway are healthy.

## Step 6A — Create a Twilio account + phone number

Do this yourself in the Twilio console — this service, and this assistant, should never see or handle live Twilio credentials.

1. Go to [twilio.com](https://www.twilio.com/) and create an account (or sign in to an existing one).
2. From the [Twilio Console](https://console.twilio.com/) dashboard, copy your **Account SID** and **Auth Token** — you'll need both for Railway (Step 6B). Don't paste them into chat, a doc, or anywhere else.
3. Get a phone number: Phone Numbers → Manage → Buy a number (or use the trial number Twilio assigns automatically). This becomes `TWILIO_FROM_NUMBER`.
4. If you're on a Twilio **trial** account, it can only send SMS to numbers you've verified: Phone Numbers → Manage → Verified Caller IDs → add `FOUNDER_PHONE_NUMBER` there before testing.
5. Both `TWILIO_FROM_NUMBER` and `FOUNDER_PHONE_NUMBER` must be in **E.164 format** (e.g. `+15551234567` — country code, no spaces, no dashes, no parentheses).

## Step 6B — Railway environment variables

On the `adaptiv-automation-hub` Railway service, set:
```
SMS_ENABLED=true
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
FOUNDER_PHONE_NUMBER=
```
`SMS_ENABLED` and the phone numbers are safe to store as plain env vars — only `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` need the careful handling above. Leave `SMS_ENABLED` unset or `false` to skip SMS entirely — every other route and `/run-full-brief` itself work exactly the same either way.

## Step 6C — SMS body format

Summary only — never the full report. The full report already lives in Notion, the Google Doc, and the email. A typical message looks like:
```
Adaptiv Brief: Yellow. Revenue: $4,200 MRR. App: Backend healthy. Approvals: 1. Top task: Ship Step 6. Doc: https://docs.google.com/document/d/.../edit
```
Built by `buildSmsSummary()` in `lib/smsDeliveryAgent.js`, capped at 320 characters (truncated with `…` if a long top-priority string would push it over).

## Step 6D — Test it

After deploying with the Step 6B variables set:
```
curl -X POST https://YOUR-AUTOMATION-HUB-URL.up.railway.app/send-test-sms
```
Expected: a text arrives at `FOUNDER_PHONE_NUMBER`. If `SMS_ENABLED` isn't `"true"`, this returns `200` with `status: "disabled"` instead of sending anything.

Then:
```
curl -X POST https://YOUR-AUTOMATION-HUB-URL.up.railway.app/run-full-brief
```
Expected: same as Step 5H, plus a text summary arrives at `FOUNDER_PHONE_NUMBER`, and the Notion Daily Brief row's `SMS Sent` / `SMS Status` reflect it.

## Step 6F — Notion Daily Briefs properties

Add these 3 properties to the Notion Daily Briefs database:

| Property | Type |
|---|---|
| SMS Sent | Checkbox |
| SMS Error | Text |
| SMS Status | Select (Not Sent / Sent / Failed / Disabled) |

## Step 6G — Failure rules

- `SMS_ENABLED` is not `"true"` → `SMS Status` = `Disabled`, no Twilio call is made, nothing else is affected.
- `SMS_ENABLED=true` but a required Twilio env var is missing → `SMS Status` = `Failed`, `SMS Error` lists which variable(s).
- Twilio credentials/number are set but the API call fails (bad auth, unverified trial number, invalid number, rate limit, etc.) → `SMS Status` = `Failed`, `SMS Error` has the Twilio error message.
- Twilio call succeeds → `SMS Status` = `Sent`, `SMS Sent` = checked.
- SMS delivery never blocks `/run-full-brief` — the Notion brief, Google Doc, and email are unaffected by SMS success or failure either way, and the SMS step always runs last so it can include the Google Doc link when available.

## Step 7A — Notion Product Bugs + Beta Feedback database fields

Already set up on the **Product Bugs** database:

| Property | Type |
|---|---|
| Bug / Issue | Title |
| Type | Select (Bug, Feature Request, UX Issue, App Store Issue, Film AI Task, Coach Feedback, Athlete Feedback) |
| Severity | Select (Critical, High, Medium, Low) |
| Status | Select (New, Triaged, In Progress, Blocked, Fixed, Rejected) |
| Source | Select (Founder, Beta Tester, Coach, Athlete, App Store, Google Play, Railway, Daily Brief) |
| Screen | Text |
| User Role | Select (Athlete, Coach, Admin, Unknown) |
| Repro Steps | Text |
| Expected | Text |
| Actual | Text |
| Owner | Text |
| Priority Score | Number |
| Created | Date |
| Notes | Text |

Already set up on the **Beta Feedback** database:

| Property | Type |
|---|---|
| Feedback | Title |
| User | Text |
| Role | Select (Athlete, Coach, Admin, Beta Tester) |
| Area | Select (Home Dashboard, Onboarding, Workouts, Progress, Nutrition, Injuries, Coach Dashboard, Team Messaging, Film AI, Other) |
| Pain Level | Select (Low, Medium, High) |
| Status | Select (New, Reviewed, In Progress, Addressed, Won't Fix) |
| Action Needed | Text |
| Created | Date |

The **Tasks** database (used for Critical/High severity bugs) has: Name (Title), Status (Select: To Do, In Progress, Done), Priority (Select: Critical, High, Medium, Low), Source Item (Text), Created (Date). The **Approvals** database (used for Critical severity bugs) already had Action/Agent/Risk/Status/Tool/Created/Notes from Step 1/2 — "Product/Bug Agent" is added as a new Agent option automatically the first time a Critical bug files an approval.

## Step 7B — Railway environment variables

On the `adaptiv-automation-hub` Railway service, set:
```
NOTION_DATABASE_PRODUCT_BUGS=
NOTION_DATABASE_BETA_FEEDBACK=
NOTION_DATABASE_TASKS=
```
`NOTION_DATABASE_APPROVALS` is already set from Step 3B/4B — no new value needed there. All of these are safe to store as plain env vars; there's no new secret in Step 7 beyond the existing `NOTION_API_KEY`.

## Step 7C — Priority score formula

```
base = Critical: 100, High: 75, Medium: 40, Low: 15

+ 25  blocksSignup
+ 25  blocksPayment
+ 20  blocksCoachDashboard
+ 15  blocksWorkoutCompletion
+ 15  blocksOnboarding
+ 15  affectsMultipleUsers
+ 25  appStoreRisk
+ 20  filmAIBlocker
```
Implemented in `computePriorityScore()` in `lib/productBugAgent.js`. Active flags are also written into the bug's Notes field as `Flags: blocksSignup, appStoreRisk` (etc.) so they stay visible in Notion even though there's no dedicated column per flag.

## Step 7D — Test with one fake bug

After deploying with the Step 7B variables set:
```
curl -X POST https://YOUR-AUTOMATION-HUB-URL.up.railway.app/submit-bug \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Workout start button does not respond",
    "type": "Bug",
    "severity": "High",
    "source": "Founder",
    "screen": "Workouts",
    "userRole": "Athlete",
    "reproSteps": "Open Workouts tab, select today'\''s workout, tap Start Workout.",
    "expected": "Workout timer starts and first exercise appears.",
    "actual": "Button taps but nothing changes.",
    "notes": "Test bug for Product/Bug Agent.",
    "flags": {
      "blocksSignup": false, "blocksPayment": false, "blocksCoachDashboard": false,
      "blocksWorkoutCompletion": true, "blocksOnboarding": false,
      "affectsMultipleUsers": true, "appStoreRisk": false, "filmAIBlocker": false
    }
  }'
```
Expected: a new row in Notion → Product Bugs (Priority Score `75 + 15 + 15 = 105`), a new row in Notion → Tasks (High severity creates a task), and — on the next `/run-full-brief` — a "Product / Bug Agent" section in the Daily Brief showing this bug under High Priority Bugs.

## Step 7E — Test with one feedback item

```
curl -X POST https://YOUR-AUTOMATION-HUB-URL.up.railway.app/submit-feedback \
  -H "Content-Type: application/json" \
  -d '{
    "feedback": "I do not understand what readiness score means or what I should do with it.",
    "user": "Beta tester",
    "role": "Athlete",
    "area": "Home Dashboard",
    "painLevel": "Medium",
    "actionNeeded": "Add short explanation under readiness score and link to recommended action."
  }'
```
Expected: a new row in Notion → Beta Feedback. If this is the 3rd+ open feedback item with `area: "Home Dashboard"`, the JSON response's `recommendation` field will say so — that's the "enough similar feedback → recommend a UX fix" behavior from the spec, surfaced directly in the response rather than as a separate Notion row.

## Step 7F — Daily Brief Product/Bug section

`/run-full-brief` now includes (when `NOTION_DATABASE_PRODUCT_BUGS`/`NOTION_DATABASE_BETA_FEEDBACK` are set):
```
## Product / Bug Agent
Status: Green / Yellow / Red
Critical Bugs: -
High Priority Bugs: -
New Feedback: -
Recommended Fix Today: -
Film AI Blockers: -
Tasks Created: -
```
Status rules (`gatherProductBugSummary()` in `lib/productBugAgent.js`):
- **Green** — no open Critical bugs, no open High bugs, no repeated feedback pattern.
- **Yellow** — an open High severity bug exists, or 3+ open feedback items share the same Area.
- **Red** — an open Critical severity bug exists, or an open Critical bug is an App Store Issue or its title mentions payment/signup/outage.

"Tasks Created" is always `0` inside `/run-full-brief` (that route only reads open bugs/feedback) — actual task counts come from `/submit-bug` responses (`taskCreated`).

## Step 7G — What this agent answers every day

Each `/run-product-triage` or `/run-full-brief` run answers: what broke (Critical/High open bugs), what confused users (repeated feedback by Area), what blocks payment/signup/coaches (via the flags folded into Notes + the App Store/payment/signup keyword check in the status rules), what should be fixed today (`recommendedFixToday` — highest Priority Score open bug, or the most-repeated feedback Area), what can wait (everything else, ranked lowest in `rankedOpenBugs`), and what should become a Film AI requirement (`filmAIBlockers` — open bugs typed "Film AI Task").

## Step 8 — Film AI Build Team (PLANNING ONLY)

**This entire step is planning scaffolding.** It writes and reads Notion rows to track the volleyball-hitting-analysis MVP build. It does not run any computer vision, does not touch real athlete video, does not create any deployment action, and does not connect to production user videos. Treat it the same way you'd treat a project-management tool — because that's all it is right now.

### Step 8A — Notion database fields

Already set up on the **Film AI Roadmap** database:

| Property | Type |
|---|---|
| Task | Title |
| Agent | Select (Film AI Product Lead, Computer Vision Engineer, Volleyball Technique Analyst, Film AI QA Agent, Film AI Demo Agent) |
| Status | Select (Backlog, Ready, In Progress, Blocked, Testing, Done) |
| Priority | Select (Critical, High, Medium, Low) |
| Feature Area | Select (Upload, Pose Detection, Technique Scoring, Report Generation, Database Save, Coach View, Athlete View, Demo) |
| Sport | Select (Volleyball, All Sports) |
| Notes | Text |
| Due Date | Date |

Already set up on the **Agent Reports** database (previously reserved/unused — now active as of Step 8):

| Property | Type |
|---|---|
| Name | Title |
| Agent | Select (same 5 agent options as above) |
| Date | Date |
| Summary | Text |

Also already set up (schema only — nothing in this service reads or writes to it yet) on the **Film AI Test Clips** database, for the future QA/demo phase:

| Property | Type |
|---|---|
| Clip | Title |
| Sport | Select (Volleyball, All Sports) |
| Skill | Select (Hitting) |
| Angle | Select (Side, Diagonal) |
| Lighting | Select (Good, Medium, Poor) |
| Result | Select (Pass, Needs Review, Fail) |
| Confidence | Number |
| Notes | Text |

### Step 8B — Railway environment variables

On the `adaptiv-automation-hub` Railway service, set:
```
NOTION_DATABASE_FILM_AI_ROADMAP=
NOTION_DATABASE_AGENT_REPORTS=
```
Both are safe to store as plain env vars — there's no new secret in Step 8 beyond the existing `NOTION_API_KEY`. `NOTION_DATABASE_FILM_AI_ROADMAP` is required by both new routes; `NOTION_DATABASE_AGENT_REPORTS` is only required by `/run-film-ai-planning`.

### Step 8C — The volleyball hitting MVP pipeline

The first Film AI MVP is scoped to one skill, one sport: **upload a volleyball hitting clip → detect movement → analyze hitting mechanics → score technique → generate a report → suggest drills → save to the athlete's profile.** Each stage of that pipeline is one of the 7 seeded roadmap tasks (Step 8F) — nothing further is in scope for the MVP.

### Step 8D — Test it

After deploying with the Step 8B variables set:
```
curl -X POST https://YOUR-AUTOMATION-HUB-URL.up.railway.app/create-film-ai-mvp-plan
```
Expected: 7 new rows appear in Notion → Film AI Roadmap, one per MVP task, all starting at `Status: Backlog`.

Then:
```
curl -X POST https://YOUR-AUTOMATION-HUB-URL.up.railway.app/run-film-ai-planning
```
Expected: a new row appears in Notion → Agent Reports summarizing the roadmap status, and the JSON response includes `filmAIStatus`, `nextUp`, and the rest of the rollup.

Then:
```
curl -X POST https://YOUR-AUTOMATION-HUB-URL.up.railway.app/run-full-brief
```
Expected: the Daily Brief now includes a "Film AI Build Team" section showing the roadmap status.

### Step 8E — Report output format (for later — not built by this service yet)

Once real technique scoring exists, each Film AI Report is expected to follow this fixed markdown template (this is documented now so the eventual report-generation code has a locked target — this service does not generate this yet):
```
# Film AI Report
Sport: Volleyball
Skill: Hitting
Clip Quality: Good / Medium / Poor
Confidence: 0-100

## Technique Score
Score: 0-100

## What Looked Good
## What Needs Work
## Key Mechanics
Approach / Plant / Jump / Arm swing / Contact point / Landing

## Suggested Drills
1.
2.
3.

## Coach Notes
## Disclaimer
This is a development tool, not a medical or injury diagnosis.
```

### Step 8F — The 7 MVP roadmap tasks

Written by `/create-film-ai-mvp-plan` (see `MVP_TASKS` in `lib/filmAIPlanningAgent.js` for the full acceptance criteria/blockers on each):

| # | Task | Agent | Priority | Feature Area |
|---|---|---|---|---|
| 1 | Build clip upload flow (web + mobile) | Film AI Product Lead | Critical | Upload |
| 2 | Detect athlete movement / pose in clip | Computer Vision Engineer | Critical | Pose Detection |
| 3 | Analyze hitting mechanics (approach, plant, jump, arm swing, contact, landing) | Volleyball Technique Analyst | Critical | Technique Scoring |
| 4 | Score technique (0-100 + confidence) | Volleyball Technique Analyst | High | Technique Scoring |
| 5 | Generate Film AI Report | Film AI Product Lead | High | Report Generation |
| 6 | Suggest drills (1-3 per report) | Volleyball Technique Analyst | Medium | Report Generation |
| 7 | Save results to athlete profile / Notion / database | Computer Vision Engineer | High | Database Save |

Tasks 1 and 7 carry an explicit blocker note tying them to the Step 8H privacy gate — neither can move past "Ready" with real athlete data until that gate clears.

### Step 8G — Daily Brief Film AI section

`/run-full-brief` now includes (when `NOTION_DATABASE_FILM_AI_ROADMAP` is set):
```
## Film AI Build Team
Status: Green / Yellow / Red (planning only — no CV model running yet)
Roadmap: X done / Y open / Z total
Blocked Tasks: -
Critical Open Tasks: -
Next Up: -
Privacy gate cleared for real athlete video: No
```
Status rules (`gatherFilmAISummary()` in `lib/filmAIPlanningAgent.js`):
- **Green** — no blocked tasks, no open Critical-priority tasks.
- **Yellow** — a blocked task exists, or an open Critical-priority task exists (but not both).
- **Red** — both a blocked task and an open Critical-priority task exist.

### Step 8H — Privacy gate (do not skip)

Adaptiv's business strategy flags data privacy and FERPA compliance as a major risk for Film AI specifically, because it involves video of (potentially minor) athletes. Before any real athlete video is uploaded, processed, or stored — by this service or any future one — the following need to be in place:
- A privacy review
- File size limits
- A video deletion policy
- Terms language covering video collection and use
- Coach **and** athlete consent (and parent/guardian consent for minors)
- A secure storage plan

None of this is built yet, and nothing in this codebase has a path to bypass it — `/create-film-ai-mvp-plan` and `/run-film-ai-planning` only ever touch Notion planning rows, and `gatherFilmAISummary()` always reports `privacyGateCleared: false`. Tasks 1 (Upload) and 7 (Database Save) in the seeded roadmap carry this as an explicit blocker note. Treat "start building the real CV pipeline against real clips" as gated behind a founder decision, not an engineering one.

## Step 9 — Coach Sales CRM Agent

Tracks coach/school/club leads for the Adaptiv launch plan (soft outreach to 10-15 Phoenix-area coaches, onboard 2-3 beta coaches, close 5+ paid coach accounts). **Every safety rule below is enforced in code, not just documented** — see `SAFETY_RULES` and the property-builder functions in `lib/coachSalesAgent.js`.

- Do not send emails automatically.
- Do not send texts automatically.
- Do not DM anyone automatically.
- Do not mark a deal as Won automatically.
- All external outreach requires approval.
- Create drafts, tasks, and recommendations only.
- Never include private student-athlete data in outreach.
- Rank leads by likelihood to convert and strategic value.

### Step 9A — Notion database fields

Already set up on the **Coach CRM** database:

| Property | Type |
|---|---|
| Lead Name | Title |
| School / Program | Text |
| Sport | Select (Volleyball, Football, Basketball, Soccer, Baseball/Softball, Track & Field, All Sports, Other) |
| Role | Select (Head Coach, Assistant Coach, Athletic Director, Club Director, Trainer, Parent Organizer, Other) |
| Email | Email |
| Phone | Phone |
| Source | Select (Founder/Referral, Cold Outreach, Inbound, Event, Instagram, Other) |
| Stage | Select (New Lead, Researching, Contacted, Interested, Demo Scheduled, Beta Access Offered, Trial Active, Proposal Sent, Won, Lost, Dormant) |
| Priority | Select (High, Medium, Low) |
| Last Contact | Date |
| Next Follow-Up | Date |
| Objection | Text |
| Notes | Text |
| Estimated Value | Number |
| Approved Outreach | Checkbox |

Already set up on the **Coach Outreach** database:

| Property | Type |
|---|---|
| Message | Title |
| Lead | Relation → Coach CRM |
| Channel | Select (Email, Instagram DM, Text, Phone Call, In Person, LinkedIn) |
| Status | Select (Draft, Needs Approval, Approved, Sent, Replied, Follow-Up Needed, Closed) |
| Draft | Text |
| Approved | Checkbox |
| Sent Date | Date |
| Follow-Up Date | Date |

The **Agent Reports** database (already active as of Step 8) gets "Coach Sales Agent" added as a new Agent option automatically the first time `/run-coach-sales-review` files a report.

### Step 9B — Railway environment variables

On the `adaptiv-automation-hub` Railway service, set:
```
NOTION_DATABASE_COACH_CRM=
NOTION_DATABASE_COACH_OUTREACH=
```
Both are safe to store as plain env vars — there's no new secret in Step 9 beyond the existing `NOTION_API_KEY`. `NOTION_DATABASE_COACH_CRM` is required by `/add-coach-lead`; `/draft-coach-outreach` also needs `NOTION_DATABASE_COACH_OUTREACH`; `/run-coach-sales-review` also needs `NOTION_DATABASE_AGENT_REPORTS` (already set from Step 8B).

### Step 9C — Lead scoring formula

```
Athletic Director            +25
Head Coach                   +20
Phoenix/Tempe area           +20
Volleyball                   +15
Known relationship/referral  +25
Interested/replied           +30
Demo scheduled                +40
Trial active                  +50
School/team budget likely    +20
No response after 3 touches  -20
Lost                        -100
```
Implemented in `computeLeadScore()` in `lib/coachSalesAgent.js`. Returned as `leadScore` (a number) and `leadScoreReasons` (a human-readable breakdown) from `/add-coach-lead`, and used to rank `topLeads` in `/run-coach-sales-review`.

### Step 9D — Test with one fake lead

After deploying with the Step 9B variables set:
```
curl -X POST https://YOUR-AUTOMATION-HUB-URL.up.railway.app/add-coach-lead \
  -H "Content-Type: application/json" \
  -d '{
    "leadName": "Test Coach",
    "schoolProgram": "Phoenix Test High School",
    "role": "Head Coach",
    "sport": "Volleyball",
    "source": "Founder/Referral",
    "stage": "New Lead",
    "estimatedValue": 99
  }'
```
Expected: a new row in Notion → Coach CRM with `Approved Outreach` unchecked, and a JSON response with `leadScore: 100` (Head Coach +20, Phoenix/Tempe area +20, Volleyball +15, Founder/Referral +25, budget likely +20). Copy the returned `leadPageId` for Step 9E.

### Step 9E — Test an outreach draft

```
curl -X POST https://YOUR-AUTOMATION-HUB-URL.up.railway.app/draft-coach-outreach \
  -H "Content-Type: application/json" \
  -d '{
    "leadPageId": "<leadPageId from Step 9D>",
    "leadName": "Test Coach",
    "schoolProgram": "Phoenix Test High School",
    "role": "Head Coach",
    "channel": "Email",
    "context": "Met at the Phoenix volleyball coaches clinic."
  }'
```
Expected: a new row in Notion → Coach Outreach with `Status: Needs Approval` and `Approved` unchecked, linked to the Test Coach lead. The JSON response's `draftText` is short, coach-friendly, mentions Adaptiv as an app + training system, includes one call to action (a 15-minute call), and never claims guaranteed results. **Nothing is sent** — review, edit if needed, and send it yourself from Notion.

Then:
```
curl -X POST https://YOUR-AUTOMATION-HUB-URL.up.railway.app/run-coach-sales-review
```
Expected: a new row in Notion → Agent Reports summarizing the pipeline, and the JSON response includes `coachSalesStatus`, `topLeads` (Test Coach should rank first), and `target` (first-sales progress).

Then:
```
curl -X POST https://YOUR-AUTOMATION-HUB-URL.up.railway.app/run-full-brief
```
Expected: the Daily Brief now includes a "Coach Sales" section showing the pipeline status and top-ranked leads.

### Step 9F — Daily Brief Coach Sales section

`/run-full-brief` now includes (when `NOTION_DATABASE_COACH_CRM` is set):
```
## Coach Sales
Status: Green / Yellow / Red
Pipeline: X total leads / Y active / Z won / W lost
First sales target progress: X/25 leads, Y/10 outreach drafts, Z/3 conversations, W/1 demo booked
Top Ranked Leads: -
Outreach drafts awaiting approval: -
```
Status rules (`gatherCoachSalesSummary()` in `lib/coachSalesAgent.js`):
- **Red** — no leads yet.
- **Yellow** — leads exist, but nothing has an outreach draft and an active conversation yet.
- **Green** — at least one outreach draft on file and at least one lead in an active-conversation stage (Contacted or later).

### Step 9G — First real sales target

The launch goal this phase tracks toward: **25 leads, 10 outreach drafts, 3 conversations, 1 demo booked.** Progress against this target (`FIRST_SALES_TARGET` in `lib/coachSalesAgent.js`) is returned by `/run-coach-sales-review` and shown in the Daily Brief's Coach Sales section. Nothing in this service auto-advances a lead toward this target — every stage change, outreach send, and Won marking is a manual step a human takes in Notion.

### Step 9H — Safety rules recap

**This agent never contacts anyone and never closes a deal.** `buildCoachLeadProperties()` always writes `Approved Outreach: false`; `buildOutreachDraftProperties()` always writes `Status: "Needs Approval"` and `Approved: false`; `validateLeadInput()` rejects any request that tries to set `Stage: "Won"`; `validateOutreachInput()` rejects any request containing an athlete-specific field. No code path in `lib/coachSalesAgent.js` or its three routes can bypass any of these — they're structural, not just documented in this README.

## Deploying to Railway

1. **Push this folder to GitHub.**
   ```
   cd adaptiv-automation-hub
   git init
   git add .
   git commit -m "Initial Adaptiv Automation Hub"
   git branch -M main
   git remote add origin <your-new-repo-url>
   git push -u origin main
   ```
2. **Connect the repo to Railway.**
   In the Railway dashboard, open the `adaptiv-automation-hub` service (already created) → Settings → Source → Connect Repo → select this new GitHub repo.
3. **Environment variables.**
   `NOTION_API_KEY` and all `NOTION_DATABASE_*` IDs (including Sales, Approvals, and Railway Health) should already be set from earlier steps. Add `STRIPE_RESTRICTED_KEY` and the three `STRIPE_PRICE_*` IDs per Step 3B, `RAILWAY_API_TOKEN` / `RAILWAY_FRONTEND_SERVICE` / `RAILWAY_BACKEND_SERVICE` / `BACKEND_HEALTH_URL` per Step 4B, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` / `FOUNDER_EMAIL` / `GOOGLE_DOC_FOLDER_ID` per Step 5D, `SMS_ENABLED` / `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` / `FOUNDER_PHONE_NUMBER` per Step 6B (optional — leave `SMS_ENABLED` unset/false to skip), `NOTION_DATABASE_PRODUCT_BUGS` / `NOTION_DATABASE_BETA_FEEDBACK` / `NOTION_DATABASE_TASKS` per Step 7B, `NOTION_DATABASE_FILM_AI_ROADMAP` / `NOTION_DATABASE_AGENT_REPORTS` per Step 8B, and `NOTION_DATABASE_COACH_CRM` / `NOTION_DATABASE_COACH_OUTREACH` per Step 9B, if you haven't already. `GOOGLE_REFRESH_TOKEN` comes later, from Step 5G.
4. **Deploy.**
   Railway will build and deploy automatically once the repo is connected. Watch the Deployments tab for build success.
5. **Get the public URL.**
   Settings → Networking → Generate Domain (if not already set), or use the existing Railway-generated domain.
6. **Test against the live URL** — see Step 3E above.
7. **(Optional) Schedule the daily run.**
   Railway doesn't have built-in cron for a web service. Either add a [Railway Cron Job](https://docs.railway.com/reference/cron-jobs) that hits `/run-full-brief` once a day, or trigger it from the Chief of Staff Agent / an external scheduler.

## Notes for the next phase

- The Daily Briefs database still only has `Name`, `Status`, `Date`, `Top Priority`, plus the 4 Step 5F delivery properties and the 3 Step 6F SMS properties — the richer sections (priorities, missing data, sales summary, Railway health) live in the page body rather than dedicated columns.
- `/run-revenue-sync` only recognizes three plan prices (Athlete, Coach/School, Coach/Team). If new prices are added in Stripe, add matching `STRIPE_PRICE_*` env vars and extend `computeMrrAndPlanCounts()` in `lib/stripeRevenueAgent.js` and the Sales database schema together.
- Every Approvals item either agent creates is a draft request only — a human still has to review it in Notion and act on it. Neither agent writes to Stripe or Railway.
- Railway database status is always reported as "Unknown" for now — database-specific health monitoring isn't wired up yet in `lib/railwayHealthAgent.js`.
- Auto-restart / auto-redeploy for Railway services is intentionally not built. That stays out of scope until the health reporting has run reliably for a while and the founder decides to unlock it.
- Google Doc "create or update" is keyed on exact title match (`Adaptiv Daily CEO Brief - YYYY-MM-DD`). Running `/run-full-brief` more than once on the same day updates that same doc rather than creating a duplicate; running it on the next calendar day creates a new one.
- If the final Notion write-back (saving Google Doc URL / Email Sent / Delivery Status / SMS Sent / SMS Status onto the Daily Brief row) fails after the doc/email/SMS already succeeded, that's logged to Railway logs but there's no automatic retry yet — a manual re-check of that day's Notion row covers it for now.
- The Product/Bug Agent's "Product / Bug Agent" Daily Brief section isn't folded into the Google Doc or SMS text yet — it's in the Notion brief and in `/run-full-brief`'s JSON response (`productBugSummary`) for now. Extending `googleDeliveryAgent.js`/`smsDeliveryAgent.js` to include it is a small follow-up if wanted.
- SMS delivery (Step 6), the Product/Bug Agent (Step 7), the Film AI Build Team planning phase (Step 8), and the Coach Sales CRM Agent (Step 9) are all done. Social Media Agents (Instagram/TikTok/YouTube/X — Step 10) are the next planned phase.
- The Film AI Build Team is planning-only by design (Step 8H). Building the actual computer vision pipeline, uploading real athlete video, or connecting to production user data is explicitly out of scope until the privacy gate (review, consent, deletion policy, secure storage plan) is cleared — that's a founder decision, not something to build around.
- The Film AI Build Team's "Film AI Build Team" Daily Brief section isn't folded into the Google Doc or SMS text yet either, same as the Product/Bug Agent section — it's in the Notion brief and in `/run-full-brief`'s JSON response (`filmAISummary`) for now.
- The Coach Sales CRM Agent never contacts a coach and never marks a deal Won — every outreach send and every stage change to Won is a manual step a human takes in Notion (Step 9H). The "Coach Sales" Daily Brief section isn't folded into the Google Doc or SMS text yet either — it's in the Notion brief and in `/run-full-brief`'s JSON response (`coachSalesSummary`) for now.
- Coach Sales progress against the first-sales target (25 leads / 10 outreach drafts / 3 conversations / 1 demo booked — Step 9G) should be checked periodically via `/run-coach-sales-review` or the Daily Brief; nothing auto-notifies when the target is hit.
