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

## Ground rules (inherited from immich-serverless)

1. Never invent a shape — every handler cites its museum source; where a
   capture later disagrees, the capture wins and this repo gets corrected.
2. One endpoint = one handler file = one test file; shared logic in `domain/`.
3. `make test && make typecheck` green before a task is done.
4. TEST-LEDGER.md is generated, never hand-edited.
5. Divergences from museum live in DECISIONS.md with reasons — not in code comments only.
