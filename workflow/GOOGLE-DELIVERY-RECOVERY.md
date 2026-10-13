# Google daily-brief delivery recovery

Status: held. This checklist does not authorize a production deployment or a message send.

## Confirmed cause and limits

- On 2026-10-13, the Automation Hub Google OAuth project was External and in
  Testing. Google expires offline refresh tokens after seven days for this
  configuration when scopes include Docs, Drive, or Gmail. That is a likely
  explanation for the observed `invalid_grant`, not proof of its exact cause.
- The October 13 Notion brief was saved; Google Doc and email delivery failed.
  An HTTP 201 from `/run-full-brief` means a brief row was created, not that
  the founder received it. Check `Delivery Status`, `Email Sent`, and `Google
  Doc` separately. SMS is separately unconfigured.
- The current production build still exposes the legacy browser OAuth setup
  routes. Do not use `/auth/google` or `/oauth2callback` to rotate credentials:
  the old callback can return and log a refresh token.
- The local default-deny Hub patch is not deployment-ready until every live
  caller has a server-side bearer credential. No browser or phone dashboard
  may receive that shared credential.

## Staged recovery

1. Inventory and pause scheduled Hub callers. Review the combined local diff,
   run `npm test`, and stage a release that disables the public OAuth setup
   routes without breaking existing brief triggers. Confirm the live routes
   return 410 and do not exchange or print tokens.
2. Complete OAuth Branding with a verified application homepage and public
   privacy/terms links. The configured scopes are `documents` (all Docs),
   `drive.file` (files used by the app), and `gmail.send` (send on behalf of
   the account); Docs and Gmail are marked sensitive in Google Cloud.
   Publishing the OAuth app broadens its audience and may require
   Google verification; obtain owner approval at that step.
3. Reauthorize only from an owner-controlled localhost callback with an
   unpredictable state value and the registered localhost redirect URI.
   Exchange the code server-side, store the refresh token directly in the
   approved Railway secret store, and never show it in a browser, chat,
   command output, repository file, or logs. Reauthorization while Testing is
   temporary and will need repeating after seven days.
4. Restart only the intended Hub service. Test one synthetic brief to the
   founder's confirmed inbox after explicit send approval. Confirm a Google
   Doc URL, email delivery status, and recipient receipt. Do not infer receipt
   from API success alone.
5. Resume the scheduled caller once and check the next automatic run. Keep
   SMS disabled unless its sender and recipient are deliberately configured.

The source-quality patch keeps known demo records and unverified reports out
of operational priorities. It does not change production until reviewed and
released. Never rerun `/run-full-brief` casually: it creates Notion rows and
can send messages when delivery recovers.

Google references: [Testing audience and seven-day consent](https://support.google.com/cloud/answer/15549945),
[refresh-token expiration](https://developers.google.com/identity/protocols/oauth2),
[OAuth branding requirements](https://support.google.com/cloud/answer/15549049).
