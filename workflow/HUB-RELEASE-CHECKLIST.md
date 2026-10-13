# Hub release checklist

Status: held. This draft does not authorize a merge, deploy, or message send.

## Caller inventory

- Railway's production Hub service has no cron schedule configured as of
  2026-10-13. This does not rule out a Claude routine or other external caller.
- Railway HTTP metadata shows eight successful `POST /run-full-brief` requests
  from October 6-13, including requests near 15:00 UTC on October 10-13.
  It shows one `POST /run-weekly-strategy-review` on October 12 at
  03:43 UTC. All used `curl/8.5.0`. HTTP 201 confirms the handler responded,
  not that Google delivered a message or that the caller is authenticated.
  No other POST route appeared in the same seven-day log window. This is
  observation of traffic, not a verified schedule or caller identity.
- Identify every caller of `/run-full-brief`, `/run-weekly-strategy-review`,
  and all other POST routes. Record who owns it, how it stores credentials,
  and whether it can send an `Authorization` header. Do not put the shared
  token in a browser, phone dashboard, URL, prompt, Notion row, or log.
- The initiating caller and its schedule are not yet verified. Do not merge
  the fail-closed auth change until the caller can use a server-side secret
  and a staged run succeeds; otherwise the existing brief flow will stop.

## Before release

1. Review this draft and its exact head SHA, including the auth middleware,
   source-quality rules, and Google callback removal. Check CI and run
   `npm test` in a clean checkout. A passing test alone is not release approval.
2. Generate a cryptographically random 64-character hexadecimal secret in an
   approved secret manager. Provision it as `HUB_API_TOKEN` on the Hub and
   every authorized server-side caller; do not reveal its value in tickets or
   terminal output. Confirm each caller can attach a bearer header.
3. Test the combined Hub and caller changes in a non-production environment.
   Without a token, protected routes must return 401 (or 503 when the Hub
   secret is absent); a valid server request may reach its handler. `GET` and
   `HEAD /health` must remain available. The retired OAuth routes must return
   410 to an authorized caller without exchanging or disclosing tokens.
4. Decide whether to pause existing external triggers during the release.
   Deploy only after explicit owner approval and a rehearsed rollback. Do not
   revert to an unauthenticated public writer as an incident workaround.

## After release

- Verify the exact deployed commit and first authorized scheduled run. Check
  Notion row creation and Google/SMS delivery status separately. A 201 with
  `status: partial` is not proof of delivery or founder receipt.
- Test one synthetic founder-recipient brief only after separate send approval.
  Do not use athlete/customer data in this smoke test.
- If the caller fails, pause the schedule, inspect non-secret status/logs,
  repair the caller or token configuration, and retry once with owner approval.
  Do not publish the token or open protected routes to browsers.

Google authorization and iOS Safari signup verification have separate gates
in `GOOGLE-DELIVERY-RECOVERY.md` and the QA plan; neither is certified by
this checklist.
