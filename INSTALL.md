# INSTALL — ente-serverless, step by step

This guide takes you from a bare machine to a running deployment. It covers
three paths, in increasing order of commitment:

- **[Part A — Local development](#part-a--local-development-localstack)**: run the server and the full test
  suite on your machine with LocalStack. No AWS account needed.
- **[Part B — Phone on the LAN](#part-b--test-with-the-real-ente-app-on-your-lan)**: point the stock ente Photos app at the
  server running on your Mac. Still no AWS account.
- **[Part C — AWS deployment](#part-c--deploy-to-aws)**: the real thing — Lambda, DynamoDB, S3,
  CloudFront — deployed with OpenTofu.

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

Expected: all suites green (117+ scenarios, including the M1–M4 gate scripts).

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

This creates **22 resources** (full inventory in
[AWS-RESOURCES.md](AWS-RESOURCES.md) §1): a DynamoDB table, a versioned S3
bucket, two Lambdas, a public Function URL fronted by CloudFront, a daily
trash-purge cron, log groups, an SNS alarm topic and two alarms.

Steps C1–C4 are one-time, out-of-band AWS work. From C5 on it is all make
targets.

### C1. Decide the account and region

The region binds Lambda, DynamoDB, S3 **and SES** together — the mail adapter
uses the Lambda's own region, so the verified SES identity must live in the
same region you deploy to. Pick once; moving later is a fresh deployment, not
a migration (the bucket name embeds the account ID and the table carries
`prevent_destroy`).

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
| `env_name` | e.g. `prod` — names every resource; **set before the first apply and never change it** (changing it renames the table and bucket, which forces a replacement that `prevent_destroy` will refuse) |
| `alarm_email` | optional; defaults to `mail_from` |

> **BACK UP `hashing_key` off-machine before applying.** It keys the
> email→user mapping; losing it orphans every account (decision D4a). The
> local `terraform.tfstate` also contains it in cleartext and is the only
> deployment record — back that up too after the first apply.

### C5. Initialize OpenTofu

```bash
make infra-init
```

Regenerates `.terraform/` and the provider lock file.

### C6. Plan

```bash
AWS_PROFILE=ente-sl make plan
```

This target:

1. runs `make build-lambda` first (esbuild zips into `dist/`, so the bundles
   can never be stale at plan time),
2. runs the account guard,
3. refuses with instructions if `ente-sl.tfvars` is missing,
4. saves the plan to `tfplan`.

On a first deploy expect **22 to add, 0 to change, 0 to destroy**. **Read the
plan.** Any `destroy` or `replace` line on a first deploy means wrong
credentials or a wrong `env_name` — stop and fix it.

### C7. Deploy

```bash
AWS_PROFILE=ente-sl make deploy
```

Applies the **saved** plan (so what ships is exactly what you reviewed), then
prints the outputs. Most resources are quick; **CloudFront takes 5–15 minutes**
to reach Deployed status.

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

---

## Teardown

```bash
AWS_PROFILE=ente-sl make destroy
```

This removes the **stateless half only**: both Lambdas, the Function URL, the
cron, the log groups, the alarms and the CloudFront distribution. The table
and the objects bucket — every photo — are deliberately out of scope and
protected by `prevent_destroy`.

Two things to know:

- Re-applying afterwards mints a **new** CloudFront domain and function URL,
  so every client must be re-pointed at the new `server_url`.
- There is intentionally no target that deletes the data. `make destroy-data`
  refuses and prints the four manual steps (empty the bucket, lift both
  `prevent_destroy` blocks, disable the table's deletion protection, then
  destroy). Back up `hashing_key` and the tfstate first.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `make plan` fails: `missing src/infra/dev/ente-sl.tfvars` | Do step C4. |
| `ACCOUNT MISMATCH — refusing to continue` | Your credentials point at a different AWS account than the one in state. Use `AWS_PROFILE=ente-sl`. |
| Plan wants to destroy/replace the bucket or table | Wrong account (see above) or `env_name` changed. Stop; do not apply. |
| `archive_file` error at plan time | `dist/` missing or stale — `make plan` runs `build-lambda` for you, but a bare `tofu plan` does not. |
| Both smoke URLs return 403 | Anonymous `InvokeFunctionUrl` permission missing, or origin secret mismatch between the Lambda env and CloudFront's custom header. |
| Signup 500s on `POST /users/ott` | SES rejected the send: `mail_from` not verified in the deploy region, or (sandbox) the recipient isn't verified. The OTT was stored but never delivered. |
| No alarm emails ever arrive | SNS subscription never confirmed — check the inbox for AWS's confirmation link (C8). |
| Phone can't upload in Part B | Use `make lan`, not `make dev` — presigned URLs must be signed against the LAN IP, and the macOS firewall must allow node. |
| LocalStack data gone after `make down` | Expected: `PERSISTENCE=0`. State only survives while the container runs. |
| `Dynamic require ... is not supported` in the deployed Lambda | The esbuild ESM require shim is missing — build with `make build-lambda`, not a bare esbuild invocation. |

## Cost expectations

Baseline ≈ **$3–5/month** for a ~500 GB library (Glacier IR originals,
Standard thumbnails, on-demand DynamoDB, everything else inside free tiers).
The variable line that matters: full-resolution downloads are S3 egress at
$0.09/GB plus $0.03/GB Glacier IR retrieval — browsing is cheap, a full
500 GB library restore is roughly $50. Details and caveats in
[AWS-RESOURCES.md](AWS-RESOURCES.md) §4.
