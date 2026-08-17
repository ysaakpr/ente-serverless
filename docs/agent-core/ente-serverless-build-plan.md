# ente-serverless — build plan
## Complete API contract, feature tags, milestones, and mandatory test gates

Companion to `ente-serverless-plan.md` (architecture + API census). This document is the
executable plan: a lightweight agent should be able to build the system from it, one
endpoint at a time, without asking questions the doc already answers.

**Decision locked 2026-08-16: originals are Glacier Instant Retrieval (GIR) only.** No Deep
Archive, no restore workflow, no touch-to-restore. Every object is readable in milliseconds;
archival economics get revisited later with real access data (plan doc §7 keeps the analysis).

---

## 0. Ground rules (inherited from immich-serverless, they earned their keep)

1. **Never invent a shape.** Every request/response below is sourced from museum's Go structs
   or the web client (paths cited per endpoint as `src:`). Before implementing an endpoint,
   **capture it from the live oracle** (museum in docker) and pin the capture as a fixture.
   Where this doc and a capture disagree, the capture wins and this doc gets corrected.
2. **One endpoint = one handler file = one test file.** No file over ~150 lines. Shared
   logic in `domain/`. No cross-handler imports.
3. **Ports and adapters.** `db`, `blobs`, `queue`, `mail`, `clock`, `crypto` ports; memory
   adapters for unit tests, LocalStack adapters for integration. Nothing requires an AWS
   account until the cloud milestone.
4. **Definition of done (mandatory, per endpoint):**
   - 100% of the endpoint's listed test scenarios pass (`make test`);
   - integration scenarios pass against LocalStack (`make test-int`) where listed;
   - the oracle parity check passes with **zero unexplained divergences** (allowlist entries
     require a written justification, same discipline as immich's `contract-allowlist.ts`);
   - `make typecheck` clean.
   An endpoint without green scenarios does not count as implemented, and a milestone is not
   done until every endpoint in it is done AND the milestone's end-to-end gate passes.
5. Dependencies: hono, @aws-sdk/*, zod, vitest, libsodium-wrappers, a vetted SRP-6a
   implementation (tssrp6a or RFC-5054 over BigInt — decided in M1 against the oracle),
   uuid. Nothing else without a written reason.

## 1. Stack and architecture

```
CloudFront ── API Lambda (hono, Function URL auth NONE)     ── DynamoDB single table
                 │                                              (+ GSIs for diff feeds)
                 ├── presigned PUT/GET ─► S3 objects bucket ◄── clients move all bytes
                 ├── SES (OTT + notification mail)
                 └── EventBridge crons: trash purge (post-M4), token/OTT sweep (or DynamoDB TTL)
```

- No worker Lambda, no container image needed (no sharp/ffmpeg). Plain esbuild zip is fine;
  keep the container pattern only if tooling parity with immich-serverless is worth it.
- Local dev: LocalStack (DynamoDB, S3, SES, SQS if used); museum + Postgres + MinIO via
  ente's quickstart compose as the **oracle** on another port.
- IDs: museum uses int64 IDs generated server-side (files, collections, users). Use a
  monotonic snowflake-style generator (epoch ms << 22 | shard | seq) — int64-safe in JSON
  (verify overflow behaviour against captures; JS `number` holds them if < 2^53 — museum IDs
  are epoch-derived and fit; assert this in a unit test).

### S3 layout and storage classes (GIR-only decision applied)

| Prefix (one bucket) | Contents | Storage class |
|---|---|---|
| `{userID}/{objectKey-uuid}` originals | encrypted `file` objects | **lifecycle → GLACIER_IR at day 0** |
| thumbnails | encrypted `thumbnail` objects | Standard (never tiered — grid reads constantly) |
| file-data (`vid_preview`, `mldata`, …) | derived objects + their metadata | Standard |

Museum's exact key layout is in `server/ente/filedata/path.go` and the upload controller
(`userID/uuid` for file/thumbnail); mirror it so captures line up.

GIR notes: retrieval is instant; reads bill ~$0.03/GB (mobile clients cache originals, so
repeats are free); 90-day minimum storage — an original deleted from trash before day 90
pays the remainder (accepted; monitor in COSTS). Thumbs must never transition. The
lifecycle rule and a plan-time guard test (no transition on thumb/file-data prefixes,
GLACIER_IR — not DEEP_ARCHIVE — on originals) land with the infra milestone.

### DynamoDB model (single table, `pk`/`sk`, GSIs `gsi1..3`)

| Entity | pk | sk | Notes |
|---|---|---|---|
| user | `USER#<id>` | `META` | email (lowercased, also unique via guard row `EMAIL#<hash>`), name |
| key attributes | `USER#<id>` | `KEYS` | the encrypted key bundle (§3 KeyAttributes) |
| SRP auth | `USER#<id>` | `SRP` | srpUserID, salt, verifier; guard `SRPUSER#<srpUserID>` → userID |
| SRP session | `SRPSESSION#<uuid>` | `META` | serverKey `b`, A, attemptCount, isVerified, TTL 15 min |
| SRP temp setup | `SRPSETUP#<uuid>` | `META` | verifier+salt awaiting complete, TTL 1 h |
| OTT | `OTT#<email-hash>` | `<code>` | TTL 10 min, attempt counter on user row |
| auth token | `TOKEN#<hash>` | `META` | userID, app, createdAt, lastUsed; GSI by user for /users/sessions |
| file | `FILE#<id>` | `META` | File json (owner, attributes, magic metadata versions) |
| collection | `COL#<id>` | `META` | Collection json |
| collection-file link | `COL#<colID>` | `FILE#<fileID>` | encryptedKey/nonce for that file-in-collection + `gsi1pk=COL#<id>#DIFF`, `gsi1sk=<updationTime>#<fileID>` → the `/collections/v2/diff` feed (tombstones: isDeleted=true rows kept) |
| collection diff feed | gsi2 on collection rows | `updationTime` | `/collections/v2?sinceTime` |
| trash entry | `TRASH#<userID>` | `<updatedAt>#<fileID>` | drives `/trash/v2/diff`; tombstones for restore/delete |
| file-data row | `FILE#<id>` | `FD#<type>` | status/objectID/size for vid_preview etc. |
| usage counter | `USER#<id>` | `USAGE` | bytes consumed (atomic add on commit/delete) |

Every mutation to files/collection-links/trash bumps `updationTime` (epoch **microseconds**
— museum uses microsecond timestamps; verify in capture and never truncate).

## 2. Feature tags

`[HEALTH]` `[AUTH-OTT]` `[AUTH-SRP]` `[ACCOUNT]` `[KEYS]` `[UPLOAD]` `[FILE-READ]`
`[FILE-META]` `[COLLECTIONS]` `[SYNC]` `[TRASH]` `[ENTITY]` `[CONFIG-STUB]`
`[BILLING-STUB]` `[PUSH-STUB]` `[BONUS-STUB]` `[FILE-DATA]` — later phases:
`[SHARING]` `[PUBLIC-LINKS]` `[MEMORIES]` `[CAST]` `[2FA]` `[PASSKEYS]` `[FAMILY-STUB]`.

## 3. Shared contract elements

**Auth:** authenticated endpoints take the session token in the `X-Auth-Token` header
(base64url). Server stores only a hash of the token. 401 body/shape: capture from oracle
(museum returns empty body 401 in most middleware rejections — verify). Public endpoints
marked `auth: none`. All clients also send `X-Client-Package` (e.g. `io.ente.photos`) — log
it, never require it.

**KeyAttributes** (returned at verification, stored by `PUT /users/attributes`;
src: `ente/user.go KeyAttributes`): `kekSalt`, `encryptedKey`, `keyDecryptionNonce`,
`publicKey`, `encryptedSecretKey`, `secretKeyDecryptionNonce`, `memLimit`, `opsLimit`,
`masterKeyEncryptedWithRecoveryKey`, `masterKeyDecryptionNonce`,
`recoveryKeyEncryptedWithMasterKey`, `recoveryKeyDecryptionNonce`. Opaque blobs — store and
echo, never inspect.

**Verification response** (shared by OTT verify and SRP verify; src: `ente/user.go
EmailAuthorizationResponse` + web `services/user.ts RemoteSRPVerificationResponse`):
```json
{ "id": <userID>, "keyAttributes": {…}|null, "encryptedToken": "<b64>"|null,
  "token": null, "twoFactorSessionID": ""|null, "passkeySessionID": ""|null,
  "srpM2": "<b64>"  // SRP path only
}
```
`encryptedToken` = libsodium **sealed box** of the raw token to the user's `publicKey`
(plaintext `token` only for accounts with no keys yet — first signup). 2FA fields empty in
core scope.

**Errors:** museum's gin errors are `{"code":"<STRING_CODE>","message":"…"}` with proper
HTTP status for structured cases, plain status for others — **capture per endpoint**; do
not assume one envelope (immich lesson: twelve handlers were wrong about this).

---

## 4. API catalogue

Format per endpoint — Tag / Auth / src / Request / Response / Behaviour / Tests.
Statuses, field names, and nesting are capture-gated (rule 0.1).

### 4.1 [HEALTH]

#### GET /ping
Auth: none. src: `pkg/api/healthcheck.go`.
Response: `{"message":"pong","id":"<instance>"}` (capture exact).
Behaviour: no auth, no DB read beyond a cheap liveness check.
Tests: (1) 200 with expected shape; (2) reachable without headers. — 2 scenarios.

### 4.2 [AUTH-OTT] — email one-time codes

#### POST /users/ott
Auth: none. src: `ente/user.go SendOTTRequest`, `pkg/controller/user/user.go`.
Request: `{"email":"a@b.c","purpose":"signup"|"login"|"change"|"", "client":"…"}`.
Response: `{}` / 200 (capture).
Behaviour: generate 6-digit code, store hashed with 10-min TTL, email via SES. Rate limit
per email+IP (museum: hardcoded caps — capture the 429 behaviour). For `purpose=signup`
with an existing account, and `login` with a missing one, museum still answers 200
(anti-enumeration) — verify by capture and match. Local/dev: code also written to logs
(museum quickstart prints it) — replicate for tests.
Tests: (1) 200 + mail sent (mail port spy); (2) code stored hashed, not plaintext;
(3) TTL expiry rejects; (4) rate limit fires; (5) enumeration-safety: same outward
behaviour for existing/missing email; (6) integration: SES-LocalStack delivery. — 6.

#### POST /users/verify-email
Auth: none. src: `ente/user.go EmailVerificationRequest` → `EmailAuthorizationResponse`.
Request: `{"email":"a@b.c","ott":"123456","source":"…"?}`.
Response: the shared **verification response** (§3). New user: creates account, returns
`id` + plaintext `token`, null keyAttributes. Existing user with keys: `encryptedToken`
sealed to publicKey, keyAttributes included.
Behaviour: consume the OTT (single use); cap wrong-attempt count (capture the lockout);
issue session token (row in TOKEN partition).
Tests: (1) new-user signup returns id+token; (2) existing-user returns sealed
encryptedToken that the test can open with the user's secret key (libsodium in test);
(3) wrong code 4xx; (4) replayed code rejected; (5) attempt-cap lockout; (6) token row
created hashed. — 6.

### 4.3 [AUTH-SRP]

Group parameters: SRP-6a, RFC 5054 **4096-bit** group, SHA-256, ente padding conventions
(reference: `github.com/ente/go-srp`). The M1 gate includes a cross-implementation vector
test: verifier/M1/M2 produced by our server must round-trip against captures from the
oracle for a scripted known-password account. FakeVerifier anti-enumeration
(src: `pkg/controller/user/srp.go` const) must be replicated: unknown srpUserID gets a
full-timing fake handshake that always fails verification.

#### GET /users/srp/attributes?email=…
Auth: none. src: `ente/srp.go GetSRPAttributesResponse`.
Response: `{"attributes":{"srpUserID":"<uuid>","srpSalt":"<b64>","memLimit":N,
"opsLimit":N,"kekSalt":"<b64>","isEmailMFAEnabled":false}}`.
Behaviour: 404 when the account has no SRP set up (web client branches on 404).
Tests: (1) happy shape; (2) 404 for unknown email; (3) 404 pre-SRP-setup account;
(4) email matching is case-insensitive (capture museum's normalization). — 4.

#### POST /users/srp/setup   (auth: token)
src: `SetupSRPRequest → SetupSRPResponse`.
Request: `{"srpUserID":"<uuid>","srpSalt":"<b64>","srpVerifier":"<b64>","srpA":"<b64>"}`.
Response: `{"setupID":"<uuid>","srpB":"<b64>"}`.
Behaviour: store verifier in a TEMP setup row + open an SRP session against it (server
generates `b`, computes B). Nothing becomes the account's SRP auth yet.
Tests: (1) returns valid B (client-side SRP lib completes M1 against it); (2) temp row not
authoritative (login with it fails before complete); (3) A ≡ 0 mod N rejected; (4) repeat
setup replaces prior temp. — 4.

#### POST /users/srp/complete   (auth: token)
src: `CompleteSRPSetupRequest → CompleteSRPSetupResponse`.
Request: `{"setupID":"<uuid>","srpM1":"<b64>"}` → Response `{"setupID","srpM2"}`.
Behaviour: verify M1 against the temp session; on success commit `(srpUserID,salt,verifier)`
as the account's SRP auth and return M2. On failure: 4xx, temp row stays until TTL.
Tests: (1) full setup→complete round-trip with a real SRP client lib; (2) wrong M1
rejected + not committed; (3) M2 verifies client-side; (4) unknown setupID 4xx. — 4.

#### POST /users/srp/create-session
Auth: none. src: `CreateSRPSessionRequest → CreateSRPSessionResponse`.
Request: `{"srpUserID":"<uuid>","srpA":"<b64>"}` → `{"sessionID":"<uuid>","srpB":"<b64>"}`.
Behaviour: load verifier (or FakeVerifier for unknown srpUserID — identical timing and
shape), generate/persist `b` with TTL, return B. Rate limit: max 10 unverified
sessions/user/hour (src constant `MaxUnverifiedSessionInAnHour`).
Tests: (1) happy B; (2) unknown srpUserID still returns plausible session (fake), and its
verify always fails; (3) rate limit at 11th; (4) A ≡ 0 rejected; (5) session TTL expiry. — 5.

#### POST /users/srp/verify-session
Auth: none. src: `VerifySRPSessionRequest` → shared verification response + `srpM2`.
Request: `{"sessionID":"<uuid>","srpUserID":"<uuid>","srpM1":"<b64>"}`.
Behaviour: recompute M1 constant-time; on success mark session verified (single use),
return M2 + keyAttributes + sealed encryptedToken. On failure increment attemptCount, cap
attempts (capture the cap + status).
Tests: (1) full login round-trip (attributes→create→verify) with real SRP client math,
sealed token opens with user secret key; (2) wrong M1 4xx; (3) session replay rejected;
(4) attempt cap; (5) M2 validates client-side; (6) oracle vector parity (same salt/verifier
fixture → interoperable session against captured transcript). — 6.

#### POST /users/srp/update   (auth: token)
src: `UpdateSRPAndKeysRequest → UpdateSRPSetupResponse`. Password change: new verifier via
setup flow + `updatedKeyAttr` (re-encrypted key bundle) + optional `logOutOtherDevices`.
Tests: (1) update swaps verifier (old password stops working, new works); (2) key
attributes replaced atomically with verifier; (3) logOutOtherDevices revokes other tokens,
keeps caller's. — 3.

### 4.4 [KEYS] / [ACCOUNT]

#### PUT /users/attributes   (auth: token)
src: `ente/user.go SetUserAttributesRequest{keyAttributes}`.
Request: `{"keyAttributes":{…§3…}}` → 200 `{}`.
Behaviour: first-time key setup after signup; immutable-ish (museum allows overwrite until
SRP exists — capture exact rule).
Tests: (1) stored+echoed via verify flow; (2) auth required; (3) blob opacity (no
validation beyond required fields). — 3.

#### GET /users/session-validity/v2   (auth: token)
Behaviour: cheap "is my token alive" probe the app calls on foreground; returns
`hasSetKeys` (capture exact shape).
Tests: (1) valid token 200; (2) revoked token 401. — 2.

#### POST /users/logout   (auth: token)
Behaviour: revoke calling token only. Tests: (1) token dead after; (2) other sessions
untouched. — 2.

#### GET /users/sessions · DELETE /users/session?token=…   (auth: token)
Session list + remote revoke (capture shapes — `ente/user.go Session`).
Tests: (1) list contains created sessions with app/ua metadata; (2) delete revokes target;
(3) cannot revoke another user's token. — 3.

#### GET /users/details/v2   (auth: token)
src: `ente/user.go UserDetailsResponse` (capture fully — large composite).
Behaviour: the app's home probe: email, usage bytes, file counts, subscription (stub:
self-host "free" plan mirroring museum's), storage bonus, family status (null).
Tests: (1) shape parity with oracle capture for a fresh account; (2) usage reflects
committed files; (3) values update after upload/delete. — 3.

Remaining `[ACCOUNT]` routes (change-email, delete-challenge/delete, two-factor status,
recovery-key, accounts-token — ~10 endpoints): **capture-first**, implement in M7
completeness pass; each gets minimum 2 scenarios (happy + authz) when specced.

### 4.5 [UPLOAD] — the byte path (all bytes go client→S3 directly)

#### GET /files/upload-urls?count=N   (auth: token)
src: `pkg/controller/file.go GetUploadURLs`, `ente/file.go UploadURL`.
Response: `{"urls":[{"objectKey":"<userID>/<uuid>","url":"<presigned PUT>"}, …]}`.
Behaviour: cap N at 50; key = `userID/uuid`; presign PUT (no content-type constraint,
expiry from museum's `PreSignedRequestValidityDuration` — capture ~= 7 days? verify);
no DB writes (URLs are speculative).
Tests: (1) N urls, distinct keys under caller's prefix; (2) cap at 50; (3) integration:
PUT to the presigned URL on LocalStack succeeds and lands at objectKey; (4) foreign user
cannot guess/commit another's objectKey (commit-side check). — 4.

#### GET /files/multipart-upload-urls?count=N   (auth: token)
src: `MultipartUploadURLs{objectKey, partURLs[], completeURL}`.
Behaviour: create S3 multipart upload; presign each part PUT + the complete call. Part
count derives from museum's fixed part size (capture — client sends count of parts it
needs? verify against mobile `multipart.dart`).
Tests: (1) shape; (2) integration: full multipart upload+complete on LocalStack, object
materializes; (3) abort/incomplete cleaned by lifecycle rule (infra test). — 3.

#### POST /files   (auth: token) — the commit
src: `ente/file.go File`, `pkg/api/file.go CreateOrUpdate`.
Request: `File` with `id:0`, `collectionID`, `encryptedKey`/`keyDecryptionNonce` (file key
wrapped with collection key), `file{objectKey,decryptionHeader,size?}`,
`thumbnail{objectKey,decryptionHeader,size?}`, `metadata{encryptedData,decryptionHeader}`,
optional `magicMetadata`/`pubMagicMetadata`.
Response: the stored `File` with server-assigned `id`, `ownerID`, `updationTime`.
Behaviour (order matters):
1. caller must own the collection (or have add rights — core: owner only);
2. both objectKeys must be under `userID/` and **exist in S3** — parallel HeadObject,
   sizes recorded; reject on mismatch with claimed sizes; enforce max file size;
3. quota check (usage + newSize ≤ plan);
4. transactional: FILE row + COL#/FILE# link (updationTime=now) + usage counter add;
5. duplicate objectKey re-commit → capture museum behaviour (update vs error).
`id != 0` = update path (same verification, bumps updationTime, feeds diff).
Tests: (1) happy commit returns id+updationTime, appears in collection diff; (2) missing S3
object → 4xx, nothing written; (3) size mismatch rejected; (4) foreign objectKey rejected;
(5) foreign collection rejected; (6) quota exceeded → capture museum's exact error (the
client aborts backup on it); (7) usage counter incremented exactly once; (8) update path
bumps updationTime and preserves owner; (9) integration: real PUT→commit→HeadObject on
LocalStack. — 9.

#### PUT /files/update · PUT /files/thumbnail
src: `UpdateThumbnailRequest` etc. Re-point attributes after client-side edit; same
verification as commit; old object orphaned (lifecycle sweeps... capture whether museum
deletes old object — likely enqueues deletion; core: leave + note).
Tests: (1) attributes replaced, updationTime bumped; (2) verification reruns; (3) diff
feed shows the update. — 3.

### 4.6 [FILE-READ]

#### GET /files/download/:fileID   (auth: token; also `/v2/:fileID`)
Behaviour: authorize (owner or sharee via collection membership), then respond with the
presigned GET — museum returns a **302 redirect** with Location (v1) / JSON `{"url":…}`
(v2? capture both). GIR objects serve instantly; no restore branch exists.
Tests: (1) owner gets working URL (integration: fetch through it on LocalStack);
(2) non-member 4xx (capture status); (3) trashed file still downloadable by owner
(capture); (4) unknown id 404. — 4.

#### GET /files/preview/:fileID   (auth: token) — the THUMBNAIL
Same authz; presigned GET of the thumbnail object. (Naming trap: "preview" here = thumb;
`vid_preview`/`img_preview` live under /files/data.)
Tests: (1) working URL; (2) authz; (3) thumbnail bytes ≠ file bytes (right object). — 3.

#### POST /files/info · POST /files/size
src: `pkg/api/file.go`. Batch metadata: `{"fileIDs":[…]}` → per-file `FileInfo`
(fileSize, thumbSize) / total size. Only caller-accessible files; capture the not-found
handling (skip vs error).
Tests: (1) sizes match committed objects; (2) foreign ids filtered per capture; (3) batch
cap (capture limit). — 3.

### 4.7 [FILE-META]

#### PUT /files/magic-metadata · PUT /files/public-magic-metadata   (auth: token)
src: `UpdateMultipleMagicMetadataRequest{metadataList:[{id, magicMetadata{version,count,
data,header}}]}`.
Behaviour: version must be ≥ stored (optimistic concurrency — capture the conflict error);
count monotonic; opaque data/header; bumps file updationTime into diffs. Magic = private
(favourites, hidden), pubMagic = shared-visible (edited name, caption).
Tests: (1) update lands + diff bump; (2) stale version → capture'd conflict; (3) count
regression rejected; (4) owner-only for magic, owner for pubMagic (capture sharee rule);
(5) batch partial behaviour per capture. — 5.

### 4.8 [COLLECTIONS]

#### POST /collections   (auth: token)
src: `ente/collection.go Collection`.
Request: collection with `encryptedKey`/`keyDecryptionNonce` (wrapped with master key),
`encryptedName`/`nameDecryptionNonce`, `type` (`album`|`folder`|`favorites`|
`uncategorized`), `attributes`, optional magicMetadata, `app:"photos"`.
Response: stored collection with `id`, `owner`, `updationTime`.
Behaviour: one `favorites` + one `uncategorized` per user per app (capture duplicate
behaviour); name is opaque ciphertext.
Tests: (1) create/echo; (2) favorites uniqueness per capture; (3) appears in
/collections/v2 with sinceTime 0. — 3.

#### GET /collections/v2?sinceTime=T   (auth: token)
Response: `{"collections":[Collection…]}` — owned + shared-with-me, changed since T,
tombstones with `isDeleted:true`.
Tests: (1) fresh account: sinceTime=0 returns created set; (2) incremental: only changes
after T; (3) rename/meta change re-emits; (4) delete emits tombstone; (5) updationTime
strictly monotonic per collection. — 5.

#### GET /collections/v2/diff?collectionID=C&sinceTime=T   (auth: token)
**The file sync spine.** Response: `{"diff":[File…],"hasMore":bool}` — files added/
changed/removed in C since T; removals as `isDeleted:true` entries; page size (capture,
museum pages internally ~2500).
Behaviour: strict updationTime ordering, tombstones never pruned before the client saw
them, `hasMore` drives the client loop.
Tests: (1) add→appears; (2) remove→tombstone; (3) move emits remove-from-old +
add-to-new; (4) pagination with >pageSize changes, no gaps/dupes across pages;
(5) metadata update re-emits file; (6) sinceTime idempotency (same T twice = same answer);
(7) oracle parity on a scripted 30-op sequence — byte-level envelope match. — 7.

#### POST /collections/add-files · /collections/move-files   (auth: token)
Request: `{"collectionID":C,"files":[{"id":F,"encryptedKey":…,"keyDecryptionNonce":…}]}`
(file key rewrapped with target collection key, client-side).
Behaviour: add creates links; move = add to target + remove from source atomically
(capture whether v3 semantics differ); both feed diffs of affected collections.
Tests: (1) add feeds target diff; (2) move feeds both diffs correctly; (3) foreign file
rejected; (4) re-add same file idempotency per capture. — 4.

#### POST /collections/v3/remove-files   (auth: token)
Remove without new key material (files leave collection; if last home → capture museum's
uncategorized fallback behaviour — v3 exists precisely for this; encode findings).
Tests: (1) tombstone in diff; (2) last-collection behaviour matches capture; (3) owner
checks. — 3.

#### POST /collections/rename · PUT /collections/magic-metadata (+ public variant)
Opaque ciphertext updates; updationTime bump into /collections/v2.
Tests: (1) rename round-trip; (2) stale-version conflict; (3) feeds collection feed. — 3.

#### DELETE /collections/v3/:id?keepFiles=true|false   (auth: token)
Behaviour: keepFiles=true → files move to uncategorized (capture); false → files to trash.
Tombstone in collection feed.
Tests: (1) both keepFiles branches; (2) trash entries created on false; (3) favorites/
uncategorized undeletable (capture). — 3.

### 4.9 [TRASH]

#### POST /files/trash   (auth: token)
src: `ente/trash.go TrashRequest{items:[{fileID,collectionID}]}`.
Behaviour: file leaves collections into trash with deleteBy = now+30d; feeds both the
collection diff (removal) and trash diff (add).
Tests: (1) trash entry + collection tombstone; (2) idempotent re-trash per capture;
(3) foreign file rejected. — 3.

#### GET /trash/v2/diff?sinceTime=T   (auth: token)
Response: `{"diff":[TrashItem…],"hasMore":bool}` — TrashItem embeds the File + `deleteBy`,
tombstones for restored/deleted entries (capture exact fields: `isDeleted`,
`isRestored`?).
Tests: (1) trash→appears with deleteBy; (2) restore→tombstone flavour per capture;
(3) permanent delete→tombstone; (4) pagination integrity; (5) oracle parity script. — 5.

#### POST /trash/delete   (auth: token) — permanent delete of listed trash entries
Behaviour: remove rows + **decrement usage** + delete S3 objects? Museum enqueues object
deletion (capture visible effects only: usage drop, diff tombstone). Our core: mark
deleted, decrement usage, enqueue S3 delete via cron (the app never needs the bytes gone
synchronously). GIR early-delete fee applies <90d — accepted.
Tests: (1) usage decremented once; (2) diff tombstone; (3) collection diffs unaffected
(already tombstoned); (4) double-delete idempotent. — 4.

#### POST /trash/empty   (auth: token)
Request: `{"lastUpdatedAt":T}` — empty everything up to T (capture). Async in museum
(returns fast, work continues) — ours may be synchronous under Lambda limits; behaviour
parity is what's tested, not timing.
Tests: (1) all ≤T gone from diff; (2) newer entries survive; (3) usage adjusted. — 3.

#### Restore = POST /collections/restore-files   (auth: token)
Request: collectionID + files with fresh wrapped keys. Trash tombstone + reappearance in
collection diff.
Tests: (1) round-trip trash→restore→collection diff; (2) deleteBy cleared; (3) restore to
foreign collection rejected. — 3.

### 4.10 [ENTITY] — user-entity store (locations, people; app syncs it at boot)

Routes (7, src `pkg/api/userentity.go`): POST /user-entity/key, GET /user-entity/key,
POST /user-entity/key/ensure?, POST /user-entity/entity, PUT /user-entity/entity,
DELETE /user-entity/entity, GET /user-entity/entity/diff.
Generic encrypted KV with types (`location`, `person`, …): opaque blobs + per-type key +
diff feed with the same tombstone discipline.
Tests per route: happy, authz, diff integrity (12 scenarios total across the group);
oracle parity on the diff. — 12.

### 4.11 Stubs the app requires to boot (capture museum's self-host answers, mirror them)

| Endpoint | Tag | Behaviour |
|---|---|---|
| GET /remote-store · POST /remote-store/update | `[CONFIG-STUB]` | per-user KV the app reads flags from; store real values (it's trivial), capture the key names the app writes |
| GET /remote-store/feature-flags | `[CONFIG-STUB]` | static JSON of flags; capture museum's defaults (internalUser, mapEnabled, …) |
| GET /billing/plans/v2 · GET /billing/subscription · POST /billing/verify-subscription | `[BILLING-STUB]` | museum self-host returns a free plan with large storage; copy the capture verbatim |
| GET /storage-bonus/details | `[BONUS-STUB]` | zeros, shape from capture |
| POST /push/token | `[PUSH-STUB]` | 200, store-and-ignore |
| GET /users/feedback? /events? | `[CONFIG-STUB]` | accept-and-drop per capture |

Tests: each stub gets (1) shape parity with capture; (2) auth requirement — 2 each,
12 total. Stubs are DONE-gated like real endpoints: the app must boot past them.

### 4.12 [FILE-DATA] — derived data (Tier 1, needed for video playback + ML sync)

Routes: PUT /files/data (mldata), POST /files/data/fetch, POST /files/data/status-diff,
GET /files/data/preview-upload-url (vid_preview|img_preview),
GET /files/data/preview, PUT /files/video-data.
src: `ente/filedata/*.go` (type gates per endpoint are already extracted — see plan doc).
Behaviour: per-type object storage under the file-data prefix with the same
verify-then-record commit pattern; status-diff feed like the others. `img_preview` is
accepted from day one (our server side of the three-tier image plan — dormant until
clients use it).
Tests: (1-2) preview-upload-url + PUT + GET /files/data/preview round-trip on LocalStack
for vid_preview AND img_preview; (3) PUT /files/video-data commit + fetch; (4) mldata
PUT/fetch batch; (5) status-diff integrity; (6) type gates reject exactly what museum
rejects (capture); (7) authz on all. — 7.

---

## 5. Milestones — each gated on LocalStack, each with a mandatory pass bar

Every milestone gate = **100% of the member endpoints' scenarios green** (`make test`,
`make test-int`) **+ the milestone E2E script green + capture-diff zero unexplained
divergences** for the endpoints in scope. No partial credit; an endpoint slips to the next
milestone rather than shipping half-tested.

**M0 — harness + oracle (no product endpoints).**
Deliverables: repo skeleton (ports/adapters/handlers/domain layout), LocalStack compose,
museum oracle compose (pinned tag — record it in `ORACLE-VERSION`), capture tooling
(`make capture` records request/response pairs; `make capture-diff` replays against ours),
synthetic client library for tests: libsodium (argon2id, sealed box, secretbox/blob
streams) + SRP client — this is the test-suite's "phone".
Gate: capture of a full museum signup→SRP→upload→diff transcript checked into fixtures;
synthetic client completes the same transcript against museum byte-compatibly.

**M1 — [HEALTH] [AUTH-OTT] [AUTH-SRP] (8 endpoints, 40 scenarios).**
Gate script: synthetic client signs up (OTT), sets keyAttributes, sets up SRP, logs out,
logs back in via SRP, opens sealed token — against OUR server on LocalStack; and the SRP
vector parity test against oracle fixtures passes.

**M2 — [KEYS] [ACCOUNT] core (6 endpoints, 16 scenarios).**
Gate: session lifecycle script (multi-device: two tokens, remote revoke, validity probe,
details/v2 parity with a fresh-account oracle capture).

**M3 — [UPLOAD] [FILE-READ] (7 endpoints, 29 scenarios).**
Gate: synthetic client encrypts a real JPEG, uploads (single + multipart ≥5 MB), commits,
downloads via /files/download, decrypts, byte-identical; thumbnail round-trip; quota
rejection path; all on LocalStack.

**M4 — [COLLECTIONS] [SYNC] [TRASH] [FILE-META] (13 endpoints, 51 scenarios).**
Gate: the 30-operation sync torture script (create/rename/add/move/remove/trash/restore/
delete/empty, interleaved across 3 collections) replayed against oracle and ours —
diff-stream equivalence at every checkpoint. This is the milestone that makes the stock
app's library correct.

**M5 — stubs + [ENTITY] (13 endpoints, 24 scenarios) → first stock-app connection.**
Gate: **the stock ente app (7-tap custom endpoint, LAN) completes onboarding against the
local server**: signup, key setup, backup of a small library, gallery browse, album
create, trash/restore, second-device login sees everything. LocalStack still the backend.
Record every unexpected request the app makes — each becomes an issue or an allowlist
entry with justification.

**M6 — [FILE-DATA] (6 endpoints, 7 scenario groups).**
Gate: video upload from the stock app plays via streaming (vid_preview HLS round-trip);
ML sync completes (mldata fetch batch); img_preview round-trip proven with the synthetic
client (no stock-app consumer yet — protocol-ready is the bar).

**M7 — cloud validation + completeness.**
Port infra to the existing `infra-tofu` pattern (data/compute/edge modules; bucket
lifecycle: originals→GLACIER_IR day 0, guard test asserting no DEEP_ARCHIVE anywhere and
no transition on thumbs/file-data). Deploy dev, run M1–M6 gate scripts against the real
URL, then the stock app over the internet. Then the completeness pass: remaining
[ACCOUNT] routes and any endpoint the M5/M7 app-captures surfaced, capture-first.
Definition of done for the whole plan: stock app daily-drivable against the cloud
deployment; `make capture-diff` green across all implemented endpoints; every endpoint's
scenario suite green in CI; observed cost recorded.

## 6. Test accounting (the mandatory success-rate ledger)

Maintain `TEST-LEDGER.md`, one row per endpoint: tag, milestone, scenario count,
last-run pass count, capture-parity status. CI fails if any implemented endpoint is below
100%. The ledger is generated from vitest output (`make ledger`), never hand-edited —
a hand-edited number is a lie waiting to be believed. Scenario totals at plan time:
~180 unit/contract + ~15 integration + 7 E2E gate scripts; expect the number to grow as
captures correct this document, never to shrink.
