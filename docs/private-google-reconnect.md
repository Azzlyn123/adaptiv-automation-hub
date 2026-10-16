# Private Google email recovery

This local-only helper reconnects existing Google delivery permissions from
an owner's phone through an already configured private Tailscale HTTPS host.
It does not start in the production Hub, enable public OAuth routes, restart
Railway, send messages, or enable SMS.

## Prerequisites

- Link this local checkout to the intended Railway project, production
  environment, and `adaptiv-automation-hub` service.
- Keep the public Hub `/auth/google` and `/oauth2callback` routes retired.
- Confirm the owner's existing Tailscale HTTPS dashboard works and Funnel is
  off. The device must be owned by a user, not a tagged service node.
- Register this exact redirect on the existing Google web OAuth client:
  `https://<device>.<tailnet>.ts.net/google-reconnect/oauth2callback`.
- Use an unoccupied loopback port. Do not stop another listener to make room.

## Operator flow

1. Run `scripts/google-phone-reconnect.js` with explicit `--project <UUID>`,
   `--service <UUID>`, `--host <device>.<tailnet>.ts.net`, and `--mode check`.
   It validates the production repo/service, configured Google client, owner
   identity, existing HTTPS, and Funnel-off state. It writes nothing.
2. Run the same command with `--mode serve`. Optional `--port` defaults to
   8765 and `--ttl-minutes` defaults to 45, with a maximum of 60. The server
   binds to `127.0.0.1`, never the LAN or public interface. In Windows it may
   run hidden under the owner account; logs contain status enums only.
3. Preserve the existing Serve root handler. Add only the private mount:
   `tailscale serve --bg --https=443 --set-path=/google-reconnect http://127.0.0.1:8765`.
   Inspect Serve status again and verify Funnel remains off.
4. Verify the HTTPS landing and `/google-reconnect/status` as the owner.
   Anonymous, wrong-owner, cross-origin, stale-state, replay, and concurrent
   callback cases are covered by synthetic local tests. The owner then
   visits `/google-reconnect/` on the phone and submits its same-origin form.
5. The owner signs in and approves Google's consent screen personally. Only
   the existing Docs, app-file Drive, and Gmail-send scopes are requested.
   A per-attempt state and PKCE verifier stay in memory and expire after ten
   minutes. No passwords or codes should be pasted into chat.
6. After complete consent the helper verifies the exact scope set and reads
   only Drive's account email under the existing `drive.file` permission to
   confirm it matches the founder inbox. It then
   writes only `GOOGLE_REFRESH_TOKEN` to the selected production service via
   Railway stdin with deploys skipped. It redirects to a clean local result
   URL and never returns credentials. Failure leaves storage unconfirmed;
   it is not an instruction to retry or broaden scopes automatically.
7. Confirm the result before separately restarting only the intended Hub
   build and sending one synthetic founder-only email test. Sending and
   receipt are separate checks. Do not run the full brief just to probe it.
8. Remove only the temporary Serve mount with
   `tailscale serve --https=443 --set-path=/google-reconnect off`. Stop this
   exact helper process if still running. Never reset the full Serve config
   or stop the Mission Control dashboard. The helper also exits at its TTL.

The helper checks Tailscale's injected owner login on every request and
rejects Funnel request headers. It trusts the local daemon/loopback proxy;
other local processes, including ones under other Windows users, can forge
loopback headers and are outside this boundary. It is a temporary recovery tool, not a
permanent public account-linking service. The original localhost helper is
also included for owner-PC use; Windows assumes Railway's normal global npm
installation. Neither helper installs new dependencies or broadens access.

Abandoned, expired, or failed attempts require stopping and restarting this
exact helper; there is no automatic retry. Google token exchange has a
20-second timeout with retries disabled; the Railway write is bounded at
30 seconds. Shutdown allows an already-started request to finish before
reporting the window closed, with a 90-second forced-close limit. No token
write starts after the consent session or overall recovery window expires.

An External Google OAuth app in Testing may need reauthorization after seven
days for these scopes. Publishing, domain verification, grant revocation,
and old-log retention require their own deliberate review. This flow does
not claim those issues are resolved. Existing Hub bearer migration and
caller-identity release gates are unchanged.
