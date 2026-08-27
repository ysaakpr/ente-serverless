# AWS-RESOURCES — what the first deploy creates

Pre-deploy report for M7 (DECISIONS.md D4). Read alongside NEXT-TASKS.md §4.
Derived from `src/infra` as of 2026-08-17 (albums web hosting added
2026-08-27, Phase F/D52; the execution role's pool `sts:AssumeRole` statement
added the same day, Phase H2/D55); **no cloud deploy has happened yet**,
so nothing below has been observed running — it is what `tofu apply` will
attempt.

Names below are written as `ente-sl-dev-*` for continuity, but `region` and
`env_name` now carry **no defaults** — both are required in `ente-sl.tfvars`, so
a missing value fails the plan instead of quietly standing up a second `dev`
deployment in us-east-1. With `env_name = "prod"` every `-dev-` below reads
`-prod-`. `<account>` is the 12-digit account ID, filled in at plan time from
`aws_caller_identity`.

## 1. The inventory — 27 managed resources

### Stateful (`modules/data`) — delete protection is variable-driven (D57)

| # | Type | Name / identifier | Notes |
|---|---|---|---|
| 1 | `aws_dynamodb_table` | `ente-sl-dev` | PAY_PER_REQUEST, `pk`/`sk`, **3 GSIs** (`gsi1` collection diff + purge due-index, `gsi2` collection feed, `gsi3` tokens/trash/entity/file-data), all `projection_type = ALL`. TTL on `ttl` (OTT expiry). PITR on. SSE on (AWS-owned key). `deletion_protection_enabled` follows the `delete_protection` variable (default **true** — blocks `DeleteTable` at the AWS API for everyone, console included; D57). |
| 2 | `aws_s3_bucket` | `ente-sl-dev-objects-<account>` | Every encrypted byte the clients upload — except users attached to a BYO storage pool (D55), whose new uploads land in their pool's own bucket (not a managed resource; the file row pins which bucket holds it). Account-ID suffix for global uniqueness. `force_destroy = !delete_protection` (default: protection on — a destroy refuses while the bucket is non-empty; D57). |
| 3 | `aws_s3_bucket_versioning` | ↑ | **Enabled**. Deletes become delete markers, so the object sweep (D6), a leaked token or a client mass-delete are all recoverable. Needs no IAM change — the role's `s3:DeleteObject` writes a marker, and it deliberately lacks `s3:DeleteObjectVersion`, so the API cannot destroy a photo. Guard-tested (mutation-checked). |
| 4 | `aws_s3_bucket_public_access_block` | ↑ | All four blocks on. |
| 5 | `aws_s3_bucket_cors_configuration` | ↑ | `GET/PUT/POST/HEAD`, origins `*`, exposes `ETag` (multipart). For browser clients PUTting to presigned URLs. |
| 6 | `aws_s3_bucket_lifecycle_configuration` | ↑ | Three rules: `originals-to-glacier-ir` (day 0, filtered on object tag `tier=original` — D7), `abort-incomplete-multipart` (7 days), and `expire-noncurrent-versions` (30 days — the paid-for half of row 3). No DEEP_ARCHIVE anywhere; guard-tested in [test/infra/lifecycle.test.ts](test/infra/lifecycle.test.ts). |

### Stateless (`modules/compute`)

| # | Type | Name / identifier | Notes |
|---|---|---|---|
| 7 | `aws_iam_role` | `ente-sl-dev-api` | One execution role, **shared by both functions**. |
| 8 | `aws_iam_role_policy` | `ente-sl-dev-api` | Inline. Scoped to the table + `/index/*`, the bucket + `/*`, `ses:SendEmail` on `*`, logs on `/aws/lambda/ente-sl-dev-*` — plus `sts:AssumeRole` on `*` for BYO pool buckets (D55): deliberate, because assuming a pool role also requires that role's trust policy to name this principal with the mandatory ExternalId, so enumerating pool ARNs would add churn, not security. Guard-tested. |
| 9 | `aws_lambda_function` | `ente-sl-dev-api` | nodejs22.x, **arm64**, 512 MB, 30 s. Zip from `dist/lambda`. |
| 10 | `aws_lambda_function_url` | on ↑ | `authorization_type = "NONE"` — deliberate (CloudFront is the canonical path; IAM auth breaks the POST body hash). |
| 11 | `aws_lambda_permission` | `FunctionURLAllowPublicAccess` | Grants anonymous `lambda:InvokeFunctionUrl`. **Required** — auth NONE alone 403s every caller, CloudFront included. Guard-tested. |
| 12 | `aws_lambda_function` | `ente-sl-dev-trash-purge` | nodejs22.x, arm64, 256 MB, 300 s. Drains the 30-day trash **and** the deferred object-sweep queue (D6). |
| 13 | `aws_cloudwatch_event_rule` | `ente-sl-dev-trash-purge` | `rate(1 day)`. |
| 14 | `aws_cloudwatch_event_target` | ↑ → the purge function | |
| 15 | `aws_lambda_permission` | `AllowEventBridge` | Lets `events.amazonaws.com` invoke the purge function. |
| 16 | `aws_cloudwatch_log_group` | `/aws/lambda/ente-sl-dev-api` | 30-day retention. Created explicitly, so the role does **not** need `logs:CreateLogGroup`. |
| 17 | `aws_cloudwatch_log_group` | `/aws/lambda/ente-sl-dev-trash-purge` | 30-day retention. |
| 18 | `aws_sns_topic` | `ente-sl-dev-alarms` | Alarm fan-out. |
| 19 | `aws_sns_topic_subscription` | email → `alarm_email` (defaults to `mail_from`) | **Needs confirming from the inbox.** Until you click AWS's link the subscription stays pending and silently drops every alarm. |
| 20 | `aws_cloudwatch_metric_alarm` | `ente-sl-dev-api-errors` | Lambda `Errors` > 0 over 5 min. |
| 21 | `aws_cloudwatch_metric_alarm` | `ente-sl-dev-trash-purge-errors` | Lambda `Errors` > 0 over **86400 s** — a daily window for a daily cron. The failure this exists for: the purge drains the D6 object-sweep queue, so a silently dead cron means deleted bytes are never reclaimed and the bill grows with no other signal. |

`Errors` counts **failed invocations** — crashes, timeouts, OOM, init failures.
It does *not* count application errors hono handles and returns, so the SES-500
on `POST /users/ott` will not fire an alarm. That one is a log concern.

### Edge (`modules/edge`)

| # | Type | Name / identifier | Notes |
|---|---|---|---|
| 22 | `aws_cloudfront_distribution` | comment `ente-sl-dev api` | `PriceClass_All` (FREE-plan requirement, D47; the old `PriceClass_200` analysis in §2.1 applies only on pay-as-you-go), IPv6 on, default `*.cloudfront.net` cert, no OAC (deliberate — same finding as immich-serverless). Managed **CachingDisabled** + **AllViewerExceptHostHeader** policies. All 7 methods allowed. Its domain is the `server_url` output the app gets pointed at. |

### Albums web hosting (`modules/web`) — Phase F, D52

Static hosting for the pinned albums viewer (`ORACLE-VERSION` "albums web"
line; built by `make build-web`, synced by `make deploy-web`). A **second**
distribution, deliberately: share links are `<albums_url>/?t=<token>` and that
base URL must not be the API's (museum's `apps.public-albums` is a separate
origin), and keeping the API distribution untouched preserves the exact
resource pair the D47 FREE-plan subscription covers.

| # | Type | Name / identifier | Notes |
|---|---|---|---|
| 23 | `aws_s3_bucket` | `ente-sl-dev-web-albums-<account>` | Build artifacts only — unconditionally `force_destroy = true` (not tied to `delete_protection`), **no** versioning: `make destroy` takes it down and `make build-web && make deploy-web` restores it. Never confuse with the objects bucket. |
| 24 | `aws_s3_bucket_public_access_block` | ↑ | All four blocks on. The bucket is never public. |
| 25 | `aws_s3_bucket_policy` | ↑ | `s3:GetObject` to the `cloudfront.amazonaws.com` service principal only, condition-pinned (`AWS:SourceArn`) to distribution 27. |
| 26 | `aws_cloudfront_origin_access_control` | `ente-sl-dev-web-albums` | sigv4, `signing_behavior = always`. The repo's "no OAC" decision applies to the **Lambda** origin (IAM auth breaks the POST body hash); an S3 origin takes OAC cleanly and must have it. |
| 27 | `aws_cloudfront_distribution` | comment `ente-sl-dev albums web` | `PriceClass_100` (pay-as-you-go — see the WAF/pricing note below), default `*.cloudfront.net` cert. Managed **CachingOptimized** default (hashed assets), **CachingDisabled** pinned to `/index.html` (it names the current asset hashes), managed SecurityHeadersPolicy. SPA fallback: 403 **and** 404 → `/index.html` as 200, `error_caching_min_ttl = 0` (OAC without ListBucket surfaces a missing key as 403, so both codes must map). Its domain is the `albums_url` output → the Lambda's `ALBUMS_URL`. |

Two pricing consequences, both deliberate (D52):

- **This distribution stays on pay-as-you-go** — the D47 FREE-plan
  subscription covers exactly the API distribution + its web ACL, and a few MB
  of static assets at share-link traffic sits inside CloudFront's perpetual
  free tier (1 TB / 10M requests per month) either way. Do not add it to the
  pricing plan; do not point `make pricing-plan` at it.
- **No WAF here.** A web ACL is $5/mo flat on pay-as-you-go and a cached
  static origin has no per-request compute to protect. Rate limiting for the
  anonymous **`/public-collection/*` API surface** (plan §4.1a) lives on the
  **API** distribution, which those requests ride: the D47-reshaped
  2000/5min/IP rate rule covers them like every other route. A *tighter,
  path-scoped* rate rule is not possible under the FREE plan — scoping a rate
  statement to the `/public-collection` prefix needs a byte-match scope-down,
  exactly the feature the FREE tier gates — so the narrower bounds are
  app-level and per-link instead (D51: token check as one `GetItem`
  cheap-fail, verify-password attempt caps, per-link daily download/upload
  ceilings, short public presigns), with reserved concurrency and the budget
  alarms as the bill fuses. Restore the 300/5min scoped rule only if the plan
  is ever cancelled back to pay-as-you-go.

Everything carries default tags `Project=ente-serverless`, `Env=dev`,
`ManagedBy=opentofu`.

### Not resources, but read/built at plan time

- `data.aws_caller_identity.current` — supplies the bucket-name suffix.
- `data.archive_file.api` / `.trash_purge` — zip `dist/lambda` and
  `dist/trash-purge`. **These fail at plan time if `make build-lambda` has not
  run.** `make plan` now depends on `build-lambda`, so this is handled.

## 2. What tofu does NOT create — the out-of-band prerequisites

These are the actual gating work for the first apply.

1. **The AWS account and region.** Still open per D4. The region choice binds
   Lambda, DynamoDB, S3 and — critically — **SES**: the mail adapter uses the
   Lambda's own `AWS_REGION`, so the verified identity must live in the same
   region. The region lives in `ente-sl.tfvars` alongside the other deploy
   config, and the make targets pass only `-var-file`, so plan and apply cannot
   disagree about it. Note that **tofu ignores your AWS CLI's configured
   region** — `aws configure get region` says nothing about where this lands.
   The price class is **settled, not open** — but by D47 now, not by cost:
   the flat-rate FREE plan refuses a restricted price class, so `edge/main.tf`
   pins `PriceClass_All` (guarded). The analysis below compared `_200` to
   `_100` for pay-as-you-go and applies again only if the plan is ever
   cancelled: `edge/main.tf` then pinned `PriceClass_200`. `PriceClass_100` covers only US, Canada, Europe and
   Israel, so Asian viewers hitched to a distant edge on every API round-trip.
   Checked against the AWS price-list API rather than assumed, the upgrade is
   free in all but name — every region `_200` adds (India, Asia Pacific,
   Japan, Middle East, South Africa) bills at **$0.0120 per 10k HTTPS
   requests, identical to Europe**, which `_100` already exposed us to. The
   only dearer request regions are Australia ($0.0125) and South America
   ($0.0220), and both sit in `_All`, not `_200`. Worst case is a request that
   would have hit a US edge at $0.0100 landing on Mumbai at $0.0120: **+20%,
   or +$0.002 per 10,000 requests**. Egress differs more in percentage terms
   ($0.085/GB US-CA-EU vs $0.109 India vs $0.120 Asia Pacific) but is
   near-irrelevant here — CachingDisabled means only small JSON crosses this
   distribution; bytes come from S3 presigned either way. And CloudFront's
   **1 TB / 10M-request perpetual free tier survived the Nov 2025 flat-rate
   plan launch and still applies to pay-as-you-go usage**, which this
   distribution is on, so realistic volumes bill $0 under either class. At 1M
   requests + 4 GB/month — roughly 10× a real single-install load — the whole
   difference is 10–30 cents. Latency, not cost, was always the only axis;
   nothing on that axis argued for `_100`.

2. **The SES identity.** No tofu resource creates it; `mail_from` is an
   unvalidated string, so a wrong value costs nothing at apply and surfaces at
   the first signup instead (see below). **A single verified ADDRESS is enough —
   no domain is required.** Verify your own inbox in the SES console for the
   deploy region and use that.

   **Production access is NOT on the critical path for a private install** —
   this corrects an earlier draft of this document, which called the sandbox
   exit the longest-lead blocker. The sandbox delivers only to *verified*
   recipients at 200/day, 1/sec; for a server whose users are the owner and a
   few family members that is an access-control mechanism rather than a limit
   (verify each person once). Request production access only if strangers must
   self-serve signup.
   - *Deliverability caveat:* an `@gmail.com`-style sender cannot align SPF and
     DKIM with that domain's DMARC, so some receivers will spam-file it.
     Acceptable for codes sent to yourself; a cheap domain is the real fix.
   - *Failure signature:* `deps.mail.send()` in `handlers/users/sendOtt.ts` is
     awaited unhandled and runs *after* `storeOtt`, so an SES rejection is a
     **500 on `POST /users/ott`** with the OTT already persisted and never
     delivered. If signup 500s, check the identity before the code.

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

- **~~The public-invoke permission on the Function URL is missing.~~**
  *(fixed 2026-08-17, before the first apply.)* `authorization_type = "NONE"`
  does not by itself add the resource-based policy statement that admits
  anonymous callers — the console adds it silently when you create a public
  Function URL by hand, the API does not. Without it every request 403s,
  CloudFront's included, which reads as a broken edge while the lambda is fine.
  Now row 10 (`aws_lambda_permission.api_public_url`), with a guard test that
  was mutation-checked. `make smoke` still checks it post-apply, because a
  guard proves the config, not the deployment.

- **The bucket name embeds the account id, so wrong-account credentials plan a
  destroy of the photo store.** *(finding 2026-08-17, hit on the first replan.)*
  `local.suffix = data.aws_caller_identity.current.account_id`, so the desired
  bucket name is a function of whoever is authenticated. Running `plan` with an
  ambient profile pointing at a different account (easy when the machine already
  has a deployer for another project) computes a different name, and tofu reads a
  name change as **destroy-and-recreate** — `bucket` is the force-new attribute.
  `prevent_destroy` did stop it, which is exactly what it is for, but the plan
  reads like a config bug rather than a wrong profile.
  - **The rails were uneven:** the bucket and table are protected; the lambdas,
    the IAM role and the SNS topic are not, and would have been replaced without
    comment.
  - Fixed by `make guard-account`, a prerequisite of `plan`, `deploy` and
    `destroy`. It compares `sts:GetCallerIdentity` against the account already
    recorded in `terraform.tfstate` and refuses on mismatch, naming both
    accounts. Needs no new configuration — the state is the source of truth —
    and it no-ops on a first deploy when there is no state yet. Guard-tested.
  - *Corollary worth internalising:* moving this deployment to another AWS
    account is **not** a re-point, it is a fresh deployment. The bucket name
    cannot follow you.

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
  is the upgrade if this ever grows a second operator. Since D55 it also keys
  the secretbox encryption of keys-mode pool credentials, so leaking it leaks
  those too — one more reason it stays the deployment's single root secret.

- **Auth tokens can travel in the query string.** Museum accepts `?token=` on
  every private route and the web/desktop client relies on it for thumbnails
  (D32), so we match it. Query strings are logged by CloudFront/ALB access logs
  by default and leak via `Referer` — if access logging is ever switched on for
  this distribution, redact `token`, and never enable a cache policy that keys
  on the full query string for these routes. Our own gate logger prints the
  path only (verified), so `make lan` does not echo tokens.

- ~~**No abuse protection at the edge.**~~ (fixed 2026-08-17, D43: WAF rate
  rule + the origin lock below; reshaped 2026-08-19, D47, to an unscoped
  2000/5min/IP rule so the WAF costs $0 under the FREE pricing plan.) The
  original finding, for the
  record: the Function URL is auth NONE, and there
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

- **Teardown is deliberately hard, and the rails are variable-driven (D57).**
  The old lifecycle `prevent_destroy` blocks are gone — tofu only accepts
  them as literals, so they could never vary per environment, and they only
  ever stopped tofu itself. In their place one module variable,
  `delete_protection` (default **true**), drives two API-level rails:
  `deletion_protection_enabled` on the table (blocks `DeleteTable` for
  everyone, console included — strictly stronger than `prevent_destroy`) and
  `force_destroy = !delete_protection` on the objects bucket (protection on:
  the destroy refuses while the bucket is non-empty — today's effective
  behavior; the web-albums bucket in row 23 is build artifacts and stays
  unconditionally `force_destroy`). `make destroy` is scoped to
  `module.compute` + `module.edge` + `module.web` only — it removes the
  lambdas, the cron, the logs, both distributions and the web bucket, and
  cannot reach a photo — and since D57 it is also profile-aware: it banners
  `>>> profile: <name> (ENV: PRODUCTION|TEST)` and requires the profile name
  typed back (or `CONFIRM=<profile>`). On the **test** profile with
  `delete_protection = false` in its tfvars, full teardown is
  `make profile test && make destroy` followed by the `destroy-data` steps —
  which now amount to flipping the variable and destroying, no console
  surgery. On **dev (= production)** `make destroy-data` still refuses
  outright and prints the manual steps. Guard-tested so neither the scoping
  nor the protection default can be widened by an edit. **Re-applying after a
  destroy mints new CloudFront domains and a new function URL**, so every
  client needs re-pointing, the albums app needs rebuilding against the new
  `server_url` (INSTALL C13), and share links minted before the destroy point
  at the dead albums domain (tokens stay valid — re-copy each link from the
  app) — that, not data loss, is the real cost of tearing the stateless half
  down.

- **The deployer policy is a privilege-escalation path if leaked.** It grants
  `iam:CreateRole` + `iam:PutRolePolicy` + `iam:PassRole` on `ente-sl-*` with no
  permissions boundary — enough to mint an admin role and pass it to a Lambda.
  Fine when the deployer *is* the account owner; not fine if it ever becomes a
  CI credential. Add a permissions boundary before that happens.

- **The deployer policy did need widening on the first apply — now resolved.**
  *(finding 2026-08-17, from a real apply.)* It failed on
  `s3:GetReplicationConfiguration` while reading back the bucket it had just
  created. The cause is an S3 naming trap worth remembering: **several
  bucket-level IAM action names do not match their API names**, so a
  `s3:GetBucket*` wildcard silently fails to cover them. The API is
  `GetBucketReplication`; the IAM action is `s3:GetReplicationConfiguration`.
  `GetAnalyticsConfiguration`, `GetMetricsConfiguration` and
  `GetIntelligentTieringConfiguration` are the same shape, and the provider
  reads several of them on every `aws_s3_bucket` refresh.
  Fixed by widening the *actions* to `s3:Get*` / `s3:Put*` / `s3:List*` while
  keeping the *resource* pinned to `arn:aws:s3:::ente-sl-*`, which ends the
  whack-a-mole without loosening blast radius. SNS got the same treatment
  (`sns:Get*`/`List*`/`Set*`) pre-emptively, since `aws_sns_topic` reads a data
  protection policy that the enumerated list missed.
  - **Consequence, and the reason for the new `Deny`:** the store used to be
    protected only by *omitting* `s3:DeleteBucket` and `dynamodb:DeleteTable`.
    An omission means nothing once action wildcards are in play, so both are now
    explicitly denied in a `NeverDeleteTheStore` statement — a Deny cannot be
    widened by a later wildcard. Lift it only as one of the deliberate steps in
    `make destroy-data`. Guard-tested.
  - **A Deny over an omission is decorative — learned the hard way, 2026-08-17.**
    The `Deny` was first added on top of actions the policy never granted, which
    withheld nothing that deny-by-default hadn't already withheld. The tell came
    during a deliberate teardown: removing the `Deny` changed nothing and the
    destroy still failed `AccessDenied: no identity-based policy allows
    s3:DeleteBucket`. **A Deny is only a rail if there is an Allow beneath it.**
    So `s3:Delete*` and `dynamodb:DeleteTable` are now permanently allowed and
    `NeverDeleteTheStore` is the single thing withholding them — which also makes
    the teardown procedure honest: remove one statement and the destroy genuinely
    becomes possible. The guard asserts *both* halves (allowed, and denied),
    wildcard-aware, so this cannot regress into decoration again.
  - **Listing actions cannot be resource-scoped — cost one more apply.**
    `logs:DescribeLogGroups` failed even though `logs:Describe*` was granted,
    because AWS authorises listing calls against a placeholder ARN with an
    **empty name** — `arn:aws:logs:REGION:ACCT:log-group::log-stream:` — which
    can never match `log-group:/aws/lambda/ente-sl-*`. The scoped grant looks
    right and fails only mid-apply. Such actions now live in a separate
    `ListingNeedsWildcard` statement on `Resource: "*"`; they are read-only
    metadata calls, so the widening is immaterial. `cloudwatch:DescribeAlarms`
    is in there defensively — the alarms actually read fine under a scoped ARN,
    but AWS's authorization reference lists it with no resource types.
    Guard-tested.
  - *Aside:* a JSON policy cannot carry comments, and IAM rejects any
    unrecognised statement key with `MalformedPolicyDocument` — so the rationale
    lives here rather than inline. A guard now asserts every statement uses only
    IAM-recognised keys.

### Confirmed sound

The execution role covers exactly what the code calls, no more. Adapters issue
`Get/Put/Update/Delete/Query/TransactWrite` on DynamoDB (no `Scan`), and
`GetObject / PutObject / DeleteObject / HeadObject / PutObjectTagging /
CreateMultipartUpload` plus presigned multipart on S3, and `ses:SendEmail`,
and (D55) `sts:AssumeRole` against pool roles. Every one has a matching
statement; `HeadObject` rides on `s3:GetObject` and the client's presigned
multipart calls ride on the role's `PutObject` + `AbortMultipartUpload` +
`ListMultipartUploadParts`. The two broad resources are deliberate:
`ses:SendEmail` on `*` (could be narrowed to the identity ARN) and
`sts:AssumeRole` on `*` (the pool role's own trust policy + ExternalId is the
real gate — see row 8).

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
| WAF (web ACL + D43 rate rule) | $5 + $1 flat + $0.60/1M req | $0 under D47, else ≈ $6 |
| CloudWatch Logs | 30-day retention, $0.50/GB ingest | < $1 |
| SES | $0.10 / 1,000 mails | ~$0 |
| Albums web (S3 + CloudFront static, D52) | a few MB of assets, `PriceClass_100`, pay-as-you-go free tiers | ~$0 (pennies at worst) |
| **Baseline** | | **≈ $3–5** |

The WAF line is the one worth understanding: on pay-as-you-go its flat fees
dwarf every other line, so the distribution subscribes to the CloudFront
flat-rate **FREE** pricing plan (`make pricing-plan`, D47), which covers the
web ACL, the rule, and all CloudFront/WAF request fees for this distribution.
Its 1M-request / 100 GB monthly allowances see only the small-JSON API path —
photo bytes ride presigned S3 URLs straight to the bucket and never touch the
distribution — and exceeding them never bills; AWS emails, and only sustained
excess degrades edge placement. If demand outgrows FREE, revert to
pay-as-you-go rather than Pro ($15/mo only wins past ~15M requests/month).

Variable, and the part that actually matters: **GIR retrieval at $0.03/GB** plus
**S3 egress at $0.09/GB** on every full-resolution download past the first
100 GB/month. Browsing is cheap (thumbnails stay Standard); a full library
restore is not — 500 GB out is roughly $15 retrieval + $36 egress.

BYO storage pools (D55) change whose bill the storage lines land on, not the
totals: a pooled user's S3 storage, retrieval and egress bill to the
household's own bucket account, leaving this account the control plane —
roughly $1–3/month — plus storage for any users still on the central bucket
(plan §7 records the cost outcome).

## 5. Prep checklist, in order

Steps 1–4 are the out-of-band work; from step 5 on it is all make targets.

1. **Decide the account and region** (closes half of D4). The region binds SES,
   so this must come first. The price class no longer factors in — D47 settles
   it at `PriceClass_All` — but the region still fixes where the origin lives,
   which is the round-trip the nearer edge cannot shorten.
2. **Verify one SES identity in that region** — your own email address is
   enough; no domain, no support ticket, no waiting. Stay in the sandbox and
   verify each intended user's address as a recipient (see §2.2). File for
   production access only if strangers must self-serve signup.
3. **Create the deployer principal** from `src/infra/deployer-policy.json`.
   Put its keys in a dedicated profile (`AWS_PROFILE=ente-sl`) rather than
   reusing an existing deployer, so the credential in play is always explicit.
   The IAM console may warn that `cloudfront:CreateDistributionWithTags` is an
   unrecognized action — that is a validator quirk, the action is real and
   `default_tags` means the provider needs it. Save anyway; don't remove it.
4. **`cp src/infra/dev/ente-sl.tfvars.example src/infra/dev/ente-sl.tfvars`**,
   fill in `region`, `mail_from` and `hashing_key`, and **back the key up
   off-machine before applying** (D4a).
5. **`make infra-init`** — regenerates `.terraform/` and the lock file, both
   dropped by the repo split.
6. **`make plan`** — rebuilds the bundles first (so `dist/` can never be stale
   at plan time), refuses with instructions if the tfvars file is missing, and
   saves `tfplan`. Expect **27 to add, 0 to change, 0 to destroy** on a fresh
   deploy (an existing pre-Phase-F deployment instead adds the 5 `module.web`
   resources and updates the API Lambda's env). Read it.
7. **`make deploy`** — applies the *saved* plan, so what ships is what you
   reviewed, then prints the outputs. The two CloudFront distributions take
   5–15 minutes to reach Deployed; the other 25 resources are quick. Then
   confirm the SNS
   subscription email, or the alarms in rows 20-21 never reach you.
8. **`make smoke`** — pings the function URL and the distribution. Healthy is
   **403 on the function URL** (the D43 origin lock refusing a direct call)
   and **200 via CloudFront**. Both returning 403 would mean row 11's
   public-invoke permission went missing or the origin secret is mismatched;
   a guard makes that unlikely now, but the config is not the deployment.
9. **Replay the M1–M6 gate scripts against `server_url`**, then the stock app
   over the internet (build plan M7).

To tear the stateless half back down: `make destroy` (data preserved; clients
need re-pointing at the new `server_url` afterwards). There is no target that
deletes the photos — see the teardown entry in §3.

Tooling on this machine is ready: OpenTofu 1.12.5, AWS CLI 2.36.24.
