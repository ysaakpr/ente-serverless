# AWS-RESOURCES — what the first deploy creates

Pre-deploy report for M7 (DECISIONS.md D4). Read alongside NEXT-TASKS.md §4.
Derived from `src/infra` as of 2026-08-17; **no cloud deploy has happened yet**,
so nothing below has been observed running — it is what `tofu apply` will
attempt.

Assumes the defaults: `region = us-east-1`, `env_name = "dev"`, so
`prefix = ente-sl-dev`. `<account>` is the 12-digit account ID, filled in at
plan time from `aws_caller_identity`.

## 1. The inventory — 16 managed resources

### Stateful (`modules/data`) — carries `prevent_destroy`

| # | Type | Name / identifier | Notes |
|---|---|---|---|
| 1 | `aws_dynamodb_table` | `ente-sl-dev` | PAY_PER_REQUEST, `pk`/`sk`, **3 GSIs** (`gsi1` collection diff + purge due-index, `gsi2` collection feed, `gsi3` tokens/trash/entity/file-data), all `projection_type = ALL`. TTL on `ttl` (OTT expiry). PITR on. SSE on (AWS-owned key). `deletion_protection_enabled = true`. |
| 2 | `aws_s3_bucket` | `ente-sl-dev-objects-<account>` | Every encrypted byte the clients upload. Account-ID suffix for global uniqueness. |
| 3 | `aws_s3_bucket_public_access_block` | ↑ | All four blocks on. |
| 4 | `aws_s3_bucket_cors_configuration` | ↑ | `GET/PUT/POST/HEAD`, origins `*`, exposes `ETag` (multipart). For browser clients PUTting to presigned URLs. |
| 5 | `aws_s3_bucket_lifecycle_configuration` | ↑ | Two rules: `originals-to-glacier-ir` (day 0, filtered on object tag `tier=original` — D7) and `abort-incomplete-multipart` (7 days). No DEEP_ARCHIVE anywhere; guard-tested in [test/infra/lifecycle.test.ts](test/infra/lifecycle.test.ts). |

### Stateless (`modules/compute`)

| # | Type | Name / identifier | Notes |
|---|---|---|---|
| 6 | `aws_iam_role` | `ente-sl-dev-api` | One execution role, **shared by both functions**. |
| 7 | `aws_iam_role_policy` | `ente-sl-dev-api` | Inline. Scoped to the table + `/index/*`, the bucket + `/*`, `ses:SendEmail` on `*`, logs on `/aws/lambda/ente-sl-dev-*`. |
| 8 | `aws_lambda_function` | `ente-sl-dev-api` | nodejs22.x, **arm64**, 512 MB, 30 s. Zip from `dist/lambda`. |
| 9 | `aws_lambda_function_url` | on ↑ | `authorization_type = "NONE"` — deliberate (CloudFront is the canonical path; IAM auth breaks the POST body hash). |
| 10 | `aws_lambda_function` | `ente-sl-dev-trash-purge` | nodejs22.x, arm64, 256 MB, 300 s. Drains the 30-day trash **and** the deferred object-sweep queue (D6). |
| 11 | `aws_cloudwatch_event_rule` | `ente-sl-dev-trash-purge` | `rate(1 day)`. |
| 12 | `aws_cloudwatch_event_target` | ↑ → the purge function | |
| 13 | `aws_lambda_permission` | `AllowEventBridge` | Lets `events.amazonaws.com` invoke the purge function. |
| 14 | `aws_cloudwatch_log_group` | `/aws/lambda/ente-sl-dev-api` | 30-day retention. Created explicitly, so the role does **not** need `logs:CreateLogGroup`. |
| 15 | `aws_cloudwatch_log_group` | `/aws/lambda/ente-sl-dev-trash-purge` | 30-day retention. |

### Edge (`modules/edge`)

| # | Type | Name / identifier | Notes |
|---|---|---|---|
| 16 | `aws_cloudfront_distribution` | comment `ente-sl-dev api` | `PriceClass_100`, IPv6 on, default `*.cloudfront.net` cert, no OAC (deliberate — same finding as immich-serverless). Managed **CachingDisabled** + **AllViewerExceptHostHeader** policies. All 7 methods allowed. Its domain is the `server_url` output the app gets pointed at. |

Everything carries default tags `Project=ente-serverless`, `Env=dev`,
`ManagedBy=opentofu`.

### Not resources, but read/built at plan time

- `data.aws_caller_identity.current` — supplies the bucket-name suffix.
- `data.archive_file.api` / `.trash_purge` — zip `dist/lambda` and
  `dist/trash-purge`. **These fail at plan time if `make build-lambda` has not
  run.** `dist/` does not currently exist in this tree.

## 2. What tofu does NOT create — the out-of-band prerequisites

These are the actual gating work for the first apply.

1. **The AWS account and region.** Still open per D4. The region choice binds
   Lambda, DynamoDB, S3 and — critically — **SES**: the mail adapter uses the
   Lambda's own `AWS_REGION`, so the verified identity must live in the same
   region.

2. **The SES identity, and SES production access.** No tofu resource creates
   either; `mail_from` is a plain variable asserted to be "an SES-verified
   identity". Two separate things are needed:
   - verify the sending identity (domain preferred over a single address);
   - **request production access**. A fresh account's SES is in the sandbox:
     mail only to *verified* recipients, 200/day, 1/sec. One-time tokens go to
     arbitrary user addresses, so **signup is broken until the sandbox exit is
     granted** — it is a support-ticket turnaround, so start it before anything
     else.

3. **The deployer principal.** `src/infra/deployer-policy.json` is a policy
   document, not a resource — the IAM user/role that carries it is a manual
   bootstrap step. It is scoped to `ente-sl-*` and deliberately omits
   `dynamodb:DeleteTable` and `s3:DeleteBucket`.

4. **`src/infra/dev/ente-sl.tfvars`.** Gitignored, does not exist yet. Copy the
   example, generate `hashing_key` with `openssl rand -base64 32`, and **back
   it up** — losing it orphans every email→user mapping (D4a).

5. **Tofu state.** Local and gitignored by design (one maintainer, one
   account). The state file *is* the deployment record; it lives only on this
   machine and contains `hashing_key` in cleartext.

## 3. Risks and gaps found while reading the config

Ordered by how likely each is to bite on the first apply.

- **The public-invoke permission on the Function URL is probably missing.**
  `aws_lambda_function_url` with `authorization_type = "NONE"` does not, by
  itself, add the resource-based policy statement that lets anonymous callers
  in — the usual fix is an explicit `aws_lambda_permission` with
  `principal = "*"`, `action = "lambda:InvokeFunctionUrl"`,
  `function_url_auth_type = "NONE"`. I could not verify this against a real
  apply. **Curl the `api_function_url` output immediately after apply**; if it
  returns 403, that resource is what's missing. Cheap to check, and it fails
  closed rather than dangerously.

- **GLACIER_IR's 90-day minimum collides with the 30-day trash purge.** Objects
  transition to GIR on day 0, and GIR bills a 90-day minimum duration (plus a
  128 KB minimum billable size per object). A photo uploaded and then
  trash-purged after 30 days is still charged for the remaining ~60 days. Not a
  bug, but it means churn costs more than the storage line suggests, and it is
  worth recording once real numbers exist.

- **Byte egress bypasses CloudFront.** Clients GET originals straight from S3
  via presigned URLs, so downloads are billed as **S3 internet egress**
  ($0.09/GB after the 100 GB/mo free allowance) and do *not* benefit from
  CloudFront's 1 TB/mo always-free tier. That is inherent to the museum
  presigned-URL design, not a misconfiguration — but it is the dominant
  variable cost, and it is the one line an "object-storage prices" pitch tends
  to forget.

- **`hashing_key` is a plaintext Lambda environment variable.** Readable by
  anyone with `lambda:GetFunctionConfiguration`, and stored unencrypted in the
  local tfstate. D4a covers *losing* it; it does not cover *at-rest exposure*.
  Acceptable for a single-owner account; Secrets Manager or an SSM SecureString
  is the upgrade if this ever grows a second operator.

- **Auth tokens can travel in the query string.** Museum accepts `?token=` on
  every private route and the web/desktop client relies on it for thumbnails
  (D32), so we match it. Query strings are logged by CloudFront/ALB access logs
  by default and leak via `Referer` — if access logging is ever switched on for
  this distribution, redact `token`, and never enable a cache policy that keys
  on the full query string for these routes. Our own gate logger prints the
  path only (verified), so `make lan` does not echo tokens.

- **No abuse protection at the edge.** The Function URL is auth NONE, and there
  is no WAF, no rate limiting, and no geo restriction on the distribution. The
  app-level limits museum has are implemented (OTT: 10 active codes, 20 wrong
  attempts → 429; SRP: 5 attempts, 10 unverified sessions/hour) — but nothing
  stops someone hammering `/users/ott` on a public URL and burning SES quota or
  damaging the sending reputation. Worth watching after the first public deploy.

- **The Function URL is directly reachable, bypassing CloudFront.** It is a
  tofu output, so it will be known. Any future edge-level control (WAF, custom
  domain, headers) is bypassable unless the origin is locked down. No OAC is
  possible here for the documented reason, so an origin shared-secret header is
  the realistic option if this matters later.

- **CORS is served by the API itself, not the edge.** ~~No CORS on the API~~
  (fixed 2026-08-17, D29): hono now answers preflights and sets museum's
  header set on every response via `src/middleware/cors.ts`, so the ente
  **web**/desktop client works against `server_url`. CloudFront still adds
  none of its own — if a cache policy is ever put in front of these routes it
  must vary on `Origin`, since `Access-Control-Allow-Origin` echoes the
  caller. The S3 bucket keeps its own separate CORS config (row 4).

- **Teardown is deliberately hard.** `prevent_destroy` on the table and bucket,
  `deletion_protection_enabled` on the table, no `force_destroy` on the bucket.
  Destroying dev means editing the tf, disabling deletion protection, and
  emptying the bucket by hand. Correct for a photo store; just don't expect
  `tofu destroy` to work.

- **The deployer policy is a privilege-escalation path if leaked.** It grants
  `iam:CreateRole` + `iam:PutRolePolicy` + `iam:PassRole` on `ente-sl-*` with no
  permissions boundary — enough to mint an admin role and pass it to a Lambda.
  Fine when the deployer *is* the account owner; not fine if it ever becomes a
  CI credential. Add a permissions boundary before that happens.

- **The policy may need a few additions on the first apply.** It was written by
  hand, not derived from a real run; provider read calls occasionally want a
  permission not on the list. Expect to iterate once, rather than treating a
  denial as a config bug.

### Confirmed sound

The execution role covers exactly what the code calls, no more. Adapters issue
`Get/Put/Update/Delete/Query/TransactWrite` on DynamoDB (no `Scan`), and
`GetObject / PutObject / DeleteObject / HeadObject / PutObjectTagging /
CreateMultipartUpload` plus presigned multipart on S3, and `ses:SendEmail`.
Every one has a matching statement; `HeadObject` rides on `s3:GetObject` and
the client's presigned multipart calls ride on the role's `PutObject` +
`AbortMultipartUpload` + `ListMultipartUploadParts`. No unused grant except the
broad `ses:SendEmail` resource `*`, which could be narrowed to the identity ARN.

## 4. Rough cost model

List prices, us-east-1, approximate — **verify against current AWS pricing**,
and replace this section with observed numbers after the first month (the build
plan's definition of done requires recorded cost).

For a ~500 GB library with ~10 GB of thumbnails and personal-scale traffic:

| Line | Basis | ≈ monthly |
|---|---|---|
| S3 Glacier IR (originals) | 500 GB × $0.004/GB | $2.00 |
| S3 Standard (thumbs, file-data) | 10 GB × $0.023/GB | $0.23 |
| DynamoDB on-demand + PITR | small table, low RPS | < $1 |
| Lambda (arm64, both functions) | well inside free tier | ~$0 |
| CloudFront | JSON only, free tier | ~$0 |
| CloudWatch Logs | 30-day retention, $0.50/GB ingest | < $1 |
| SES | $0.10 / 1,000 mails | ~$0 |
| **Baseline** | | **≈ $3–5** |

Variable, and the part that actually matters: **GIR retrieval at $0.03/GB** plus
**S3 egress at $0.09/GB** on every full-resolution download past the first
100 GB/month. Browsing is cheap (thumbnails stay Standard); a full library
restore is not — 500 GB out is roughly $15 retrieval + $36 egress.

## 5. Prep checklist, in order

1. Decide the AWS account and region (closes half of D4). Note the region binds SES.
2. Verify the SES identity in that region **and file the sandbox-exit request** — longest lead time, start first.
3. Create the deployer principal from `src/infra/deployer-policy.json`; configure credentials locally.
4. `cp src/infra/dev/ente-sl.tfvars.example src/infra/dev/ente-sl.tfvars`, fill in `hashing_key` and `mail_from`, **back the key up off-machine**.
5. `make build-lambda` — `dist/` must exist before plan.
6. `tofu -chdir=src/infra/dev init` (regenerates `.terraform/` and the lock file, both dropped by the repo split).
7. `tofu -chdir=src/infra/dev plan -var-file=ente-sl.tfvars` — expect **16 to add**. Read it before applying.
8. Apply. CloudFront takes ~5–15 minutes to reach Deployed; everything else is quick.
9. Immediately curl the `api_function_url` output and the `server_url` output (`/ping`). A 403 on the former means the missing invoke permission from §3.
10. Replay the M1–M6 gate scripts against `server_url`, then the stock app over the internet (build plan M7).

Tooling on this machine is ready: OpenTofu 1.12.5, AWS CLI 2.36.24.
