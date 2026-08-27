# All commands run from ente-serverless/. Nothing here needs an AWS account.

LOCALSTACK_ENV = AWS_ENDPOINT_URL=http://127.0.0.1:4567 AWS_REGION=us-east-1 \
	AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
	TABLE_NAME=ente-serverless BUCKET_NAME=ente-objects \
	HASHING_KEY=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=

.PHONY: test test-int typecheck up down bootstrap dev ledger oracle-up oracle-down infra-test \
	build-lambda capture-diff lan infra-init guard-account plan deploy outputs smoke destroy destroy-data \
	pricing-plan pricing-plan-status build-web deploy-web invite invites revoke-invite set-storage \
	pool-create pool-attach pool-detach pools pool-set-quota pool-disable pool-enable pool-requeue

test:
	npx vitest run test/unit

test-int:
	$(LOCALSTACK_ENV) npx vitest run test/integration

typecheck:
	npx tsc --noEmit

up:
	docker compose up -d --wait

down:
	docker compose down

bootstrap:
	$(LOCALSTACK_ENV) node --experimental-transform-types scripts/bootstrap-local.ts

dev: bootstrap
	$(LOCALSTACK_ENV) npm run dev

# M5 device gate: serve on the Mac's LAN IP so a phone on the same wifi can
# reach it. AWS_ENDPOINT_URL uses the LAN IP too, so presigned S3 URLs are
# reachable FROM THE PHONE (127.0.0.1 presigns were the first gate failure).
# Test signups: any @example.org email verifies with OTT 123456.
# Full steps: RUNBOOK-M5.md
lan:
	@IP=$$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1); \
	echo "==> point the ente app at: http://$$IP:8080 (7-tap custom endpoint)"; \
	AWS_ENDPOINT_URL=http://$$IP:4567 AWS_REGION=us-east-1 \
	AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
	TABLE_NAME=ente-serverless BUCKET_NAME=ente-objects \
	HASHING_KEY=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc= \
	node --experimental-transform-types scripts/bootstrap-local.ts; \
	AWS_ENDPOINT_URL=http://$$IP:4567 AWS_REGION=us-east-1 \
	AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
	TABLE_NAME=ente-serverless BUCKET_NAME=ente-objects \
	HASHING_KEY=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc= \
	HARDCODED_OTT_SUFFIX=@example.org HARDCODED_OTT_VALUE=123456 \
	LOG_REQUESTS=1 PORT=8080 npm run start

ledger:
	node --experimental-transform-types tools/ledger.ts

# ---------------------------------------------------------------------------
# Invite-gated signup + per-user storage (Phase H1, D54) — operator tooling,
# never a client surface. Env-driven exactly like the Lambda: TABLE_NAME +
# AWS credentials/region select the deployment; add the $(LOCALSTACK_ENV)
# variables (or `env $(LOCALSTACK_ENV) make invite ...`) to hit LocalStack.
# set-storage additionally needs HASHING_KEY (user lookup is hash-keyed);
# invite/list/revoke deliberately do not (invite rows key on plain email).
#   make invite EMAIL=alice@example.com [STORAGE_GB=50] [VIEWER=1]
#   make invites
#   make revoke-invite EMAIL=alice@example.com
#   make set-storage EMAIL=alice@example.com STORAGE_GB=50   (or STORAGE_GB=default)
# STORAGE_GB=0 means ZERO bytes — a viewer-style no-upload account, not "off".
# ---------------------------------------------------------------------------
INVITE_TOOL = node --experimental-transform-types tools/invite.ts

invite:
	@test -n "$(EMAIL)" || { echo "usage: make invite EMAIL=... [STORAGE_GB=...] [VIEWER=1]"; exit 1; }
	@$(INVITE_TOOL) invite "$(EMAIL)" \
		$(if $(STORAGE_GB),--storage-gb $(STORAGE_GB)) $(if $(VIEWER),--viewer)

invites:
	@$(INVITE_TOOL) list

revoke-invite:
	@test -n "$(EMAIL)" || { echo "usage: make revoke-invite EMAIL=..."; exit 1; }
	@$(INVITE_TOOL) revoke "$(EMAIL)"

set-storage:
	@test -n "$(EMAIL)" -a -n "$(STORAGE_GB)" || { echo "usage: make set-storage EMAIL=... STORAGE_GB=<n|default>"; exit 1; }
	@$(INVITE_TOOL) set-storage "$(EMAIL)" "$(STORAGE_GB)"

# ---------------------------------------------------------------------------
# BYO storage pools (Phase H2, D55) — operator tooling, never a client
# surface. One pool = one S3 bucket shared by many users (a household);
# object keys stay <userID>/<uuid>, and pool membership never grants access
# to other members' photos. Env-driven exactly like tools/invite.ts.
# pool-create runs a validation checklist (creds, HeadBucket, PUT/GET/DELETE
# probe, tagging, multipart, public-access-block, CORS, abort-MPU lifecycle)
# and REFUSES to onboard on hard failures. HASHING_KEY is needed by
# pool-create in keys mode (credential encryption) and by
# pool-attach/pool-detach (hashed user lookup).
#   make pool-create POOL=smith BUCKET=smith-photos REGION=eu-west-1 \
#        ROLE_ARN=arn:aws:iam::123:role/ente-pool EXTERNAL_ID=$(openssl rand -hex 16)
#   POOL_ACCESS_KEY=... POOL_SECRET_KEY=... \
#        make pool-create POOL=smith BUCKET=... REGION=... [ENDPOINT=...]
#        (RECOMMENDED keys form: env vars stay out of `ps` and shell history;
#        the ACCESS_KEY=.../SECRET_KEY=... make-var form still works but both
#        values are visible in the process list and your history file)
#   make pool-attach EMAIL=alice@example.com POOL=smith   (user row, or invite row pre-signup)
#   make pool-detach EMAIL=alice@example.com
#   make pools
#   make pool-set-quota POOL=smith STORAGE_GB=<n|unlimited>
#   make pool-disable POOL=smith / make pool-enable POOL=smith
# ---------------------------------------------------------------------------
POOL_TOOL = node --experimental-transform-types tools/storagePool.ts

pool-create:
	@test -n "$(POOL)" -a -n "$(BUCKET)" -a -n "$(REGION)" || { \
		echo "usage: make pool-create POOL=... BUCKET=... REGION=... (ROLE_ARN=... EXTERNAL_ID=... | POOL_ACCESS_KEY/POOL_SECRET_KEY env | ACCESS_KEY=... SECRET_KEY=... [ENDPOINT=...]) [STORAGE_GB=...]"; \
		echo "  keys mode: prefer the POOL_ACCESS_KEY/POOL_SECRET_KEY env vars — make vars land in ps/shell history"; exit 1; }
	@$(POOL_TOOL) create "$(POOL)" --bucket "$(BUCKET)" --region "$(REGION)" \
		$(if $(ROLE_ARN),--role-arn "$(ROLE_ARN)") $(if $(EXTERNAL_ID),--external-id "$(EXTERNAL_ID)") \
		$(if $(ACCESS_KEY),--access-key "$(ACCESS_KEY)") $(if $(SECRET_KEY),--secret-key "$(SECRET_KEY)") \
		$(if $(ENDPOINT),--endpoint "$(ENDPOINT)") $(if $(STORAGE_GB),--storage-gb $(STORAGE_GB))

pool-attach:
	@test -n "$(EMAIL)" -a -n "$(POOL)" || { echo "usage: make pool-attach EMAIL=... POOL=..."; exit 1; }
	@$(POOL_TOOL) attach "$(EMAIL)" "$(POOL)"

pool-detach:
	@test -n "$(EMAIL)" || { echo "usage: make pool-detach EMAIL=..."; exit 1; }
	@$(POOL_TOOL) detach "$(EMAIL)"

pools:
	@$(POOL_TOOL) list

pool-set-quota:
	@test -n "$(POOL)" -a -n "$(STORAGE_GB)" || { echo "usage: make pool-set-quota POOL=... STORAGE_GB=<n|unlimited>"; exit 1; }
	@$(POOL_TOOL) set-quota "$(POOL)" "$(STORAGE_GB)"

pool-disable:
	@test -n "$(POOL)" || { echo "usage: make pool-disable POOL=..."; exit 1; }
	@$(POOL_TOOL) disable "$(POOL)"

pool-enable:
	@test -n "$(POOL)" || { echo "usage: make pool-enable POOL=..."; exit 1; }
	@$(POOL_TOOL) enable "$(POOL)"

# Drain a deleted/unresolvable pool's QUARANTINED sweep rows by re-pinning
# them to another pool or the central bucket (D56). Running it ASSERTS the
# bytes actually live in the target bucket — the CLI restates this.
#   make pool-requeue POOL=smith [TO=<poolId>|central]   (default: central)
pool-requeue:
	@test -n "$(POOL)" || { echo "usage: make pool-requeue POOL=... [TO=<poolId>|central]"; exit 1; }
	@$(POOL_TOOL) requeue "$(POOL)" $(if $(TO),--to "$(TO)")

oracle-up:
	docker compose -f docker-compose.oracle.yml up -d --wait

oracle-down:
	docker compose -f docker-compose.oracle.yml down

# Plan-time guard tests over the tofu config (storage classes, lifecycle).
infra-test:
	npx vitest run test/infra

# Zip payloads for the tofu compute module (plain esbuild — no container).
#
# ESM_REQUIRE_SHIM: bundled CJS deps that call require() at runtime (qrcode's
# PNG renderer does `require("fs")`) throw "Dynamic require ... is not
# supported" in an ESM bundle. Local dev never sees it — node runs the TS
# directly — so this only ever fails in the deployed Lambda. D36.
# The import is aliased because src/lib/sodium.ts (D25) already imports
# createRequire, and esbuild hoists that to the same top-level scope.
ESM_REQUIRE_SHIM = import{createRequire as __entRequire}from'module';const require=__entRequire(import.meta.url);

build-lambda:
	npx esbuild src/lambda.ts --bundle --platform=node --format=esm --target=node22 \
		--banner:js="$(ESM_REQUIRE_SHIM)" \
		--outfile=dist/lambda/index.mjs --external:@aws-sdk/* --external:libsodium-wrappers
	npx esbuild src/workers/trashPurge.ts --bundle --platform=node --format=esm --target=node22 \
		--banner:js="$(ESM_REQUIRE_SHIM)" \
		--outfile=dist/trash-purge/index.mjs --external:@aws-sdk/* --external:libsodium-wrappers
	cp -R node_modules/libsodium-wrappers dist/lambda/node_modules/libsodium-wrappers 2>/dev/null || \
		(mkdir -p dist/lambda/node_modules && cp -R node_modules/libsodium-wrappers node_modules/libsodium dist/lambda/node_modules/)
	mkdir -p dist/trash-purge/node_modules && cp -R node_modules/libsodium-wrappers node_modules/libsodium dist/trash-purge/node_modules/ 2>/dev/null || true

capture-diff:
	node --experimental-transform-types tools/capture-diff.ts

# ---------------------------------------------------------------------------
# Albums web viewer (Phase F, D52) — the second client in the compatibility
# contract (plan §3 caveat 5). PINNED, same discipline as the museum image:
# this tag must match the "albums web" line in ORACLE-VERSION (guard-tested).
# photos-v1.3.61 = ente-io/ente release of 2026-08-11; the albums app lives
# at web/apps/albums in that monorepo and rides the photos-v* tag family
# (it has no tag family of its own).
#
# Build facts, verified against the repo at the pinned tag's era:
#   - web/ is an npm workspace (engines pin npm 11.x); `npm ci` then
#     `npm run build:albums` produces a Next.js STATIC EXPORT at
#     web/apps/albums/out/ — pure files, which is why a private S3 bucket
#     behind CloudFront (modules/web) can serve it.
#   - NEXT_PUBLIC_ENTE_ENDPOINT is baked in AT BUILD TIME (web/apps/albums/
#     .env); changing the API URL means rebuilding, not re-syncing.
# ---------------------------------------------------------------------------
ALBUMS_WEB_TAG  = photos-v1.3.61
ALBUMS_WEB_REPO = https://github.com/ente-io/ente

# Builds LOCALLY into dist/web-albums (gitignored). Deploys nothing.
# The API origin the build bakes in: pass ALBUMS_API_ORIGIN=https://... or,
# when the stack is already deployed, let it default to the server_url output.
build-web:
	@command -v git >/dev/null || { echo "git is required"; exit 1; }
	@command -v npm >/dev/null || { echo "npm is required (the ente web workspace pins npm 11.x — a very old npm may refuse)"; exit 1; }
	@ORIGIN="$${ALBUMS_API_ORIGIN:-$$($(TF) output -raw server_url 2>/dev/null)}"; \
	case "$$ORIGIN" in \
		http*) ;; \
		*) echo "no API origin: pass ALBUMS_API_ORIGIN=https://<server_url> (or deploy first so 'tofu output server_url' resolves)"; exit 1;; \
	esac; \
	echo "==> building ente albums $(ALBUMS_WEB_TAG) against $$ORIGIN"; \
	rm -rf dist/ente-web-src dist/web-albums; \
	git clone --depth 1 --branch $(ALBUMS_WEB_TAG) --filter=blob:none --sparse $(ALBUMS_WEB_REPO) dist/ente-web-src && \
	git -C dist/ente-web-src sparse-checkout set web && \
	cd dist/ente-web-src/web && npm ci && \
	NEXT_PUBLIC_ENTE_ENDPOINT="$$ORIGIN" NEXT_TELEMETRY_DISABLED=1 npm run build:albums || { \
		echo ""; \
		echo "build failed. Prerequisites: git, node >= 20, npm 11.x, network access to"; \
		echo "github.com and the npm registry. The workspace install is large (~2 GB)."; \
		echo "Nothing about the tofu depends on this build — retry after fixing the tool."; \
		exit 1; }
	mkdir -p dist/web-albums
	cp -R dist/ente-web-src/web/apps/albums/out/. dist/web-albums/
	@echo "==> dist/web-albums ready ($$(du -sh dist/web-albums | cut -f1)) — 'make deploy-web' syncs it"

# Syncs the local build to the web bucket and invalidates the distribution.
# Guarded like every other state-mutating target. --delete keeps the bucket
# an exact mirror; a viewer holding a stale index.html mid-deploy re-fetches
# it uncached (the module pins index.html to CachingDisabled) and heals.
deploy-web: guard-account
	@test -d dist/web-albums || { echo "no dist/web-albums — run 'make build-web' first"; exit 1; }
	@test -f dist/web-albums/index.html || { echo "dist/web-albums has no index.html — the albums build did not finish"; exit 1; }
	@BUCKET=$$($(TF) output -raw web_bucket); DIST=$$($(TF) output -raw web_distribution_id); \
	aws s3 sync dist/web-albums "s3://$$BUCKET" --delete && \
	aws cloudfront create-invalidation --distribution-id "$$DIST" --paths "/*" \
		--query 'Invalidation.{id:Id,status:Status}' --output table
	@echo "==> albums app live at $$($(TF) output -raw albums_url)"

# ---------------------------------------------------------------------------
# AWS deploy (M7, decision D4). Everything environment-specific — region,
# hashing_key, mail_from — lives in src/infra/dev/ente-sl.tfvars (gitignored).
# These targets pass ONLY -var-file, so plan and apply can never disagree about
# which region they are addressing. Note that tofu reads the region from that
# file, NOT from your AWS CLI config: the two being different is normal and
# harmless, but it means `aws configure get region` tells you nothing about
# where this deploys.
#
# Credentials come from the environment. Use a dedicated profile so the deployer
# is always explicit:   AWS_PROFILE=ente-sl make plan
# ---------------------------------------------------------------------------
TF     = tofu -chdir=src/infra/dev
# Path is relative to src/infra/dev, because of tofu -chdir above.
TFVARS = ente-sl.tfvars
TFPLAN = tfplan

infra-init:
	$(TF) init

# The objects bucket embeds the account id in its NAME, so running plan/apply
# with credentials for a different account renames it — and tofu reads a rename
# as destroy-and-recreate of the photo store. prevent_destroy does stop that,
# but only after a plan that reads like a config bug rather than a wrong
# profile. Worse, the lambdas/role/topic carry no such rail and WOULD be
# replaced. So: compare the caller against the account already recorded in
# state. No extra config — the state file is the source of truth, and a first
# deploy (no state yet) skips the check.
STATE = src/infra/dev/terraform.tfstate

guard-account:
	@test -s $(STATE) || exit 0; \
	WANT=$$(grep -o 'arn:aws:dynamodb:[^"]*' $(STATE) | head -1 | cut -d: -f5); \
	test -n "$$WANT" || exit 0; \
	HAVE=$$(aws sts get-caller-identity --query Account --output text 2>/dev/null); \
	test "$$WANT" = "$$HAVE" || { \
		echo "ACCOUNT MISMATCH — refusing to continue."; \
		echo "  state was built in : $$WANT"; \
		echo "  your credentials are: $$HAVE"; \
		echo "  The bucket name embeds the account id, so tofu would plan to REPLACE"; \
		echo "  the photo store. Select the right profile, e.g.:"; \
		echo "      AWS_PROFILE=ente-sl make plan"; \
		echo "  If you genuinely mean to move accounts, that is a fresh deployment:"; \
		echo "  clean up the old one and start from an empty state, do not re-point this one."; \
		exit 1; }

# archive_file zips dist/ AT PLAN TIME, so the bundles are rebuilt first —
# an absent or stale dist/ otherwise fails the plan, not the apply.
plan: build-lambda guard-account
	@test -f src/infra/dev/$(TFVARS) || { \
		echo "missing src/infra/dev/$(TFVARS)"; \
		echo "  cp src/infra/dev/ente-sl.tfvars.example src/infra/dev/$(TFVARS)"; \
		echo "  then fill in region, mail_from, and hashing_key (openssl rand -base64 32)"; \
		echo "  BACK UP hashing_key first — losing it orphans every email->user mapping (D4a)"; \
		exit 1; }
	$(TF) plan -var-file=$(TFVARS) -out=$(TFPLAN)

# Applies the SAVED plan, so what ships is exactly what you reviewed.
# The two CloudFront distributions take 5-15 min to reach Deployed; the rest
# of the resources are quick.
deploy: guard-account
	@test -f src/infra/dev/$(TFPLAN) || { echo "no saved plan — run 'make plan' and read it first"; exit 1; }
	$(TF) apply $(TFPLAN)
	@rm -f src/infra/dev/$(TFPLAN)
	@$(MAKE) --no-print-directory outputs

outputs:
	@$(TF) output

# Post-deploy check. With the origin lock (D43) the HEALTHY state is:
#   function-url 403 (app refuses requests without CloudFront's secret header)
#   cloudfront   200
# CloudFront is the disambiguator: 403 on BOTH means the anonymous
# InvokeFunctionUrl permission went missing (or the origin secret is mismatched
# between the lambda env and the distribution's custom_header).
smoke:
	@FU=$$($(TF) output -raw api_function_url); CF=$$($(TF) output -raw server_url); \
	printf '  function-url /ping -> '; curl -sS -o /dev/null -w '%{http_code}  (403 = origin lock working)\n' "$${FU}ping"; \
	printf '  cloudfront   /ping -> '; curl -sS -o /dev/null -w '%{http_code}  (must be 200)\n' "$$CF/ping"; \
	echo "  point the app at: $$CF"

# CloudFront flat-rate FREE plan (D47). One subscription covers exactly this
# distribution and its web ACL, and zeroes what is otherwise the largest fixed
# line on the bill: the WAF web ACL ($5/mo) + rate rule ($1/mo) + all
# CloudFront/WAF request fees. The FREE-tier allowances (1M requests, 100 GB
# transfer per month) see only the small-JSON API path — photo bytes ride
# presigned S3 URLs and never cross the distribution — and are soft: AWS never
# bills overage, it emails and may eventually slow delivery. FREE activates
# immediately; no approval step.
#
# A one-time CLI step, NOT a tofu resource: the AWS provider has no
# pricingplanmanager support yet (hashicorp/terraform-provider-aws#49232) —
# fold it into the edge module when that ships. The subscription survives
# `make deploy` but dies with the distribution, so re-run this after any
# `make destroy` + re-apply. PricingPlanManager is a single us-east-1 endpoint
# (same story as CLOUDFRONT-scope WAF), hence the pinned --region.
PPM = aws pricing-plan-manager --region us-east-1

pricing-plan: guard-account
	@DIST=$$($(TF) output -raw distribution_arn); ACL=$$($(TF) output -raw web_acl_arn); \
	if ! HAVE=$$($(PPM) list-subscriptions \
		--query "subscriptionSummaries[?contains(resourceArns, '$$DIST')].status" --output text); then \
		echo "cannot read subscriptions, refusing to create blind."; \
		echo "  AccessDenied means the deployer's inline policy predates D47 — re-paste"; \
		echo "  src/infra/deployer-policy.json over it (INSTALL C3); PricingPlanFreeTier is new."; \
		exit 1; fi; \
	if [ -n "$$HAVE" ]; then \
		echo "already subscribed (status: $$HAVE) — 'make pricing-plan-status' for details"; exit 0; fi; \
	$(PPM) create-subscription --plan-family CloudFront --plan-tier FREE \
		--resource-arns "$$DIST" "$$ACL" \
		--query 'subscription.{planTier:planTier,status:status,arn:arn}' --output table

pricing-plan-status:
	@$(PPM) list-subscriptions \
		--query 'subscriptionSummaries[].{planTier:planTier,status:status,updatedAt:updatedAt,resources:resourceArns}' \
		--output json

# Tears down the STATELESS half only: both lambdas, the function URL, the cron,
# the log groups, both distributions and the web-albums bucket (build artifacts
# only — force_destroy, rebuildable via build-web). module.data — the table and
# the objects bucket — is deliberately out of scope; it carries prevent_destroy
# and holds every photo. Costs a redeploy, not a memory.
# Re-applying afterwards mints NEW CloudFront domains and a NEW function URL:
# every client has to be re-pointed at the new server_url, and every share link
# minted before the destroy points at the DEAD albums domain (tokens stay
# valid — re-copy the link from the app after rebuilding, D52).
destroy: guard-account
	@echo "==> destroying module.compute + module.edge + module.web — table and objects bucket are preserved"
	$(TF) destroy -var-file=$(TFVARS) -target=module.compute -target=module.edge -target=module.web

# There is deliberately no target that destroys module.data.
destroy-data:
	@echo "REFUSING: module.data is the table and the objects bucket — every photo in the deployment."
	@echo ""
	@echo "Three safety rails guard it. If you genuinely mean this, lift them by hand"
	@echo "so that each one is a separate conscious step:"
	@echo "  1. empty the bucket — tofu cannot delete a non-empty one (no force_destroy, on purpose)"
	@echo "  2. remove both prevent_destroy blocks in src/infra/modules/data/main.tf"
	@echo "  3. set deletion_protection_enabled = false on the table and apply THAT alone"
	@echo "  4. then, finally: $(TF) destroy -var-file=$(TFVARS)"
	@echo ""
	@echo "Back up hashing_key and the tfstate before step 1 (D4a)."
	@exit 1
