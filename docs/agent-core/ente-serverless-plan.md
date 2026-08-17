# ente-serverless — plan
## An ente-compatible (museum) backend, fully serverless, for the stock ente apps

Written 2026-08-16, after Phase 5 of immich-serverless validated on real AWS. Route counts
below were measured from `ente-io/ente@main` (`server/cmd/museum/main.go`), not estimated.
**The executable build plan — full API contract, feature tags, milestones, test gates — is
`ente-serverless-build-plan.md`; this document holds the architecture and rationale.**
Companion evidence: the stock apps upload/download **directly against S3 presigned URLs** —
`GetUploadURLs` in `server/pkg/api/file.go`, the client PUT in
`mobile/apps/photos/lib/module/upload/service/upload_transport.dart`, commit verification by
`HeadObject` in `server/pkg/controller/file.go`.

---

## 1. Why ente instead of (or alongside) immich

One fact changes the whole shape: **museum never touches file bytes.** Clients encrypt
locally, fetch presigned URLs, PUT straight to S3 (multipart for large files), then commit
metadata. The server is a pure JSON control plane over Postgres + S3 presigning.

Consequences for a serverless port:

| Problem in immich-serverless | In ente-serverless |
|---|---|
| 6 MB Lambda ceiling → upload lane, 307 experiment, proxy Fargate | **does not exist** — bytes never pass through compute |
| sharp + ffmpeg in a container image, 3 GB worker | **no media processing at all** — clients make thumbnails and even the HLS video streams, and upload them as objects |
| MediaConvert for transcoding (D25) | not needed — E2EE makes server-side transcoding impossible *by design* |
| Cookie/Authorization forwarding through CloudFront | simple `X-Auth-Token` header |
| Response streaming, Range requests through the API | downloads are also presigned — API returns URLs, S3 serves bytes |

The trade: E2EE cuts the other way too. No server-side search over content, no EXIF
extraction, no fixing thumbnails server-side; the client is authoritative for all derived
data. And compatibility is with a fast-moving client, so the oracle must be version-pinned.

## 2. The API surface, measured

301 routes across 11 router groups in museum (`main.go`):

| Router group | Routes | What it is | Needed for stock photos app? |
|---|---|---|---|
| `storageAPI` (auth'd, storage-adjacent) | 111 | files (34), collections (27+3), contacts (12), cast (7), user-entity (7), comments/reactions/social (9+2), memory-share (4), trash (3), attachments (2), users (1) | core + social features |
| `privateAPI` (auth'd) | 68 | users/sessions (26), emergency-contacts (11), legacy-kits (8), authenticator (6), billing (6), remote-store (4), storage-bonus (4), family/push/events (3) | core + stubs |
| `publicAPI` (unauth) | 39 | users/SRP/OTT (14), legacy-kits (6), billing (5), cast (3), paste (3), family (2), misc (6) | auth flow + stubs |
| `adminAPI` | 25 | admin CLI | **no** — operator tooling |
| `publicCollectionAPI` | 23 | public album links (view + guest upload) | link sharing |
| `publicMemoryAPI` | 8 | shared memories | sharing extra |
| `fileLinkApi` | 7 | public single-file links | sharing extra |
| `familyAuthAPI` | 6 | family plans | stub for self-host |
| `castAPI` | 6 | TV cast receiver | cast feature |
| `accountsJwtAuthAPI` | 5 | passkeys | 2FA extra |
| `paymentJwtAuthAPI` | 3 | Stripe webhooks | **no** — self-host is free |

**Compatibility tiers:**

- **Tier 0 — backup-and-browse loop, ~60 routes.** Sign-up/login (OTT email + SRP-6a:
  `/users/ott`, `/users/verify-email`, `/users/srp/attributes|create-session|verify-session|setup|complete`),
  key attributes + sessions (~12 of `privateAPI /users`), upload
  (`/files/upload-urls`, `/files/multipart-upload-urls`, `POST /files` commit with HeadObject
  verification, `PUT /files/update`, thumbnail + download URL routes), collections CRUD +
  membership, the three sync spines (`/collections/v2/diff`, `/trash/v2/diff`,
  `/user-entity/entity/diff`), trash (`/files/trash`, `/trash/delete`, `/trash/empty`),
  and the plumbing the app probes: `/ping`, `/remote-store` feature flags, billing
  subscription stub (self-host answers "free, huge quota"), `/push/token` accept-and-drop.
- **Tier 1 — daily driver, ~150 routes.** + magic metadata (per-file and per-collection),
  collection sharing, public links (create/manage on `storageAPI`, serve on
  `publicCollectionAPI`), memories, `files/data` (client-computed ML embeddings sync) and
  `files/video-data` (client-generated HLS), storage-bonus/referral stubs, family stubs.
- **Tier 2 — complete client-facing compatibility, 270 routes.** Everything except
  `adminAPI` (25) and `authenticator` (6). The authenticator group is 6 more routes and makes
  the separate ente Auth app work — cheap bonus if wanted.

## 3. Serverless architecture (maps almost 1:1 onto what Phase 5 built)

```
CloudFront ── API Lambda (hono, Function URL auth NONE — the proven pattern)
                 │        DynamoDB single-table (users, sessions, SRP verifiers,
                 │        files, collections, diff feeds keyed by updatedAt — the
                 │        gsi3-style change feed pattern carries over directly)
                 │
                 ├── presigns PUT/GET ──►  S3 objects bucket   ◄── clients PUT/GET bytes
                 │                         (encrypted blobs: file, thumb, file-data;
                 │                          key = userID/uuid, client-opaque)
                 └── SES (OTT emails)      lifecycle: abort-MPU; NO delete grants except
                                           the trash-purge cron's scoped role
EventBridge crons: trash purge (30d), deferred account deletion, stale-MPU/objects sweep
DynamoDB TTL: OTTs, sessions, tokens
```

- **No worker Lambda, no container image requirement at all** — nothing needs sharp/ffmpeg;
  plain zip bundles suffice (or keep the container pattern for parity with tooling).
- **Uploads**: `upload-urls` returns presigned PUTs (50 max per request, mirroring museum);
  multipart URLs for large files; commit does parallel HeadObject size verification exactly
  like museum. S3-native, no LocalStack incompatibilities.
- **Downloads/thumbnails**: return presigned GETs (museum's download routes redirect /
  return URLs; match observed behaviour, don't guess).
- **Deep Archive does NOT fit here**: clients re-download originals to view full-res (E2EE
  means no server-side rendition can substitute). Originals live in Standard/IA;
  the immich-style cold-storage thesis needs rethinking against real access patterns —
  measure first, tier later.
- **Web app + CORS**: the web client PUTs to S3 from the browser — bucket CORS must allow
  `X-Auth-Token`, `X-Client-Package`, `X-Client-Version`, `UPLOAD-URL`, `Content-MD5`
  (from ente's own self-hosting docs).

## 4. What carries over from immich-serverless, verbatim

- **Method**: oracle-first. Museum self-hosts in one docker compose (their quickstart) —
  run it as the contract oracle, capture every response, `capture-diff` against ours.
  Fixture beats schema; never invent a shape. Pin the oracle to one museum release AND one
  app APK version; record divergences with evidence.
- **Infra**: the whole `infra-tofu/` layout — data module (DynamoDB + buckets +
  prevent_destroy), compute (Lambda + Function URL auth NONE), edge (CloudFront, no OAC —
  that finding transfers as-is), deployer policy pattern, budget-in-extras.
- **Ground rules**: one endpoint = one handler = one test file; adapters + memory ports so
  everything runs without AWS; LocalStack for integration.

## 5. New hard parts (none involve bytes)

1. **SRP-6a login** — museum uses SRP (RFC 5054 group), stored verifiers, and libsodium
   argon2id happens client-side. Implement against a JS SRP library (e.g. tssrp6a) and
   validate against the live oracle with the real app. This is THE compatibility risk;
   do it first, not last.
2. **Diff-feed semantics** — `/collections/v2/diff` + `/trash/v2/diff` pagination,
   tombstones, and `updationTime` ordering must match exactly (same class of problem as
   immich's sync stream — solved the same way: capture, don't guess).
3. **Billing/feature stubs** — the app expects coherent answers about subscription state,
   storage quota, feature flags (`remote-store`). Self-hosted museum already models this;
   copy its answers.
4. **Client version coupling** — ente ships weekly; new routes appear. Mitigation: pin the
   tested APK, run capture-diff against each museum tag before adopting it.

## 6. Phasing (oracle-driven, same discipline as immich phases 0–5)

- **P0** — museum oracle up in docker; capture auth + upload + diff flows from the real app
  (mitmproxy or museum request logs); write the contract notes.
- **P1** — Tier 0 (~60 routes) against LocalStack + memory adapters; stock app completes
  sign-up → backup → browse → trash loop locally.
- **P2** — cloud validation on the existing tofu pattern (this repo's Phase 5, replayed —
  budget/deploy/validate; presigned uploads mean no upload-lane phase exists).
- **P3** — Tier 1 (sharing, public links, memories, file-data/video-data).
- **P4** — Tier 2 completeness sweep + the 6 authenticator routes; capture-diff green
  across the board.

## 7. Archival and retrieval (stock app, zero client changes)

> **Decision 2026-08-16: build with Glacier Instant Retrieval ONLY** — originals transition
> to GIR at day 0, thumbs/file-data stay Standard, no Deep Archive, no restore workflow.
> Verified client behaviour (below) showed image opens fetch originals, so seamlessness wins;
> archival economics get revisited with real access data. The DA analysis below is kept as
> the record for that revisit. Execution detail lives in `ente-serverless-build-plan.md`.

Each file is three client-encrypted objects: original, thumbnail, video preview/HLS. Only
originals go cold; thumbs and previews stay hot.

**Verified client behaviour (web `gallery/services/download-core.ts`, 2026-08-16):** opening
an IMAGE full-screen fetches the **original** (no intermediate size — `img_preview` exists as
a server-side ObjectType in `ente/file.go` but no photos client generates or fetches it, and
no remote-store flag controls it). Opening a VIDEO plays the hot HLS `vid_preview`; the
original is only fetched on download/export. So the desired thumb→large→original split is
stock behaviour **for videos only**; for images, full-screen open = original fetch, and E2EE
means the server cannot substitute a smaller variant (it cannot encrypt one with the file
key). Consequence: image originals must stay warm for the whole active-viewing horizon;
DA is for the deep tail where thumbnail-degradation + email restore is acceptable. Video
originals (the bulk of most libraries' bytes) can be archived aggressively from day one.

**E2EE kills the immich restore-UX trick**: the server cannot rename albums or rewrite
descriptions — it cannot write a single user-visible word into the app. Remaining channels:
the API itself (every full-res fetch passes through `/files/download/:fileID` — the
tripwire), email (login identity, not E2EE'd), and optionally a shared "status album" owned
by a server-side bot account (sharing encrypts a collection key to the user's PUBLIC key,
which the server has — the stock app renders it natively).

**Touch-to-restore flow**: download request for an archived original → HeadObject → fire
`RestoreObject` (Days=7) + `RESTORE#` dedupe row + one batched email with the ETA → the app
meanwhile degrades to the thumbnail it already has. `s3:ObjectRestore:Completed` →
EventBridge → "ready until <date>" email (+ status album). The restored copy expires by
itself — no re-archive job, no delete grants. Bulk export goes through a separate status
webpage with bulk-tier restores.

**Policy**: originals Standard → Glacier Instant (~90 d, ms retrieval, no workflow) →
Deep Archive (~2–3 y, $1/TB-mo, 12 h restore). No tar bundling (per-object presigned GETs
are the protocol); never archive thumbs/previews; archive only past the trash window + 180 d
minimum-duration margin. MVP option: GIR-only (fully seamless) and add DA once the event
plumbing exists.

## 8. Open questions (decide with evidence, not upfront)

- Which museum tag + app version pair to pin as the contract baseline.
- Whether the web photos app (also self-hostable, static) gets hosted from the same stack
  (S3+CloudFront) — likely trivial, but out of MVP scope.
- Storage class strategy for encrypted originals given real re-download frequency.
- Whether immich-serverless and ente-serverless share the tofu modules as one repo family
  (likely: data/compute/edge modules are already app-agnostic).
