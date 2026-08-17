# DECISIONS — required decisions, corrections, and knowing divergences

The build ran to the plan's rule: never stop until a milestone genuinely needs
an external decision; log it and continue. This file is that log. Three kinds
of entries: **[NEEDS-DECISION]** (blocked on a human/external input),
**[CAPTURE-GATED]** (implemented from source reading; the oracle capture will
confirm or correct), and **[CORRECTION]** (the build plan said X, museum's
source says Y — source won).

## Blocking further milestones

- **D1 [DECIDED 2026-08-16] Oracle pinned by digest.** Museum =
  `ghcr.io/ente/server@sha256:f646b68a…` (that day's `:latest`, matching the
  main-branch source the shapes were read from; note the image lives under the
  `ente` org, not `ente-io`). App APK = pin the then-current Play Store
  version when the M5 device gate actually runs (D1b). Recorded in
  `ORACLE-VERSION` + `docker-compose.oracle.yml`.

- **D2 [NEEDS-DECISION → NEXT-TASK] Run the capture suite.** All shapes here
  are pinned against museum's Go source (paths cited in each handler), which
  is materially stronger than the plan doc but still not a capture. The
  capture tooling skeleton is `tools/capture-diff.ts`; the capture script
  itself should be written against the running oracle (rule 0.1: the capture
  wins). Blocked behind D1. Gates affected: M0, the M1 SRP oracle-vector test,
  M4's 30-op oracle replay (our version runs against our own server only),
  M5/M7 app-capture passes.

- **D3 [PREPARED 2026-08-16] M5 stock-app gate.** Runs whenever a device is
  handy: `make lan` serves on the Mac's LAN IP with the hardcoded-OTT test
  domain; RUNBOOK-M5.md has the exact steps (7-tap endpoint, @example.org /
  123456 signups, what to verify, what to record). App version gets pinned in
  ORACLE-VERSION at gate time (D1b).

- **D4 [PARTLY DECIDED] M7 deploy.** The deploy itself stays out of scope
  until explicitly requested. `src/infra` is written, `tofu validate` passes,
  guard tests green, lambda bundles build and load.
  **D4a [DECIDED 2026-08-16]:** `hashing_key` lives in a local gitignored
  tfvars file (`src/infra/dev/ente-sl.tfvars`, example checked in) — owner
  manages the backup; losing the key orphans every email→user mapping.
  Still open before the first apply: which AWS account/region, and an
  SES-verified `mail_from` identity.

## Capture-gated implementation choices

- **D5 [RESOLVED BY SOURCE 2026-08-16] Server-side `updationTime`.** Museum's
  API layer overwrites `file.UpdationTime = time.Microseconds()` before
  validation on BOTH commit paths (pkg/api/file.go CreateOrUpdate + Update),
  so the client value is ignored and the controller's "required" check is
  unreachable. We do the same (monotonic server stamp), and we removed the
  400-on-missing-updationTime check — clients may omit the field, as against
  museum. (Asked as a preference question; the source made it moot.)
- **D6 [DECIDED 2026-08-16] Deferred object deletion via sweep.** Matches
  museum's enqueue-and-return: permanent-delete/purge and the update paths
  (PUT /files, /files/update, /files/thumbnail) enqueue replaced/deleted
  objects onto a `PURGEQ` partition; the daily trash-purge worker drains it
  (`domain/objectSweep.ts`). Visible effects unchanged (usage drop +
  tombstone are synchronous); bytes disappear within a day.
- **D7 [DIVERGENCE, deliberate] GIR via object tag.** The plan's prefix-based
  lifecycle is impossible: museum issues `userID/uuid` keys for originals AND
  thumbnails from the same URL pool, so no prefix separates them. The API tags
  originals `tier=original` at commit; the lifecycle rule filters on the tag.
  Tag failure costs storage class only, never the commit.
- **D8 [DECIDED 2026-08-16, keep] img_preview protocol-ready divergence.**
  Museum main has no commit endpoint for img_preview (no client generates
  it); we record the objectID at preview-upload-url issuance so the GET side
  works. Kept deliberately as the server half of the three-tier image plan;
  revisit when museum grows the real endpoint.
- **D9 [CAPTURE-GATED] Magic-metadata version increments (+1 on store), and
  count regression tolerance (>2 drop rejected) — both read from
  `validateUpdateMetadataRequest`; capture should confirm stored version.
- **D10 [CAPTURE-GATED] Stub payloads**: feature-flags defaults, storage-bonus
  `{storageBonuses: []}`, billing free plan `{storage, duration: 100,
  period: "days"}`, subscription id = userID. Shapes from source; self-host
  capture should be copied verbatim once the oracle runs.
- **D11 [DECIDED 2026-08-16] Free plan storage default = effectively
  unlimited (1 PiB).** Museum's constant is 10 GiB; ours stays env-configurable
  (`FREE_PLAN_STORAGE_BYTES`) but defaults to 1 PiB in config.ts and the tofu
  variable so quota never interferes on a self-host. The 426 quota path stays
  covered by tests via the override.

## Corrections to the build plan (source beat the plan doc)

- **D12 [CORRECTION] OTT**: validity is **1 hour** (not 10 min), max 10
  active codes, 20 wrong attempts locks until codes expire (429), wrong code
  is **401 {}**, expired/consumed is **410 {}** (`handler.go` mapping).
- **D13 [CORRECTION] OTT anti-enumeration**: museum DOES disclose
  (signup+existing → 409 USER_ALREADY_REGISTERED, login+missing → 404
  USER_NOT_REGISTERED, login+incomplete → 404 USER_SIGNUP_INCOMPLETE);
  swallowing only kicks in past an abuse rate-limit. The plan's "always 200"
  guess was wrong.
- **D14 [CORRECTION] Tokens are not hash-only storable**: GET /users/sessions
  returns the token strings (clients delete sessions by token), so rows keep
  the plaintext under a hash key. Museum stores plaintext too.
- **D15 [CORRECTION] Download v1 redirects with **307**, not 302; v2/v3
  return `{"url"}`. "preview" = thumbnail; the 4xx for non-members is 404.
- **D16 [CORRECTION] remove-files v3** rejects removing files the collection
  owner owns (400 "can not remove files owned collection owner...") — there
  is NO server-side uncategorized fallback; clients move instead.
- **D17 [CORRECTION] DELETE /collections/v3 `keepFiles=true` requires an
  EMPTY collection** (409 COLLECTION_NOT_EMPTY otherwise); `false` trashes
  the remainder. Request binds from QUERY params.
- **D18 [CORRECTION] Quota exceeded is 426 (Upgrade Required) `{}`**, file
  too large 413, missing S3 object at commit **503 OBJECT_SIZE_FETCH_FAILED**.
- **D19 [CORRECTION] SRP**: go-srp (node-srp conventions) — 4096-bit RFC 5054
  group with **g = 5**, SHA-256; `x = H(salt | H(I ":" P))`;
  `M1 = H(pad(A)|pad(B)|pad(S))`; A/B exactly 512 bytes, M1 32 bytes;
  attempt cap 5 → 410 TOO_MANY_WRONG_ATTEMPTS; replay → 410
  SESSION_ALREADY_VERIFIED; unverified-session rate limit 10/h → 429
  TOO_MANY_UNVERIFIED_SESSIONS; fake sessions persisted for unknown srpUserIDs.
  SRP password = `crypto_kdf(kek, 32, 1, "loginctx")` (web client source).
- **D20 [CORRECTION] `logOutOtherDevices` defaults to TRUE** on
  /users/srp/update (api layer sets clearTokens=true when absent).
- **D21 [CORRECTION] PUT /users/attributes is immutable once set** (403), not
  "until SRP exists"; KDF strength must equal 4 GiB · ops (memLimit·opsLimit)
  with memLimit ≥ 128 MiB.

- **D26 [GATE FINDING 2026-08-17] The current app uses the V2 upload routes.**
  First M5 device run: login + recovery passed; uploads failed. The app's
  primary path is `POST /files/upload-url` (contentLength+contentMD5) and
  `POST /files/multipart-upload-url`, plus a `GET /files/upload-eligibility`
  probe — all three were missing (the plan only listed the GET v1 routes) and
  are now implemented with bare (unwrapped) responses, as the app's models
  expect. Sub-divergence: museum binds Content-Length/Content-MD5 into the
  presign signature; we presign host-only (SigV4 query auth ignores unsigned
  headers, verified against LocalStack with app-like headers). Tighten with
  captures. Second gate fix: `make lan` now signs presigned URLs against the
  Mac's LAN IP so the phone can reach them.

- **D27 [GATE FINDING 2026-08-17] The app polls social/sharing probes every
  sync loop:** `GET /comments-reactions/updated-at`,
  `GET /collection-actions/pending-remove`, `GET /contacts/diff` (plus their
  siblings `counts` and `delete-suggestions`). Implemented as authenticated
  empty envelopes (`{"updates":[]}`, `{"actions":[],"hasMore":false}`,
  `{"diff":[]}`) — core scope has no sharing/comments/contacts, so empty is
  the truthful answer; shapes from pkg/api/social.go, collection_actions.go,
  contact.go. Capture-gated nuance: museum may emit `null` instead of `[]`
  for some empty cases (Go nil slices) — verify with captures.

- **D28 [GATE FINDING 2026-08-17] Trash diff must carry the origin
  collection.** After POST /files/trash the app re-syncs, reads
  `file.collectionID` from /trash/v2/diff, and resolves it via
  `GET /collections/:collectionID` (which also didn't exist). Our diff was
  emitting `collectionID: 0` → the app polled `/collections/0` every loop.
  Fixed per museum's SQL (repo/trash.go joins collection_files on
  trash.collection_id): trash rows now store the origin collectionID, the
  diff serves that collection's wrapped key, legacy rows recover the origin
  from the tombstoned link, and GET /collections/:collectionID is implemented
  (deleted collections included, param route registered after the static
  /collections/* routes).

## Environment facts discovered while building

- **D22** LocalStack community has no SESv2 — the mail adapter uses SES v1
  (`@aws-sdk/client-ses`), which real AWS serves identically for SendEmail.
- **D23** AWS SDK ≥3.729 poisons presigned PUTs with a default
  `x-amz-checksum-crc32`; `requestChecksumCalculation: WHEN_REQUIRED` on the
  S3 client is required for client-uploaded bytes to verify.
- **D24** `node --experimental-strip-types` rejects TS parameter properties;
  all run scripts use `--experimental-transform-types`.
- **D25** libsodium-wrappers' ESM dist is broken under Node's resolver; the
  single CJS-require shim lives in `src/lib/sodium.ts`.
