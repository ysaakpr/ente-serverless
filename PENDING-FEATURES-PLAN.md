# Pending features — holistic build plan, caveats, mitigations

Design document for everything the README feature report lists as **Pending**
(album collaborators, public album links, single-file links, memories,
contacts, comments/reactions, cast, passkeys, family, legacy contacts).
Written from the 2026-08-18 audit of the then-current code. **Nothing here
was built yet at the time of writing** — this is the map, recorded before
the work so the schema and sequencing decisions were made once, deliberately.

> **Implementation status (2026-08-27, branch `feature/sharing-public-links`):
> Phases A–D and F are built.** A `43eebc5` (schema foundation, D48), B
> `44733f8` (authz seam, D49), C `8604287` (collaborator sharing, D50), D
> `4dd62b2` (public links, D51), F=§4.5/§4.1a `807c864` (albums web hosting,
> D52). Phase E remains pending. The plan text below is kept as written;
> each phase carries an **Outcome** note recording where reality diverged —
> the full judgment calls live in DECISIONS.md D48–D52. Sections §5 and §6
> were added post-build.
>
> **Phase H (deployment controls, 2026-08-27, same branch): H1 `09e54a9`
> (invite-gated signup + per-user quotas, D54), H2 `6f24912` (BYO storage
> pools, D55).** Off-plan and off-parity by design — museum has neither.
> §7 below records the design discussion and why Option 1 was chosen.

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

> **Outcome (D48, `43eebc5`).** Option 2 taken as recommended — reverse
> partitions, `PUBTOKEN#` GetItem, no `gsi4` — plus a rollback rule the plan
> didn't have: new row types set NO gsi attributes, so pre-sharing code
> ignores them by construction (guard-tested). Two divergences from the text
> above: the DB port **already had** a transaction primitive (`transactWrite`)
> — only the 100-op ceiling guard was added, so the "port + both-adapters
> change" was far cheaper than budgeted; and "hashed at rest" was **partially
> reversed** in Phase D (D51) — museum re-emits the full token-bearing URL in
> `publicURLs`, so the plaintext is stored as an attribute on the hash-keyed
> row, the exact session-token discipline.

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

> **Outcome (D49, `44733f8`).** `resolveCollectionAccess` ports museum's
> access controller check-for-check. But two of the three "landmines" turned
> out to be the plan's audit being wrong about museum, not baked-in bugs:
> **`/files/info` stayed strict-ownership** (museum's GetFileInfo gates on
> VerifyFileOwner — there is no filter-to-accessible; capture-gated), and
> **file commit stays owner-only** (museum: "Creating a file requires
> collection ownership" — collaborators commit into their own collection and
> `/collections/add-files`). `removeFilesV3` got museum's real permission
> matrix, test rewritten in the same commit as planned. Deliberate,
> capture-gated divergence: non-members read 403 here where museum 404s.

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

> **Outcome (D50, `8604287`).** Query-time merge, as recommended — fan-out
> never became necessary. share/unshare/leave/sharees are live with the
> sharee feed field-for-field off museum's scan (wrapped key without nonce,
> real owner email, withheld private magicMetadata); unshare is a per-user
> `SHAREDTOMB#` row (§4.4's design, verbatim); leave removes the leaver's own
> files; delete/account cascades are centralized per §4.6. Role menu is
> VIEWER|COLLABORATOR (ADMIN 400s — nothing here can mint an ADMIN row).
> The tombstone wire shape, `sharedAt`, and several edge behaviours are
> capture-gated — the list is in D50.

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

> **Outcome (D51, `4dd62b2`).** All three halves built: share-url CRUD +
> join-link, 10 `/public-collection/*` routes behind the access-token
> middleware (museum's error bodies verbatim), collect with attribution
> flipped to the link owner, plus the §4.1 abuse controls (verify-password
> attempt caps, per-link daily download/upload ceilings, short public
> presigns) and the JWT primitive (`src/lib/jwt.ts`, signing key derived from
> HASHING_KEY — no second secret). Divergences: **`enableDownload: false` is
> enforced server-side here (403 on originals) where museum does not enforce
> the flag at all** — a deliberate hardening divergence, and still
> access-control-not-DRM exactly as §3.2 warned; **report-abuse was NOT
> implemented** because the route no longer exists upstream (the plan's
> "23-route" count included it); public HLS `video-data` fetch is deferred
> (404, the albums app degrades to original download). Not stubbed-empty
> anywhere: unimplemented public routes 404 (§4.5's rule).

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

> **Outcome.** Phase E is the part that remains pending — nothing in this
> table is built. The token spine, public middleware, and JWT primitive it
> rides on now exist (D48/D51), so the "what it reuses" column is real.
> Queued as future items in NEXT-TASKS.md.

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
   > **Outcome (D51/D52).** (b)–(e) landed as written. (a) landed weaker
   > than planned: **the D47 FREE pricing plan cannot path-scope a rate
   > rule** (that needs a byte-match scope-down, exactly the feature the
   > FREE tier gates), so `/public-collection/*` rides the API
   > distribution's unscoped 2000/5min/IP rule and the tighter bounds stay
   > app-level and per-link. Restore a 300/5min scoped rule only if the plan
   > is ever cancelled back to pay-as-you-go.
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
   > **Outcome (D52, `807c864` — this became Phase F).** Pinned:
   > `photos-v1.3.61` in ORACLE-VERSION + the Makefile's `ALBUMS_WEB_TAG`
   > (guard asserts they agree); hosting + build/deploy pipeline in §6
   > below. The manual open-a-real-link checklist is the outstanding
   > release gate (NEXT-TASKS.md). Unimplemented public routes 404, as
   > prescribed.
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

---

## 5. Backward compatibility & migration safety (post-build, 2026-08-27)

What Phases A–D and F did to a table and clients that predate them — the
answer is "nothing", by construction:

- **Additive-only rows, no migration.** Every new row type (sharee pairs,
  `SHAREDTOMB#` tombstones, `PUBTOKEN#` links and their `DEVICE#`/counter
  children, `COL#…/LINK` pointers) is a new PK/SK shape in the existing
  table. No existing row was rewritten, no backfill ran, no index was added
  — a pre-sharing deployment upgrades by shipping new Lambda code and
  nothing else.
- **Rollback-safe via the no-gsi-attributes rule (D48).** New row types set
  NO gsi1/gsi2/gsi3 attributes, and the GSIs are sparse — so code deployed
  from `main` against a table that already contains sharing rows behaves
  exactly as before the branch: every pre-sharing query path is blind to the
  new rows. Enforced by the rollback-rule test in
  `test/unit/sharing.test.ts` and re-asserted for each row type D51 added.
- **The three deletion-adjacent risk zones are now guard-tested** (§3
  caveat 6's fear, discharged): `deleteCollectionV3` trashes only
  owner-owned files and merely unlinks sharee-owned ones (the pre-D50 code
  would have trashed a collaborator's file into the owner's trash), account
  deletion (`reapUserData`) revokes shares in both directions and disables
  links on every owned collection, and links are disabled BEFORE the
  collection tombstones so no window serves a dead album. TTL on link rows
  is backstop only — middleware stays the enforcement, and disabled rows
  have their `ttl` stripped so dead tokens answer 410 forever, never a
  reaped 401.
- **One operational caveat — the ALBUMS_URL Lambda roll.** Links are minted
  as `<ALBUMS_URL>/?t=<token>`. Any link minted before the web
  distribution's URL reaches the Lambda env (first Phase-F deploy, or any
  later `albums_url` change) embeds the config default and points at the
  wrong host. The tokens stay valid — re-copy each affected link from the
  app; nothing needs re-minting server-side.

---

## 6. Web deployment (Phase F, D52; consolidated D58)

The albums viewer hosting that Phase D's links point at. Full operator steps
in INSTALL.md C13; resource detail in AWS-RESOURCES.md rows 22–27.

- **The SAME CloudFront distribution as the API** (D58 — this section
  originally specified a second distribution; the FREE pricing plan's
  3-distributions-per-account cap consolidated them): the API rides
  root-path ordered behaviors derived from src/app.ts (guard-tested), the
  default behavior serves a fully private bucket (OAC, public-access-block
  ×4, SPA fallback via a viewer-request CloudFront function — never
  `custom_error_response`, which would corrupt the API's museum-shaped
  404/403 JSON). Share links are `https://<server_url domain>/?t=<token>`.
  The bucket holds build artifacts only: `force_destroy`, no versioning,
  inside `make destroy` scope.
- **Pinned albums build**: ente-io/ente tag `photos-v1.3.61`, recorded in
  ORACLE-VERSION and the Makefile's `ALBUMS_WEB_TAG` (guard asserts both
  agree). `make build-web` sparse-clones the tag and static-exports the app
  with the API URL **baked in at build time** — an API-URL change is a
  rebuild, not a re-sync; `make deploy-web` (guard-account-gated) syncs +
  invalidates the consolidated distribution.
- **Operator order for an existing pre-D58 deployment**: re-paste
  `src/infra/deployer-policy.json` over the deployer's inline policy (the
  CloudFront function actions are new) → the D58 migration cycle in
  INSTALL.md ("Migrating an existing deployment to the consolidated
  distribution") → `make build-web` → `make deploy-web` → mint a share link
  in the app and open it in a browser (the D52 release gate).

---

## 7. Deployment controls & cost delegation — Option 1 (Phase H, D54/D55)

Recorded post-build, 2026-08-27. The ask, off-plan and off-museum-parity:
one operator invites a wider circle (friends, siblings' households) without
paying for their storage or letting signup run open — with **zero
client-visible changes**, so the stock apps keep working untouched.

### The three options considered

1. **Central account + BYO storage pools — CHOSEN.** One control plane
   (DynamoDB, Lambda, CloudFront, SES) in the operator's account; storage
   delegated per household to a bucket that household owns and pays for.
   Everything stays a single deployment — one table, one set of transactions,
   one museum-shaped surface — and the delegation is pure blob routing behind
   presigned URLs, which clients never introspect.
2. **Per-user data plane (per-user DynamoDB in the user's own account) —
   REJECTED on the cross-account-transaction impossibility.** The
   correctness spine of this codebase is `TransactWriteItems` over one
   table: a file commit atomically writes file rows + the owner's usage
   counter + collection links; sharing dual-writes reverse-lookup pairs
   (D48). DynamoDB transactions cannot span accounts (nor could any
   cross-account two-phase substitute be built without inventing a
   distributed-commit protocol this project has no business owning), so
   splitting the table per user forfeits atomicity exactly where it
   matters. Dead on arrival, not merely deferred.
3. **Full federation (each household runs its own deployment) — DEFERRED.**
   Cleanest cost story, but cross-instance sharing needs a shared user
   directory, and that directory becomes the **trust anchor**: whoever runs
   it can substitute public keys during lookup, which is a stronger trust
   grant than "they can see my ciphertext bytes". Deferred, not rejected —
   and the seam is already prepared: the `home` field on invite/user rows
   (D54) is the one-line hook a future multi-home deployment routes by,
   with no migration.

### The pool model (D55, the shape Option 1 landed as)

- **Many users : one bucket.** A pool is one household-owned bucket shared
  by multiple users; object keys stay `<userID>/<uuid>`, so members keep
  their own prefixes. Pool membership grants nothing through authorization
  — access still flows only through shares.
- **File-level pinning.** Commits stamp `storagePoolId` on the file row;
  every read/purge path resolves the bucket from the pin, so re-assigning a
  user affects only new uploads — nothing migrates, nothing strands.
- **Quota precedence**, all one museum-shaped 426: viewer / per-user-0
  blocks first, then the per-user override (D54), then the pool's shared
  cap against the pool usage counter.

### The cost outcome for the central account

The point of the exercise: with storage delegated, the central account keeps
only the control plane — roughly **$1–3/month** (DynamoDB on-demand + PITR,
Lambda/CloudFront/SES inside free tiers or pennies, CloudWatch) — and the
**marginal cost per additional user is cents**: a user's control-plane
footprint is small-JSON API calls and table rows; their bytes, egress and
Glacier retrievals bill to their household's bucket. Invite-gating (D54)
bounds who can create that footprint; per-user quotas and viewer accounts
bound it for anyone still on the central bucket.
