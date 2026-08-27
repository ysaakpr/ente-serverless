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
- **D11 [DECIDED 2026-08-16, REVISED 2026-08-17] Free plan storage default =
  10 TiB.** Museum's constant is 10 GiB; ours stays env-configurable
  (`FREE_PLAN_STORAGE_BYTES`) but defaults high, because it's the user's own
  bucket and bill and quota should not interfere on a self-host. Originally
  1 PiB ("effectively unlimited"); lowered to **10 TiB = 10995116277760** on
  request — still far past any realistic library, but a real ceiling rather
  than a number chosen to never trigger, so a runaway client hits 426 instead
  of an S3 invoice. Binary units throughout, matching museum's 10 GiB
  (10737418240) and the rest of this repo. Set in config.ts and the tofu
  variable `free_plan_storage_bytes`; the 426 quota path stays covered by
  tests via the override.

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

- **D29 [GATE FINDING 2026-08-17] The API needs CORS — browser clients
  preflight everything.** A browser-based client (web/desktop) hit
  `OPTIONS /users/ott -> 404`: the POST route existed but nothing answered the
  preflight, so the real request never fired. Previously logged as an accepted
  limitation in AWS-RESOURCES.md ("mobile does not care"); it blocks the web
  client outright. Shape captured from the pinned oracle rather than invented
  (`OPTIONS`/`POST /users/ott`, `GET /ping` against
  ghcr.io/ente/server@sha256:f646b68a…): museum answers the preflight **200**
  with an empty body, echoes the request `Origin` verbatim for **any** origin
  (`Allow-Credentials: true` forbids a bare `*`), emits an empty
  `Allow-Origin` when the request carries no `Origin`, and puts the full
  header set on *every* response, not just preflights. Implemented in
  src/middleware/cors.ts, hand-rolled because `hono/cors` answers 204 where
  museum answers 200. Verified byte-identical (modulo Go's header-name
  title-casing) against the live oracle.

- **D30 [GATE FINDING 2026-08-17] The free subscription must be derived from
  stored state, not the clock.** The web client's Manage-subscription page hung
  on an infinite loader, polling `GET /users/details/v2` forever. Cause: we
  computed `expiryTime` as `now + 100 days` on every request, so **no two
  responses were ever equal** and the client's refetch-on-change loop never
  settled. Oracle capture (free user created 2026-08-17T07:05:30Z) shows
  museum returns the identical body on repeated calls, with
  `expiryTime 4942623930338282` = 2126-08-17T07:05:30Z — exactly Go's
  `AddDate(100, 0, 0)` off the *stored* subscription row — and `period: "year"`
  where we sent `""`. Fixed: `freeSubscription` now takes the user row and
  derives the expiry from `creationTime` (stable for the life of the account,
  no schema change); `/billing/subscription` and `/billing/verify-subscription`
  load the user for the same reason. `/users/details/v2` key order was also
  aligned to museum's struct order for the D2 harness. Verified byte-identical
  against the live oracle apart from the two fields below.
  - *Known divergence:* `subscription.id` is museum's Postgres serial (1 for
    the first account); ours is the userID. Stable per user either way, and we
    have no subscription table to draw a serial from. Revisit only if a client
    is found to depend on it.
  - *Known divergence:* free-plan storage is env-configured (`10 TiB` default,
    D11) where museum ships 10 GiB — pre-existing self-host decision, not new
    here.

- **D32 [GATE FINDING 2026-08-17] The auth token must also be accepted as a
  `?token=` query param.** The desktop (Electron) client logged a wall of
  `GET /files/preview/<id> -> 401 (0ms)` while signed in. Cause: those routes
  answer a **307 redirect** to presigned S3 and the client loads them as image
  sources — an `<img>`/CSS image load cannot carry `X-Auth-Token`, so our
  header-only middleware rejected every thumbnail. Oracle capture 2026-08-17
  settles the mechanism: museum accepts `?token=` on **every** private route
  (verified on /users/details/v2, /collections/v2, /files/preview/1,
  /files/download/1, /files/preview/v2/1, /trash/v2/diff), a present header
  wins over the query param (valid header + garbage query → 200) and a garbage
  header gets no second chance (garbage header + valid query → 401). Fixed in
  src/middleware/auth.ts; our probe output is now identical to the oracle's.
  - Same capture corrected a **wrong claim in our own docstring**: museum's
    401 body is `{"error":"missing token"}` / `{"error":"invalid token"}`, not
    the bare `{}` the file asserted. Now emitted faithfully. No test asserted
    the old empty body.
  - *Security note:* tokens in URLs land in access logs and `Referer` headers.
    Our gate logger prints `c.req.path` only (verified: a `?token=` value does
    not appear in the log), but edge/CDN access logs are a real exposure —
    see AWS-RESOURCES.md.

- **D33 [GATE FINDING 2026-08-17] The LocalStack bucket needs the same CORS
  rule as the real one.** With D32 in, `/files/preview/:id` returned 307
  correctly but the desktop gallery still showed no images. The 307 points at
  presigned S3, and LocalStack served the bytes `200` with **no
  `Access-Control-Allow-Origin`** (`GetBucketCors` → `NoSuchCORSConfiguration`),
  so the browser discarded every thumbnail. Pure prod/local drift: the tofu
  applies `aws_s3_bucket_cors_configuration` to the real bucket, but
  `scripts/bootstrap-local.ts` only created it. The bootstrap now applies the
  identical rule (GET/PUT/POST/HEAD, origins `*`, expose `ETag`, max-age 3000).
  - `*` matters, not a specific origin: after a cross-origin redirect the
    browser sends `Origin: null`, which only a wildcard satisfies. Both cases
    are asserted end-to-end in test/integration.
  - Guarded in test/infra so the two definitions cannot drift again — the
    guard was mutation-checked (it fails when the lists disagree).

- **D34 [GATE FINDING 2026-08-17] `GET /billing/user-plans` was unimplemented,
  and it exposed a wrong `freePlan.period`.** The desktop client hit
  `/billing/user-plans -> 404`. Oracle capture: it returns the **identical**
  body to `/billing/plans/v2` —
  `{"freePlan":{"storage":…,"duration":100,"period":"year"},"plans":[]}`,
  `freePlan` first — and differs only in auth (plans/v2 is public and answers
  200 unauthenticated; user-plans 401s without a token). Implemented as a
  shared payload behind the two routes.
  - The capture also corrected `freePlan.period`, which we had invented as
    `"days"`. Museum sends `"year"`; `duration: 100` + `"year"` is the same
    100-year horizon as the free subscription expiry in D30, so the two
    captures corroborate each other. `test/unit/stubs.test.ts` had asserted
    the invented `"days"` — the test encoded the guess, so it was corrected
    with the code (ground rule 1: the capture wins).

- **D35 [GATE FINDING 2026-08-17] Account/security page: one route stubbed,
  2FA and passkeys deliberately still 404.** The desktop security page hits
  `GET /emergency-contacts/info`, `POST /users/two-factor/setup` and
  `POST /users/two-factor/passkeys/configure-recovery`. Captured all three:
  - `/emergency-contacts/info` → 200
    `{"contacts":[],"recoverSessions":[],"othersEmergencyContact":[],"othersRecoverySession":[]}`.
    Implemented as a static empty envelope — for a server that has never
    stored an emergency contact, empty *is* the truthful answer (same
    reasoning as the D27 social probes).
  - `/users/two-factor/recovery-status`: the capture corrected another
    invented value — museum sends `allowAdminReset: true`, we had `false`.
  - `/users/two-factor/setup` → 200 with a REAL TOTP secret + QR PNG
    (`{"secretCode":"<base32>","qrCode":"<base64 png>"}`). **Deliberately not
    implemented.** Setup alone is worse than a 404: the app would show a
    scannable QR, then fail at `/users/two-factor/enable`, and if enable ever
    did land, SRP login must start returning a `twoFactorSessionID` instead of
    a token, with `/verify`, `/remove` and recovery codes to match. A partial
    2FA implementation risks locking a user out of their own account, so it
    stays out until it can be built whole. Same for passkeys
    (`configure-recovery` → museum 400s an empty body; it is real WebAuthn).
  - *Probe note:* museum 404s `/users/two-factor/setup` for a half-created
    account (no key attributes / no SRP), which is easy to mistake for "the
    route does not exist". Its **no-route** 404 is gin's plain-text
    `404 page not found`, whereas a handler-level 404 is JSON `{}` — that
    difference is how to tell them apart when probing.
  - *Minor known divergence:* our no-route 404 body is hono's
    `404 Not Found` vs gin's `404 page not found`. No client reads it.

- **D36 [2026-08-17] TOTP two-factor implemented in full** (requested after
  D35 flagged it as out of scope). Built against a complete oracle capture —
  setup → enable → login → verify → recover → remove → disable — rather than
  from the Go source. The contract:

  | route | auth | request | response |
  |---|---|---|---|
  | `POST /two-factor/setup` | token | — | `{secretCode, qrCode}` |
  | `POST /two-factor/enable` | token | `{code, encryptedTwoFactorSecret, twoFactorSecretDecryptionNonce}` | **200, empty body**; `401 {}` on a bad code |
  | `GET /two-factor/status` | token | — | `{status}` |
  | `POST /two-factor/verify` | **public** | `{sessionID, code}` | `{id, keyAttributes, encryptedToken}`; `401 {}` on a bad code |
  | `GET /two-factor/recover` | **public** | `?sessionID=` | `{encryptedSecret, secretDecryptionNonce}` |
  | `POST /two-factor/remove` | **public** | `{sessionID, secret}` | `{id, keyAttributes, encryptedToken}`; **`403 {}`** on a bad secret |
  | `POST /two-factor/disable` | token | — | 200, empty body |

  - **Both login routes** (`/users/verify-email` and `/users/srp/verify-session`)
    switch to `{id, passkeySessionID:"", accountsUrl:"", twoFactorSessionID,
    twoFactorSessionIDV2:""}` with **no token and no keyAttributes**, so the
    branch lives in `onVerificationSuccess` and no token is minted at all
    until the second factor is proven.
  - The three login-shaped 2FA responses carry ONLY
    `id/keyAttributes/encryptedToken` — none of the padding fields.
  - A bad *code* is 401 but a bad recovery *secret* is 403. Captured, not a
    typo.
  - **Parameters** come from decoding museum's own QR PNG:
    `otpauth://totp/ente:<email>?algorithm=SHA1&digits=6&issuer=ente&period=30&secret=<b32>`
    in a 200x200 PNG — SHA-1, 6 digits, 30 s, 20-byte secret (32 base32
    chars). Skew is pquerna's default ±1 window.
  - *Ours, not captured:* two-factor sessions expire after 10 minutes and are
    single-use, and the session id is stored hashed (like auth tokens). The
    lifetime is not observable from a capture without waiting it out.
  - *Known divergence:* `subscription`-style key ordering inside
    `keyAttributes` follows whatever the client sent at signup, where museum
    rebuilds it in Go struct order. Pre-existing, affects every route that
    returns keyAttributes.
  - **New dependency `qrcode`** (+`@types/qrcode`). Its PNG renderer calls
    `require("fs")` at runtime, which an esbuild **ESM bundle cannot do** —
    `make build-lambda` now injects a `createRequire` banner, aliased because
    src/lib/sodium.ts (D25) already imports that name. This failure is
    invisible locally (dev runs the TS directly) and would have surfaced only
    as a 500 in the deployed Lambda; caught by invoking the built artifact,
    and guarded in test/infra (mutation-checked). Bundle is 481 KB.

- **D37 [GATE FINDING 2026-08-17, first cloud upload] Presigned PUTs must bind
  Content-MD5 into the signature. This CORRECTS D26's sub-divergence.** D26
  claimed "SigV4 query auth ignores unsigned headers, verified against
  LocalStack, so the app's headers still pass". That is false against real S3.
  The app sends `Content-MD5` on every single-part PUT and on every multipart
  part; real S3 treats Content-MD5 as an integrity header and refuses a request
  carrying one the signature does not cover:
  `AccessDenied / "There were headers present in the request which were not
  signed" / HeadersNotSigned: content-md5`. Every upload in the first cloud
  backup failed this way (~2000 files, 4 retries each), while every local suite
  stayed green — **LocalStack and the memory adapter do not verify signatures at
  all**, so nothing local could ever have caught it. Same prod/local drift class
  as D33.
  - *Fix needed no protocol change:* the handler already received the values and
    discarded them. `POST /files/upload-url` parsed `contentMD5`,
    `POST /files/multipart-upload-url` parsed and length-checked `partMd5s`, and
    both then called the port without them. They are now threaded through
    `Blobs.presignPut(key, expiry, contentMd5?)` and
    `Blobs.createMultipart(key, partCount, expiry, partMd5s?)`.
  - *Mechanism, verified rather than assumed:* passing `ContentMD5` on the
    command is sufficient and necessary — the presigner signs the header because
    it is present and non-hoistable. `signableHeaders: ['content-md5']` was
    tried and **does nothing**: with no such header set it signs nothing, and
    with one set it changes no output. It is deliberately absent so the adapter
    carries no cargo-cult option.
  - *Content-Length is deliberately left unsigned.* S3's error named only
    content-md5; signing content-length makes presigned PUTs brittle. Revisit
    only if a capture or a real error names it.
  - *Guarded* in `test/unit/presign-md5.test.ts`, which needs neither AWS nor
    docker because SigV4 presigning is pure local computation: it asserts
    `X-Amz-SignedHeaders` contains `content-md5` when an MD5 is supplied and
    omits it when not, plus that both V2 handlers forward the client MD5s to the
    port. Mutation-checked (dropping `ContentMD5` fails the suite).

- **D38 [SECURITY 2026-08-17] The `SRPUSER#<srpUserID>` guard is now write-once
  per owner, and `/users/srp/complete` is bound to its caller.** Found by audit,
  reproduced end-to-end before fixing.
  - The hole: `commitSrpAuth` wrote the guard with an unconditional put, and
    `srpUserID` is *public* — `GET /users/srp/attributes?email=` hands it to an
    unauthenticated caller. So any account could take a victim's srpUserID,
    register it against a verifier of its own, and repoint the guard. Login
    resolves `SRPUSER#<id>` → userId and trusts it, so `create-session` then
    answered with the attacker's `srpB` and the victim's M1 could never match:
    **permanent lockout of any user whose email address is known.** Not takeover
    — `verify-session` re-reads the user from the guard, so the attacker only
    ever minted their own token — the damage was availability, not confidentiality.
  - Compounding it, `completeSrpSetup` never called `auth(c)` at all: the route
    sat behind `authed` but acted purely on `setupID`, so any token could
    complete anyone's pending setup. Its sibling `updateSrp` had the ownership
    check already; this is the same line.
  - Fix: `assertSrpUserIdClaimable` refuses an id held by another account, and the
    guard put carries `ifNotExists` **only when no guard was read**, which closes
    the read-then-write race without breaking the legitimate case — a password
    change that keeps the same srpUserID must re-put a row that already exists,
    and the oracle confirms museum answers 200 to exactly that.
  - **ORACLE-CAPTURED 2026-08-17** against the pinned image (capture 5 in
    ORACLE-VERSION), after an initial guess of 409 turned out to be wrong. Museum
    is NOT exposed to this: its UNIQUE constraint on `srp_users.srp_user_id`
    refuses the write and the victim's login survives every path. The full
    captured contract, all of which we now reproduce:

    | case | museum |
    |---|---|
    | `srp/setup`, any srpUserID (even foreign, even if caller configured) | 200 |
    | `srp/complete`, caller already has SRP | 400 `{"code":"BAD_REQUEST","message":"SRP setup already complete"}` |
    | `srp/complete`, foreign srpUserID, caller has no SRP | 500 `{}` |
    | `srp/update`, foreign srpUserID | 500 `{}` |
    | `srp/update`, own srpUserID kept, new verifier | 200 — password changes, id unchanged |
    | `srp/update`, fresh srpUserID | 200 — rotates |
    | re-completing a spent setupID | 410 `SESSION_ALREADY_VERIFIED` |

  - Three consequences for our code, all now applied:
    1. The collision is reproduced as museum's bare **500**, not the 409 first
       written — same call as `favoritesAlreadyExists`. No legitimate client sees
       it (srpUserID is a fresh uuid4), so parity costs nothing.
    2. The early collision check in `setupSrp` was **removed**: museum answers 200
       there and refuses only at commit, so rejecting early was a gratuitous
       divergence. `commitSrpAuth` is the authoritative gate.
    3. `/users/srp/complete` is now **first-time-only** (400 "SRP setup already
       complete"), which we did not implement at all before. This is museum's own
       primary defence for the common case and it independently blocks the hijack
       for any already-configured account.
  - **One deliberate divergence, kept.** Museum answers **200** to a `complete`
    carrying another account's setupID and commits the material to whoever CALLS:
    captured as `stolen=200 ownerSrpAfter=404 thiefSrpAfter=200 thiefGotTheId=true`
    — the thief takes the srpUserID and the owner is left with no SRP at all. That
    is a cross-account integrity bug; we answer **403** and commit nothing.
    `updateSrp` already had this check before the audit.
  - *Guarded* by `describe('SRP identity guard')` in
    `test/unit/srp-endpoints.test.ts` — the hijack via the public attributes route,
    the first-time-only 400, the collision reached past that gate by a no-SRP
    caller, the same write with the setup row forged directly (so only the
    transaction condition stands), the 403 divergence, and the same-id password
    change that must keep working.

- **D39 [SECURITY 2026-08-17] `GET /files/multipart-upload-urls` bounds its
  part count; the cap now lives in `domain/files.ts` where both multipart routes
  share it.** Found by the same audit as D38.
  - The hole: V1 read `count` straight off the query string and passed it to
    `createMultipart`. `?count=20000` returned 20,000 presigned URLs — a SigV4
    signing operation and ~200 bytes of response each — so one authenticated GET
    could burn the API lambda's 30s timeout and 512MB. Verified before the fix.
  - Root cause worth naming: the ceiling existed as a *private* `MAX_PART_COUNT`
    in the V2 handler, and V1 was written without it. Hoisted to
    `MAX_MULTIPART_PART_COUNT` in `domain/files.ts` and imported by both, so the
    siblings cannot drift again. (`MAX_UPLOAD_URLS` already lived there.)
  - **Rejects rather than clamps**, unlike `/files/upload-urls`. Those URLs are
    independent, so returning fewer is harmless; these are parts of ONE object,
    and a client silently handed fewer would upload an incomplete object and only
    find out at CompleteMultipartUpload. Past 10k is unsatisfiable at S3 anyway.
    Matches the V2 multipart route's existing 400.
  - `count >= 1` is also enforced: `count=0` (and a missing param, which defaults
    to `0`) previously reached S3 and opened a real multipart upload holding zero
    parts, billing until the 7-day abort rule swept it.
  - **ORACLE-CAPTURED 2026-08-17 — exact match, no divergence.** Museum answers
    `count` 1..10000 with that many partURLs, and **400 `{}`** for 10001, 20000,
    0, -5, `abc`, and an omitted param; `GET /files/upload-urls?count=80` returns
    200 with 50. So museum draws the reject-vs-clamp line in exactly the same
    place, for the same reason, and our responses are byte-identical:
    `4:200/4 10000:200/10000 10001:400 20000:400 0:400 -5:400 abc:400 omitted:400
    single80:200/50` from both servers.
  - *Guarded* by `describe('GET /files/multipart-upload-urls part-count bounds')`
    in `test/unit/upload.test.ts` — boundary (10000 ok / 10001 rejected), absurd
    counts, and the non-positive cases asserting `blobs.partMd5s` stays empty so
    the port was never reached. Mutation-checked: deleting the bounds line fails
    all three guard tests.

- **D40 [SECURITY 2026-08-17] Session tokens can now expire on idle, but the
  default is OFF because museum has no expiry at all.** Second of the audit's
  medium findings.
  - The gap: `requireAuth` WROTE `lastUsedTime` on every request and never read
    it, and nothing else bounded a token's life. A token recovered from anywhere
    stayed valid for ever. Combined with `?token=` riding the query string on
    every private route (D32, not removable — the image-src redirects need it),
    that is a long tail.
  - **ORACLE-CAPTURED**: museum's `tokens` table is `user_id, token,
    creation_time, ip, user_agent, is_deleted, last_used_at, app` — **no expiry
    column of any kind**. So museum tokens never expire, and making ours expire
    unconditionally would log real devices out of a photo app. Hence
    `SESSION_IDLE_EXPIRY_SECONDS`, default `0` = off = museum parity. Switching it
    on is a deliberate, documented divergence the operator opts into.
  - When set, `requireAuth` compares now against `max(lastUsedTime, creationTime)`
    — the creationTime fallback matters because the bump is fire-and-forget and
    may legitimately be missing — then REVOKES the row and answers the same
    `401 {"error":"invalid token"}` a revoked token gets. No new wire shape, so an
    expired session is indistinguishable from a logged-out one.
  - Scope correction to the original finding: **no log sink currently captures
    query strings.** CloudFront has no `logging_config`, the bucket has no access
    logging, and our own access log renders `c.req.path`. So the token-in-logs
    exposure was latent, not active. It is now guarded by
    `describe('access log never contains the token')` in
    `test/unit/auth-token.test.ts`, which asserts the log line carries no `?`, no
    `token=`, and not the token itself — so a future switch to `c.req.url` cannot
    quietly start leaking bearer tokens into CloudWatch.
  - *Guarded* by `describe('session idle expiry')`: off-by-default (a token idled
    ten years still authenticates), the opt-in revoking and 401ing, activity
    inside the window keeping a session alive indefinitely (which fails if the
    `lastUsedTime` bump is not being read), and the missing-`lastUsedTime`
    fallback. Mutation-checked.

- **D41 [SECURITY 2026-08-17] The client-supplied `objectID` is validated before
  it reaches an S3 key, and `objectKey()` refuses to build an escaping key.**
  Third of the audit's findings.
  - The gap: `PUT /files/video-data` took `objectID` as `z.string().min(1)` and
    `objectKey()` interpolated it into
    `<owner>/file-data/<fileID>/<type>/<objectID>`, then persisted it for the read
    side to rebuild. Every id this server issues is `pv_<uuid>` / `pi_<uuid>` from
    `previewUploadUrl`, so the commit had no business accepting anything else.
    Whether S3 would actually resolve a `..` segment is beside the point — closing
    it is cheap and the alternative is arguing about S3 key normalisation.
  - Two layers on purpose: `isValidObjectId` at the edge for a clean 400, and the
    same predicate asserted inside `objectKey()` as an invariant, so a future
    ingress cannot reintroduce the hole. The pattern is deliberately looser than a
    strict uuid (`p[vi]_` + up to 64 URL-safe chars) so a client that decorates the
    id still works, while `/`, `\` and `.` stay impossible.
  - **ORACLE-CAPTURED, and it moved us TOWARDS parity.** Museum answers 400 `{}`
    to every objectID shape on this route. Measured differentially against the
    pinned image, five shapes (one well-formed, four malformed):
    - before: `ours 404 404 404 404 404` vs `museum 400 400 400 400 400`
    - after:  `ours 404 400 400 400 400` vs `museum 400 400 400 400 400`
  - **Pre-existing divergence left alone, now measured:** the remaining case is a
    well-formed objectID with a nonexistent fileID, where `getOwnedFile` answers
    404 and museum answers 400. It predates this fix (the "before" row above is
    HEAD). Not fixed here because museum is inconsistent per route — captured:
    `/files/video-data` 400, `/files/data` (mldata) **404**,
    `/files/data/preview-upload-url` 400 — so getting it right needs a
    route-specific not-found status and more captures than this finding warrants.
  - **Known gap, deliberately not changed:** file-data bytes (mldata,
    vid_preview) never pass `assertQuota`, unlike the main upload path. Museum's
    `file_data` table carries `size` with an index `(user_id, data_type,
    is_deleted) INCLUDE (size)` — shaped exactly for a per-user SUM, which is
    strong evidence museum does count it, but not proof that it feeds the quota
    rather than reporting. Confirming it needs a real upload, which this oracle
    cannot do from the host: docker-compose.oracle.yml does not publish MinIO's
    port and museum's presigned URLs are signed for the in-network host `minio:3200`.
    Left unchanged rather than guessed, since over-counting would hand users
    spurious 426s.

- **D42 [SECURITY 2026-08-17] TOTP verification is now capped at 5 attempts per
  two-factor session — a deliberate, observable divergence.** Finding 1 of the
  security review (SECURITY-REVIEW.md).
  - The gap: `verifyTwoFactor` counted nothing, and a wrong code threw BEFORE
    `consumeTwoFactorSession`, so one half-authenticated session admitted
    unlimited parallel guesses for its full 10-minute validity. With
    `TOTP_SKEW_STEPS = 1`, 3 of 10⁶ codes are accepted at any instant; at
    ~1000 req/s that is ~600k guesses per session with expected hits ≈ 1.8 —
    and the attacker can mint fresh sessions at will, since reaching this
    endpoint already requires the password. 2FA reduced to a delay.
  - **Divergence, stated honestly:** D36 captured the 2FA endpoint SHAPES and
    recorded no attempt cap — meaning museum's behaviour past N failures was
    never captured, not that it is known to be uncapped. After this change a
    client sees `429 {}` where it previously saw `401 {}` forever. Same
    category as the OTT hashed-at-rest note in `ott.ts`: hardening the oracle
    never specified. If capture-parity later contradicts this, re-capture past
    20 wrong codes and revisit — but shipping uncapped 2FA to a public URL is
    the worse of the two risks.
  - Mechanics: `TWO_FACTOR_ATTEMPT_LIMIT = 5` (matches `SRP_ATTEMPT_CAP`, the
    closest "prove a secret for this session" analogue; absorbs clock-drift
    retries at skew ±1). The counter lives on the SESSION row — already
    TTL'd, and an attacker can only burn a session they created — never on
    the user partition, where it would be a lockout weapon against the
    account owner. The increment is the F0 atomic `addToCountersReturning`
    (increment first, judge second), and it happens BEFORE the code compare,
    so a correct code past the cap still 429s and a crash mid-handler can
    never hand out a free attempt. `POST /users/two-factor/remove` inherits
    the same counter for consistency and log signal (its secret is
    high-entropy; brute force was never the concern there).
  - *Guarded* by `two-factor.test.ts`: 5 wrong codes → 401, past the cap →
    429 even for a CORRECT code, a fresh login still works (no victim
    lockout), 50 parallel wrong codes stored as exactly 50 (the F0 regression
    guard at this call site), and the shared counter on `remove`.

- **D43 [SECURITY 2026-08-17] Spend ceilings and an origin lock: budget page,
  reserved concurrency, WAF rate rule, security response headers, and a
  shared-secret header that closes the direct Function URL.** Findings 4, 6
  and the infra half of 7 from SECURITY-REVIEW.md, shipped as one edge pass.
  - Layer 1, the budget: `aws_budgets_budget` pages the alarms topic at 80%
    and 100% of ACTUAL spend ($25/mo default, `monthly_budget_usd`). Note the
    explicit `aws_sns_topic_policy` REPLACES the account-default policy, so it
    restates the CloudWatch grant — dropping that would silently mute both
    Errors alarms (guarded by test).
  - Layer 2, `reserved_concurrent_executions` on the API function
    (`api_reserved_concurrency`, default **-1 = unreserved**). The intended 50
    did not survive contact with the account: AWS requires 10 executions to
    stay unreserved account-wide, and this account still sits at the default
    Lambda quota (~10 total), so NO reservation is deployable — and that
    account-wide 10 is itself a tighter invocation ceiling than 50, so the
    protection exists regardless, enforced by AWS. After a Service Quotas
    raise, set ~50 in the tfvars. Double edge stated honestly: exhausted, a
    reservation throttles legitimate users too — the right trade for a
    single-owner deployment, the wrong one for a shared one.
  - Layer 3, the WAF rate rule (300 req / 5 min / IP on `/users/ott`,
    `/users/srp/*`, `/users/two-factor/*`) — only meaningful because of the
    **origin lock**: CloudFront injects `x-origin-secret` (a `random_password`
    that lives only in state, deliberately not in tfvars) and the app 403s
    bare requests when `ORIGIN_SECRET` is set. Off in `make dev`/`make lan`,
    which never traverse CloudFront. OBSERVABLE: the direct Function URL now
    answers `403 {}` to everyone — that URL was never the supported endpoint
    (`server_url` is the CloudFront domain), so no client change.
  - Response headers ride a CloudFront `response_headers_policy` — at the
    edge, NOT in the app, which stays byte-faithful to museum's header set
    (D29): HSTS 1y, `X-Content-Type-Options: nosniff`, and `Referrer-Policy:
    no-referrer`, the one that earns its place by keeping `?token=` URLs
    (D32) out of Referer headers.
  - CLOUDFRONT-scope WAF only exists in us-east-1: the edge module takes an
    aliased `aws.use1` provider from the env root regardless of `var.region`.
  - Audit rows now store only the RIGHTMOST `X-Forwarded-For` entry
    (`src/lib/ip.ts`) — the CloudFront-appended, unforgeable-through-that-path
    address — instead of the verbatim client-controlled header. Fully sound
    only combined with the origin lock above; a strict improvement either way.
  - *Guarded* by `test/infra/lifecycle.test.ts` (`spend ceiling + edge
    hardening guards`), `test/unit/origin-lock.test.ts`, and the XFF cases in
    `auth-token.test.ts`.

- **D44 [SECURITY 2026-08-17] Presigned-URL validity split by verb; PUT cut to
  24 hours, GET deliberately left at museum's 7 days pending an M5 re-run.**
  Finding 5. One knob (`PRESIGN_EXPIRY_SECONDS`, still honoured as a fallback
  for both) fed two very different lifetimes: a download URL consumed in
  seconds but valid a week rides in `<img>` sources and 307 Locations, and a
  week-long presigned PUT is a standing write grant to a key. PUT now defaults
  to 24h (`PRESIGN_PUT_EXPIRY_SECONDS`) — big uploads on slow links stay
  viable, window cut 7×. GET is NOT shortened yet: D26 and D32 were both gate
  findings where real client behaviour contradicted a reasonable server-side
  assumption, and a client that caches thumbnail URLs would start 404ing after
  an hour. Shorten `PRESIGN_GET_EXPIRY_SECONDS` only after the next M5 device
  gate proves the gallery survives idling past the window. Guarded by
  `test/unit/presign-expiry.test.ts`.

- **D45 [SECURITY 2026-08-18] Second review (SECURITY-REVIEW-2.md, gitignored):
  nine findings fixed. None is an observable oracle divergence** — every change
  is invisible hardening, an internal-consistency fix, or a rejection of clearly
  malformed input. Tests in `test/unit/security-review-2.test.ts` (+ the
  existing SRP concurrency test). Summary of what changed and why:
  - **F1 (critical) — `POST /push/token` arbitrary write.** The handler spread
    raw `c.req.json()` into `db.put` AFTER `pk`/`sk`, so a client `pk`/`sk`
    overrode the server key → write to any table row → forge a `TOKEN#` row →
    account takeover. Now a strict zod schema strips unknown keys and the key is
    built server-side (`keys.pushToken`). Museum's push row is store-and-ignore,
    so dropping non-device-token fields is behaviour-neutral.
  - **F2 — SRP verify attempt cap bypassable under concurrency.** The gate read
    a stale, eventually-consistent `attemptCount` and discarded the atomic ADD's
    return, so a parallel burst slipped unbounded guesses past a cap of 5. Now it
    increments first and gates on the returned value — the same shape as the
    OTT/TOTP fixes (F0/D42). The fake-session branch caps identically, so an
    unknown `srpUserID` is indistinguishable from a wrong password at the cap.
  - **F3 — colliding server IDs.** Epoch-derived IDs are only monotonic per
    process, so two instances minting in one millisecond could collide and the
    unconditioned put let one file/collection overwrite another user's. File and
    collection creates now write `ifNotExists` and re-mint on collision.
  - **F4 — unbounded batch endpoints.** `/files/info`, `/files/magic-metadata`,
    `/trash/delete` took uncapped arrays (a single-request fan-out DoS). Now
    `assertBatchSize` (≤1000 → 413), matching the sibling batch routes.
  - **F5 — `entityDiff` `limit=NaN`.** `?limit=abc` slipped past `limit<=0 ||
    limit>5000` (both false for NaN) and drained the whole partition. Now
    `Number.isFinite` gates it.
  - **F6 — purge cron fragility.** `purgeAgedTrash` had no per-row try/catch and
    ran before the object sweep, so one poison/throttle error wedged both GCs.
    Now each row is isolated (skip-and-log, like the sweep already did) and the
    worker runs both GCs independently, re-throwing at the end so the CloudWatch
    `Errors` alarm still fires.
  - **F7 — deletion left data + never checked `isDeleted`.** `deleteAccount`
    tombstoned the user but nothing reaped their S3 objects or key material
    (the "sweep cron's concern" comment was untrue). Now `reapUserData`
    (`domain/accountReaper.ts`) enqueues the user's objects for the existing
    sweep and drops KEYS/SRP/2FA rows, and `requireAuth` refuses a token whose
    user row is `isDeleted` (closes the concurrent-login-during-delete TOCTOU at
    the cost of one point read per request — acceptable at single-owner scale).
  - **F9 — `HASHING_KEY` length unchecked.** `wire.ts` accepted any non-empty
    value; a malformed one decoded to a short/empty buffer and silently degraded
    `emailHash` to an UNKEYED hash. Now it must decode to exactly 32 bytes.
  - **Defense-in-depth:** SRP verify now binds the session to the request's
    `srpUserID`, so a leaked/guessed sessionID can't be exercised under another
    identity to burn its counter.

- **D46 [SECURITY 2026-08-18] Deliberately NOT changed, to preserve oracle
  parity (ground rule #1).** These second-review items are museum-faithful and
  changing them would invent a shape or break the stock client; recorded so they
  are not re-opened as regressions:
  - **`GET /users/sessions` returns plaintext tokens** (F8). Museum stores and
    returns them, and the client terminates a session by passing that very token
    to `DELETE /users/session?token=`, so hiding it would break termination.
    Left as-is; revisit only with a museum-divergent session-id scheme.
  - **OTT is not purpose-bound** (login vs change-email share the partition).
    Not exploitable — every path still needs the code delivered to the target
    inbox, and `sendOtt` refuses a `change` OTT for an already-registered
    address. Museum separates purposes; matching it is a future capture, not a
    guess.
  - **TOTP codes are replayable within their ~90s skew window** and **2FA
    enable/disable/change-email do not re-auth or rotate sessions** — both
    museum/pquerna-faithful. The per-session TOTP cap of 5 (D42) is already a
    port improvement over museum's uncapped behaviour.
  - **`entityDiff`/`getEntityKey` skip `assertEntityType`.** Verified NOT
    cross-tenant (the partition is always `USER#<caller>` / `ENTITY#<caller>`),
    so it is a pure-consistency nit; adding the assert risks 400-ing a type
    museum returns empty for, so it waits on a capture.

- **D47 [COST 2026-08-19] The distribution subscribes to the CloudFront
  flat-rate FREE pricing plan — the WAF becomes $0 instead of the bill's
  largest fixed line.** On pay-as-you-go the D43 rate rule costs $5/mo (web
  ACL) + $1/mo (rule) + $0.60/1M requests — trivially the dominant line item
  when everything else sits in free tier. The config already embodies every
  applicable WAF cost practice (scope-down on the rate rule, no managed rule
  groups, no WAF logging, bytes bypass the distribution via presigned S3), so
  the fixed fees were the irreducible remainder. AWS's flat-rate plans
  (launched late 2025) cover, for one distribution + one web ACL: the ACL,
  custom rules, and ALL CloudFront/WAF request fees. FREE tier = $0/mo.
  - **Eligibility checked against the unsupported-features list**: standard
    distribution, modern managed cache/origin-request policies, no real-time
    logs, no rule groups, no OAI/dedicated-IP/field-level encryption, and the
    web ACL is associated with only this distribution (plans require exclusive
    association — and require an ACL stay attached, so D43's rule is
    load-bearing here, not just tolerated).
  - **Two D43 controls were FREE-tier-gated and got substitutes** (the console
    flags them on the switch-plan page: "custom response headers policies,
    byte match" — the docs' unsupported-features list does NOT mention these
    per-tier gates; the features-by-tier matrix does). Accepted dilutions,
    decided 2026-08-19:
    - The rate rule's auth-path scope-down used `byte_match_statement`s
      (Business-tier regex/byte matching); plain IP rate limiting is in every
      tier. The rule is now unscoped at **2000/5min/IP** (was 300/5min on
      auth paths only) — high enough to clear an initial backup's API burst,
      still a hard flood ceiling. The brute-force bounds were never really
      the edge's: the app's atomic per-account caps (D42/D45) are the tight
      gate, and SES-burn is sandbox-bounded besides.
    - The custom response-headers policy (`no-referrer`) is replaced by the
      AWS managed SecurityHeadersPolicy (`67f7725c-…`): HSTS 1y + nosniff
      survive unchanged; Referrer-Policy becomes
      `strict-origin-when-cross-origin`, under which cross-origin Referers
      carry scheme+host only — the `?token=` query (D32, the actual leak)
      still never reaches a third party. Restore the D43 originals only if
      the plan is ever cancelled back to pay-as-you-go.
    - A third gate is UNDOCUMENTED and the console does not pre-warn about
      it: `CreateSubscription` refused the PriceClass_200 distribution
      ("resources are not eligible for this subscription tier"). Subscribing
      from the console works — it flips the distribution to
      **PriceClass_All** in the process. `price_class` is now pinned to All
      in the config to match (a revert breaks the plan; guarded), and the
      earlier PriceClass_200 cost analysis (AWS-RESOURCES §2.1) matters again
      only on pay-as-you-go.
  - **Subscribed 2026-08-19 from the console, status ACTIVE**, covering the
    distribution + web ACL. `make pricing-plan` now no-ops against it and
    exists for re-subscribing after a destroy/re-apply.
  - **Allowances (1M requests / 100 GB per month) are soft** — no overage
    charges ever; blocked requests don't count; one 3× spike per month is
    accommodated; only sustained excess triggers an upgrade nudge or slower
    edges. Photo bytes never cross this distribution (presigned S3 is the byte
    path), so the allowance sees only small JSON.
  - **If demand outgrows FREE**: revert to pay-as-you-go, do NOT take Pro —
    $15/mo only beats $6 + $0.60/1M past ~15M requests/month.
  - **CLI, not tofu**: the AWS provider has no pricingplanmanager resource yet
    (hashicorp/terraform-provider-aws#49232 open as of 2026-08-19); the
    subscription is `make pricing-plan` — idempotent, guarded by
    guard-account, ARNs from the new `distribution_arn`/`web_acl_arn`
    outputs. Fold into the edge module when the provider ships support. The
    subscription dies with the distribution: re-run after any `make destroy` +
    re-apply. Revert path: `aws pricing-plan-manager cancel-subscription`.
  - Deployer policy grows a `PricingPlanFreeTier` statement
    (pricingplanmanager Create/Get/List/Update/CancelSubscription) — re-paste
    the inline policy on deployers created before this (INSTALL C3).
  - *Guarded* by `test/infra/lifecycle.test.ts` (`pricing-plan subscribes THIS
    distribution + web ACL to the FREE tier`), including that the target can
    never create a paid tier.

- **D48 [SCHEMA 2026-08-27] Sharing/public-link lookups use explicit
  reverse-lookup partitions (PENDING-FEATURES-PLAN §2 Option 2), NOT a new
  `gsi4`.** Phase A schema foundation, decided before any sharing handler
  exists so it is cut once. Three parts:
  - **Reverse partitions over gsi4.** "Collections shared with me" is a dual
    write: `COL#<id>/SHAREE#<userID>` + `USER#<userID>/SHARED#<colID>`, both
    sides applied in one `transactWrite` (the port primitive already existed;
    it now also refuses batches past DynamoDB's 100-item TransactWriteItems
    ceiling, both adapters). "Token → collection" is its own PK
    (`PUBTOKEN#<tokenHash>/META`, a plain GetItem) plus a `COL#<id>/LINK`
    pointer so the owner finds the active link. A `gsi4` would have been
    cleaner to query but costs an online backfill on the prod table, mirrored
    memory-adapter + tofu changes, and the last cheap index — the dual-write
    tax is paid instead, and *only* `src/domain/sharing.ts` may write the
    pairs (no handler touches one side directly, so the sides cannot drift).
    `USER#<id>/SHAREDTOMB#<colID>` is reserved for the Phase C per-user
    unshare tombstone (deliberately NOT under the `SHARED#` prefix, so live
    listings never see tombstones); nothing writes it yet.
  - **Link tokens are hashed at rest** (sha256, the `tokenHash` discipline
    session tokens already follow). Unlike session tokens there is no
    list-sessions-style route that must return the plaintext, so only the
    hash is stored; the plaintext exists once, in the create response, and a
    disabled link is never resurrected — re-enabling mints a new token
    (plan §4.3 margin against leaked URLs).
  - **Rollback rule: new row types set NO gsi1/gsi2/gsi3 attributes.** The
    GSIs are sparse, so sharee/link/tombstone rows are invisible to every
    pre-sharing query path by construction — code deployed from `main`
    against a table already containing Phase A rows behaves exactly as
    today. Enforced by the "rollback rule" test in
    `test/unit/sharing.test.ts`; the key shapes live in `src/domain/model.ts`
    with the rule stated where the next row type will be added.

- **D49 [AUTHZ 2026-08-27] Phase B authz seam: role-aware access resolution,
  with museum re-verified from source where the plan's audit was wrong.**
  `resolveCollectionAccess` (src/domain/collections.ts) ports museum's access
  controller (pkg/controller/access/collection.go GetCollection) including its
  check order and the `VerifyOwner` short-circuit; `getOwnedCollection` is now
  a thin owner-requiring wrapper, so owner-only routes are byte-identical.
  Judgment calls, each pinned against museum source fetched 2026-08-27
  (ente-io/ente main — the pinned oracle image is frozen 2026-08-16 main and
  the cited lines predate the freeze):
  - **removeFilesV3's dead branch became museum's real matrix**
    (file_action.go isRemoveAllowed): files owned by the COLLECTION OWNER are
    never removable via this endpoint — 400 for everyone (owner included;
    clients move or trash instead); past that gate the owner removes any
    sharee-owned files, and a sharee removes only files they own (403
    otherwise). Museum's ADMIN remove-suggestion flow is out of scope: no code
    path here can mint an ADMIN participant row, so `CollectionRole` models
    OWNER/COLLABORATOR/VIEWER only. The old test locking the unconditional 400
    was rewritten in the same commit (plan §4.8).
  - **/files/info did NOT get "filter-to-accessible".** The
    PENDING-FEATURES-PLAN §1 audit claimed museum filters to accessible files;
    museum source says otherwise — GetFileInfo (pkg/controller/file.go) gates
    on FileRepo.VerifyFileOwner, pure strict ownership (400 unknown/partial,
    403 foreign), sharing or not. Strict ownership stands unchanged;
    capture-gated (a capture showing sharee access flips this).
  - **File commit stays owner-only.** The plan expected collaborators to
    commit into shared collections; museum's validateFileCreateOrUpdateReq
    says "Creating a file requires collection ownership, not shared access"
    (the check carries a "Warning: Do not remove" in pre-prune history). The
    collaborator flow is commit-into-own-collection + /collections/add-files
    (AddFiles allows Role.CanAdd() = OWNER|COLLABORATOR|ADMIN). Quota and
    object-key attribution stay with the uploader — unchanged.
  - **Non-members read 403, museum reads 404.** On role-resolved paths
    (getById, diff v2, add-files, remove-files v3) museum surfaces
    non-membership as sql.ErrNoRows from GetCollectionShareeRole → 404 via
    handler.go's status mapping. This repo throws errPermissionDenied (403),
    matching the pre-sharing owner-only behaviour and the existing locked
    tests. Deliberate, capture-gated: if the capture-diff harness confirms
    museum's 404, flip the resolver's non-member throw and the tests together.
  - **Deleted-collection diffs still serve tombstones to the owner.** Museum
    GetDiffV2 passes IncludeDeleted:false (deleted → 404); this repo keeps the
    pre-Phase-B behaviour (includeDeleted:true) because the trash replay gate
    diffs deleted albums to convergence. Capture-gated with the same rule.
  - **getAccessibleFile's sharee branch** ports the accessible-object SQL
    (pkg/repo/object.go GetAccessibleObjectWithDCs): owner, else any live
    FILE-LINKS row whose collection the caller is sharee of (getSharee, one
    GetItem) or owns. One simplification: museum's owner branch technically
    requires a live collection_shares row with from_user_id = actor; this repo
    grants the collection owner directly, so an owner who unshared everyone
    keeps reading a collaborator's still-linked file where museum would 404 —
    strictly more permissive for exactly the user the E2EE model already
    trusts with the collection key. Non-members and unknown ids stay 404
    (enumeration resistance preserved).

- **D50 [SHARING 2026-08-27] Phase C: collaborator share endpoints + the
  sharee sync feed, pinned against museum source fetched 2026-08-27
  (pkg/api/collection.go, pkg/controller/collections/share.go +
  key_validation.go + diff.go, pkg/repo/collection.go, ente/collection.go —
  the pinned oracle image is frozen 2026-08-16, so anything newer than the
  freeze is flagged capture-gated below).** Routes are museum's:
  `POST /collections/share`, `POST /collections/unshare`,
  `POST /collections/leave/:collectionID`, `GET /collections/sharees`, all
  answering `{"sharees":[{id,email,name:"",role}]}` where museum does.
  Judgment calls:
  - **The per-user unshare tombstone is a `SHAREDTOMB#` row, and its feed
    entry reuses the blanked global-tombstone shape.** Museum has no separate
    tombstone: the collection_shares row itself flips `is_deleted` and the
    sharee-feed scan emits it with the collection's live fields, the share's
    encryptedKey, owner email blanked, and `sharees`/`publicURLs` as `[]`.
    This repo emits the pre-existing blanked shape (key material empty,
    sharees/publicURLs null) — clients act only on `id`+`isDeleted`.
    Capture-gated. Related divergence: museum's shared-feed join has NO
    is_deleted filter, so a stale unshare re-surfaces whenever the collection
    is later restamped; ours surfaces once per tombstone stamp (re-stamped on
    repeat removals). Idempotent either way; capture-gated.
  - **The sharee's live feed entry is museum's scan, field for field**
    (GetCollectionsSharedWithUser): `encryptedKey` = the share row's wrapped
    key with NO `keyDecryptionNonce` (never selected; omitempty; sealed boxes
    need no nonce), owner block carries the real owner's email, `attributes`
    is the zero struct `{"version":0}`, the owner's private magicMetadata is
    withheld while pubMagicMetadata passes, and `sharees` is the full live
    list including the caller. `sharedAt` is stored (first-share time, kept on
    live re-share, re-stamped on resurrection — the ON CONFLICT CASE) and
    emitted; the field may postdate the frozen oracle — capture-gated.
    `sharedMagicMetadata` and the plain-name legacy column have no equivalent
    here (no sharee-magic-metadata endpoint yet — Phase E at the earliest).
  - **GET /collections/:id now swaps in the sharee's wrapped key** (museum
    GetWithSharingDetailsForUser) while the collection's own
    keyDecryptionNonce rides along unchanged — museum's exact quirk. Sharees
    lists are populated for every caller on getById and both feed halves;
    the create response keeps `sharees: null` (museum returns the fresh
    struct, Sharees never set).
  - **publicURLs stays null everywhere until Phase D.** Museum emits `[]` on
    both v2 feed halves and null only on a link-less getById, then filters
    links for non-owner roles (FilterPublicURLsForRole — seam comment left in
    collectionToJson). Pre-sharing behaviour kept; capture-gated with Phase D.
    Same call for the owned-feed owner block: museum's owned scan leaves
    owner.email "", this repo has always filled it — kept, capture-gated.
  - **Role menu is VIEWER|COLLABORATOR; ADMIN is 400.** Museum's repo accepts
    ADMIN on share (and 500s on unknown strings); nothing in this repo can
    honour an ADMIN row (D49), so zod refuses it as 400. Capture-gated.
    Sealed-key validation matches museum's plain-error-to-bare-500 mapping
    (validateSealedCollectionKey: exactly 80 bytes), including a MISSING
    encryptedKey (not binding-required upstream → 500, not 400).
    AllowParticipantSharing verified from source: favorites ARE shareable;
    uncategorized only as VIEWER. Share carries NO app-mismatch check in
    museum (ErrInvalidApp is create-time only) — none added, per the Phase B
    handoff question. Sharing a DELETED collection: museum's repo.Get does
    not filter is_deleted so it would proceed; this repo 404s — capture-gated.
  - **Leave removes the leaver's OWN files from the collection** — verified in
    source (Leave → UnShare → UnShareContext's collection_files update), same
    composite as unshare (`revokeShareeAccess`: row pair + tombstone in one
    transaction, then the sharee's link tombstones, then a collection
    restamp). Owner-leave is 403, leaving a collection never shared with you
    is a 200 no-op, both museum-exact.
  - **Cascades.** deleteCollectionV3 now (a) trashes only OWNER-owned files
    and merely unlinks sharee-owned ones (museum TrashV3 +
    removeAllFilesAddedByOthers — the old code would have trashed a
    collaborator's file into the owner's trash), and (b) removes + feed-
    tombstones every sharee (museum ScheduleDelete's collection_shares
    UPDATE), chunked at 33 sharees per transaction (3 ops each, under
    MAX_TRANSACT_OPS; each sharee's ops stay in one chunk — only the batch as
    a whole is non-atomic past 33, where museum's single SQL UPDATE is).
    Account deletion (reapUserData) revokes both directions — collections
    shared WITH the user via the full unshare composite (their files leave
    others' albums too), collections the user OWNED via removeAllSharees —
    matching ResetUserSharingAccess; cast/social/link cleanup has no
    equivalent surface here yet. Best-effort like the rest of the reaper.
  - Non-member 403-vs-404 stays as D49 left it (this repo 403s), now also
    covering the post-unshare probes in the new tests.

- **D51 [SHARING 2026-08-27] Phase D: public album links end to end —
  share-url management, the /public-collection serving surface, collect
  uploads, and the plan-§4.1 abuse controls. Pinned against museum source
  fetched 2026-08-27 (ente-io/ente main: cmd/museum/main.go,
  pkg/api/public_collection.go + collection.go, pkg/controller/public/
  collection_link.go + link_common.go + link_device_token.go,
  pkg/controller/collections/share.go, pkg/repo/public/collection_link.go,
  pkg/middleware/collection_link.go, ente/public_collection.go, ente/jwt;
  where the frozen 2026-08-16 oracle revision ba654ea differs it was diffed
  and the FROZEN behaviour kept — noted per item).** Routes:
  POST/PUT `/collections/share-url`, DELETE `/collections/share-url/:id`
  (response `{"result": PublicURL}` / `{"result": PublicURL}` / bare 200),
  POST `/collections/join-link` (authed + access token), and the public group
  behind the X-Auth-Access-Token middleware: GET `/public-collection/info`,
  `/diff`, `/files/preview/:id`, `/files/thumbnail/v3/:id`,
  `/files/download/:id`, `/files/download/v3/:id`, POST `/verify-password`,
  `/upload-url`, `/multipart-upload-url`, `/file`. Judgment calls:
  - **D48's "only the token hash is stored" is PARTIALLY REVERSED.** Its
    premise ("no route must return the plaintext") is false: museum re-emits
    the full token-bearing URL (`<apps.public-albums>/?t=<token>`) in
    `publicURLs` on the owned feed, the sharee feed and getById
    (repo/collection.go GetCollectionToActivePublicURLMap + the owned-feed
    join). The PUBTOKEN row therefore now stores the plaintext token as an
    attribute — the exact session-token discipline of tokens.ts (hash-keyed
    row, plaintext alongside; museum stores plaintext outright). The rewritten
    test asserts the plaintext appears in no key, only on the hash-keyed row.
  - **Token format**: 10 chars uniform over the unambiguous 32-char uppercase
    alphanumeric alphabet (50 bits from crypto rand) — same length/shape as
    museum's `strings.ToUpper(shortuuid.New()[0:10])` and at least its
    effective entropy. A create on a collection with an active link returns
    THAT link, 200 (museum's ErrActiveLinkAlreadyExists path) — even when the
    existing link is expired ("active" upstream only means not disabled, so
    expired links keep emitting in publicURLs and stay updatable). validTill
    is clock-checked on UPDATE only, never on create — upstream quirk, kept.
  - **PublicURL JSON** field-for-field per ente/public_collection.go:
    nonce/memLimit/opsLimit only on passworded links, minRole omitempty,
    passwordEnabled keyed on the nonce (the repo scans do that; the update
    path's PassHash-based computation is equivalent since the four move
    together here). The `/info` variant is museum's "limited info" scrub:
    flags + KDF params only, url/deviceLimit/validTill as zero values —
    a viewer never gets the token echoed back. minRole is accepted on update
    (VIEWER/COLLABORATOR/ADMIN/OWNER — IsValidShareRole) and filters
    feed/getById visibility by role rank (FilterPublicURLsForRole); a sharee
    whose role satisfies it DOES see the token-bearing URL, as upstream.
  - **Owner email is blanked on `/public-collection/info`** (museum repo.Get
    never selects it) — the one place collectionToJson's always-filled owner
    email (D50) must not leak, so the handler builds the JSON itself.
    referralCode rides the storage-bonus stub → `""` (museum ignores the
    GetOrCreateReferralCode error; zero value on that path).
  - **Middleware order + error bodies verbatim** from
    pkg/middleware/collection_link.go: missing token 401 {"error":"missing
    accessToken","context":"album_link"}; unknown 401 {"error":"invalid
    token"} (one GetItem — plan §4.1b cheap-fail); disabled 410
    {"error":"disabled token"}; expired 410 {"error":"expired token"};
    password gate 401 {"error":{}} (gin marshals the Go error to {}) with
    /info and /verify-password whitelisted so clients can fetch KDF params.
    NOT ported: the owner-subscription check (billing is stubbed active, D34
    — including the free-user device-limit clamp, the only frozen-vs-main
    middleware diff) and custom-domain Origin validation.
  - **Device limit**: museum-exact mechanics — a device is (client IP, UA);
    admission happens ONLY on /info and /diff; a device that ever got in
    stays in; deviceLimit 0 = unlimited but unique devices are still
    recorded; the settable max 50 is enforced as 500
    (DeviceLimitThreshold×10 — quirk, reproduced); over-limit → 403
    {"code":"LINK_DEVICE_LIMIT_EXCEEDED",...}. Implemented as one DEVICE# row
    per device + an atomic DEVICES counter under the PUBTOKEN partition (one
    transactWrite — museum's SELECT-then-INSERT is racier). The link-device
    JWT rides too: X-Auth-Link-Device-Token in, X-**Ente**-Link-Device-Token
    out (the FROZEN header name; current main renamed it to
    X-Link-Device-Token post-freeze — frozen wins), 365-day expiry capped at
    validTill, refreshed inside 30 days, claims per LinkDeviceClaim with
    linkID = tokenHash (upstream uses the row's serial id; the claim is
    opaque to clients). Discord abuse alerts and the CF-worker IP skip have
    no equivalent here.
  - **JWT**: new src/lib/jwt.ts, HS256 compact JWS mirroring golang-jwt v4 as
    museum uses it — NO registered exp/iat handling; claims carry
    `expiryTime` in epoch MICROS checked by the caller (LinkPasswordClaim
    {passKey, expiryTime}, 30-day validity). Museum signs with its own
    `jwt.secret` config; this repo derives the signing key as keyed blake2b
    of a fixed context over HASHING_KEY (no second secret to provision, and
    the email-hash / JWT domains stay separated). verify-password compares
    the client-derived argon2id passHash constant-time; its wire shapes are
    museum's (missing body 400 {}, unconfigured 400 {}, wrong 401 {}, match
    {"jwtToken"}). Join-link reproduces museum's quirky split: a
    missing/garbled JWT is a bare 500 (golang-jwt parse error propagates as a
    plain error), a valid JWT with a stale passKey is 401.
  - **GetPublicDiff**: same 2500/cluster pagination spine as the authed diff
    (extracted to domain/files.ts collectionDiffPage), with magicMetadata
    stripped per entry. Museum's action-marker→isDeleted and
    `encryptedData=="-"` stale-row conversions have no equivalent rows here
    (links tombstone via isDeleted directly). Missing sinceTime is 400
    BAD_REQUEST (museum ParseInt), unlike the authed diff's default-to-0.
  - **Collect**: only museum's POST routes exist publicly (upload-url,
    multipart-upload-url — partMd5s REQUIRED there, bare 400 on absence —
    and file). Attribution flips to the link owner: object keys under
    `<ownerID>/`, quota asserted/charged against the owner, file.OwnerID =
    owner and file.ID forced 0 (no updates through a link), body.collectionID
    must equal the link's (400 "can only update to associated collection").
    enableCollect=false → 405 PUBLIC_COLLECT_DISABLED on all three.
  - **DIVERGENCE — flags are access-control, not DRM (plan §4.2/§4.3).**
    `enableDownload:false` is enforced server-side as 403 {} on ORIGINAL
    downloads (both variants) while previews still serve — museum does NOT
    enforce the flag at all (client-honoured; verified in
    GetPublicOrCastFileURL → getSignedURLForCollectionObject, no flag check).
    Documented limits, deliberately: previews must stay decryptable for the
    page to render; presigned GETs are bearer URLs for their lifetime (public
    presigns use a new short knob, below); a link-holder who synced keeps the
    collection key forever — revocation is shallow by protocol design, the
    one real remedy is the client-side remove-files-and-recreate-album flow.
    Disable kills the token immediately at the API but not bytes already
    fetched; a disabled token is never resurrected — re-enable mints a new
    one.
  - **DIVERGENCE — abuse ceilings with no museum equivalent (plan §4.1).**
    (a) verify-password wrong-attempt cap: 20 per (tokenHash, IP) per sliding
    hour → 429 {} (the OTT-cap pattern, atomic ADD-then-judge, TTL'd row);
    museum leans on its per-IP gin rate limiter, which this stack lacks.
    (b) Per-link daily ceilings: downloads (presign issuance, previews
    included) and uploads (upload-url mints + commits) against
    PUBLIC_LINK_DAILY_DOWNLOADS (default 10000) / PUBLIC_LINK_DAILY_UPLOADS
    (default 1000), 0 = off → 429 {}. Counter rows live under the PUBTOKEN
    partition, TTL'd, no gsi attributes (D48 rollback rule holds for every
    new row type).
  - **Config knobs added**: ALBUMS_URL (museum apps.public-albums, default
    https://albums.ente.com — main.go SetDefault, verified at the frozen
    revision), PRESIGN_PUBLIC_GET_EXPIRY_SECONDS (default 3600 — the plan
    §4.2 short public presign, vs 7d authed), and the two daily ceilings.
  - **Lifecycle (plan §4.6, done now not Phase E)**: deleteCollectionV3
    disables the link BEFORE tombstoning (museum TrashV3 order) and
    reapUserData disables links on every owned collection (museum
    HandleAccountDeletion); disableLink also purges the link's device/attempt/
    ceiling rows best-effort. TTL backstop: EXPIRING link rows carry the
    table's `ttl` attribute at validTill + 90 days (so recently expired links
    still emit in publicURLs and can be extended, museum-style) — middleware
    stays the enforcement; disabled rows have their ttl STRIPPED so dead
    tokens never get reaped into a 401 (they must answer 410 forever).
  - **Deliberately unimplemented public routes** (404, never hollow 200s —
    plan §3 caveat 5): the social/comments/reactions/anon-identity group
    (Phase E scope with the D27 stubs), and GET /files/data/fetch +
    /files/data/preview (public HLS video-data — the albums app degrades to
    original download; revisit with a capture if the pinned albums build
    breaks on it). POST /public-collection/report-abuse does NOT exist
    upstream anymore (absent from main.go at the frozen revision AND current
    main — only the request struct lingers in ente/public_collection.go), so
    it is deliberately NOT implemented despite appearing in older docs; the
    ground rule "never invent a shape" wins.
  - Free-user device-limit clamping, locker URLs (`share.ente.com/c/<t>`),
    Discord alerts, and the middleware's response cache are museum features
    with no meaning here (billing stubbed, photos-only, single-user scale).

- **D52 [SHARING 2026-08-27] Phase F: albums web hosting infra — tofu web
  module, build/deploy pipeline for the pinned albums viewer, and the
  plan-§4.1a edge posture for /public-collection/*. Infra + tooling only; no
  deploy performed (M7 discipline holds).** Judgment calls:
  - **Module placement: a fourth module, `src/infra/modules/web`,** beside
    data/compute/edge rather than inside edge — it shares edge's technology
    (CloudFront) but not its lifecycle or subject (edge fronts the API and is
    pinned to the D47 FREE-plan shape; web is an independent static site the
    operator re-syncs at will). Stateless like compute: the bucket holds only
    `make build-web` output, so it carries `force_destroy = true`, no
    versioning, no prevent_destroy, and `make destroy` now targets module.web
    too — tearing it down costs a rebuild, never a memory.
  - **A SECOND distribution, not a new origin/behavior on the API one.**
    Three reasons: ALBUMS_URL is a different BASE URL by museum contract
    (apps.public-albums vs the API host — path-based routing on one domain
    would diverge from every upstream client's URL parsing); the dev env uses
    default *.cloudfront.net domains, and one distribution has exactly one of
    those; and the API distribution + its web ACL are the exact resource pair
    the D47 FREE subscription was created against — mutating it risks the
    undocumented eligibility gates D47 already tripped over. The albums
    distribution stays on PAY-AS-YOU-GO (PriceClass_100, no WAF): static
    assets sit inside CloudFront's perpetual free tier, a web ACL is $5/mo
    flat, and a cached static origin has no per-request compute to protect.
  - **OAC on the web bucket** — the long-standing "no OAC" decision transfers
    from immich-serverless for the LAMBDA origin only (IAM auth breaks the
    POST body hash); an S3 origin takes OAC cleanly, so the bucket is fully
    private (public-access-block ×4) with s3:GetObject granted only to the
    cloudfront service principal condition-pinned to this distribution's ARN.
    SPA fallback maps BOTH 403 and 404 → /index.html 200 (OAC without
    ListBucket surfaces missing keys as 403), error_caching_min_ttl 0. Cache
    split: managed CachingOptimized for the hashed assets, CachingDisabled
    pinned to /index.html (it names the current hashes — a stale index 404s
    every asset it references), managed SecurityHeadersPolicy on both.
  - **§4.1a rate limiting for /public-collection/*: the FREE plan cannot
    scope a rate rule to a path** (that needs a byte-match scope-down —
    exactly the feature D47 traded away), so the surface rides the API
    distribution's existing unscoped 2000/5min/IP rule and the tighter bounds
    stay app-level and per-LINK (D51: one-GetItem token cheap-fail,
    verify-password caps, per-link daily ceilings, short public presigns),
    with reserved concurrency + budget alarms as bill fuses. Documented in
    edge/main.tf and AWS-RESOURCES.md (guard-tested); restore a 300/5min
    scoped rule only if the plan is ever cancelled to pay-as-you-go.
  - **Albums build pinned like the oracle (plan §4.5): ente-io/ente tag
    photos-v1.3.61** (2026-08-11; the viewer lives at web/apps/albums and
    rides the photos-v* family — it has no tags of its own). The pin lives
    twice on purpose — Makefile `ALBUMS_WEB_TAG` (machine-read by build-web)
    and the ORACLE-VERSION "albums web" line (the version-of-record document)
    — with a guard asserting they agree. Build facts verified against the
    repo 2026-08-27: npm workspace (engines npm 11.x), `npm ci && npm run
    build:albums`, Next.js STATIC export to web/apps/albums/out/,
    NEXT_PUBLIC_ENTE_ENDPOINT baked in AT BUILD TIME — so `make build-web`
    builds locally into gitignored dist/web-albums (sparse clone of web/
    only), and a separate, guard-account-gated `make deploy-web` does the s3
    sync + invalidation. An API-URL change is a REBUILD, not a re-sync.
  - **ALBUMS_URL wiring**: compute takes a required `albums_url` variable (no
    default — a silent fallback would mint links pointing at ente's own
    albums.ente.com) and the dev env feeds it
    `coalesce(var.albums_url, module.web.albums_url)`, so a custom domain is
    a tfvars override away. PRESIGN_PUBLIC_GET_EXPIRY_SECONDS and the two
    D51 ceilings became optional tofu vars → Lambda env; their tofu defaults
    (3600 / 10000 / 1000) are guard-matched to config.ts, D11-style.
  - **Objects-bucket CORS verified, unchanged**: browser upload/download from
    the albums origin is already covered — origins `*`, headers `*`,
    GET/PUT/POST/HEAD, ETag exposed (multipart part PUTs need it; D33 guards
    keep tofu and the LocalStack bootstrap in lockstep). The
    X-Auth-Access-Token header family is API CORS (src/middleware/cors.ts,
    museum-shaped per D29), not bucket CORS — presigned S3 requests carry no
    custom headers.
  - Consciously NOT done here (Phase G / operator scope): actually deploying
    anything, custom-domain plumbing (ACM cert + alias), CloudFront access
    logging, and the manual open-a-real-link gate on the pinned build —
    which stays the release gate before the README row flips to Done.

- **D53 [SHARING 2026-08-27] Security-review fixes on the public-links branch
  — device-admission TTL + daily ceiling (P2-1), atomic same-device admission
  (P3-1), constant-time join-link token compare (P3-2).** Judgment calls:
  - **P2-1a — admission rows get a rolling TTL backstop**: DEVICE#<hash> rows
    and the DEVICES counter now carry `ttl` = now + 90 days (the link-META
    validTill+90d margin), refreshed on the counter at every new admission.
    Museum keeps public_collection_access_history forever, so a device reaped
    after 90 quiet days simply gets RE-admitted (burning a slot and a ceiling
    unit again) — "admitted stays admitted" drifting to "re-admitted" is the
    accepted delta; the counter can also briefly overcount reaped rows near
    the limit, which only errs toward stricter. The disable-link purge of the
    PUBTOKEN partition is unchanged (TTL is the backstop, not the cleanup).
  - **P2-1b — per-link daily admission ceiling**: new knob
    `PUBLIC_LINK_DAILY_DEVICES` (default 1000, 0 = off) → config
    `publicLinkDailyDeviceLimit` → `bumpDailyCeiling(kind: 'devices')`, wired
    env→config→tofu exactly like the D51/D52 download/upload ceilings
    (compute + dev variables, guard-matched defaults). Needed because
    /public-collection/info is password-whitelisted AND device-admitting: a
    token holder cycling User-Agents was unbounded permanent rows + write
    cost, and with a deviceLimit set could exhaust slots to lock out real
    viewers. A tripped ceiling fails the ADMISSION as the same bare-429
    SentinelError the other ceilings raise (the middleware rethrows it past
    its museum-500 catch-all); already-admitted devices are untouched.
  - **P3-1 — the DEVICE# put is now conditioned on not-exists** inside the
    existing transactWrite, so a concurrent admit of the SAME device loses
    the transaction, maps ConditionFailedError to admitted, and can never
    double-increment DEVICES. Two DIFFERENT devices racing under the last
    slot can still both land (read-then-judge on the counter) — museum's
    SELECT-then-INSERT is racier still, so that over-admission stays as
    accepted, museum-consistent drift rather than new port machinery.
  - **P3-2 — /collections/join-link token compare**: `link.token !==
    accessToken` became `passHashEquals` (the branch's timingSafeEqual
    helper from verify-password) — an attacker-supplied token must not leak
    prefix-match timing.
  - **Residuals accepted, unchanged**: the share email-enumeration oracle is
    upstream-faithful (D50), and the XFF-based caps can be skewed only via
    the direct Function URL, which the tracked origin-lock finding (D47/D52
    ORIGIN_SECRET) already closes for edge traffic.

- **D54 [OPS 2026-08-27] Phase H1: invite-gated signup + per-user storage
  quotas — a deliberate OFF-PARITY feature, server/CLI-side only.** Museum has
  no invite mode and no per-user storage knob; a self-host operator here wants
  to invite users by email, let them complete the stock OTT+SRP flow
  self-serve, and cap some of them (down to 0 bytes — "viewer accounts" that
  only consume shares). HARD CONSTRAINT honoured: zero client-side changes —
  every wire shape stays museum-shaped and only VALUES differ; provisioning is
  `make invite` / tools/invite.ts, never an API route. **capture-diff must
  skip invite-mode behaviour**: captures run against a museum that always
  admits signups, so the harness must run this server with SIGNUP_MODE unset
  (the default) — the gate is config'd off and the surface is byte-identical
  to pre-H1. Judgment calls:
  - **Config**: `SIGNUP_MODE=invite` → `config.signupMode` ('open' default —
    existing deployments unaffected). Login and change-email are NEVER gated;
    only account CREATION is.
  - **Invite rows**: `INVITE#<lowercased-email>/META` (model.ts), fields
    email, optional storageLimitBytes, viewer (default false), home,
    createdAt, consumedAt. Keyed by PLAINTEXT lowercased email, unlike the
    hashed EMAIL# guards, on purpose: invites are operator data, and listing/
    revoking them must work without HASHING_KEY (only `make set-storage`
    needs it, for the hashed user lookup). No gsi attributes — the D48
    rollback rule holds; `main` deployed against a table with invite rows
    behaves exactly as before. `home: 'local'` is a one-line federation seam:
    a future multi-home deployment routes users by it without a migration;
    nothing reads it today.
  - **Error shape for a gated signup: 403 {} (errPermissionDenied), NOT a new
    code.** Museum has no invite analogue, so the choice is which EXISTING
    signup-path 4xx the stock client renders sanely: 409
    USER_ALREADY_REGISTERED actively steers the user into the login flow
    (wrong), 404 USER_NOT_REGISTERED means "not registered" only on login
    paths, while /users/ott already returns a bare 403 {} on its
    change-purpose branch — so a 403 is an in-family sendOtt refusal the
    client shows as its generic failure dialog. Capture-gated for the LAN
    gate (M5): if the device run shows the stock app handling it badly, pick
    whatever the gate proves better. The gate keys on `state === 'noAccount'`
    rather than `purpose === 'signup'` because old clients send purpose ""
    (museum validates nothing there); login+noAccount has already 404'd
    above it, so login flows are untouched by construction. The OTT is
    neither stored nor mailed on rejection (tested).
  - **Consumption is atomic with account creation** (createUser transaction:
    email guard + user row + consumedAt stamp), copying
    storageLimitBytes/viewer/home onto the user row. Invites are single-use
    for signup but the consumed row is KEPT as audit trail; re-running
    `make invite` re-arms it (the documented re-admission path, e.g. after
    account deletion). createUser re-checks the invite as belt-and-braces —
    covers the revoked-between-OTT-and-verify window. Overrides apply
    whenever a usable invite exists even in open mode, so an operator can
    pre-provision limits before flipping the mode.
  - **Per-user quota**: user row gains optional `storageLimitBytes` (absent =
    config.freePlanStorageBytes) and `viewer`. assertQuota resolves the limit
    from the user row (one extra GetItem per quota check, shared by every
    upload-url mint, eligibility probe, commit, and the public-collect path —
    which passes the LINK OWNER, so a capped owner's links can't collect
    either). **0 means ZERO** — no uploads at all — deliberately unlike the
    0-disables-it ceiling knobs elsewhere in config; stated in both places
    and locked by test. `userStorageBytes` (billing.ts) is the single
    resolver: subscription stub, /users/details/v2 and enforcement all report
    the same number, in the unchanged museum envelope (same fields, real
    value). `/billing/plans/v2` keeps the global freePlan number — it is a
    catalog, not the user's entitlement.
  - **Viewer semantics**: viewer=true refuses every upload-URL mint, the
    eligibility probe and file commit with the same 426 storage-limit
    sentinel (self-consistent with a 0-byte plan, and the stock client
    already renders it), and refuses album/folder creation with 403 {}
    (errPermissionDenied — the same family a VIEWER sharee gets on rename).
    Viewers still read shares, download, diff, leave collections, and appear
    in sharees. **Special-collections decision** (the highest
    client-breakage risk): POST /collections with type favorites or
    uncategorized stays ALLOWED for viewers. The stock apps create these
    lazily — favorites on the first favorite tap, uncategorized when a file
    leaves its last album — not at boot, but a viewer favoriting a SHARED
    photo is a legitimate consume-a-share action that must not 403 mid-loop.
    Both are metadata-only rows (zero storage), and create.ts's
    duplicate-create semantics already return the existing row idempotently,
    so admitting them costs nothing. Locked by test; LAN-gate re-run with a
    viewer account stays the release proof.
  - **Ops CLI**: tools/invite.ts (`make invite EMAIL=... [STORAGE_GB=...]
    [VIEWER=1]`, `make invites`, `make revoke-invite EMAIL=...`,
    `make set-storage EMAIL=... STORAGE_GB=<n|default>`), env-driven exactly
    like the Lambda (TABLE_NAME/AWS_* select LocalStack vs prod).
    revoke-invite refuses consumed rows (audit); set-storage is the post-hoc
    lever writing the user row attribute, `default` clears it. Listing is a
    paged Scan filtered to INVITE# — the one operator-only full listing, not
    worth an index (D48 discipline).

- **D55 [OPS 2026-08-27] Phase H2: BYO storage pools — user-group-owned S3
  buckets, many users : one bucket, server/CLI-side only.** A pool is ONE
  bucket (typically owned and paid for by a household — "me and my partner one
  bucket, my brother and his partner another") shared by MULTIPLE users; users
  map many-to-one onto pools via `storagePoolId` on the user row. Object keys
  stay `<userID>/<uuid>`, so members keep their own prefixes inside the shared
  bucket. Deliberately OFF-PARITY (museum's S3 config is global); HARD
  CONSTRAINT honoured: zero client-visible changes — clients only ever see
  presigned URLs, and with no pool rows the surface is byte-identical to
  pre-H2, so **capture-diff must simply run without pool rows** (the default;
  no harness change needed). Judgment calls:
  - **Pools are INVISIBLE to authorization.** getAccessibleFile and
    resolveCollectionAccess never consult pool state — locked by a grep-level
    test over their extracted sources plus route probes (two members of one
    pool, no share → 404/403 exactly as strangers; access opens only via a
    normal share). The pool is a storage/billing grouping, nothing else.
  - **Schema**: `POOL#<poolId>/META` (mode 'role'|'keys', bucket, region,
    endpoint?, roleArn+externalId or encryptedAccessKey/encryptedSecretKey,
    poolStorageLimitBytes?, createdAt, disabled?) + `POOL#<poolId>/USAGE`
    counter row, mirrored atomically wherever the per-user USAGE row mutates
    (commit transaction, update paths, thumbnail replace, trash purge,
    account reaper). No gsi attributes — the D48 rollback rule holds;
    rollback caveat: detach users before deploying `main`, since old code
    ignores `storagePoolId` and would mint against the central bucket.
  - **File-level pool PINNING**: the commit stamps `storagePoolId` on the
    FILE row (the row every download/purge path already reads — resolution
    costs no extra read); absent = central bucket. `thumbPoolId` exists ONLY
    when a post-move thumbnail replacement lands the thumb in a different
    pool than the original (updateThumbnail / updateFileAttributes re-pin
    per object: replaced key → current pool, unchanged key → old pin).
    Downloads, previews, file-data (derived data follows the FILE's pin),
    public downloads, purge deletes and account-deletion cleanup all resolve
    the bucket from the PIN — **pool reassignment therefore affects only NEW
    uploads**; nothing is migrated and nothing strands.
  - **Quota precedence**, all one museum-shaped 426: viewer blocks first,
    then the per-user limit (D54; a 0 override blocks before any pool math),
    then the pool's shared cap against the POOL usage counter (absent =
    unlimited pool). A `disabled` pool 426s new mints/commits; reads and
    purges still resolve. assertQuota now returns the loaded {user, pool}
    context so every mint reuses the read (H1's one-GetItem discipline kept;
    pool users pay +2 GetItems: pool META + pool USAGE).
  - **Credential handling**: mode 'role' (PREFERRED) stores roleArn +
    ExternalId — no long-lived secret at rest at all; ExternalId is MANDATORY
    (putPool refuses without it) as the confused-deputy guard: the pool
    role's trust policy + ExternalId is what stops anyone who learns the ARN
    from pointing their own deployment at the bucket. Temp creds are cached
    ~50 min (10-min refresh margin) and **presigns from a role pool are
    clamped to the remaining session lifetime** — a SigV4 URL signed with
    temporary credentials dies with the session whatever X-Amz-Expires says,
    so role-pool PUT/GET URLs live ≤ ~1h instead of the config'd 24h/7d
    (documented deviation; keys-mode pools keep the full expiries). Mode
    'keys' (for S3-compatibles + LocalStack) secretbox-encrypts both values
    with a key derived from HASHING_KEY (fixed context, same
    derive-don't-reuse family as the D51 JWT secret) — NEVER plaintext at
    rest, never logged, decrypted only into the in-process client cache. KMS
    was considered and rejected: HASHING_KEY is already the deployment's
    root secret (losing it orphans every account), so a KMS dependency adds
    IAM surface and per-call cost without changing the trust model.
  - **sts:AssumeRole on Resource "*"** in the execution role (shared by the
    API lambda and the trash-purge worker): acceptable because assuming a
    role ALSO requires that role's trust policy to name this principal (plus
    the ExternalId) — enumerating pool ARNs in the policy would add churn,
    not security. Guard-tested, including that both lambdas still share the
    one role.
  - **The household caveat** (stated, not solved): whoever holds the pool
    bucket's credentials — the household member who owns the AWS account —
    can LIST and DELETE the ciphertext out-of-band. That is an AVAILABILITY
    lever, not a confidentiality one: bytes are end-to-end encrypted, and a
    member's own prefix names reveal only object counts/sizes. Members who
    don't hold bucket credentials have no path at all (the server never
    discloses other members' keys). Same trust shape as any BYO-storage
    arrangement; the operator should say so to households.
  - **Quarantine behaviour**: the object sweep resolves blobs per queue row's
    pinned pool; a pool that fails to resolve or whose delete errors
    quarantines THAT pool's remaining rows for the run — logged and counted,
    rows left intact for retry — while other pools and the central bucket
    keep sweeping. One broken household bucket can never stall global GC or
    crash the cron.
  - **Ops CLI**: tools/storagePool.ts (`make pool-create/pool-attach/
    pool-detach/pools/pool-set-quota/pool-disable/pool-enable`), env-driven
    like tools/invite.ts. pool-create runs a validation checklist FIRST and
    refuses to write on hard failures (creds/AssumeRole, HeadBucket,
    PUT+GET+DELETE probe, PutObjectTagging, multipart create+abort, and an
    explicitly-open public-access block); warns on missing PAB config
    (S3-compatibles), missing browser-PUT CORS (D33), and a missing
    abort-MPU lifecycle rule. pool-attach works on user rows AND unconsumed
    invite rows (the H1 seam: signup copies `storagePoolId` onto the user
    row; `make invite` re-runs preserve it). Listing is a paged Scan — the
    same operator-only full-listing exception as invites (D48 discipline).
  - **Role-mode validation caveat**: the CLI assumes the pool role with the
    OPERATOR's ambient credentials, so the pool role's trust policy must
    admit the operator as well as the Lambda execution role (same
    ExternalId). LocalStack e2e uses mode 'keys' (LocalStack accepts the STS
    API but has no real assumable identities); the AssumeRole path is locked
    at unit level with a stubbed STS client (ExternalId sent, creds cached,
    presign clamped).

- **D56 [FIX 2026-08-27] Review fixes on H1/H2: thumb-pin central sentinel,
  file-data pool gates, scoped AssumeRole, ops hardening.** Second-pass review
  findings on the Phase H work, all server/CLI-side; wire shapes unchanged.
  - **P1 — thumb pin could not say "central" (silent 404 + object leak).**
    `thumbPoolPin` resolved `thumbPoolId ?? storagePoolId`, and both re-stamp
    sites (updateThumbnail / updateFileAttributes) only wrote `thumbPoolId`
    when truthy — so a pool-detached user replacing a thumbnail put the new
    bytes in the CENTRAL bucket while the row still resolved the thumb pin to
    the old pool: previews presigned the wrong bucket (silent 404s) and the
    central object survived deletion. Fixed with a SENTINEL: `thumbPoolId: ''`
    (`CENTRAL_THUMB_PIN`, files.ts) means "diverged into the central bucket";
    absence still means "follows storagePoolId". Both re-stamp sites now share
    one helper (`restampThumbPin`, resolved-pin in, stored-shape out) so they
    cannot drift; `thumbPoolPin` maps '' -> undefined. The pool-counter delta
    math at both sites operates on RESOLVED pins (string | undefined, never
    the sentinel) and was independently correct — left as-is, locked by tests
    covering pool->central and central->pool divergence on BOTH update paths
    (row shape, preview bucket, sweep bucket, counter deltas).
  - **P2 — file-data write paths bypassed pool controls.** previewUploadUrl
    (PUT + multipart mints), putFileData and putVideoData resolved the pinned
    pool's client but never honoured `disabled` and never charged POOL#/USAGE.
    Now: every file-data WRITE goes through `fileDataBlobsForWrite`
    (fileData.ts), which 426s (museum shape) when the PIN's pool is disabled —
    the pin's pool, not the owner's current one, because that is where the
    bytes land; reads stay on the untouched resolver so pinned bytes remain
    servable. **Quota decision:** the pool counter is charged only where the
    write path KNOWS the size — putFileData (the server writes the object) and
    putVideoData (the vid_preview commit step, size verified by HeadObject) —
    each net of the previous fd-row size on replacement. Presigned img_preview
    uploads have NO commit/verify step in museum main (D8 dormant tier), so
    they stay UNCHARGED rather than invent a non-museum verification step;
    likewise file/fd DELETION does not yet refund fd bytes. Both halves of
    that drift are one item: the filedata size-reconciliation pass in
    NEXT-TASKS. Per-user counters deliberately untouched (museum parity:
    file-data never counts toward user storage).
  - **P2 — sts:AssumeRole scoped to the ente-pool-\* naming convention.**
    D55 shipped `Resource "*"` reasoning that each pool role's trust policy +
    ExternalId is the real gate. The reviewer's counterpoint stands: a pool
    role whose trust policy names its ACCOUNT ROOT (a common operator
    shortcut) is assumable by any principal in that account holding a broad
    AssumeRole — with "*" on our side, this deployment is such a principal
    for every root-trusted role in every account. Now
    `arn:aws:iam::*:role/ente-pool-*` (compute/iam.tf, guard test locks the
    scoped form and rejects "*"), pool-create REFUSES role ARNs outside the
    convention (clear operator error naming it), and INSTALL's trust-policy
    section documents the convention and says to name principals, never the
    account root.
  - Also (one-liners): upsertInvite now preserves existing
    storageLimitBytes/viewer across re-invites like storagePoolId (explicit
    values win; re-arming a consumed 0-byte viewer invite keeps both) and the
    invite CLI passes viewer only when --viewer given. trash.ts
    permanentlyDelete is ONE transactWrite (tombstone + user/pool counters +
    OBJ guards + queue rows + file row, <=9 ops); the account reaper folds
    each chunk's queue rows and their pool decrements into one chunk-aware
    transactWrite (flushes when <4 op slots remain of MAX_TRANSACT_OPS) — a
    crash can no longer decrement a household counter without the matching
    rows. `make pool-requeue POOL=... [TO=...]` drains a dead pool's
    quarantined sweep rows by re-pinning them (default central); running it
    ASSERTS the bytes' true location, restated by the CLI and INSTALL.
    objectSweep now console.errors default-bucket delete failures with the
    key (they were silently swallowed). blobs.pool.ts dedupes concurrent
    AssumeRole refreshes behind one in-flight promise (N concurrent presigns
    after idle = 1 STS call; failures clear the slot for retry). SIGNUP_MODE
    is a tofu var (`signup_mode`, default "open", validated open|invite,
    compute module + dev passthrough, guard-tested against the config.ts
    default) replacing INSTALL's edit-main.tf instruction.

- **D57 [OPS 2026-08-27] Operator safety: variable-driven delete protection +
  Makefile profile switcher with typed confirmation.** Two features, one
  motive: `src/infra/dev` IS the live production deployment (named before it
  went live), and a second env has to be easy to stand up and tear down
  without any command being able to silently address prod.
  - **`delete_protection` replaces `prevent_destroy` (data module, bool,
    default true).** `lifecycle { prevent_destroy }` only accepts a literal —
    tofu evaluates lifecycle at parse time, so it cannot reference a var —
    which made per-env protection impossible and would have hard-blocked test
    teardown forever. The replacement rails are API-level and strictly
    stronger where it matters: `deletion_protection_enabled =
    var.delete_protection` on the table blocks DeleteTable for EVERYONE
    (console and CLI included; prevent_destroy only ever stopped tofu), and
    `force_destroy = !var.delete_protection` on the objects bucket preserves
    today's effective behavior (protection on = destroy refuses while the
    bucket is non-empty). Both lifecycle blocks are REMOVED — deliberately,
    since a leftover literal would override the variable — and the guard
    tests now assert the var wiring, the true default in the module and BOTH
    env layers, and that no `prevent_destroy` remains in the data module.
    **Expected diff on the next prod `make plan`** (could not be run here —
    prod state is live): an in-place `~ update` on `aws_s3_bucket.objects`
    setting `force_destroy = false` (provider-side attribute, never sent to
    AWS — possibly no diff at all since false is the provider default), and
    NO change on the table (`deletion_protection_enabled` was already
    literally true; it becomes var-driven with the same value). Removing
    lifecycle blocks produces no plan lines. **Any destroy/replace line means
    stop.** `make destroy-data`'s steps collapse to: flip the tfvars value,
    apply that alone, then destroy.
  - **`src/infra/test`**: a full second env dir — main/variables/outputs/
    versions copied VERBATIM from dev (they are env-agnostic; everything
    env-specific rides the tfvars) plus its own `ente-sl.tfvars.example`
    (`env_name = "test"`, `delete_protection = false`, and a loud FRESH-key
    warning: reusing prod's `hashing_key` would link every test account to a
    production identity). Gitignore already covers every env dir — the
    `*.tfstate`/`*.tfvars`/`tfplan` patterns are bare names, now commented so
    nobody re-scopes them to one dir.
  - **Profile switcher**: `.tf-profile` (gitignored, repo root) names the env
    every tofu-touching target addresses — `TF = tofu -chdir=src/infra/$(PROFILE)`,
    with `TFVARS`/`STATE`/`guard-account` all derived from it. `make profile
    dev|test` sets it (parse-time conditional neutralizes the second goal
    word, so it cannot trigger the real `dev`/`test` targets); bare `make
    profile` prints it. **No default, ever**: without a profile every such
    target fails with `no profile chosen — choose: make profile dev | make
    profile test`. **Labels name what the env IS, not the folder**:
    dev → `ENV: PRODUCTION`, test → `ENV: TEST`, bannered
    (`>>> profile: dev (ENV: PRODUCTION)`) before any action, plan included.
  - **Typed confirmation on mutation**: `deploy`, `destroy`, `deploy-web` and
    `pricing-plan` require the exact profile name typed back — stronger than
    y/n because reflexively confirming while pointed at the wrong env is
    precisely the accident; typing "dev" is hard to do while believing you
    are on test. `CONFIRM=<profile>` skips the prompt for scripting/CI and
    REFUSES on mismatch rather than falling back to the prompt. `plan` stays
    unconfirmed (read-only) but banners. `guard-account` is per-profile (the
    selected profile's state is the source of truth) and still no-ops on a
    fresh env with no state, so the first test apply is not blocked.
    Non-AWS targets (test/test-int/infra-test/build-lambda/ledger/dev/lan,
    the invite + pool tooling) stay profile-free. All of it guard-tested:
    profile-driven TF dir with no hardcoded `-chdir=src/infra/dev` left,
    confirm gates on the four mutating targets, plan explicitly
    unconfirmed.
  - **Addendum [2026-08-27]: the typed profile confirmation is REMOVED**
    (`confirm-profile` target and the `CONFIRM=<profile>` variable, gone
    entirely). Rationale: it was redundant friction on top of safeguards
    that already cover each mutation — `tofu destroy` prompts interactively
    at the actual point of destruction (nothing passes `-auto-approve`, and
    a guard test now asserts that), `deploy` applies only a saved plan the
    operator just reviewed, and profile state/tfvars/guard-account are fully
    disjoint so a mutation cannot cross environments. What remains, and is
    still guard-tested: the `>>> profile: <name> (ENV: ...)` banner on every
    profile-aware target, the no-default no-profile refusal, and
    `guard-account` on the mutating path. The previously gated targets
    (`deploy`, `destroy`, `deploy-web`, `pricing-plan`) now depend on
    `require-profile guard-account` directly.

- **D58 [COST/EDGE 2026-08-27] One CloudFront distribution per environment —
  the API and the albums web app consolidated onto the (former) API
  distribution; modules/web folded into modules/edge.** Motive: the CloudFront
  flat-rate FREE plan (D47) covers one distribution + one web ACL per
  subscription and allows **at most 3 distributions per account**; the D52
  two-distribution layout spent 2 slots per env, so prod + test could never
  both ride the $0 plan and the test env's albums distribution (plus its
  future ACL) would silently run pay-as-you-go. Consolidated: prod + test = 2
  distributions, one spare, every one subscribable. Judgment calls:
  - **The API stays at the ROOT of the existing distribution — root-path
    ordered behaviors, not an /api prefix.** Three reasons: the distribution's
    domain IS the `server_url` real devices are configured with, so nothing
    may re-point (an /api prefix or a new domain breaks every client); the
    Lambda sees unrewritten paths, so museum 404/403 parity holds with no
    prefix-strip anywhere; and prefix-stripping at the edge would need a
    function on every API behavior. Every top-level prefix in src/app.ts gets
    an ordered behavior to the Lambda origin (per-origin `x-origin-secret`
    unchanged, WAF ACL unchanged): `/ping` exact plus 14 bare-prefix
    wildcards (`/users*`, `/files*`, `/collections*`, `/trash*`,
    `/user-entity*`, `/remote-store*`, `/billing*`, `/storage-bonus*`,
    `/push*`, `/comments-reactions*`, `/collection-actions*`, `/contacts*`,
    `/emergency-contacts*`, `/public-collection*`) — the no-slash form so
    bare-prefix routes (POST /files, POST /collections, GET /remote-store)
    ride the same behavior. **15 API + /index.html = 16 ordered behaviors + 1
    default = 17, comfortably under the 25-behavior default quota.**
  - **THE load-bearing constraint: `custom_error_response` must never exist
    on the distribution.** Error responses are distribution-WIDE — the old
    web module's 403/404→/index.html SPA fallback would rewrite the API's
    museum-shaped 404/403 JSON into 200 HTML for every client. SPA fallback
    is now a viewer-request **CloudFront function** on the DEFAULT behavior
    only: a URI whose last segment has no dot rewrites to /index.html, asset
    paths pass through. Consequence accepted: a deep link serves index.html
    under the default behavior's CachingOptimized policy, so `make
    deploy-web`'s /* invalidation stays the freshness backstop (the same
    belt-and-braces the old error_caching_min_ttl-0 fallback relied on);
    /index.html requested literally stays pinned to CachingDisabled.
  - **The guard that keeps it honest** (test/infra/web.test.ts): derives the
    top-level prefix set from src/app.ts route registrations and asserts
    set-EQUALITY with the edge module's `api_path_patterns` (a new route
    group without a behavior would fall through to the web bucket; a stale
    pattern would steal web URL space), plus: no custom_error_response
    anywhere in the infra, exactly one aws_cloudfront_distribution across all
    modules, the SPA function associated to the default behavior only,
    behavior count ≤ 20, API behaviors keeping CachingDisabled +
    AllViewerExceptHostHeader + all 7 methods, and the moved-block refactor
    below.
  - **ALBUMS_URL = the distribution's own URL — wired via a plan-time hint,
    because tofu cannot express the self-reference.** lambda env →
    distribution domain → function URL → lambda is a hard resource cycle;
    one of the three value-flows has to leave the graph. Chosen: `make plan`
    injects `-var albums_url_hint=$(tofu output -raw server_url)` — the
    previous apply's own output, stable because a distribution's domain
    never changes in place — and the env roots wire
    `coalesce(var.albums_url, var.albums_url_hint,
    "https://albums-url-pending.invalid")`. A tfvars `albums_url` (custom
    domain) still wins; a fresh env's FIRST apply deploys the loud .invalid
    sentinel and the routine second plan/deploy pins the real domain (prod's
    migration plan is correct immediately — its state already holds
    server_url). Rejected alternatives: an operator-pinned tfvars value
    (manual step on prod, forgettable), an SSM parameter + data source
    (broken first-plan or unmanaged out-of-band state), and minting from a
    CloudFront-function-injected x-forwarded-host header (app change on a
    parity-sensitive, just-security-reviewed surface). Public links are now
    `https://<server_url domain>/?t=<token>`; the albums app is same-origin
    with the API it calls, and no rebuild is needed at migration because
    build-web already baked this same origin as NEXT_PUBLIC_ENTE_ENDPOINT.
  - **Module shape: modules/web died into modules/edge** (bucket, public
    access block, bucket policy, OAC — policy now SourceArn-pinned to the one
    distribution), because the bucket policy needs the distribution ARN and
    the distribution needs the bucket/OAC: splitting them across modules
    would mean mutually-referencing modules for no gain. `moved` blocks in
    the env roots carry all four resources across, so the migration plan
    MOVES them (bucket content preserved, no re-sync required) instead of
    destroy-and-recreate. The standalone albums distribution has no
    destination and is destroyed by the same plan. PriceClass_All (D47) now
    simply applies — the web module's PriceClass_100 died with its
    distribution.
  - **Expected migration plan on an existing deployment** (verified shape;
    could not be run against prod here): 4 moved, **1 to add** (the SPA
    CloudFront function), **3 to change in-place** (the main distribution —
    new web origin, default-behavior swap, 16 ordered behaviors,
    default_root_object, comment; the bucket policy's SourceArn; the API
    Lambda's ALBUMS_URL env), **1 to destroy** (the old albums
    distribution). Everything on the main distribution is an in-place
    UpdateDistribution — **any replace line touching it means STOP**, since
    replacement mints a new domain and breaks every configured client. The
    D47 FREE subscription survives in-place updates; verify with `make
    pricing-plan-status` after, and run `make pricing-plan` per env (test
    included — an unsubscribed env pays ~$6/mo of WAF fees). Links minted
    BEFORE consolidation point at the old albums distribution's now-dead
    domain — tokens stay valid, re-copy each link from the app (the
    documented D52 caveat pattern).
  - Trade-offs accepted: requests under prefixes app.ts does not register
    now reach the web bucket and 200 as HTML instead of 404 JSON (real route
    groups are guard-covered; clients never probe unregistered prefixes);
    the WAF rate rule now also counts web-asset hits (cached responses
    included — WAF runs before the cache), which only errs stricter; and a
    brief albums-web blip during the migration apply while the bucket policy
    re-pins (the API path is untouched throughout).

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
- **D31** Museum's viper env override replaces BOTH `.` and `-` with `_`, so
  `ENTE_INTERNAL_HARDCODED-OTT_LOCAL-DOMAIN-SUFFIX` never bound and the oracle
  mailed random OTTs (every scripted capture 401'd on verify-email).
  docker-compose.oracle.yml now uses the all-underscore spelling; verified
  `verify-email` with `123456` → 200. Museum logs OTTs to **stderr**
  (`Skipping sending email to …: Verification code: NNNNNN`), so a capture
  script reading `docker logs` must merge stderr, not just stdout.
