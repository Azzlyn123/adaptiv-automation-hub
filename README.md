# Adaptiv Automation Hub

Adaptiv Athletics Railway Automation Hub. Currently does four things:
1. **Daily Brief writer** — writes a Daily CEO Brief into the Notion "Daily Briefs" database.
2. **Stripe Revenue Agent** (read-only) — pulls subscription data from Stripe, writes a report row into the Notion "Sales" database, and files a Notion "Approvals" item when subscriptions are past due.
3. **Railway Health Agent** (read-only) — checks the frontend/backend Railway services and the backend health endpoint, writes a report row into the Notion "Railway Health" database, and files a Notion "Approvals" item when something looks wrong.
4. **Google Doc + Email Delivery** (OAuth) — after `/run-full-brief` writes to Notion, it also creates/updates a Google Doc with the full brief and emails a short summary to `FOUNDER_EMAIL`, with the Doc link in both Notion and the email.

Explicitly out of scope:
- No social channel connections
- No SMS sending (planned for a later phase)
- **No writes to Stripe, ever.** This service only reads Stripe data. It never creates charges, never issues refunds, never cancels subscriptions, and never updates customers.
- **No writes to Railway, ever.** This service only reads Railway service/deployment status. It never restarts a service, never triggers a redeploy, never changes a variable, and never deletes anything. If something needs action, it files a Notion Approval item instead — a human decides and acts from there.
- **No Google password, ever.** Google delivery uses OAuth only. This service and this assistant never see or handle a live Google account password.
- **Only emails `FOUNDER_EMAIL`.** The Gmail send agent never emails anyone else.

## File structure

```
adaptiv-automation-hub/
├── server.js              Express app: routes + Notion writes + error handling
├── lib/
│   ├── stripeRevenueAgent.js   Stripe reads + metric calculations + Notion payload builders
│   ├── railwayHealthAgent.js   Railway GraphQL reads + status rules + Notion payload builders
│   └── googleDeliveryAgent.js  OAuth + Google Docs/Drive/Gmail delivery + failure-isolation logic
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
   curl -X POST http://localhost:3000/run-full-brief
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
Runs the Stripe revenue sync and the Railway health check, then creates a Daily Brief that includes real **Sales Summary** and **Railway Health** sections built from that same data, instead of listing Stripe/Railway as missing data sources. Then attempts Google Doc + email delivery (Step 5) and writes the result (Google Doc URL / Email Sent / Email Error / Delivery Status) back onto the same Daily Brief row. Google delivery never blocks this response — if it's not configured or fails, the Notion brief is still created and `delivery.deliveryStatus` comes back as `Not Sent` / `Partial` / `Failed`. Returns `201` with the metrics, health data, the Sales/Railway Health/Approvals page URLs (as applicable), the Daily Brief page URL, and the `delivery` result.

### `GET /auth/google`
Step 5G one-time setup route. Visit this **in a browser** (not curl) to start the OAuth consent flow — redirects to Google's consent screen for the scopes in Step 5C.

### `GET /oauth2callback`
Google redirects here after you approve consent. Exchanges the one-time code for tokens and returns the refresh token **once**, to be copied into Railway as `GOOGLE_REFRESH_TOKEN`. No other route in this service ever exposes it.

### `POST /create-test-doc`
Step 5H. Creates a small test Google Doc to confirm OAuth + Docs/Drive scopes work. Returns `201` with the doc URL.

### `POST /send-test-email`
Step 5H. Sends a test email to `FOUNDER_EMAIL` only, to confirm Gmail send scope works. Returns `200` on success.

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
   `NOTION_API_KEY` and all `NOTION_DATABASE_*` IDs (including Sales, Approvals, and Railway Health) should already be set from earlier steps. Add `STRIPE_RESTRICTED_KEY` and the three `STRIPE_PRICE_*` IDs per Step 3B, `RAILWAY_API_TOKEN` / `RAILWAY_FRONTEND_SERVICE` / `RAILWAY_BACKEND_SERVICE` / `BACKEND_HEALTH_URL` per Step 4B, and `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` / `FOUNDER_EMAIL` / `GOOGLE_DOC_FOLDER_ID` per Step 5D, if you haven't already. `GOOGLE_REFRESH_TOKEN` comes later, from Step 5G.
4. **Deploy.**
   Railway will build and deploy automatically once the repo is connected. Watch the Deployments tab for build success.
5. **Get the public URL.**
   Settings → Networking → Generate Domain (if not already set), or use the existing Railway-generated domain.
6. **Test against the live URL** — see Step 3E above.
7. **(Optional) Schedule the daily run.**
   Railway doesn't have built-in cron for a web service. Either add a [Railway Cron Job](https://docs.railway.com/reference/cron-jobs) that hits `/run-full-brief` once a day, or trigger it from the Chief of Staff Agent / an external scheduler.

## Notes for the next phase

- The Daily Briefs database still only has `Name`, `Status`, `Date`, `Top Priority`, plus the 4 new Step 5F delivery properties — the richer sections (priorities, missing data, sales summary, Railway health) live in the page body rather than dedicated columns.
- `/run-revenue-sync` only recognizes three plan prices (Athlete, Coach/School, Coach/Team). If new prices are added in Stripe, add matching `STRIPE_PRICE_*` env vars and extend `computeMrrAndPlanCounts()` in `lib/stripeRevenueAgent.js` and the Sales database schema together.
- Every Approvals item either agent creates is a draft request only — a human still has to review it in Notion and act on it. Neither agent writes to Stripe or Railway.
- Railway database status is always reported as "Unknown" for now — database-specific health monitoring isn't wired up yet in `lib/railwayHealthAgent.js`.
- Auto-restart / auto-redeploy for Railway services is intentionally not built. That stays out of scope until the health reporting has run reliably for a while and the founder decides to unlock it.
- Google Doc "create or update" is keyed on exact title match (`Adaptiv Daily CEO Brief - YYYY-MM-DD`). Running `/run-full-brief` more than once on the same day updates that same doc rather than creating a duplicate; running it on the next calendar day creates a new one.
- If the final Notion write-back (saving Google Doc URL / Email Sent / Delivery Status onto the Daily Brief row) fails after the doc/email already succeeded, that's logged to Railway logs but there's no automatic retry yet — a manual re-check of that day's Notion row covers it for now.
- SMS delivery (Step 6) and the Film AI Build Team (Step 7) are the next planned phases.
