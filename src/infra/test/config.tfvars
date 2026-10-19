# COMMITTED settings for the TEST deployment (D67). Safe for a public repo:
# nothing private lives here. hashing_key, mail_from, alarm_email and
# operator_principal_arns are kept in s3://ente-sl-tfstate-<account>/secrets/test.tfvars
# and fetched by `make plan` for the run only (make secrets-pull / secrets-push).
# `make tfvars-check` (and the infra tests) refuse this file if a private value
# lands in it. Values below were read off the live deployment on 2026-10-19.

# MUST be a FRESH key: openssl rand -base64 32
# NEVER paste production's hashing_key here. The key derives the email->user
# mapping, so sharing it across environments links every test account to its
# production identity — and a leaked/committed test key would then compromise
# prod. A throwaway env gets a throwaway key.
# hashing_key = <private: secrets/<env>.tfvars in the state bucket — make secrets-pull>

# Any SES-verified identity in `region` below (sandbox is fine — verify your
# own inbox in the SES console for that region).
# mail_from = <private: secrets/<env>.tfvars in the state bucket — make secrets-pull>

# Where this test env deploys. Independent of prod's region — a different one
# is fine and keeps the two stacks visually unmistakable in the console.
region = "ap-southeast-1"

# Names everything: table ente-sl-test, bucket ente-sl-test-objects-<account>,
# both lambdas, the IAM role, the log groups, the Env tag.
env_name = "test"

# D57: OFF for a test env — `make profile test && make destroy` (and the
# destroy-data steps) can then tear everything down, data included, with no
# console surgery. Leave true only if this env starts holding photos you care
# about. Production (src/infra/dev) defaults to true and must stay true.
delete_protection = false

# Optional knobs — same meaning as in src/infra/dev/ente-sl.tfvars.example:
# alarm_email = <private when set: secrets/<env>.tfvars>
# albums_url  = "https://albums-test.example.com"
# signup_mode = "invite"

# Optional. Who may assume ente-sl-<env>-operator, the role the tools/ CLI runs
# under (invite.ts, storagePool.ts — they need dynamodb:Scan the request path
# lacks, D64). Omit to trust the ACCOUNT ROOT — the self-host default. Set it to
# specific IAM user / SSO-role ARNs to narrow who can assume it, then point an
# AWS profile's role_arn at the role (`AWS_PROFILE=... make invite ...`).
# operator_principal_arns = <private when set: secrets/<env>.tfvars>

# Days originals stay in Standard before GLACIER_IR (D59, default 7): day N
# in Standard ≈ $0.023/GB-mo prorated vs GIR retrieval $0.03/GB on early views.
# gir_transition_days = 7
