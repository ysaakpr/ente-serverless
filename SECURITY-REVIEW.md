# Security review — remediation plan

Review date **2026-08-17**, against a live deployed stack. Method: probing both
entrypoints (the Function URL and the CloudFront distribution) plus a read of
`src/middleware`, `src/handlers`, `src/domain` and `src/infra`.

Naming follows `AWS-RESOURCES.md`: resources read `ente-sl-dev-*`, and the
account ID, region, endpoint hostnames and bucket name are deliberately left
out. The deployment this was run against is identified only by
`ente-sl.tfvars`, which is gitignored — keep it that way when updating this
file, since a findings document is exactly the wrong place to pair a live
hostname with an unfixed weakness.

This file was written as the **fix plan only**; the remediation status below
was appended when the fixes landed. Findings are ordered by what I would fix
first, not by discovery order. Each entry states the root cause, the concrete
fix, the trade-off it carries, and how to prove it worked.

---

## Remediation status — updated 2026-08-17

All findings fixed in code/infra on this date, in the suggested sequence.
271/271 tests pass (`TEST-LEDGER.md`); new decisions D42–D44.

| # | Status | Where |
|---|---|---|
| F0 | **Done** — `addToCountersReturning` (atomic ADD + `ReturnValues`, optional `set`) in the port and both adapters | `src/ports/db.ts`, `db.dynamo.ts`, `db.memory.ts`; concurrency guard `test/unit/db-counters.test.ts` |
| 1 | **Done** — `TWO_FACTOR_ATTEMPT_LIMIT = 5` on the session row, increment-before-compare, `remove` inherits it. Divergence logged as **D42** | `src/domain/twoFactor.ts`, `src/handlers/users/twoFactor.ts`; tests incl. 50-parallel case |
| 2 | **Done** — session row `ttl` 1h, index row `ttl` 2h (> the 1h throttle window, guarded by test) | `src/domain/srpSessions.ts`; tests in `srp-endpoints.test.ts` |
| 3 | **Done** — atomic ADD with `expiresAt` + `ttl` riding along; stale ATTEMPTS row cleared so the D12 lock still lifts; SRP `attemptCount` writes made atomic in the same pass | `src/domain/ott.ts`, `srpSessions.ts`; 100-parallel test in `verify-email.test.ts` |
| 4 | **Done in tofu, pending `make deploy`** — budget page (80%/100% ACTUAL → alarms topic), WAF rate rule (300/5min/IP on the auth POSTs), and the origin lock (`random_password` → CloudFront `custom_header` → app-side 403). Logged as **D43**. Reserved concurrency is a knob defaulting to **-1 (unreserved)**: the account's default Lambda quota (~10 total, with 10 required unreserved) both forbids a reservation and already caps invocations tighter than the intended 50 — set `api_reserved_concurrency = 50` in tfvars after a Service Quotas raise. Run `tofu init -upgrade` first (new `random` provider); then verify live: direct Function URL 403s, CloudFront path 200s | `modules/compute`, `modules/edge`, `dev/main.tf`, `src/app.ts`, `src/config.ts`; guards in `test/infra/lifecycle.test.ts`, `test/unit/origin-lock.test.ts` |
| 5 | **Done, conservatively** — knob split; PUT default 24h; **GET deliberately kept at 7 days** until the next M5 device gate proves clients re-fetch rather than cache (D44). Shorten `PRESIGN_GET_EXPIRY_SECONDS` after that run | `src/config.ts` + call sites; `test/unit/presign-expiry.test.ts` |
| 6 | **Done in tofu, pending deploy** — response-headers policy (HSTS 1y, nosniff, `Referrer-Policy: no-referrer`) on the distribution | `modules/edge/main.tf` |
| 7 | **Done** — rightmost XFF entry only, shared `clientIp()` helper on all three login paths; fully sound once the finding-4 apply lands | `src/lib/ip.ts`; tests in `auth-token.test.ts` |

Residue for the operator: the four inert probe rows from this review are still
in the live table — they are the only `SRPSESSION#`/`SRPSESSBYUSER#` items
without a `ttl`, so they are easy to find and delete; and the SNS topic policy
now replaces the account default, so confirm the budget/alarm emails still
arrive after the first apply.

Scope note: the infra-level exposures already written up honestly in
`AWS-RESOURCES.md` §3 (no WAF, `?token=` in query strings, plaintext
`HASHING_KEY`, Function URL reachable around CloudFront) are not re-derived here.
Where a fix below intersects one of those, it says so.

---

## What is already correct

Stated so the fixes below are not misread as a broken authorization model. The
access control itself holds.

- Every private route 401s with no token, a garbage `X-Auth-Token`, and a garbage
  `?token=` — verified live on `/users/details/v2`, `/collections/v2`,
  `/trash/v2/diff`, `/files/preview/1`, `/files/download/1`,
  `/users/session-validity/v2`, through **both** the Function URL and CloudFront.
- Objects bucket: anonymous `ListBucket` and `GetObject` both 403. All four
  public-access blocks on. Versioning on, and the execution role deliberately
  omits `s3:DeleteObjectVersion`, so the API cannot destroy a photo.
- Table: SSE on, PITR on, deletion protection on. The role is scoped to this one
  table (+ its indexes) and this one bucket.
- No handler trusts a client-supplied identity. `src/domain/files.ts:164`
  rejects a mismatched `ownerID` outright; reads go through
  `getAccessibleFile` / `getOwnedCollection` / `verifyFileOwnership`. Upload keys
  are server-minted `userID/uuid` and re-validated for the caller's prefix at
  commit (`src/domain/files.ts:154`).
- Secrets are not in git. The deployed function carries no `HARDCODED_OTT_*`
  backdoor. Tokens and session IDs are 32 bytes of `crypto.randomBytes`; TOTP
  codes and SRP proofs compare in constant time; error bodies are bare `{}` with
  no stack traces.

---

## Priority

| # | Severity | Finding | Fix effort | Oracle impact |
|---|---|---|---|---|
| 1 | **High** | No attempt cap on TOTP verification — the second factor is brute-forceable | ~half a day (needs F0) | **Divergence** — needs a `DECISIONS.md` entry |
| 2 | Med-High | Unauthenticated unbounded table growth via SRP fake sessions (no `ttl`) | ~1 hour | None — invisible hardening |
| 3 | Medium | OTT wrong-attempt cap is bypassable by concurrency | ~2 hours (needs F0) | **Restores** documented D12 behaviour |
| 4 | Medium | No spend ceiling anywhere (Lambda concurrency, WAF, budget) | ~half a day | None — infra only |
| 5 | Low-Med | 7-day presigned URLs for both GET and PUT | ~1 hour + device test | Divergence, needs M5 re-run |
| 6 | Low | Missing transport/browser security headers | ~1 hour | None — infra only |
| 7 | Low | `X-Forwarded-For` trusted verbatim into audit rows | ~1 hour | None |
| — | Accepted | Account enumeration; CORS origin echo | no action | Museum-faithful by design |

**F0** below is a shared prerequisite for findings 1 and 3. Do it first.

---

## F0 — Prerequisite: a race-free capped counter in the Db port

Findings 1 and 3 are both "a cap exists on paper but not under concurrency". They
share one missing primitive, so fixing the primitive once is cheaper and safer
than patching each call site.

**Where.** `src/ports/db.ts:47`, `src/adapters/aws/db.dynamo.ts:191`,
`src/adapters/memory/db.memory.ts`.

**Why the current primitives are not enough.**

- `db.update()` builds a `SET` expression (`db.dynamo.ts:49`,
  `SET ${sets.join(', ')}`). `SET #c = :n` with `:n` computed in Node is a
  read-modify-write: two concurrent callers read the same value and the second
  overwrites the first. This is the mechanism behind findings 1 and 3.
- `db.addToCounters()` *is* a genuine atomic `ADD` (`db.dynamo.ts:191`) — but it
  passes no `ReturnValues` and no `ConditionExpression`, so the caller cannot
  learn the post-increment value and cannot enforce a ceiling. It is currently
  used only for usage bytes/file counts, where no cap applies.

**Fix.** Add one method that increments atomically **and** reports the resulting
value, so the caller compares a number nobody else can have observed:

```ts
// src/ports/db.ts
/** Atomic ADD that returns the post-increment values. Race-free for caps. */
addToCountersReturning(
  pk: string,
  sk: string,
  deltas: Record<string, number>,
): Promise<Record<string, number>>;
```

The Dynamo implementation is the existing `addToCounters` body plus
`ReturnValues: 'UPDATED_NEW'`, returning `Attributes`. The memory adapter mirrors
it — trivial, since it is single-threaded.

Callers then read as: *increment first, judge second.*

```ts
const { count } = await deps.db.addToCountersReturning(pk, sk, { count: 1 });
if (count > CAP) throw errTooManyBadRequest();
```

**Why this shape and not a `ConditionExpression`.** A conditional
`ADD ... IF #c < :cap` also closes the race, but it needs condition plumbing
through the port, a `ConditionalCheckFailedException` → `ConditionFailedError`
mapping, and a matching branch in the memory adapter. Increment-then-compare
needs one new field on the return type and behaves identically under load. Either
is defensible; this one is less machinery.

**Caveat to design around.** `addToCountersReturning` creates the item when
missing, so the row it touches must be one that is safe to conjure — for OTT that
is the existing `ATTEMPTS` row, which is already created on demand. Make sure the
row carries a `ttl` when created this way, or F0 quietly reintroduces finding 2's
shape (an attacker-creatable row with no expiry) on the OTT partition.

**Verify.** A unit test that fires N concurrent increments through
`Promise.all` against the memory adapter and asserts the returned values are the
distinct set `1..N` with no duplicates. That test fails against `db.update()`
today, which is the regression guard for both findings.

---

## Finding 1 — High: TOTP verification has no attempt cap

**Where.** `src/handlers/users/twoFactor.ts:126` (`verifyTwoFactor`), supported by
`src/domain/twoFactor.ts:109` (`resolveTwoFactorSession`).

**Root cause.** Two independent gaps compound:

1. `verifyTwoFactor` counts nothing. There is no attempt state for 2FA anywhere
   in `src/domain/twoFactor.ts` — compare `OTT_WRONG_ATTEMPT_LIMIT`
   (`ott.ts:16`) and `SRP_ATTEMPT_CAP` (`srpSessions.ts:21`), both of which
   exist. The 2FA path simply has no equivalent.
2. A wrong code throws at `twoFactor.ts:134`, **before**
   `consumeTwoFactorSession` at line 137. The half-authenticated session
   therefore survives every failure and stays usable for its full
   `TWO_FACTOR_SESSION_VALIDITY_MICROS` — 10 minutes (`twoFactor.ts:23`).

With `TOTP_SKEW_STEPS = 1` (`totp.ts:26`), three of 10⁶ codes are accepted at any
instant. One session admits unlimited parallel guesses for 10 minutes; at ~1000
req/s that is ~600k attempts, expected hits ≈ 1.8. And an attacker in a position
to reach this endpoint already holds the password (a `sessionID` is only issued
after SRP or OTT succeeds), so they can mint fresh sessions and repeat
indefinitely. The practical effect is that 2FA reduces to a delay — it fails to do
the one job it has, which is to survive password compromise.

`POST /users/two-factor/remove` (`twoFactor.ts:163`) is uncapped for the same
reason. Its `secret` is high-entropy so brute force is not the concern there; it
should inherit the same counter for consistency and for log signal.

**Fix.** Put the attempt counter on the session row — it already exists, is
already TTL'd, and is already the natural unit of "one login attempt in
progress".

1. Have `resolveTwoFactorSession` return the row rather than just `userId` (or add
   a `resolveTwoFactorSessionRow` beside it and leave the existing signature for
   its other callers). The handler needs the row's `pk`/`sk` to increment.
2. In `verifyTwoFactor`, before comparing the code, increment via F0 and reject
   past the cap:

   ```ts
   const { attemptCount } = await deps.db.addToCountersReturning(
     row.pk, row.sk, { attemptCount: 1 },
   );
   if (attemptCount > TWO_FACTOR_ATTEMPT_LIMIT) throw errTooManyBadRequest();
   ```

   Increment **before** verifying, not after failing: a `return` on the success
   path must not be the only thing that stops the counter, or a crash between
   check and increment gives a free attempt.
3. Pick the cap to match the neighbours. `SRP_ATTEMPT_CAP = 5` is the closest
   analogue (both are "prove a secret for this session"); 5 also comfortably
   absorbs clock-drift retries given skew ±1. Export it as
   `TWO_FACTOR_ATTEMPT_LIMIT` in `src/domain/twoFactor.ts` next to the validity
   constant, so the three caps sit in three visible places.
4. Apply the same counter to `removeTwoFactor`.

**Trade-off, and the honest part.** This is an **observable divergence** from the
oracle. D36 captured the 2FA endpoint shapes on 2026-08-17 and recorded no attempt
cap — meaning museum's behaviour past N failures was never captured, not that it
is known to be uncapped. After this fix a client sees `429` where it previously
saw `401` forever. That needs a `DECISIONS.md` entry in the D-series stating the
divergence and why (this is the same category as the OTT hashed-at-rest note in
`ott.ts:4` — hardening the oracle never specified). If oracle fidelity here is
non-negotiable, re-capture museum's behaviour past 20 wrong 2FA codes first and
match whatever it does; but shipping the current uncapped behaviour to a public
URL is the worse of the two risks.

A cap also introduces a small denial-of-service surface: someone who knows a
victim's password can burn the cap to lock the victim's own login attempts. Since
they hold the password, this is not a meaningful escalation — and it is why the
counter belongs on the **session** (10-minute TTL, attacker can only burn the
session they created) rather than on the **user**, where it would be a real
lockout weapon. Do not move it to the user partition.

**Verify.** Extend `test/unit/two-factor.test.ts`: 5 wrong codes → `401`,
the 6th → `429`, and a *correct* code after the cap → still `429` (proves the
cap gates the compare, not the response). Add a concurrency case: 50 parallel
wrong codes against one session, then assert the stored `attemptCount` is exactly
50 — that is the F0 regression guard at the 2FA call site. Log the new 429 in
`TEST-LEDGER.md`.

---

## Finding 2 — Med-High: unauthenticated unbounded table growth via SRP sessions

**Where.** `src/handlers/srp/createSession.ts:24` and `:30`;
`src/domain/srpSessions.ts:70` (the `transactWrite` in
`createAndInsertSrpSession`).

**Root cause.** Three things line up:

1. An unknown `srpUserID` gets a **persisted** fake session
   (`createSession.ts:24`) — deliberate anti-enumeration, mirroring museum's
   `fCreateSession`.
2. The 10-per-hour throttle (`srpSessions.ts:49-55`) is keyed on
   `sessionsByUser(srpUserID)` — a value the **caller chooses**. A fresh UUID per
   request resets the limit to zero, so it constrains an honest client and
   nothing else.
3. Neither row written at `srpSessions.ts:70` carries a `ttl`. OTT rows do
   (`ott.ts:39`) and 2FA sessions do (`twoFactor.ts:100`); SRP sessions were
   missed. The daily `trash-purge` worker does not sweep them either.

So: two unauthenticated writes per request, no auth, no effective rate limit,
and nothing that ever reclaims them. Confirmed live during this review — two
`create-session` calls with freshly generated `srpUserID` values both returned
`200` with a real `sessionID`, leaving four rows behind (two `SRPSESSION#<uuid>`
rows and their two `SRPSESSBYUSER#<uuid>` index rows). They are inert, but if you
want a clean table, the probe rows are the `SRPSESSION#` items created on the
review date; after the fix below they are also the only ones lacking a `ttl`,
which makes them easy to find.

**Fix.** Add `ttl` to both puts in `createAndInsertSrpSession`, following the
exact pattern already used at `ott.ts:39` — epoch **seconds**, matching the
`ttl { attribute_name = "ttl" }` config in `src/infra/modules/data/main.tf:104`:

```ts
ttl: Math.ceil((now + SRP_SESSION_RETENTION_MICROS) / MICROS_PER_SECOND),
```

Two different retentions are needed, and the ordering between them matters:

- **Session row** (`SRPSESSION#<id>`): must outlive a real login round-trip and
  the replay window that produces `SESSION_ALREADY_VERIFIED` (`srpSessions.ts:119`).
  **1 hour** is generous — the create → verify round-trip is seconds — and keeps
  the replay response intact for any realistic client.
- **Index row** (`SRPSESSBYUSER#<srpUserID>`): feeds the rate-limit query, which
  scans back exactly `MICROS_PER_HOUR` (`srpSessions.ts:50`). Its TTL must
  **exceed** that window or the throttle silently weakens for legitimate users.
  **2 hours** gives clear headroom.

Getting this backwards — a short index TTL — would turn a hardening fix into a
regression in the one rate limit that currently works. Guard it with a test.

**What TTL does and does not buy.** DynamoDB TTL deletion is asynchronous and
AWS documents it as typically within 48 hours, so this bounds growth to a rolling
window rather than capping it precisely. That is sufficient for the storage and
cost concern. The **request** cost is not addressed by TTL at all — that is
finding 4, and the two should be read together: TTL stops the table growing
forever, a WAF rate rule stops the writes being free.

Do **not** fix this by dropping the fake-session write. It is load-bearing
anti-enumeration: without a persisted fake session, an unknown `srpUserID`
becomes distinguishable from a known one by timing and by whether
`verify-session` later finds the session. That would trade a cost bug for a
disclosure bug.

**Verify.** Extend `test/unit/srp-endpoints.test.ts`: assert both rows written by
`create-session` carry a `ttl` in the future; assert the index row's `ttl`
exceeds `now + MICROS_PER_HOUR`; and assert the 10-unverified-sessions throttle
still fires for a *fixed* `srpUserID` after the change.

---

## Finding 3 — Medium: the OTT wrong-attempt cap is bypassable by concurrency

**Where.** `src/domain/ott.ts:62-67` (the `ATTEMPTS` row write inside
`consumeOtt`).

**Root cause.** `consumeOtt` reads `attempts` at line 51, then writes
`count: attemptCount + 1` with an unconditional `deps.db.put` at line 62 — a full
`PutItem` overwrite. Concurrent requests all read the same `attemptCount` and
overwrite each other's increment, so `OTT_WRONG_ATTEMPT_LIMIT` (20) does not bind
under parallel load. The cap works exactly as documented when attempts are
serial, which is why the unit tests pass.

Impact is worse than the SRP equivalent because the reward is bigger: a correct
OTT goes straight to `onVerificationSuccess` (`verifyEmail.ts:27`), which issues a
full session token. With up to `OTT_ACTIVE_CODE_LIMIT = 10` live codes in a
partition, each guess against a 6-digit code has ~10⁻⁵ odds — brute-forceable
from an email address alone once the cap stops binding.

The same non-atomic pattern sits at `srpSessions.ts:134`, but there the
10-sessions-per-hour ceiling bounds an attacker to roughly 50 password guesses an
hour, so it is a much smaller lever. Fix it in the same pass for consistency.

**Fix.** Replace the read-then-put with F0's atomic increment:

```ts
// src/domain/ott.ts — replaces the db.put at :62
const { count } = await deps.db.addToCountersReturning(partition, ATTEMPTS_SK, { count: 1 });
if (count > OTT_WRONG_ATTEMPT_LIMIT) throw errTooManyBadRequest();
throw errIncorrectOTT();
```

Two details not to lose in the swap:

- The current row carries `expiresAt: Math.max(...active.map(r => r.expiresAt))`
  (`ott.ts:66`) — that is what makes the lock expire with the codes rather than
  persisting forever, and D12 describes exactly that behaviour ("locks until
  codes expire"). `addToCountersReturning` must set it alongside the increment, or
  extend the method to take a `set` map the way `TransactOp` already does
  (`ports/db.ts:37`). Dropping it turns a temporary lock into a permanent one.
- Give the row a `ttl` while you are there. Since F0's increment creates the row
  on demand, an attacker can now conjure `ATTEMPTS` rows for arbitrary email
  hashes — the same shape as finding 2 if left unexpiring.

Also move the cap check **after** the increment. Reading the count first and
incrementing later reintroduces the window, just narrower.

**Trade-off.** Unlike finding 1, this is **not** a divergence — D12 already
documents "20 wrong attempts locks until codes expire (429)". The fix makes the
implementation match the behaviour the ledger already claims. No `DECISIONS.md`
entry needed; a `TEST-LEDGER.md` line is enough.

**Verify.** Extend `test/unit/send-ott.test.ts` (or `verify-email.test.ts`): 100
parallel wrong-OTT calls via `Promise.all`, then assert the stored `count` is
exactly 100 and that the 21st sequential call onward returns `429`. Assert
`expiresAt` still tracks the newest active code, so the lock still lifts.

---

## Finding 4 — Medium: no spend ceiling

**Where.** `src/infra/modules/compute/main.tf:26` (no
`reserved_concurrent_executions`), `src/infra/modules/edge/main.tf:22` (no WAF —
confirmed `web_acl_id = ''` in state), `src/infra/modules/data/main.tf:25`
(`PAY_PER_REQUEST`).

**Root cause.** `AWS-RESOURCES.md` §3 documents this as a *reputation* risk
("burning SES quota"). The sharper reading is financial: `/ping`,
`/billing/plans/v2` and all of `/users/srp/*` answer unauthenticated, Lambda
scales to the account concurrency limit, and the table bills per request with no
provisioned ceiling. Combined with finding 2, an anonymous caller can drive
invocation cost, request cost **and** stored bytes with no upper bound.

**Fix — three independent layers, useful in this order:**

1. **A budget alarm, first.** `aws_budgets_budget` with an actual-spend
   notification to the existing `aws_sns_topic.alarms`. It fixes nothing, but it
   is an hour of work and converts a surprise invoice into a page. Do this before
   the controls below, not after.
2. **`reserved_concurrent_executions` on the API function.** A hard invocation
   ceiling. Note the double edge honestly: a reservation is also a DoS lever —
   once exhausted, legitimate users get throttled too. For a single-owner
   deployment a modest reservation (say 50) is a much better failure mode than an
   unbounded bill; for a shared deployment, prefer layer 3 and leave concurrency
   unreserved.
3. **A WAF rate-based rule on the distribution**, targeting the unauthenticated
   POST routes (`/users/ott`, `/users/srp/create-session`,
   `/users/two-factor/*`). This is the layer that actually addresses finding 2's
   write amplification.

**The catch that makes layer 3 conditional.** `AWS-RESOURCES.md` §3 already flags
it: the Function URL is a tofu output and reachable directly, so **any** edge
control is bypassable until the origin is locked. A WAF on CloudFront alone buys
approximately nothing against someone who reads the output. OAC is ruled out for
the documented reason (IAM auth breaks the POST body hash), so the realistic
sequence is:

- add a shared-secret header at the CloudFront origin config
  (`custom_header` on the `origin` block), and
- have the app reject requests lacking it — with a config flag so `make dev` and
  `make lan` keep working, since neither goes through CloudFront.

Only then is a WAF rule meaningful. That ordering is the whole reason layer 3
costs half a day rather than an hour.

**Verify.** `test/infra/lifecycle.test.ts` already guard-tests infra invariants —
extend it with the reserved-concurrency and origin-header assertions, matching the
existing pattern for `FunctionURLAllowPublicAccess`. Then confirm live that a
direct Function URL request without the secret header is rejected while the
CloudFront path still answers `200`.

---

## Finding 5 — Low-Medium: 7-day presigned URLs for both GET and PUT

**Where.** `src/config.ts:36` — `presignExpirySeconds` defaults to `7 * 24 * 3600`
and is the single knob feeding both `presignGet` and `presignPut`
(`src/adapters/aws/blobs.s3.ts:75,83`).

**Root cause.** One config value serves two very different lifetimes. A download
or thumbnail URL is consumed within seconds of issue, but stays valid for a week —
and those URLs travel in `<img>` sources and 307 `Location` headers, so they land
in browser history and any intermediary log. A presigned **PUT** valid for a week
is the sharper edge: it grants writes to a specific key for that whole window.

**Fix.** Split the knob into two:

```ts
presignGetExpirySeconds: Number(process.env.PRESIGN_GET_EXPIRY_SECONDS ?? 3600),
presignPutExpirySeconds: Number(process.env.PRESIGN_PUT_EXPIRY_SECONDS ?? 24 * 3600),
```

Keep `PRESIGN_EXPIRY_SECONDS` honoured as a fallback for both so nothing breaks
mid-deploy. 1 hour for GET is ample for immediate consumption; 24 hours for PUT
keeps large uploads on slow links viable while cutting the window 7×.

**Trade-off — and why this needs a device test, not just a unit test.** Museum's
`PreSignedRequestValidityDuration` is 7 days and the comment at `config.ts:16`
records that deliberately. The risk is a client that **caches** presigned URLs
rather than re-fetching: shorten the GET expiry and cached thumbnails start
404ing after an hour. D26 and D32 are both gate findings where real client
behaviour contradicted a reasonable server-side assumption, so assume nothing
here. Re-run the M5 device gate (`RUNBOOK-M5.md`) with a shortened GET expiry and
confirm the gallery still loads after sitting idle past the window before
committing to the default. If it does not, keep GET at 7 days and shorten only
PUT — the PUT window is the larger exposure anyway.

This finding is genuinely lower priority than 1–4. Fix it when the M5 gate is
being re-run for another reason, not as a standalone change.

---

## Finding 6 — Low: missing transport and browser security headers

**Where.** Confirmed absent on every response: `Strict-Transport-Security`,
`X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`,
`Referrer-Policy`.

**Root cause.** `src/middleware/cors.ts` sets exactly museum's six CORS headers
and nothing else, and the distribution attaches no response-headers policy.

**Fix.** Add these at **CloudFront**, not in the app —
`aws_cloudfront_response_headers_policy` referenced from
`default_cache_behavior.response_headers_policy_id` in
`src/infra/modules/edge/main.tf:40`. Two reasons the edge is the right place:
the app is byte-faithful to museum's header set and D29 exists to keep it that
way, and HSTS on a `*.cloudfront.net` domain is a property of the distribution.

Worth setting: `Strict-Transport-Security` (`max-age=31536000`),
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.

`Referrer-Policy: no-referrer` is the one that earns its place beyond
box-ticking: it directly reduces the `?token=` leakage that
`AWS-RESOURCES.md` §3 flags, by stopping the token-bearing URL riding out in a
`Referer` header. CSP and `X-Frame-Options` are near-pointless for a JSON API —
set them or don't.

**Known limitation.** None of this covers the direct Function URL, which serves
no such headers. That is finding 4's origin lock again; until then these headers
protect the CloudFront path only. Fine, since `server_url` (the CloudFront
domain) is what clients are pointed at.

---

## Finding 7 — Low: `X-Forwarded-For` trusted verbatim

**Where.** `src/middleware/auth.ts` writes no IP, but every login path does:
`verifyEmail.ts:29`, `twoFactor.ts:113`, `verifySession.ts:44` all take
`c.req.header('x-forwarded-for') ?? ''` and store it on the token row.

**Root cause.** The header is client-settable, and the Function URL is directly
reachable, so a caller fully controls what `GET /users/sessions` will later show
as the origin of their session. Session history is exactly the surface a user
reads to spot a compromise, so poisoning it has real (if modest) value to an
attacker.

**Fix.** Take the **last** comma-separated entry, not the whole header.
CloudFront appends the viewer's IP to the right of whatever the client sent, so
the rightmost value is the edge-observed address and cannot be forged through
that path. Something like:

```ts
const clientIp = (c.req.header('x-forwarded-for') ?? '')
  .split(',').pop()?.trim() ?? '';
```

For the direct Function URL there is no trustworthy value in the header at all —
the real caller is in `requestContext.http.sourceIp` on the Lambda event, which
`src/lambda.ts` would need to surface into the request context. Note the honest
ordering: this fix is only fully sound **after** finding 4's origin lock makes
CloudFront the sole path. Before that, the last-entry parse is a strict
improvement over trusting the whole header, not a guarantee.

**Verify.** A unit test asserting a spoofed `X-Forwarded-For: 1.2.3.4, 5.6.7.8`
stores `5.6.7.8`. Existing coverage sits in `test/unit/auth-token.test.ts`.

---

## Accepted — no action

Both are deliberate and documented; recorded here so a future reviewer does not
re-open them as new.

**Account enumeration.** `GET /users/srp/attributes` returns 404 for an unknown
email and 200 with `srpUserID`/`srpSalt`/Argon2 params for a real one;
`POST /users/ott` distinguishes `USER_NOT_REGISTERED` from success. Confirmed
live. This is museum's documented behaviour and **D13 explicitly corrects an
earlier "always 200" guess** — museum discloses, and only swallows past an abuse
rate limit. Changing it would break the web client's signup/login branching. The
salts leak no offline attack surface on their own: cracking the KEK also needs
the encrypted key attributes, which require authentication.

**CORS echoes any origin with `Allow-Credentials: true`.** Confirmed live —
`Origin: https://evil.example.com` comes back verbatim. Museum-faithful and D29
pins it. The reason this is not exploitable here: authentication is a header
token (`X-Auth-Token`), not a cookie, so there is no ambient credential for an
attacker's page to ride. The browser will happily make the cross-origin request
and read the reply, but only if it already holds the token — at which point CORS
is not what is protecting anything. Revisit only if cookie auth is ever added,
and note `AWS-RESOURCES.md` §3's standing warning that any future cache policy
in front of these routes must vary on `Origin`.

---

## Suggested sequencing

1. **F0** (capped counter) — unblocks 1 and 3, and its concurrency test is the
   regression guard for both.
2. **Finding 2** (SRP `ttl`) — one hour, no observable behaviour change, stops
   the only actively exploitable-by-anyone issue.
3. **Finding 1** (TOTP cap) — highest severity; needs the `DECISIONS.md`
   divergence entry, so it needs a decision, not just a patch.
4. **Finding 3** (OTT counter) — same primitive as 1, restores documented D12.
5. **Finding 4** budget alarm + reserved concurrency now; the origin lock and WAF
   as one deliberate change later.
6. **Findings 6, 7** — cheap, bundle them with the finding 4 infra pass.
7. **Finding 5** — fold into the next M5 device gate re-run.

Findings 1, 2 and 3 are the ones I would want closed before this table holds
photos that matter.
