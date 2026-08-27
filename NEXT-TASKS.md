# NEXT-TASKS

In dependency order. D-numbers reference DECISIONS.md.
(2026-08-16 decision round: oracle pinned by digest (D1), captures explicitly
deferred (D2), M5 runbook prepared (D3, see RUNBOOK-M5.md), hashing_key in
local tfvars (D4a), object sweep implemented (D6), account routes pulled
forward and implemented.)
(2026-08-27: P3 sharing implemented — collaborators + public album links,
plan Phases A–D and F on `feature/sharing-public-links`, D48–D52. Items 2, 4
and 6 below are its release gates; the README feature-table rows stay
gate-annotated until they pass.)

1. **Write the capture script + run it (D2, deferred by decision).** Bring up
   the pinned oracle (`make oracle-up`), drive the synthetic client
   (test/helpers/client.ts) against museum, record request/response pairs
   under `test/fixtures/oracle-<digest>/`, grow `tools/capture-diff.ts` into
   the replay-and-diff harness, add `tools/contract-allowlist.ts` with
   justified entries only. Correct handlers where captures disagree — the
   remaining CAPTURE-GATED items are D9 (magic-metadata version) and D10
   (stub payloads, 2FA recovery-status shape, accounts-token).
2. **Sharing/public-links capture parity (release gate, rides item 1's
   harness).** Script share → sync-as-sharee → unshare → sync-as-sharee and
   share-url → public-collection flows against the oracle (two accounts;
   test/helpers/publicClient.ts already speaks the access-token side) and
   diff. The capture-gated calls to settle are enumerated in D49 (non-member
   403-vs-404, deleted-collection diff tombstones, /files/info sharee
   access), D50 (unshare-tombstone wire shape + re-surfacing, `sharedAt`,
   ADMIN role, owned-feed owner email, publicURLs `[]`-vs-null, sharing a
   deleted collection), and D51 (device-limit quirks, error bodies, the
   frozen X-Ente-Link-Device-Token header). Flip resolver + tests together
   where museum disagrees.
3. **SRP oracle vector test** (M1 gate leftover): scripted known-password
   account against museum, transcript pinned as fixture, replayed against us.
4. **M5 stock-app LAN gate (D3, prepared):** `make lan` + RUNBOOK-M5.md;
   pin the app version in ORACLE-VERSION at gate time (D1b); record every
   unexpected request. Re-run with a shared album (release gate for D50):
   share to a second `…@example.org` account, sync as the sharee,
   collaborator-add a file, unshare, confirm the album drops from the
   sharee's app.
5. **M7 deploy (D4):** `make build-lambda`, fill `src/infra/dev/ente-sl.tfvars`
   from the example (BACK UP hashing_key), `tofu apply`, replay gates against
   the real URL, then the app over the internet. Still open: account/region +
   SES-verified mail_from. Post-apply: `make pricing-plan` (C12) and the
   albums web deploy (C13: `make build-web` + `make deploy-web`).
6. **Manual albums-link browser gate (D52, release gate; needs item 5).**
   Mint a real share link in the app and open it in the pinned albums build
   (photos-v1.3.61, guard-matched to ORACLE-VERSION): album renders, plain +
   passworded + collect variants work, device limit trips, disabled link
   shows "broken", not "empty" (RUNBOOK-M5-style checklist; record findings).
7. **Hardening follow-ups:** account-deletion data cleanup in the sweep cron
   (rows/objects of deleted users); CI (unit + infra every push; integration
   behind a LocalStack service).
8. **Phase E leftovers (future, capture-first — PENDING-FEATURES-PLAN §2
   Phase E):** single-file links (`fileLinkApi`), shared memories
   (`publicMemoryAPI`), cast, real contacts + comments/reactions (replacing
   the D27 empty-feed stubs), passkeys, family plans, legacy/trusted
   contacts. The token spine, public middleware and JWT primitive they reuse
   exist as of D48/D51.
