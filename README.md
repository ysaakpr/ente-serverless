# ente-serverless

An **ente-compatible (museum) backend on serverless AWS**. Point the stock ente
Photos app at it (7-tap custom endpoint) and your encrypted photos live in your
own S3 account at object-storage prices. Clean-room implementation of museum's
API, shapes pinned against `ente-io/ente` server source (paths cited per
handler); oracle capture-parity is the next gate (see DECISIONS.md D2).

Not affiliated with ente. Built from the plan in
`docs/agent-core/ente-serverless-build-plan.md`.

## Why this exists (vs immich-serverless)

Museum never touches file bytes: clients encrypt locally, PUT/GET straight to
S3 via presigned URLs, and the server is a pure JSON control plane. That
erases every hard problem immich-serverless had to solve (6 MB Lambda ceiling,
sharp/ffmpeg containers, upload lanes) — a plain zip Lambda + DynamoDB +
presigned S3 is the whole backend.

## Architecture

```
CloudFront (ONE distribution, 2 behaviors — FREE-plan limit is 5, D58/D60)
  ├─ default ─► API Lambda (hono, Function URL auth NONE) ── DynamoDB single table
  │  (all API │                                          (gsi1 collection diff,
  │   routes) ├── presigned PUT/GET ─► S3 objects bucket  gsi2 collection feed,
  │           │      (clients move ALL bytes)             gsi3 tokens/trash/entity/fd)
  │           ├── SES (OTT mail)
  │           └── EventBridge cron: trash purge (30 d); OTTs expire via DynamoDB TTL
  └─ /albums* ─► S3 web bucket (OAC, private, albums/ prefix) — the pinned albums
                 viewer built with basePath=/albums (SPA via CloudFront function);
                 share links are <server_url>/albums/?t=<token> (D52/D58/D60)
```

With BYO storage pools (D55) a presigned URL may point at a per-pool household
bucket instead of the central objects bucket — each file row pins the pool its
bytes landed in.

Storage classes (GIR-only decision, 2026-08-16; transition days D59):
originals → GLACIER_IR after `gir_transition_days` (configurable, default 7 —
fresh uploads are the most-viewed, and a day-0 transition billed $0.03/GB GIR
retrieval on exactly those views) via the `tier=original` object tag (applied
at commit — museum's key layout makes a prefix rule impossible); thumbnails
and file-data stay Standard; **no Deep Archive, no restore workflow**
(guard-tested).

## Layout

```
src/                the server: one endpoint = one handler file
  handlers/         health, users, srp, files, collections, trash, entity, filedata, public, stubs
  domain/           shared logic (srp math, diffs, trash, tokens, quotas, sharing)
  ports/ adapters/  db/blobs/mail/clock ports; memory (unit) + AWS (LocalStack/prod)
  workers/          trashPurge (EventBridge cron)
  infra/            OpenTofu — data/compute/edge modules, dev + test envs, deployer-policy.json
test/unit           356 scenarios incl. the M1–M4 gate scripts
test/integration    LocalStack end-to-end (real presigned HTTP, SES, SRP)
test/infra          plan-time lifecycle/storage-class guards
tools/              ledger generator, capture-diff harness (skeleton), operator
                    CLIs (invite.ts D54, storagePool.ts D55)
```

The infra living under `src/infra` (not a top-level `infra/`) was requested at
project creation; the tofu never imports TS and vice versa.

## Running it

Full step-by-step setup lives in **[INSTALL.md](INSTALL.md)** — local
development on LocalStack, pointing the stock ente app at the server on your
LAN, and the AWS deployment with OpenTofu. Quick reference:

```bash
npm install
make test          # unit suites — no docker needed
make up            # LocalStack (DynamoDB, S3, SES) on :4567
make test-int      # integration on LocalStack
make infra-test    # tofu guard tests
make typecheck
make dev           # bootstrap LocalStack + run the API on :8080
make ledger        # regenerate TEST-LEDGER.md from vitest output
make build-lambda  # esbuild zips for the tofu compute module
make build-web     # clone + static-export the pinned albums viewer (ALBUMS_WEB_TAG)
make deploy-web    # sync the albums build to the web bucket + CF invalidation
make invites       # operator CLI, D54 — also: invite / revoke-invite / set-storage
make pools         # operator CLI, D55 — also: pool-create / pool-attach /
                   #   pool-detach / pool-set-quota / pool-disable / pool-enable
```

Deploy (dev, NOT yet performed — session scope excluded it):

```bash
make build-lambda
cd src/infra/dev
tofu init && tofu apply \
  -var hashing_key="$(openssl rand -base64 32)" \
  -var mail_from="verified-identity@your-domain"
# point the app at the server_url output
```

## Status — see TEST-LEDGER.md (generated) and DECISIONS.md (the honest list)

Milestones M1–M6 implemented and green on unit + LocalStack integration +
infra guards; P3 sharing (album collaborators + public links, plan Phases
A–D and F, D48–D52) implemented on `feature/sharing-public-links`, plus the
Option-1 deployment controls (invite-gated signup, per-user quotas, BYO
storage pools — H1/H2, D54/D55, plan §7). Pending,
in order: capture runs → capture-diff parity (D2, now also covering the
sharing/public surfaces), the stock-app LAN gate (M5, needs a device; re-run
with a shared album), first cloud deploy (M7, excluded from the build
session) + the manual albums-link browser gate (D52), remaining [ACCOUNT]
routes (capture-first, M7 completeness pass).

## Feature report — implemented vs museum parity

Museum exposes 301 routes across 11 router groups (see
`docs/agent-core/ente-serverless-plan.md` §2). This repo currently covers
**Tier 0 (the single-user backup-and-browse loop) plus the Tier 1 file-data
and sharing pieces** — roughly the ~60-route core plus magic metadata,
`files/data`/`files/video-data`, collection sharing, and public album links
(share-url CRUD + 10 of the `publicCollectionAPI` routes).

> **Status meanings** — 🟢 **Done**: real implementation, museum-shaped,
> tested. 🟠 **Stubbed**: a coherent fixed answer so the stock app boots and
> syncs, but the feature is intentionally inert (no storage, no behaviour
> behind it). ⚪ **Pending**: not implemented at all — the routes 404 and
> clients render the feature as unconfigured; these are the gap to
> full-client parity.

| Feature | Status | Routes / notes | Plan tier |
|---|---|---|---|
| Auth — OTT email | 🟢 Done | `/users/ott`, `/users/verify-email` | Tier 0 |
| Auth — SRP-6a | 🟢 Done | attributes, setup, complete, create/verify-session, update | Tier 0 |
| Auth — TOTP 2FA | 🟢 Done | setup, enable, disable, verify, recover, remove; recovery key; email-MFA toggle | Tier 0 |
| Sessions | 🟢 Done | session-validity/v2, logout, list + terminate sessions | Tier 0 |
| Account | 🟢 Done | attributes, details/v2, change-email, public-key lookup, accounts-token, delete (challenge + delete) | Tier 0 |
| Upload | 🟢 Done | upload-urls, multipart, upload-url v2, eligibility, `POST /files` commit (HeadObject-verified), update, thumbnail | Tier 0 |
| File read | 🟢 Done | download v1/v2/v3, preview/thumbnail v2/v3, info, size — presigned S3 GETs | Tier 0 |
| File metadata | 🟢 Done | per-file magic + public-magic metadata | Tier 1 |
| Collections (owner-only) | 🟢 Done | create, list v2, diff v2, add/move/restore/remove-files, rename, magic + pub-magic metadata, delete v3, get-by-id | Tier 0 |
| Sync spines | 🟢 Done | `/collections/v2/diff`, `/trash/v2/diff`, `/user-entity/entity/diff` | Tier 0 |
| Trash | 🟢 Done | trash, diff v2, delete, empty; 30-day purge cron | Tier 0 |
| User entities | 🟢 Done | key create/ensure/get, entity CRUD + diff | Tier 0 |
| File-data | 🟢 Done | `files/data` (ML embeddings), `files/video-data` (HLS), preview upload/fetch, status-diff | Tier 1 |
| Hardening | 🟢 Done | origin lock, attempt caps/TTLs, spend ceilings, quota checks, GIR storage tiering (day 7, D59) | — |
| Deployment controls (off-parity, ops-only) | 🟢 Done | deliberate operator-side features, zero client-visible shape changes (D54/D55): `SIGNUP_MODE=invite` gating, viewer accounts, per-user quotas (`make invite`/`invites`/`revoke-invite`/`set-storage`); BYO storage pools — one household bucket, many users (`make pool-create`/`pool-attach`/`pool-detach`/`pools`/`pool-set-quota`/`pool-disable`); capture-diff runs with both off | — |
| Billing | 🟠 Stubbed | free plan, huge quota (`/billing/*`, D34) | Tier 0 |
| Remote store / feature flags | 🟠 Stubbed | fixed flags; `castUrl`/`embedUrl` empty | Tier 0 |
| Storage bonus / referrals | 🟠 Stubbed | zeros | Tier 1 |
| Push tokens, event reporting | 🟠 Stubbed | accept-and-drop | Tier 0 |
| Social sync probes | 🟠 Stubbed | empty feeds: comments-reactions, collection-actions, contacts diff (D27) | Tier 2 |
| Emergency contacts | 🟠 Stubbed | `info` returns empty (D35) | Tier 2 |
| Album collaborators / viewers | 🟢 Done | `/collections/share`, `unshare`, `leave`, sharees list; VIEWER/COLLABORATOR roles, per-sharee wrapped keys, sharee sync feed + per-user unshare tombstones (D49/D50); capture-gated items pending oracle parity | Tier 1 (P3) |
| Public album links | 🟢 Done (gate pending) | `share-url` create/update/delete, `join-link`, the `/public-collection/*` surface (info, diff, verify-password, previews/downloads, collect uploads), password links, device limits, per-link daily ceilings (D51); the manual open-a-real-link-in-the-pinned-albums-build gate (D52) is still outstanding. Deliberately absent: report-abuse (removed upstream), public HLS video-data (deferred) | Tier 1 (P3) |
| Public single-file links | ⚪ Pending | `fileLinkApi` (7 routes) | Tier 1+ |
| Shared memories | ⚪ Pending | memories + `publicMemoryAPI` (8 routes) | Tier 1 (P3) |
| Contacts | ⚪ Pending | real contacts (12 routes; only the empty diff probe exists) | Tier 2 |
| Comments / reactions | ⚪ Pending | real social (11 routes; only empty probes exist) | Tier 2 |
| Cast (TV) | ⚪ Pending | `castAPI` + storage-side cast routes | Tier 2 |
| Passkeys | ⚪ Pending | `accountsJwtAuthAPI` (5 routes) | Tier 2 |
| Family plans | ⚪ Pending | real family API (stub-level answers only) | Tier 2 |
| Legacy / trusted contacts | ⚪ Pending | legacy-kits (14 routes), emergency-contacts beyond the info stub | Tier 2 |
| Admin API, Stripe webhooks | Out of scope | operator tooling / self-host is free — deliberate exclusion | — |

The holistic build plan for the Pending rows — phasing, schema decisions,
caveats, and their mitigations — lives in
**[PENDING-FEATURES-PLAN.md](PENDING-FEATURES-PLAN.md)**.

Notes on the two headline rows (2026-08-27, implemented on
`feature/sharing-public-links`): the 2026-08-18 audit's blockers are gone —
collection access is role-resolved (`resolveCollectionAccess`, D49),
`sharees`/`publicURLs` are real data, and the schema landed as explicit
reverse-lookup partitions with no new GSI and a rollback-safe
no-gsi-attributes rule (D48). What still stands between the rows and museum
parity: the capture-diff run over the new surfaces (the capture-gated calls
listed in D49–D51 — non-member 403-vs-404, tombstone shape, `sharedAt`, ADMIN
role, deleted-collection semantics, …), the LAN gate re-run with a shared
album, and the manual open-a-real-link-in-the-pinned-albums-build check
(D52) — the release gates in NEXT-TASKS.md. `/public-collection/*` routes
without an implementation still 404, never hollow 200s (an empty diff on a
real link is indistinguishable from a broken one — D27's reasoning doesn't
extend there).

## Ground rules (inherited from immich-serverless)

1. Never invent a shape — every handler cites its museum source; where a
   capture later disagrees, the capture wins and this repo gets corrected.
2. One endpoint = one handler file = one test file; shared logic in `domain/`.
3. `make test && make typecheck` green before a task is done.
4. TEST-LEDGER.md is generated, never hand-edited.
5. Divergences from museum live in DECISIONS.md with reasons — not in code comments only.
