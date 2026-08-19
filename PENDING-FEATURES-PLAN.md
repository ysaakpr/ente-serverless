# Pending features — holistic build plan, caveats, mitigations

Design document for everything the README feature report lists as **Pending**
(album collaborators, public album links, single-file links, memories,
contacts, comments/reactions, cast, passkeys, family, legacy contacts).
Written from the 2026-08-18 audit of the current code. **Nothing here is
built yet** — this is the map, recorded before the work so the schema and
sequencing decisions are made once, deliberately.

Companion documents: [DECISIONS.md](DECISIONS.md) (divergences and their
reasons), [NEXT-TASKS.md](NEXT-TASKS.md) (the near-term queue — P3 items
should be lifted from here when scheduled),
`docs/agent-core/ente-serverless-plan.md` §2 (the measured museum API
surface and tier definitions).

---

## 1. The shape of the problem

The Pending rows are not ten independent features. Collaborators, public
album links, single-file links, memories, and cast all sit on the **same two
missing primitives**:

1. a **collection-access model** that isn't "owner or 404" — today every
   collection path is hard-gated through `getOwnedCollection`
   (`src/domain/collections.ts`) and `getAccessibleFile`
   (`src/domain/files.ts`), and the collection JSON hardcodes
   `sharees: null, publicURLs: null`;
2. a **bearer-token identity** that isn't a session — the only auth path is
   `X-Auth-Token` → session lookup (`src/middleware/auth.ts`); the
   `X-Auth-Access-Token` family of headers is CORS-allowed but consumed by
   nothing.

Build those two once (Phases A–B), and the features become route work
(Phases C–E). Build features first, and the schema gets re-cut three times.

### Current-code facts the plan rests on (audit findings)

- All three DynamoDB GSIs are allocated: `gsi1` collection diff, `gsi2`
  owner's collection feed, `gsi3` triple-purposed (tokens, trash diff,
  file→links index). Sharing and links need new lookups → schema decision.
- The `gsi2` comment in `src/domain/model.ts` claims "all collections
  visible to a user" but the partition is owner-only. The
  `getAccessibleFile` docstring describes a sharee branch that does not
  exist. Both must be corrected before implementation starts (see §4.7).
- `removeFilesV3` (`src/handlers/collections/fileActions.ts`) has a branch
  that can only ever 400 in the current owner-only model, and
  `test/unit/collections.test.ts` asserts that degenerate behaviour — the
  test needs rewriting, not extending.
- `/files/info` uses strict ownership (403-on-foreign) where museum filters
  to accessible files — wrong the moment sharing exists.
- Upload attribution is authenticated-user-only: object keys derive from the
  caller's userID and quota is charged to the caller
  (`src/handlers/files/uploadUrls.ts`) — a collect flow needs the opposite.
- Account deletion does not unshare or kill links (nothing to kill yet);
  museum does both.
- The spend ceilings landed in `f620970` are per-authenticated-user; public
  links need per-link ceilings.

---

## 2. Build order

### Phase A — schema foundation (the real decision)

Two viable paths for the new lookups ("collections shared with me",
"token → collection"):

- **Option 1 — add `gsi4`.** Clean, but an online backfill on the prod
  table, mirrored changes in the memory adapter and the tofu data module,
  and the last cheap index is spent.
- **Option 2 (recommended) — explicit reverse-lookup partitions, no new
  index.** Write participant rows twice under both key shapes
  (`COL#<id>#SHAREE#<userID>` and `USER#<userID>#SHARED#<colID>`); public
  tokens live under their own PK (`PUBTOKEN#<tokenHash>` → collectionID, a
  natural `GetItem`). Cost: every share/unshare/link mutation becomes a
  `TransactWriteItems` dual-write, and the DB port has no transaction
  primitive today — that is a port + both-adapters change (§4.7).

Store link tokens **hashed at rest**, same discipline as session tokens
(`tokenHash` in `src/domain/tokens.ts`).

### Phase B — authz seam rework

- `getOwnedCollection` → `resolveCollectionAccess(userId, colID) →
  {role: OWNER | COLLABORATOR | VIEWER}`; each of the ~12 collection
  handlers declares its minimum role.
- `getAccessibleFile` grows the sharee branch: owner, or member of any
  collection containing the file.
- Fix the landmines in the same phase: `removeFilesV3`'s unconditional-400
  branch (+ its test, rewritten in the same commit), `/files/info`
  filter-to-accessible semantics, upload commit allowing collaborators to
  target shared collections.

### Phase C — album collaborators (share with Ente users)

Routes: `POST /collections/share`, `unshare`, `leave`,
`GET /collections/sharees` (+ join-link later). Key wrap is already solved:
`crypto_box_seal` exists and `GET /users/public-key` is live. The genuinely
new problem is the **sharee's sync feed** — `gsi2` is owner-partitioned, so
a shared collection must appear in the sharee's `/collections/v2` by either:

- **query-time merge (start here)**: read owned partition + shared partition,
  merge by `updationTime`; simpler, no write amplification;
- fan-out feed rows per participant — only if captured pagination semantics
  force it; cheap only with a participant cap (museum caps anyway).

### Phase D — public album links

Two halves:

1. **Management (authed API)**: `POST/PUT/DELETE /collections/share-url` —
   token generation (uuid-grade entropy, stored hashed), `validTill`,
   `deviceLimit`, password KDF params (nonce/opsLimit/memLimit — client-side
   argon2id, server stores params + verifies a derived hash),
   `enableDownload` / `enableCollect` / `enableJoin`.
2. **Serving (`/public-collection/*`, ~23 routes)** behind a **second auth
   middleware**: `X-Auth-Access-Token` → `PUBTOKEN#` row → collection, with
   expiry / disabled / device-limit checked on every request.
   Password-protected links need a **JWT primitive** (museum issues a JWT
   after `verify-password`; sign with the existing hashing key) — the repo
   has none today.
3. **Collect (guest upload)**: reuse the presign machinery with attribution
   flipped — object keys and quota charged to the **link owner**, per-link
   upload ceiling enforced.

The collection key never reaches the server: it travels in the link's URL
fragment, so the public surface serves only ciphertext + the per-file keys
already wrapped with the collection key (the wire shape `fileToDiffJson`
already emits).

### Phase E — the rest, riding the same spine

| Feature | What it reuses / what's new |
|---|---|
| Single-file links (`fileLinkApi`, 7 routes) | same token entity + public middleware, file-scoped |
| Shared memories (`publicMemoryAPI`, 8 routes) | same token entity, memory-scoped |
| Cast (TV) | token entity + a device-pairing code flow (short-lived codes, polling) |
| Contacts, comments/reactions | replace the D27 empty-feed stubs with real fan-out feeds; independent of the token spine |
| Passkeys (`accountsJwtAuthAPI`) | independent; the only item bringing a new hard dependency (WebAuthn verification) |
| Family plans | mostly stub-extension over billing; independent |
| Legacy / trusted contacts | time-delayed access; needs a cron; independent |

**Effort shape**: Phases A+B are the risky, cross-cutting ~30%. C and D are
each roughly the size of the existing trash+entity work combined. Everything
after D is incremental.

---

## 3. Caveats the new implementation creates

1. **Unauthenticated endpoints on a pay-per-request stack.** Everything
   today is behind session auth; `/public-collection/*` is anonymous by
   design. Every scraper hit is a billable Lambda invocation + DynamoDB
   read; AWS-RESOURCES.md already admits there is no edge abuse protection.
   No reusable rate-limiter exists (OTT/2FA caps are bespoke).
2. **Several flags are only softly enforceable.** `enableDownload: false`
   can block the original-download route, but the viewer still needs
   decryptable preview bytes to render at all — deterrent, not DRM.
   Presigned S3 GETs are bearer URLs for their lifetime.
3. **Revocation is shallow, by protocol design.** Unshare/disable deletes
   rows, but a sharee or link-holder who already synced keeps the collection
   key forever; there is no key-rotation path. (Matches upstream Ente.)
4. **Tombstones become per-user.** Today `isDeleted` is global. Unshare must
   surface as a deletion in *one* user's feed while the collection lives on
   for everyone else. Diff semantics (tombstone shape, `sinceTime`
   interplay, Go `nil` vs `[]` — the D27 trap) are the highest
   capture-parity risk in the effort.
5. **A second client enters the compatibility contract.** Public links are
   consumed by the separate **albums web app**, not the Photos app — its
   version must be pinned and captured alongside the museum tag and APK.
   And `/public-collection/*` must never be stubbed empty as an interim
   step: an empty diff on a real link is indistinguishable from a broken
   one.
6. **Lifecycle interactions multiply.** Account deletion must unshare and
   kill links; collection delete must cascade to links + participants;
   expired links need cleanup; collaborator-owned files inside an owner's
   collection complicate trash/purge refcounting (which assumes one owner
   per collection's files).
7. **Cost/consistency tax on the data layer.** Dual-write reverse lookups
   need transactions (new port capability, both adapters,
   LocalStack-tested). Two existing artifacts actively mislead: the `gsi2`
   comment and the `getAccessibleFile` docstring.
8. **Test surface roughly doubles for the touched area.** One endpoint = one
   test file means ~30+ new test files, a new unauthenticated test client,
   and rewrites of tests that lock in owner-only behaviour.

---

## 4. Mitigations, one per caveat

1. **Edge + cheap-fail + ceilings.**
   (a) `/public-collection/*` behind CloudFront with WAF rate-based rules
   (or at minimum CloudFront throttling) so junk dies at the edge — the
   origin lock already guarantees nothing bypasses it.
   (b) Token check is the *first* thing in the public middleware, a single
   PK `GetItem` — invalid token = one cheap read, no downstream work.
   (c) Hand-rolled attempt caps in the existing OTT/2FA style: a counter row
   per `(tokenHash, ip)` with DynamoDB TTL for password verification;
   atomic device-limit counter checked before serving.
   (d) A **per-link ceiling row** (downloads/bytes/uploads per day),
   extending the `f620970` spend-ceiling work.
   (e) Lambda reserved-concurrency cap as the final bill fuse; existing
   budget alarms cover the rest.
2. **Enforce the enforceable, document the rest.** `enableDownload: false`
   → 403 on original-download, previews only; `enableCollect: false` → no
   upload-URL issuance. Short public-path presign expiry (minutes — add a
   public-specific config override next to `presignGetExpirySeconds`). A
   DECISIONS.md entry stating flags are access-control, not DRM — the
   documentation *is* the mitigation against overselling the guarantee.
3. **Margins + honesty.** Transactional row deletion on unshare/disable;
   short presign expiry bounds the tail (from #2); document that synced
   clients keep the collection key (same DECISIONS.md entry); the one real
   remedy the E2EE model allows is the client-side "remove files and
   re-create the album" flow. Links: always mint a **new** token on
   re-enable, never resurrect an old one.
4. **Capture first, per-user tombstone rows.** Run the museum oracle,
   script share → sync-as-sharee → unshare → sync-as-sharee, and record the
   exact wire shapes *before* designing feed rows (the D2 discipline).
   Model unshare as a **per-user tombstone row** in the sharee's feed
   partition — never mutate the global collection row — so owner and other
   sharees are untouched by construction. Add capture-diff fixtures for
   these flows to the parity harness.
5. **Pin the albums web app too.** Add an albums-web release to
   ORACLE-VERSION alongside the museum tag and APK; capture its actual
   traffic. Gate the feature on a manual "open a real link in the pinned
   albums build" checklist item (RUNBOOK-M5 style). If shipping partially:
   404 the whole `/public-collection/*` surface (clients show "link
   broken"), never hollow 200s (clients show "empty album", which lies).
6. **Centralize cascades; TTL as backstop only.** One `onCollectionDelete`
   and one `onAccountDelete` domain function that every handler calls, each
   owning the full cascade (participants, links, per-user feed tombstones,
   device counters). Token rows get DynamoDB TTL **plus** an expiry check in
   the middleware — TTL deletion lags up to ~48 h, so it is never the
   enforcement (same pattern as OTTs). Add an ownership-aware branch to the
   trash-purge cron and pin it with an integration test *before* enabling
   sharing — the purge job is the one place a mistake destroys bytes
   irreversibly.
7. **Transactional port + a prep commit that fixes the lies.** Add
   `transactPut` (or equivalent) to the DB port; implement in both adapters
   (trivial in memory; `TransactWriteItems` on AWS) with a LocalStack test
   proving partial-failure atomicity. All participant/link mutations go
   through domain functions that own the paired writes — no handler writes
   one side directly. Before any of this: a standalone commit correcting the
   `gsi2` comment and the `getAccessibleFile` docstring — the cheapest
   mitigation in this list.
8. **Scaffolding before endpoints.** Build the unauthenticated public test
   client and `shareCollection` / `createLink` fixtures in `test/helpers/`
   first, so each endpoint test file stays small. Rewrite the
   owner-only-locking tests (the `removeFilesV3` 400 test) in the same
   commit that changes the behaviour. Add negative-parity as a class: one
   parameterized test asserting expired, disabled, wrong-password, and
   garbage tokens all return the *same* status shape — enumeration
   resistance as a property, not an accident. TEST-LEDGER picks it all up
   from convention.

**Meta-pattern**: caveats 1, 6, 7 are mitigated with code written once at
the foundation layer (edge throttling, cascade functions, transactional
port); 4, 5, 8 with the project's existing capture/test discipline applied
early; 2 and 3 cannot be engineered away — their mitigation is short-lived
credentials plus honest documentation, which is exactly how upstream Ente
lives with the same constraints.
