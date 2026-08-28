# INSTALL — ente-serverless, step by step

This guide takes you from a bare machine to a running deployment. It covers
three paths, in increasing order of commitment:

- **[Part A — Local development](#part-a--local-development-localstack)**: run the server and the full test
  suite on your machine with LocalStack. No AWS account needed.
- **[Part B — Phone on the LAN](#part-b--test-with-the-real-ente-app-on-your-lan)**: point the stock ente Photos app at the
  server running on your Mac. Still no AWS account.
- **[Part C — AWS deployment](#part-c--deploy-to-aws)**: the real thing — Lambda, DynamoDB, S3,
  CloudFront — deployed with OpenTofu.

Once deployed, **[Inviting users & storage
pools](#inviting-users--storage-pools)** covers the optional operator
features: invite-gated signup, per-user quotas, and BYO pool buckets.

Companion documents: [AWS-RESOURCES.md](AWS-RESOURCES.md) (every resource the
deploy creates, risks, cost model), [RUNBOOK-M5.md](RUNBOOK-M5.md) (the LAN
gate in detail), [DECISIONS.md](DECISIONS.md) (why things are the way they are).

---

## Prerequisites

| Tool | Version | Needed for | Check |
|---|---|---|---|
| Node.js | **≥ 22.7** (runs TS via `--experimental-transform-types`) | everything | `node --version` |
| npm | comes with Node | everything | `npm --version` |
| GNU make | any | everything | `make --version` |
| Docker + Compose | any recent | Parts A & B (LocalStack) | `docker compose version` |
| OpenTofu | ≥ 1.12 | Part C | `tofu version` |
| AWS CLI | v2 | Part C | `aws --version` |
| openssl | any | Part C (`hashing_key`) | `openssl version` |

Install on macOS:

```bash
brew install node opentofu awscli
```

Docker Desktop (or OrbStack/colima) must be running for Parts A and B.

---

## Part A — Local development (LocalStack)

Everything here runs against LocalStack on port **4567**. No AWS account, no
credentials — the Makefile injects dummy keys.

### A1. Clone and install

```bash
git clone <this-repo> ente-serverless
cd ente-serverless
npm install
```

### A2. Run the unit tests (no Docker needed)

```bash
make test
```

Expected: all suites green (356 scenarios, including the M1–M4 gate scripts).

```bash
make typecheck
```

Expected: `tsc` exits clean with no output.

### A3. Start LocalStack

```bash
make up
```

This starts `localstack/localstack:3` with DynamoDB, S3 and SES, mapped to
`127.0.0.1:4567`, and waits for its healthcheck. Verify:

```bash
curl -s http://127.0.0.1:4567/_localstack/health
```

### A4. Run the integration tests

```bash
make test-int
```

These exercise real presigned HTTP uploads, SES mail capture, and the full SRP
flow against LocalStack. Expected: green.

### A5. Run the API locally

```bash
make dev
```

This first runs `scripts/bootstrap-local.ts` (creates the `ente-serverless`
table and `ente-objects` bucket in LocalStack, verifies the SES sender), then
starts the server on **http://127.0.0.1:8080** with file-watching reload.

Smoke it:

```bash
curl -s http://127.0.0.1:8080/ping
```

### A6. (Optional) Infra guard tests

```bash
make infra-test
```

Plan-time assertions over the OpenTofu config — storage classes, lifecycle
rules, teardown rails. No AWS calls; safe to run anytime.

### A7. Stop everything

```bash
make down
```

LocalStack runs with `PERSISTENCE=0`, so `make down` discards all local data.
That is intentional for dev; restart with `make up && make dev`.

---

## Part B — Test with the real ente app on your LAN

The M5 gate: onboard the stock ente Photos app against your Mac. Full detail in
[RUNBOOK-M5.md](RUNBOOK-M5.md); condensed steps:

### B1. Network prerequisites

1. Phone and Mac on the **same wifi**.
2. macOS firewall must allow inbound connections to node (System Settings →
   Network → Firewall), or turn it off temporarily.

### B2. Start the LAN server

```bash
make up
make lan
```

`make lan` differs from `make dev` in three ways:

- It binds presigned S3 URLs to your **Mac's LAN IP** instead of 127.0.0.1, so
  the phone can actually reach them (this was the first gate failure).
- It enables a hardcoded test OTT: **any `…@example.org` email verifies with
  code `123456`** — no real mail needed.
- It logs every request (`LOG_REQUESTS=1`); unimplemented routes are marked
  `UNHANDLED ROUTE?`.

It prints the URL to use, e.g. `http://192.168.1.23:8080`.

### B3. Point the app at your server

1. Install **ente Photos** from the store.
2. On the onboarding screen, **tap the ente logo 7 times** — the custom server
   endpoint dialog appears.
3. Enter the printed URL (`http://<mac-ip>:8080`) and save.
4. Sign up with `anything@example.org`, enter OTT `123456`, set a password.
   This runs the real argon2 + SRP setup against your server.

### B4. Exercise it

Back up a small album, browse thumbnails, open a photo full-screen, create and
rename an album, favorite something, trash and restore a photo, play a video.
Then log in from a second device (or a reinstall) with the same
email/password — the SRP login path — and confirm the library appears.

Watch the `make lan` terminal for any 404/4xx/5xx; each one is an
unimplemented or wrong endpoint and belongs in NEXT-TASKS.md.

LocalStack keeps its state while the container runs, so restarting `make lan`
after a code fix preserves your test account.

---

## Part C — Deploy to AWS

This creates **27 resources** (full inventory in
[AWS-RESOURCES.md](AWS-RESOURCES.md) §1): a DynamoDB table, a versioned S3
bucket, two Lambdas, a public Function URL fronted by CloudFront, a daily
trash-purge cron, log groups, an SNS alarm topic and two alarms — plus the
albums web hosting (a private static bucket served by the SAME CloudFront
distribution as the API, D58), whose content is built and synced separately
in C13.

Steps C1–C4 are one-time, out-of-band AWS work. From C5 on it is all make
targets.

### C1. Decide the account and region

The region binds Lambda, DynamoDB, S3 **and SES** together — the mail adapter
uses the Lambda's own region, so the verified SES identity must live in the
same region you deploy to. Pick once; moving later is a fresh deployment, not
a migration (the bucket name embeds the account ID and the table carries
API-level deletion protection, D57).

Note: OpenTofu reads the region from `ente-sl.tfvars` (step C4), **not** from
your AWS CLI config. `aws configure get region` tells you nothing about where
this deploys.

### C2. Verify an SES identity in that region

A single verified **address** is enough — no domain, no support ticket:

1. AWS console → SES → pick your deploy region → Identities → Create identity
   → Email address → enter your inbox.
2. Click the confirmation link SES mails you.

**Stay in the SES sandbox** (the default). It delivers only to *verified*
recipients at 200/day — for a private server that is an access-control
mechanism, not a limit: verify each person who should be able to hold an
account, once each, the same way. Request production access only if strangers
must self-serve signup.

Deliverability caveat: sending from an `@gmail.com`-style address can be
spam-filed (SPF/DKIM can't align with Google's DMARC). Tolerable for codes you
send to yourself; a cheap domain is the proper fix.

### C3. Create the deployer principal

The IAM user that runs the deploy is a manual bootstrap step. Its policy is
[src/infra/deployer-policy.json](src/infra/deployer-policy.json) — scoped to
`ente-sl-*`, with `s3:DeleteBucket` and `dynamodb:DeleteTable` explicitly
denied so the deployer can never destroy the photo store.

1. IAM console → Users → Create user (e.g. `ente-sl-deployer`), no console
   access.
2. Attach an inline policy: paste the contents of
   `src/infra/deployer-policy.json`.
   - The console may warn that `cloudfront:CreateDistributionWithTags` is
     unrecognized — that is a validator quirk; the action is real. Save anyway.
3. Create an access key and put it in a **dedicated profile**:

```bash
aws configure --profile ente-sl
```

Set the access key, secret, and any output format. Using a dedicated profile
means the credential in play is always explicit:

```bash
AWS_PROFILE=ente-sl aws sts get-caller-identity
```

Confirm the account ID is the one you decided on in C1. A `guard-account`
check in the Makefile will also refuse plan/deploy/destroy if your credentials
ever point at a different account than the one recorded in state.

### C4. Create and fill in the tfvars

```bash
cp src/infra/dev/ente-sl.tfvars.example src/infra/dev/ente-sl.tfvars
```

Fill in all four values (the file is gitignored):

| Variable | Value |
|---|---|
| `hashing_key` | `openssl rand -base64 32` — generate once, see warning below |
| `mail_from` | the SES-verified address from C2 |
| `region` | the region from C1, e.g. `ap-southeast-1` |
| `env_name` | e.g. `prod` — names every resource; **set before the first apply and never change it** (changing it renames the table and bucket, which plans a replacement of the photo store — the delete-protection rails refuse it, but stop and fix the value rather than fighting them) |
| `alarm_email` | optional; defaults to `mail_from` |
| `delete_protection` | optional, default `true` (D57) — API-level deletion protection on the table + no `force_destroy` on the objects bucket. **Leave it true here**; only a test env's tfvars sets `false` |

> **BACK UP `hashing_key` off-machine before applying.** It keys the
> email→user mapping; losing it orphans every account (decision D4a). The
> local `terraform.tfstate` also contains it in cleartext and is the only
> deployment record — back that up too after the first apply.

### C4a. Choose the deployment profile

```bash
make profile dev
```

Every tofu-touching make target (`infra-init`, `plan`, `deploy`, `outputs`,
`smoke`, `destroy`, `build-web`, `deploy-web`, `pricing-plan`, …) addresses
the env dir named in `.tf-profile` (gitignored, written by `make profile`):

- `make profile dev` → `src/infra/dev` — labelled **PRODUCTION** (the dir was
  named before it went live; it *is* the production deployment)
- `make profile test` → `src/infra/test` — labelled **TEST** (see
  [A second environment](#a-second-environment-test))

There is **no default**: with no profile chosen every such target refuses
with `no profile chosen — choose: make profile dev | make profile test`.
Every profile-aware target banners which env it is about to touch, e.g.
`>>> profile: dev (ENV: PRODUCTION)`, before acting. There is no extra typed
confirmation beyond that (dropped 2026-08-27, see D57 addendum): profiles are
fully disjoint (state, tfvars, and the account guard are all per-profile),
`deploy` only ever applies a plan you just reviewed, and `destroy` ends at
tofu's own interactive approval prompt. Bare `make profile` prints the
current choice.

### C5. Initialize OpenTofu

```bash
make infra-init
```

Regenerates `.terraform/` and the provider lock file (of the selected
profile's dir).

### C6. Plan

```bash
AWS_PROFILE=ente-sl make plan
```

This target:

1. banners the profile (`>>> profile: dev (ENV: PRODUCTION)`) and refuses if
   none is chosen,
2. runs `make build-lambda` first (esbuild zips into `dist/`, so the bundles
   can never be stale at plan time),
3. runs the account guard,
4. refuses with instructions if the profile dir's `ente-sl.tfvars` is missing,
5. saves the plan to `tfplan`.

On a first deploy expect **27 to add, 0 to change, 0 to destroy**. **Read the
plan.** Any `destroy` or `replace` line on a first deploy means wrong
credentials or a wrong `env_name` — stop and fix it.

One expected quirk of a FIRST plan (D58): the banner
`no server_url in state yet — ALBUMS_URL deploys as the pending sentinel`.
The Lambda's `ALBUMS_URL` should be the distribution's own URL, which does
not exist yet — the first apply deploys a loud placeholder and the routine
second `make plan && make deploy` (a one-line Lambda env update) pins the
real domain. C13 reminds you.

### C7. Deploy

```bash
AWS_PROFILE=ente-sl make deploy
```

After the profile banner, deploy applies the **saved** plan (so what ships is
exactly what you reviewed — that review is the safeguard here) and prints the
outputs. Most resources are quick; **CloudFront takes 5–15 minutes** to reach
Deployed status.

Outputs to note:

- `server_url` — the CloudFront domain. This is what clients get pointed at.
- `api_function_url` — the raw Lambda URL (origin-locked; direct calls 403).

### C8. Confirm the SNS alarm subscription

AWS mails a "Subscription Confirmation" to `alarm_email` (or `mail_from`).
**Click the link.** Until you do, the subscription stays pending and silently
drops every alarm — including the one that tells you the trash-purge cron
died.

### C9. Smoke test

```bash
AWS_PROFILE=ente-sl make smoke
```

Healthy output:

```
  function-url /ping -> 403  (403 = origin lock working)
  cloudfront   /ping -> 200  (must be 200)
```

The function URL **should** 403 — the app refuses requests that don't carry
CloudFront's secret origin header. If **both** return 403, the anonymous
`InvokeFunctionUrl` permission is missing or the origin secret is mismatched.

### C10. Point the ente app at it

1. In ente Photos, tap the logo 7 times on the onboarding screen.
2. Enter the `server_url` output (the `https://…cloudfront.net` domain).
3. Sign up with an email address you verified as an SES recipient (sandbox
   rule from C2). The OTT arrives by real mail this time.

**Failure signature to know:** if signup returns a 500 on `POST /users/ott`,
the OTT was stored but SES refused to send — check that `mail_from` is
verified in the deploy region and that the recipient is verified (sandbox)
before suspecting the code.

### C11. (Recommended) Post-deploy verification

Replay the gate flows from Part B against the cloud `server_url`: signup,
backup, browse, trash/restore, second-device login. Watch
`/aws/lambda/ente-sl-<env>-api` logs in CloudWatch for surprises.

### C12. The CloudFront FREE pricing plan (automatic since D60)

`make deploy` runs the subscription for you as a post-apply step: it is
idempotent (already subscribed → a one-line no-op) and **never fails the
deploy** — on a transient refusal (IAM propagation, a distribution still
deploying, the account's 3-distribution FREE budget) it prints a loud WARNING
and leaves the manual re-run to you:

```bash
AWS_PROFILE=ente-sl make pricing-plan
```

One subscription **per environment**, and the biggest single line off the
bill: the flat-rate FREE plan covers the WAF web ACL, its rate rule, and all
CloudFront/WAF request fees for this distribution — otherwise ≈ $6/mo of flat
WAF fees (D47). Since D58 the one distribution also serves the albums web
app, so the subscription covers that too. The plan's allowances (1M requests
/ 100 GB per month) only ever see small JSON plus a few MB of static assets —
photo bytes go straight to S3 via presigned URLs — and exceeding them never
bills anything.

It is a CLI step rather than a tofu resource because the AWS provider does not
support pricing plans yet; consequently it does **not** survive `make destroy`
— the deploy chain re-subscribes on the re-apply that mints the new
distribution. `make pricing-plan-status` shows the current subscription. If
the deployer user predates D47, re-paste `src/infra/deployer-policy.json`
over its inline policy first (C3) — the `PricingPlanFreeTier` statement is
new.

The edge module is deliberately FREE-tier-shaped (D47/D60): AWS-managed
policies only, no byte-match statements in the WAF, `PriceClass_All`, and —
the D60 lesson — **at most 5 cache behaviors** (this layout uses 2: API on
the default behavior, `/albums*` for the web app). The FREE tier gates all
of those (the price-class and behavior-count gates are undocumented; the
latter refuses with "You're using configuration not available in this tier:
17 cache behaviors (limit 5)"), and AWS refuses (or warns on) the
subscription while the distribution uses them. If subscribing complains
about incompatible configuration, a pre-D47/pre-D60 edge config is still
deployed — run the C6/C7 plan-deploy cycle first, then retry.

One subscription covers exactly one distribution + one web ACL, and the FREE
plan allows at most **3 distributions per AWS account** — the D58
consolidation is what keeps prod + test at 2 (one spare). Every deployed
env's own `make deploy` chain subscribes it; if the WARNING ever fires,
re-run by hand (`make profile test && AWS_PROFILE=ente-sl make
pricing-plan`): an unsubscribed env silently pays the ~$6/mo WAF fees on
pay-as-you-go.

### C13. Deploy the albums web app (public share links)

Public album links minted by the server are `<albums_url>/?t=<token>` — they
only work once ente's **albums web viewer** is being served at that URL.
Since D58/D60 that URL is **`https://<server_url domain>/albums`**: the one
CloudFront distribution serves the API on its default behavior and the
albums app on the `/albums*` path (a private S3 bucket behind OAC, assets
under the `albums/` key prefix — the FREE plan caps cache behaviors at 5,
D60). The tofu from C7 already created the hosting; this step builds and
uploads the app itself.

First, pin `ALBUMS_URL` (fresh deploys only — see the C6 note):

```bash
AWS_PROFILE=ente-sl make plan      # one in-place Lambda env change: ALBUMS_URL
AWS_PROFILE=ente-sl make deploy    # sentinel -> the distribution's real domain
```

Prerequisites: `git`, Node ≥ 20 and a recent `npm` (the ente web workspace
pins npm 11.x), network access to github.com and the npm registry, and disk
for a ~2 GB workspace install under `dist/`.

```bash
make build-web                     # clones ente at the PINNED tag (ALBUMS_WEB_TAG
                                   # in the Makefile — must match ORACLE-VERSION,
                                   # guard-tested), patches basePath=/albums into
                                   # the pinned next.config (D60), npm ci,
                                   # static-exports into dist/web-albums
AWS_PROFILE=ente-sl make deploy-web   # s3 sync to the bucket's albums/ prefix
                                      # (index.html no-cache, hashed assets
                                      # immutable) + invalidation
```

Four things worth knowing:

- **The API URL is baked in at build time** (`NEXT_PUBLIC_ENTE_ENDPOINT`).
  `build-web` defaults it to the `server_url` output; building before the
  first deploy needs `make build-web ALBUMS_API_ORIGIN=https://<server_url>`.
  If `server_url` ever changes (e.g. after `make destroy` + re-apply), rebuild
  — re-syncing the old build keeps pointing at the dead API. (Since D58 the
  app is served from that same domain, so its API calls are same-origin.)
- **The `/albums` base path is patched in at build time too** (D60): the
  pinned tag has no env-based basePath support, so `build-web` runs
  `scripts/patch-albums-basepath.ts` against the fresh clone before
  building. If a future tag bump changes the config's shape, that script
  fails the build loudly — reconcile it with the new config rather than
  building an unprefixed app (it would 404 behind `/albums*`; `deploy-web`
  also refuses to sync such a build).
- **Custom domain**: set `albums_url = "https://albums.example.com"` in the
  tfvars (the full base URL the viewer is served at, no trailing slash — the
  server appends `/?t=<token>`; used verbatim, no `/albums` suffix is added)
  and re-deploy so minted links use it; it wins over the D58/D60 hint.
  Fronting the distribution with that domain (ACM cert + alias) is out of
  scope here.
- **Verify** by creating a share link in the ente app and opening it in a
  browser — the album should render and (if enabled) collect uploads should
  work. A blank page with console 401s means the app was built against the
  wrong API origin.

---

## Inviting users & storage pools

Optional operator features, deliberately off-parity (museum has neither;
DECISIONS.md D54/D55). Both are server/CLI-side only: the stock apps see
byte-identical wire shapes, and with `SIGNUP_MODE` unset and no pool rows the
server behaves exactly as it did before Phase H.

The CLIs (`tools/invite.ts`, `tools/storagePool.ts`) are env-driven exactly
like the Lambda. Against LocalStack, prefix the targets with the same
variables `make dev` injects. Against a real deployment, point them at it
explicitly:

```bash
TABLE_NAME=ente-sl-<env> AWS_REGION=<region> AWS_PROFILE=ente-sl \
HASHING_KEY=<the tfvars value> make invites
```

`HASHING_KEY` is needed only where noted below; everything else works
without it.

### Inviting users (invite-gated signup, D54)

Signup is **open by default** (`SIGNUP_MODE` unset). To admit only invited
users:

1. **Set `SIGNUP_MODE=invite` in the API Lambda's environment.** Locally
   that is `SIGNUP_MODE=invite make dev` (or `make lan`). On AWS, set
   `signup_mode = "invite"` in `src/infra/dev/ente-sl.tfvars` and run the
   plan/deploy cycle (the var validates to `open|invite` and defaults to
   open). Only account *creation* is gated: login and change-email always work, and
   existing accounts are untouched. A non-invited signup gets a bare 403 the
   stock app renders as its generic failure dialog; the OTT is neither
   stored nor mailed.
2. **Invite each user by email**, optionally capping their storage:

```bash
make invite EMAIL=alice@example.com            # default storage (config free plan)
make invite EMAIL=bob@example.com STORAGE_GB=50
make invite EMAIL=carol@example.com VIEWER=1   # viewer account — consumes shares only
make invites                                   # list, with consumed/open state
make revoke-invite EMAIL=bob@example.com       # refuses consumed rows (audit trail)
make set-storage EMAIL=alice@example.com STORAGE_GB=100   # post-signup lever; needs HASHING_KEY
```

Worth knowing:

- **`STORAGE_GB=0` means ZERO bytes** — no uploads at all, deliberately
  unlike the 0-disables-it config knobs. `STORAGE_GB=default` clears an
  override. Viewer accounts additionally cannot create albums; they can
  still browse shares, download, and favorite.
- Invites are single-use for signup but the consumed row is **kept** as an
  audit trail; re-running `make invite` re-arms it (the re-admission path,
  e.g. after an account deletion). Storage/viewer overrides apply whenever a
  usable invite exists, even in open mode — you can pre-provision limits
  before flipping the mode.
- The SES sandbox rule from C2 still applies: verify each invited address as
  an SES recipient too, or their OTT mail never arrives.

### BYO storage pools (D55)

A pool is **one S3 bucket — typically owned and paid for by a household —
shared by many users**: "me and my partner one bucket, my brother and his
partner another". Members' new uploads land in the pool bucket (object keys
stay `<userID>/<uuid>`, so each member keeps their own prefix) and the
bucket owner pays for them. Pool membership grants **no data access** — two
members of a pool are strangers until someone shares an album, exactly as
before.

#### 1. Prepare the pool bucket

The onboarding CLI validates all of this and refuses to onboard on the hard
failures:

- **Block Public Access: all four blocks ON** (hard failure — every photo
  byte would otherwise be one guessed key away from public).
- **CORS mirroring the central bucket's browser-PUT rule** (warn): methods
  `GET/PUT/POST/HEAD`, origins `*`, `ExposeHeaders: ETag` — without it
  web/browser uploads fail (D33).
- **An abort-incomplete-multipart lifecycle rule** (warn) — abandoned
  multipart uploads otherwise bill forever; the central bucket uses 7 days.
- **Optional but recommended — the GLACIER_IR tier rule**: the server tags
  originals `tier=original` in every bucket, central or pool, so a lifecycle
  rule filtered on that tag (transition to `GLACIER_IR` after **7 or more
  days**, matching the central bucket's `gir_transition_days` default — D59)
  gives the pool the same cost profile as the central bucket. Keep the
  transition off day 0: fresh uploads are the most-viewed, and GIR bills
  $0.03/GB retrieval on those views while a week of Standard costs about
  $0.006/GB once. Pool owners manage their own lifecycle rules — the server
  never touches them. Without the rule the pool bills Standard rates.

#### 2. Grant access — mode `role` (preferred on real AWS)

Create an IAM role **in the bucket owner's account**, **named
`ente-pool-<something>`** (e.g. `ente-pool-smith`): the server's
`sts:AssumeRole` permission is scoped to `arn:aws:iam::*:role/ente-pool-*`
(never `Resource: "*"`), and `pool-create` refuses role ARNs outside the
convention. The scope matters because a pool role whose trust policy names
the **account root** (a common shortcut) is assumable by *any* principal in
that account that holds a broad AssumeRole grant — the naming convention
keeps this deployment's reach to roles that explicitly opted in.

The role's trust policy admits the server's Lambda execution role — and the
operator identity you run the CLI as, since `pool-create` validates with
*your* credentials — both locked to a shared ExternalId (generate one:
`openssl rand -hex 16`). Name the **principals**, not the account root:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": [
          "arn:aws:iam::<server-account>:role/ente-sl-<env>-api",
          "arn:aws:iam::<server-account>:user/<your-operator-user>"
        ]
      },
      "Action": "sts:AssumeRole",
      "Condition": { "StringEquals": { "sts:ExternalId": "<external-id>" } }
    }
  ]
}
```

The ExternalId is mandatory (`pool-create` refuses without it) — it is the
confused-deputy guard: the trust policy + ExternalId is what stops anyone
who merely learns the role ARN from pointing their own deployment at the
bucket.

The role's permissions policy needs the object round-trip plus the read-only
checks the validator runs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
        "s3:PutObjectTagging", "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::<pool-bucket>/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket", "s3:GetBucketCORS",
        "s3:GetLifecycleConfiguration", "s3:GetBucketPublicAccessBlock"
      ],
      "Resource": "arn:aws:s3:::<pool-bucket>"
    }
  ]
}
```

Mode `keys` (static access key + secret) exists for S3-compatibles and
LocalStack; the secret is secretbox-encrypted at rest with a key derived
from `HASHING_KEY`, never stored or logged in plaintext.

#### 3. Onboard the pool

```bash
# role mode (preferred):
make pool-create POOL=smith BUCKET=smith-photos REGION=eu-west-1 \
     ROLE_ARN=arn:aws:iam::<bucket-account>:role/ente-pool-smith EXTERNAL_ID=<external-id>

# keys mode (S3-compatibles) — pass the secrets as ENVIRONMENT variables:
POOL_ACCESS_KEY=... POOL_SECRET_KEY=... \
     make pool-create POOL=smith BUCKET=smith-photos REGION=eu-west-1 [ENDPOINT=https://...]
```

The env form is the **recommended** way to pass keys-mode secrets: make
variables (`ACCESS_KEY=...`/`SECRET_KEY=...` still work) appear in `ps`
output and your shell history file; environment variables prefixed to the
command do not (they still land in history — use your shell's
leading-space/`HISTIGNORE` convention or read them from a credential store
for the invocation).

`pool-create` runs the §1 checklist first (credentials, HeadBucket,
PUT+GET+DELETE probe, tagging, multipart create+abort, public-access block,
CORS, abort-MPU rule) and refuses to write the pool row on any hard failure.

#### 4. Attach members and manage the pool

```bash
make pool-attach EMAIL=alice@example.com POOL=smith   # user row, or unconsumed invite pre-signup
make pool-detach EMAIL=alice@example.com
make pools                                            # members, usage, quota, disabled state
make pool-set-quota POOL=smith STORAGE_GB=500         # shared cap (or STORAGE_GB=unlimited)
make pool-disable POOL=smith                          # new uploads 426; reads/purges still work
make pool-enable POOL=smith
make pool-requeue POOL=smith TO=central               # drain a dead pool's quarantined sweep rows
```

`pool-requeue` is the escape hatch for a pool that no longer resolves (row
deleted, credentials gone for good): the object sweep *quarantines* that
pool's queued deletions on every run — logged, counted, retried — and they
never drain on their own. Requeueing re-pins them onto another pool (or the
central bucket, the default) so the next sweep can delete them. **Running it
asserts the bytes actually live in the target bucket** (e.g. after you
migrated them out-of-band); the CLI restates this. A wrong assertion is
harmless to the target (the deletes no-op on missing keys) but leaves the
real bytes orphaned wherever they are.

Attach/detach affect **new uploads only**: every file is pinned at commit
time to the pool its bytes landed in, and downloads, purges and cleanup
resolve the bucket from that pin — nothing is migrated, nothing strands.
Quota precedence on upload, all surfaced as the same museum-shaped 426:
viewer / per-user-0 blocks first, then the user's own limit (D54), then the
pool's shared cap.

#### Caveats to know (and to tell the household)

- **Role-mode presigns live ≤ ~1 hour.** A presigned URL signed with
  temporary AssumeRole credentials dies with the STS session regardless of
  its nominal expiry, so role-pool PUT/GET URLs are clamped to the remaining
  session lifetime instead of the configured 24 h/7 d. Clients re-request
  URLs as a matter of course; keys-mode pools keep the full expiries.
- **The bucket-credential holder can touch ciphertext.** Whoever owns the
  pool bucket's AWS account can list and delete the objects out-of-band.
  That is an **availability** lever, not a confidentiality one: bytes are
  end-to-end encrypted, and prefixes reveal only per-member object counts
  and sizes. Members without bucket credentials have no path at all. Same
  trust shape as any BYO-storage arrangement — say so to the household.
- **Rollback caveat: detach pool users before rolling the Lambda back past
  H2.** Pre-H2 code ignores `storagePoolId` and would mint new uploads
  against the central bucket while old files stay pinned to pools it cannot
  resolve. (Pool *rows* in the table are harmless to old code — the D48
  no-gsi-attributes rule — it is attached *users* that must not be.)

---

## Updating a deployment

Code change → redeploy is the same plan/deploy cycle; `make plan` rebuilds the
bundles automatically:

```bash
AWS_PROFILE=ente-sl make plan     # read it — routine code updates change only the lambdas
AWS_PROFILE=ente-sl make deploy
AWS_PROFILE=ente-sl make smoke
```

`make outputs` reprints the URLs anytime.

### Migrating an existing deployment to the FREE-tier edge layout (D58 → D60)

Two starting points exist, and one plan/deploy cycle handles either — no
tfvars edits. **The operator order is the same for both**: plan → read the
plan against the expected shape below → deploy → rebuild + re-sync the web
app → verify.

**Starting point A — the D58 single-distribution layout** (17 behaviors: web
default + `/index.html` + 15 API prefixes; the test env deployed this — the
shape the pricing plan refused):

1. `make profile dev` (or `test`), then `AWS_PROFILE=ente-sl make plan`.
2. **Expected plan — everything in-place, nothing moved or destroyed**:
   - *update in-place*: the **one distribution** (the 16 ordered behaviors
     collapse to the single `/albums*`, the default behavior swaps back to
     the Lambda origin, `default_root_object` drops), the **SPA CloudFront
     function** (code update: rewrite target `/albums/index.html`), and the
     **API Lambda** (`ALBUMS_URL` gains the `/albums` suffix).
   - **Any `replace` line on the distribution = ABORT.** Replacement mints a
     new domain and breaks every configured client; nothing in this change
     forces one.

**Starting point B — the pre-D58 two-distribution layout** (API distribution
+ standalone albums distribution): the D58 consolidation and the D60
inversion land as ONE plan:

1. Same commands.
2. **Expected plan — 4 moved, 1 to add, 3 to change, 1 to destroy**:
   - *moved* (not destroyed): the web bucket, its public-access block, its
     bucket policy and the OAC — `module.web.* -> module.edge.*`.
   - *add*: the SPA viewer-request CloudFront function.
   - *update in-place*: the **main distribution** (new S3 origin + the one
     `/albums*` behavior; the default behavior keeps its API settings), the
     web **bucket policy** (`AWS:SourceArn` re-pins to the main
     distribution), and the **API Lambda** (`ALBUMS_URL` becomes
     `https://<server_url domain>/albums` — the plan-time hint reads the
     domain from state).
   - *destroy*: the standalone albums distribution — the ONLY acceptable
     destroy line.
   - **Any `replace` on the main distribution or the buckets = ABORT.**

Then, for both starting points:

3. `AWS_PROFILE=ente-sl make deploy`. The distribution update takes 5–15
   minutes; the API keeps serving throughout. The deploy chain runs
   `make pricing-plan` at the end — on a D58-layout env this is the moment
   the FREE subscription finally succeeds (≤ 5 behaviors); heed the WARNING
   if it fires and re-run by hand.
4. **`make build-web && AWS_PROFILE=ente-sl make deploy-web` is REQUIRED**
   (unlike the D58 migration): the assets change — the app must be rebuilt
   with the `/albums` base path, and the sync now targets the bucket's
   `albums/` key prefix. Old root-level objects from a D58-era sync become
   unreachable cruft; optionally clean them with
   `aws s3 rm s3://$(tofu -chdir=src/infra/<profile> output -raw web_bucket) --recursive --exclude "albums/*"`.
5. Verify: `make smoke` (still 403/200), then open
   `https://<server_url domain>/albums` in a browser — the albums viewer
   should load; `https://<server_url domain>/` should return the API's JSON
   404 again (pre-D58 behavior).
6. `make pricing-plan-status` — the subscription should be ACTIVE against
   the distribution + web ACL.
7. **Share links minted before the migration break** and must be re-copied
   from the app (tokens stay valid — the standing D52 caveat): links from
   the D58 window (`https://<domain>/?t=...`) now hit the API and 404;
   pre-D58 links point at the destroyed albums distribution's dead domain.

---

## A second environment (test)

`src/infra/test` is a complete second env dir — same modules, its own tfvars
and state — so you can rehearse a change (or this whole install) against a
disposable stack without ever pointing a command at production. The whole
workflow is the profile switcher (C4a):

```bash
make profile test                 # every target now addresses src/infra/test
cp src/infra/test/ente-sl.tfvars.example src/infra/test/ente-sl.tfvars
# fill it in: env_name = "test", delete_protection = false, and a FRESH
# hashing_key (openssl rand -base64 32) — NEVER paste production's key
make infra-init
AWS_PROFILE=ente-sl make plan     # banner: >>> profile: test (ENV: TEST)
AWS_PROFILE=ente-sl make deploy   # applies the saved plan you just reviewed
```

Notes:

- **`delete_protection = false`** (D57) is what makes the env disposable: the
  table skips API-level deletion protection and the objects bucket gets
  `force_destroy`, so teardown deletes everything cleanly. Production's
  tfvars leaves it at the default `true`.
- **`hashing_key` must be fresh.** It derives the email→user mapping; reusing
  prod's key links every test account to a production identity and makes the
  test key as sensitive as the real one.
- The account guard is per-profile and skips a first deploy (no state yet),
  so a fresh test env is never blocked by it.
- After the first apply, run `make plan && make deploy` once more to pin
  `ALBUMS_URL` (C6 note, D58/D60). The deploy chain subscribes this env's
  distribution to the FREE plan automatically (D60) — if its WARNING fires,
  re-run `AWS_PROFILE=ente-sl make pricing-plan` by hand: the plan is per
  distribution + web ACL, and an unsubscribed test env silently pays ~$6/mo
  of WAF fees. The account-wide FREE-plan budget is 3 distributions; prod +
  test = 2 (D58).
- Full teardown when you are done:

```bash
make profile test
AWS_PROFILE=ente-sl make destroy            # stateless half — tofu asks for a "yes"
# then the data (test only — delete_protection is already false):
AWS_PROFILE=ente-sl tofu -chdir=src/infra/test destroy -var-file=ente-sl.tfvars
```

Switch back with `make profile dev` when you return to production — nothing
switches implicitly.

---

## Teardown

```bash
make profile dev   # or test — the banner names the env
AWS_PROFILE=ente-sl make destroy   # tofu's own interactive prompt is the final confirmation
```

This removes the **stateless half only**: both Lambdas, the Function URL, the
cron, the log groups, the alarms, the CloudFront distribution and the
albums web bucket (build artifacts only — rebuildable via `make build-web`).
The table and the objects bucket — every photo — are deliberately out of
scope and protected by the `delete_protection` rails (D57): API-level
deletion protection on the table, no `force_destroy` on the bucket.

Two things to know:

- Re-applying afterwards mints a **new** CloudFront domain and a new function
  URL: every client must be re-pointed at the new `server_url`, the albums
  app must be rebuilt against it (C13), every share link minted before
  the destroy points at the dead domain — the tokens stay valid, so
  re-copying each link from the app recovers it — and `ALBUMS_URL` needs the
  routine second `make plan && make deploy` to pick the new domain up (the
  D58 hint reads it from state).
- There is intentionally no target that deletes the data. `make destroy-data`
  refuses and prints the manual steps, which since D57 are: set
  `delete_protection = false` in the profile's tfvars and plan/deploy **that
  change alone** (it lifts the table's API-level protection and arms
  `force_destroy` on the objects bucket), then run the printed
  `tofu destroy`. Back up `hashing_key` and the tfstate first.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `no profile chosen — choose: make profile dev \| make profile test` | Do step C4a — the make targets refuse to guess which env they address. |
| `make plan` fails: `missing src/infra/<profile>/ente-sl.tfvars` | Do step C4 (or the test-env copy step) for the selected profile. |
| `ACCOUNT MISMATCH — refusing to continue` | Your credentials point at a different AWS account than the one in the selected profile's state. Use `AWS_PROFILE=ente-sl`. |
| Plan wants to destroy/replace the bucket or table | Wrong account (see above) or `env_name` changed. Stop; do not apply. |
| `archive_file` error at plan time | `dist/` missing or stale — `make plan` runs `build-lambda` for you, but a bare `tofu plan` does not. |
| Both smoke URLs return 403 | Anonymous `InvokeFunctionUrl` permission missing, or origin secret mismatch between the Lambda env and CloudFront's custom header. |
| Signup 500s on `POST /users/ott` | SES rejected the send: `mail_from` not verified in the deploy region, or (sandbox) the recipient isn't verified. The OTT was stored but never delivered. |
| No alarm emails ever arrive | SNS subscription never confirmed — check the inbox for AWS's confirmation link (C8). |
| Phone can't upload in Part B | Use `make lan`, not `make dev` — presigned URLs must be signed against the LAN IP, and the macOS firewall must allow node. |
| LocalStack data gone after `make down` | Expected: `PERSISTENCE=0`. State only survives while the container runs. |
| `Dynamic require ... is not supported` in the deployed Lambda | The esbuild ESM require shim is missing — build with `make build-lambda`, not a bare esbuild invocation. |

## Cost expectations

Baseline ≈ **$3–5/month** for a ~500 GB library (Glacier IR originals after a
week in Standard — `gir_transition_days`, D59 — Standard thumbnails, on-demand
DynamoDB, everything else inside free tiers). The variable line that matters:
full-resolution downloads are S3 egress at $0.09/GB plus $0.03/GB Glacier IR
retrieval — browsing is cheap (and the first week's views skip the retrieval
fee entirely), a full 500 GB library restore is roughly $50. Details and
caveats in [AWS-RESOURCES.md](AWS-RESOURCES.md) §4.

With BYO storage pools (D55) the storage and egress lines move to the pool
owners' own bills: the central account keeps the control plane — DynamoDB,
Lambda, CloudFront, SES — at roughly $1–3/month, plus storage for any users
still on the central bucket. Per-user marginal cost on the control plane is
cents.
