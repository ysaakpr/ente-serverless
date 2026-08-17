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
