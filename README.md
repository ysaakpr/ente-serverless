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
CloudFront ── API Lambda (hono, Function URL auth NONE) ── DynamoDB single table
                 │                                          (gsi1 collection diff,
                 ├── presigned PUT/GET ─► S3 objects bucket  gsi2 collection feed,
                 │      (clients move ALL bytes)             gsi3 tokens/trash/entity/fd)
                 ├── SES (OTT mail)
                 └── EventBridge cron: trash purge (30 d); OTTs expire via DynamoDB TTL
```

Storage classes (GIR-only decision, 2026-08-16): originals → GLACIER_IR at
day 0 via the `tier=original` object tag (applied at commit — museum's key
layout makes a prefix rule impossible); thumbnails and file-data stay
Standard; **no Deep Archive, no restore workflow** (guard-tested).

## Layout

```
src/                the server: one endpoint = one handler file
  handlers/         health, users, srp, files, collections, trash, entity, filedata, stubs
  domain/           shared logic (srp math, diffs, trash, tokens, quotas)
  ports/ adapters/  db/blobs/mail/clock ports; memory (unit) + AWS (LocalStack/prod)
  workers/          trashPurge (EventBridge cron)
  infra/            OpenTofu — data/compute/edge modules, dev env, deployer-policy.json
test/unit           117 scenarios incl. the M1–M4 gate scripts
test/integration    LocalStack end-to-end (real presigned HTTP, SES, SRP)
test/infra          plan-time lifecycle/storage-class guards
tools/              ledger generator, capture-diff harness (skeleton)
```

The infra living under `src/infra` (not a top-level `infra/`) was requested at
project creation; the tofu never imports TS and vice versa.

## Running it

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
infra guards. Pending, in order: pin the museum oracle tag → capture runs →
capture-diff parity (D2), the stock-app LAN gate (M5, needs a device), first
cloud deploy (M7, excluded from the build session), remaining [ACCOUNT]
routes (capture-first, M7 completeness pass).

## Feature report — implemented vs museum parity

Museum exposes 301 routes across 11 router groups (see
`docs/agent-core/ente-serverless-plan.md` §2). This repo currently covers
**Tier 0 (the single-user backup-and-browse loop) plus the Tier 1 file-data
pieces** — roughly the ~60-route core plus magic metadata and
`files/data`/`files/video-data`.

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
| Hardening | 🟢 Done | origin lock, attempt caps/TTLs, spend ceilings, quota checks, GIR-at-day-0 storage tiering | — |
| Billing | 🟠 Stubbed | free plan, huge quota (`/billing/*`, D34) | Tier 0 |
| Remote store / feature flags | 🟠 Stubbed | fixed flags; `castUrl`/`embedUrl` empty | Tier 0 |
| Storage bonus / referrals | 🟠 Stubbed | zeros | Tier 1 |
| Push tokens, event reporting | 🟠 Stubbed | accept-and-drop | Tier 0 |
| Social sync probes | 🟠 Stubbed | empty feeds: comments-reactions, collection-actions, contacts diff (D27) | Tier 2 |
| Emergency contacts | 🟠 Stubbed | `info` returns empty (D35) | Tier 2 |
| Album collaborators / viewers | ⚪ Pending | `/collections/share`, `unshare`, `leave`, `join-link`, sharees list, VIEWER/COLLABORATOR roles, per-sharee wrapped keys, sharee diff/download access | Tier 1 (P3) |
| Public album links | ⚪ Pending | `share-url` create/update/delete + the 23-route `publicCollectionAPI` (info, diff, verify-password, guest-upload/collect, report-abuse, device limits, expiry) | Tier 1 (P3) |
| Public single-file links | ⚪ Pending | `fileLinkApi` (7 routes) | Tier 1+ |
| Shared memories | ⚪ Pending | memories + `publicMemoryAPI` (8 routes) | Tier 1 (P3) |
| Contacts | ⚪ Pending | real contacts (12 routes; only the empty diff probe exists) | Tier 2 |
| Comments / reactions | ⚪ Pending | real social (11 routes; only empty probes exist) | Tier 2 |
| Cast (TV) | ⚪ Pending | `castAPI` + storage-side cast routes | Tier 2 |
| Passkeys | ⚪ Pending | `accountsJwtAuthAPI` (5 routes) | Tier 2 |
| Family plans | ⚪ Pending | real family API (stub-level answers only) | Tier 2 |
| Legacy / trusted contacts | ⚪ Pending | legacy-kits (14 routes), emergency-contacts beyond the info stub | Tier 2 |
| Admin API, Stripe webhooks | Out of scope | operator tooling / self-host is free — deliberate exclusion | — |

Notes on the two headline Pending rows (2026-08-18 audit): every collection
path today is hard-gated to the owner (`getOwnedCollection`,
`getAccessibleFile`) and the collection JSON hardcodes
`sharees: null, publicURLs: null`, so clients show sharing as unconfigured
and share attempts 404. All three DynamoDB GSIs are already allocated, so
sharing ("collections shared with me") and public links (token → collection
lookup) need a schema decision, not just handlers. `removeFilesV3`'s
owner-file 400 branch and `/files/info`'s strict-ownership check are baked-in
owner-only assumptions to rework when sharing lands. `/public-collection/*`
must NOT be stubbed empty — an empty diff on a real link is indistinguishable
from a broken one (D27's reasoning doesn't extend there).

## Ground rules (inherited from immich-serverless)

1. Never invent a shape — every handler cites its museum source; where a
   capture later disagrees, the capture wins and this repo gets corrected.
2. One endpoint = one handler file = one test file; shared logic in `domain/`.
3. `make test && make typecheck` green before a task is done.
4. TEST-LEDGER.md is generated, never hand-edited.
5. Divergences from museum live in DECISIONS.md with reasons — not in code comments only.
