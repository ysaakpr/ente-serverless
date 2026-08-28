# NEXT-TASKS

In dependency order. D-numbers reference DECISIONS.md.
(2026-08-16 decision round: oracle pinned by digest (D1), captures explicitly
deferred (D2), M5 runbook prepared (D3, see RUNBOOK-M5.md), hashing_key in
local tfvars (D4a), object sweep implemented (D6), account routes pulled
forward and implemented.)
(2026-08-27: P3 sharing implemented — collaborators + public album links,
plan Phases A–D and F on `feature/sharing-public-links`, D48–D52. Items 2, 4
and 6 below are its release gates; the README feature-table rows stay
gate-annotated until they pass. Same day, Phase H deployment controls —
invite-gated signup + per-user quotas + BYO storage pools, D54/D55, plan §7;
its device checks ride item 4 and its cloud check is item 9.)

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
   sharee's app. D54 on-device checks (run `make lan` with
   `SIGNUP_MODE=invite`): a non-invited signup's 403 on `/users/ott` must
   surface as the stock app's generic failure dialog, not a crash or a
   misleading steer (the error-shape choice in D54 is capture-gated on
   exactly this); and a viewer account (`make invite … VIEWER=1`) must boot,
   sync, browse a share, and favorite a shared photo without tripping on the
   426/403 refusals.
5. **M7 deploy (D4):** `make build-lambda`, fill `src/infra/dev/ente-sl.tfvars`
   from the example (BACK UP hashing_key), `tofu apply`, replay gates against
   the real URL, then the app over the internet. Still open: account/region +
   SES-verified mail_from. Post-apply: the FREE pricing-plan subscription is
   chained into `make deploy` (D60; C12 — re-run `make pricing-plan` by hand
   if its WARNING fires) and the albums web deploy (C13: `make build-web` +
   `make deploy-web`).
6. **Manual albums-link browser gate (D52/D60, release gate; needs item 5).**
   Mint a real share link in the app and open it in the pinned albums build
   (photos-v1.3.61, guard-matched to ORACLE-VERSION) at its D60 address —
   `https://<server_url domain>/albums/?t=<token>`: album renders (basePath
   /albums assets load — this is also where the build-time basePath patch
   proves out), plain + passworded + collect variants work, device limit
   trips, disabled link shows "broken", not "empty" (RUNBOOK-M5-style
   checklist; record findings).
7. **Hardening follow-ups:** account-deletion data cleanup in the sweep cron
   (rows/objects of deleted users); CI (unit + infra every push; integration
   behind a LocalStack service).
8. **Phase E leftovers (future, capture-first — PENDING-FEATURES-PLAN §2
   Phase E):** single-file links (`fileLinkApi`), shared memories
   (`publicMemoryAPI`), cast, real contacts + comments/reactions (replacing
   the D27 empty-feed stubs), passkeys, family plans, legacy/trusted
   contacts. The token spine, public middleware and JWT primitive they reuse
   exist as of D48/D51.
9. **Pool-bucket end-to-end on a real AWS account (D55; needs item 5).** The
   AssumeRole path cannot be fully proven on LocalStack (no real assumable
   identities — it is unit-stubbed only, and the LocalStack integration test
   runs mode 'keys'). On real AWS: create a pool bucket + role per INSTALL
   "Inviting users & storage pools" (trust policy with ExternalId, bucket
   checklist), `make pool-create` in role mode (checklist must pass),
   `make pool-attach`, upload from the stock app, confirm the bytes land in
   the pool bucket under the user's prefix, download/thumbnail round-trip
   (presigns ≤ ~1h), then trash → purge and confirm the sweep deletes from
   the pool bucket. Note the role must be named `ente-pool-*` (D56 — the
   execution role's AssumeRole is scoped to that convention).
10. **Filedata size-reconciliation pass (D56).** Pool counters are charged
    for file-data only where the write path knows the size (putFileData,
    putVideoData — net of replacement). Two drift sources remain: presigned
    `img_preview` uploads have no commit/verify step in museum main and stay
    UNCHARGED (deliberate — do not invent a non-museum verification step
    without a capture), and file/fd deletion paths do not refund fd bytes to
    the pool counter. A reconciliation pass should (a) decrement the pool
    counter when fd rows/objects are deleted, keyed off the fd row's `size`
    and the file's pin, and (b) decide the img_preview story once a client
    generates it (capture-first, D8). Until then a pool's counter can read
    slightly HIGH after fd deletions — the safe direction for a shared cap.
