# All commands run from ente-serverless/. Nothing here needs an AWS account.

LOCALSTACK_ENV = AWS_ENDPOINT_URL=http://127.0.0.1:4567 AWS_REGION=us-east-1 \
	AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
	TABLE_NAME=ente-serverless BUCKET_NAME=ente-objects \
	HASHING_KEY=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=

.PHONY: test test-int typecheck up down bootstrap dev ledger oracle-up oracle-down infra-test \
	build-lambda capture-diff lan infra-init guard-account plan deploy outputs smoke destroy destroy-data \
	pricing-plan pricing-plan-status build-web deploy-web invite invites revoke-invite set-storage users \
	pool-create pool-attach pool-detach pools pool-set-quota pool-disable pool-enable pool-requeue \
	profile require-profile

# `make profile dev` / `make profile test` (D57): the env word arrives as a
# SECOND GOAL, which would otherwise also run the real `dev` (LocalStack
# server) or `test` (unit suite) target. When — and only when — the first
# goal is `profile`, both words become no-ops; otherwise the real targets are
# defined exactly as before. Parse-time conditional, so neither definition
# ever collides with the other.
ifeq ($(firstword $(MAKECMDGOALS)),profile)
dev test:
	@:
else
test:
	npx vitest run test/unit

dev: bootstrap
	$(LOCALSTACK_ENV) npm run dev
endif

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

# (`dev` — the LocalStack dev server — is defined next to `test` above, inside
# the profile-goal conditional.)

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
# never a client surface.
#
# LIVE ENV (D64): pick it once with `make profile dev|test`; every target below
# then runs through $(OPS), which assumes that env's operator role and sets
# TABLE_NAME + region for you — no TABLE_NAME/AWS_PROFILE prefix. Your creds
# just need sts:AssumeRole on the role (your deployer profile has it); set
# OPERATOR_PROFILE=<profile> to choose which profile assumes it. set-storage
# additionally needs HASHING_KEY (user lookup is hash-keyed); invite/list/revoke
# deliberately do not (invite rows key on plain email) — export it or prefix it.
# LOCALSTACK: `env $(LOCALSTACK_ENV) make invite ...` sets AWS_ENDPOINT_URL, so
# $(OPS) passes straight through — the role dance is skipped.
#   make profile dev            # once — selects the env everything below hits
#   make invite EMAIL=alice@example.com [STORAGE_GB=50] [VIEWER=1]
#   make invites
#   make revoke-invite EMAIL=alice@example.com
#   HASHING_KEY=... make set-storage EMAIL=alice@example.com STORAGE_GB=50   (or =default)
# STORAGE_GB=0 means ZERO bytes — a viewer-style no-upload account, not "off".
# ---------------------------------------------------------------------------
INVITE_TOOL = node --experimental-transform-types tools/invite.ts

invite:
	@test -n "$(EMAIL)" || { echo "usage: make invite EMAIL=... [STORAGE_GB=...] [VIEWER=1]"; exit 1; }
	@$(OPS) $(INVITE_TOOL) invite "$(EMAIL)" \
		$(if $(STORAGE_GB),--storage-gb $(STORAGE_GB)) $(if $(VIEWER),--viewer)

invites:
	@$(OPS) $(INVITE_TOOL) list

revoke-invite:
	@test -n "$(EMAIL)" || { echo "usage: make revoke-invite EMAIL=..."; exit 1; }
	@$(OPS) $(INVITE_TOOL) revoke "$(EMAIL)"

set-storage:
	@test -n "$(EMAIL)" -a -n "$(STORAGE_GB)" || { echo "usage: make set-storage EMAIL=... STORAGE_GB=<n|default>"; exit 1; }
	@$(OPS) $(INVITE_TOOL) set-storage "$(EMAIL)" "$(STORAGE_GB)"

# Every account with email, usage and limits (operator Scan, D64):
#   make users            table view
#   make users JSON=1     raw JSON
users:
	@$(OPS) node --experimental-transform-types tools/users.ts list $(if $(JSON),--json)

# ---------------------------------------------------------------------------
# BYO storage pools (Phase H2, D55) — operator tooling, never a client
# surface. One pool = one S3 bucket shared by many users (a household);
# object keys stay <userID>/<uuid>, and pool membership never grants access
# to other members' photos. Runs through $(OPS) exactly like the invite
# targets above (D64): `make profile dev|test` picks the env, the operator role
# supplies creds + TABLE_NAME. HASHING_KEY is still yours to provide for
# pool-attach/pool-detach (hashed user lookup) and keys-mode pool-create
# (credential encryption).
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
	@$(OPS) $(POOL_TOOL) create "$(POOL)" --bucket "$(BUCKET)" --region "$(REGION)" \
		$(if $(ROLE_ARN),--role-arn "$(ROLE_ARN)") $(if $(EXTERNAL_ID),--external-id "$(EXTERNAL_ID)") \
		$(if $(ACCESS_KEY),--access-key "$(ACCESS_KEY)") $(if $(SECRET_KEY),--secret-key "$(SECRET_KEY)") \
		$(if $(ENDPOINT),--endpoint "$(ENDPOINT)") $(if $(STORAGE_GB),--storage-gb $(STORAGE_GB))

pool-attach:
	@test -n "$(EMAIL)" -a -n "$(POOL)" || { echo "usage: make pool-attach EMAIL=... POOL=..."; exit 1; }
	@$(OPS) $(POOL_TOOL) attach "$(EMAIL)" "$(POOL)"

pool-detach:
	@test -n "$(EMAIL)" || { echo "usage: make pool-detach EMAIL=..."; exit 1; }
	@$(OPS) $(POOL_TOOL) detach "$(EMAIL)"

pools:
	@$(OPS) $(POOL_TOOL) list

pool-set-quota:
	@test -n "$(POOL)" -a -n "$(STORAGE_GB)" || { echo "usage: make pool-set-quota POOL=... STORAGE_GB=<n|unlimited>"; exit 1; }
	@$(OPS) $(POOL_TOOL) set-quota "$(POOL)" "$(STORAGE_GB)"

pool-disable:
	@test -n "$(POOL)" || { echo "usage: make pool-disable POOL=..."; exit 1; }
	@$(OPS) $(POOL_TOOL) disable "$(POOL)"

pool-enable:
	@test -n "$(POOL)" || { echo "usage: make pool-enable POOL=..."; exit 1; }
	@$(OPS) $(POOL_TOOL) enable "$(POOL)"

# Drain a deleted/unresolvable pool's QUARANTINED sweep rows by re-pinning
# them to another pool or the central bucket (D56). Running it ASSERTS the
# bytes actually live in the target bucket — the CLI restates this.
#   make pool-requeue POOL=smith [TO=<poolId>|central]   (default: central)
pool-requeue:
	@test -n "$(POOL)" || { echo "usage: make pool-requeue POOL=... [TO=<poolId>|central]"; exit 1; }
	@$(OPS) $(POOL_TOOL) requeue "$(POOL)" $(if $(TO),--to "$(TO)")

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
#     behind CloudFront (modules/edge, D58) can serve it.
#   - NEXT_PUBLIC_ENTE_ENDPOINT is baked in AT BUILD TIME (web/apps/albums/
#     .env); changing the API URL means rebuilding, not re-syncing.
# ---------------------------------------------------------------------------
ALBUMS_WEB_TAG  = photos-v1.3.61
ALBUMS_WEB_REPO = https://github.com/ente-io/ente

# Builds LOCALLY into dist/web-albums (gitignored). Deploys nothing.
# The API origin the build bakes in: pass ALBUMS_API_ORIGIN=https://... or,
# when the stack is already deployed, let it default to the server_url output.
# basePath (D60): the app is served under /albums (the one web-facing
# behavior on the consolidated distribution — FREE plan, 5-behavior ceiling),
# and the pinned tag's next.config has no env-based basePath support, so the
# patch script injects basePath/assetPrefix = /albums into the sparse clone
# before the build. Anchor-checked: a tag bump that changes the config's
# shape fails the build loudly instead of exporting an unprefixed app.
# Sparse set: web/ (the npm workspace) AND rust/ — the workspace's ente-wasm /
# ente-wasm-core / ente-space-wasm packages wasm-pack-build crates that live at
# rust/bindings/wasm/*, path-dependent on the rust/ cargo workspace, so the
# whole rust/ tree must be present (requires rustup + wasm32-unknown-unknown +
# wasm-pack on PATH). Stale/partial clones need no special handling: the
# unconditional rm -rf below starts every run from a fresh clone, so a changed
# sparse set or an earlier failed run can never leave dist/ente-web-src stale.
build-web: require-profile
	@command -v git >/dev/null || { echo "git is required"; exit 1; }
	@command -v npm >/dev/null || { echo "npm is required (the ente web workspace pins npm 11.x — a very old npm may refuse)"; exit 1; }
	@command -v cargo >/dev/null || { echo "cargo is required (rustup with the wasm32-unknown-unknown target — the workspace wasm-pack-builds rust/bindings/wasm/*)"; exit 1; }
	@ORIGIN="$${ALBUMS_API_ORIGIN:-$$($(TF) output -raw server_url 2>/dev/null)}"; \
	case "$$ORIGIN" in \
		http*) ;; \
		*) echo "no API origin: pass ALBUMS_API_ORIGIN=https://<server_url> (or deploy first so 'tofu output server_url' resolves)"; exit 1;; \
	esac; \
	echo "==> building ente albums $(ALBUMS_WEB_TAG) against $$ORIGIN"; \
	rm -rf dist/ente-web-src dist/web-albums; \
	git clone --depth 1 --branch $(ALBUMS_WEB_TAG) --filter=blob:none --sparse $(ALBUMS_WEB_REPO) dist/ente-web-src && \
	git -C dist/ente-web-src sparse-checkout set web rust && \
	node --experimental-transform-types scripts/patch-albums-basepath.ts \
		dist/ente-web-src/web/apps/albums/next.config.js && \
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

# Syncs the local build to the web bucket's albums/ KEY PREFIX (D60 — the
# /albums* behavior's URI is the object key verbatim, no origin path) and
# invalidates the ONE consolidated distribution (D58 — the same distribution
# that serves the API; the API default behavior is CachingDisabled, so the
# /* invalidation only actually evicts web assets). Guarded like every other
# state-mutating target. --delete keeps the prefix an exact mirror.
# index.html freshness rides ORIGIN METADATA, not a dedicated behavior (the
# FREE plan caps the distribution at 5 behaviors, D60): index.html uploads
# with Cache-Control: no-cache — CachingOptimized honors it — and the hashed
# /_next assets with a 1y immutable max-age. Upload order matters: assets
# first, index.html LAST, so a live index never names assets that are not in
# the bucket yet; the invalidation stays the belt and braces.
deploy-web: require-profile guard-account
	@test -d dist/web-albums || { echo "no dist/web-albums — run 'make build-web' first"; exit 1; }
	@test -f dist/web-albums/index.html || { echo "dist/web-albums has no index.html — the albums build did not finish"; exit 1; }
	@grep -q '/albums/_next' dist/web-albums/index.html || { \
		echo "dist/web-albums was built WITHOUT basePath /albums — a stale pre-D60 build."; \
		echo "Re-run 'make build-web' (it patches the pinned next.config at build time)."; exit 1; }
	@BUCKET=$$($(TF) output -raw web_bucket); DIST=$$($(TF) output -raw distribution_id); \
	aws s3 sync dist/web-albums/_next "s3://$$BUCKET/albums/_next" --delete \
		--cache-control "public, max-age=31536000, immutable" && \
	aws s3 sync dist/web-albums "s3://$$BUCKET/albums" --delete \
		--exclude "_next/*" --exclude "index.html" && \
	aws s3 cp dist/web-albums/index.html "s3://$$BUCKET/albums/index.html" \
		--cache-control "no-cache" && \
	aws cloudfront create-invalidation --distribution-id "$$DIST" --paths "/*" \
		--query 'Invalidation.{id:Id,status:Status}' --output table
	@echo "==> albums app live at $$($(TF) output -raw albums_url)"

# ---------------------------------------------------------------------------
# AWS deploy (M7, decision D4; profiles D57). Everything environment-specific
# — region, hashing_key, mail_from — lives in src/infra/<profile>/ente-sl.tfvars
# (gitignored). These targets pass ONLY -var-file, so plan and apply can never
# disagree about which region they are addressing. Note that tofu reads the
# region from that file, NOT from your AWS CLI config: the two being different
# is normal and harmless, but it means `aws configure get region` tells you
# nothing about where this deploys.
#
# Credentials come from the environment. Use a dedicated profile so the deployer
# is always explicit:   AWS_PROFILE=ente-sl make plan
#
# WHICH env dir the targets address comes from .tf-profile (gitignored):
#     make profile dev    # src/infra/dev  — the LIVE PRODUCTION deployment
#     make profile test   # src/infra/test — the disposable test env
# The label deliberately names what the env IS, not what the folder is called:
# "dev" was named before it went live, and it IS production now. There is NO
# default — with no profile chosen, every tofu-touching target refuses.
# Mutating targets carry no extra typed confirmation (D57 addendum,
# 2026-08-27): the banner names the env, profiles are fully disjoint (state,
# tfvars, guard-account are all per-profile), `deploy` applies a plan you
# just reviewed, and `destroy` still hits tofu's own interactive approval —
# nothing here passes -auto-approve.
# ---------------------------------------------------------------------------
PROFILE_FILE = .tf-profile
PROFILE      = $(strip $(shell cat $(PROFILE_FILE) 2>/dev/null))

PROFILE_LABEL_dev  = PRODUCTION
PROFILE_LABEL_test = TEST
PROFILE_LABEL      = $(PROFILE_LABEL_$(PROFILE))

NO_PROFILE_MSG = no profile chosen — choose: make profile dev | make profile test

TFDIR  = src/infra/$(PROFILE)
TF     = tofu -chdir=$(TFDIR)
# Path is relative to $(TFDIR), because of tofu -chdir above.
TFVARS = ente-sl.tfvars
TFPLAN = tfplan
STATE  = $(TFDIR)/terraform.tfstate

# Wrapper for the operator CLIs (invite/pool, D64): assumes the SELECTED env's
# operator role and sets TABLE_NAME + region so you run `make invite EMAIL=...`
# with no TABLE_NAME/AWS_PROFILE prefix — just `make profile dev` once. It is a
# transparent passthrough when AWS_ENDPOINT_URL is set (LocalStack via
# $(LOCALSTACK_ENV)), so those flows are unchanged. OPERATOR_PROFILE picks which
# AWS profile's creds assume the role (your deployer profile qualifies — the
# role trusts the account root and deployer-policy.json grants it
# sts:AssumeRole); unset uses your default credential chain / exported
# AWS_PROFILE. HASHING_KEY is still yours to provide for set-storage / pool
# attach-detach / keys-mode pool-create.
OPS = $(if $(OPERATOR_PROFILE),AWS_PROFILE=$(OPERATOR_PROFILE) )sh tools/with-operator-role.sh $(TFDIR)

# `make profile <name>` records the choice; bare `make profile` prints it.
profile:
	@ARG="$(word 2,$(MAKECMDGOALS))"; \
	label() { case "$$1" in dev) echo "$(PROFILE_LABEL_dev)";; test) echo "$(PROFILE_LABEL_test)";; esac; }; \
	case "$$ARG" in \
	dev|test) \
		echo "$$ARG" > $(PROFILE_FILE); \
		echo ">>> profile: $$ARG (ENV: $$(label $$ARG))";; \
	"") \
		if [ -s $(PROFILE_FILE) ]; then \
			P=$$(cat $(PROFILE_FILE)); L=$$(label $$P); \
			if [ -n "$$L" ]; then echo "profile: $$P (ENV: $$L)"; \
			else echo "unknown profile '$$P' in $(PROFILE_FILE) — choose: make profile dev | make profile test"; exit 1; fi; \
		else \
			echo "$(NO_PROFILE_MSG)"; exit 1; \
		fi;; \
	*) \
		echo "unknown profile '$$ARG' — choose: make profile dev | make profile test"; exit 1;; \
	esac

# Fails fast when no profile is chosen and banners which env is addressed.
# NEVER defaults to dev: dev is production, and a silent default is exactly
# the accident this exists to prevent.
require-profile:
	@test -n "$(PROFILE)" || { echo "$(NO_PROFILE_MSG)"; exit 1; }
	@test -n "$(PROFILE_LABEL)" || { echo "unknown profile '$(PROFILE)' in $(PROFILE_FILE) — choose: make profile dev | make profile test"; exit 1; }
	@echo ">>> profile: $(PROFILE) (ENV: $(PROFILE_LABEL))"

infra-init: require-profile
	$(TF) init

# The objects bucket embeds the account id in its NAME, so running plan/apply
# with credentials for a different account renames it — and tofu reads a rename
# as destroy-and-recreate of the photo store. The table's API-level deletion
# protection does stop the table half (D57), but only after a plan that reads
# like a config bug rather than a wrong profile. Worse, the lambdas/role/topic
# carry no such rail and WOULD be replaced. So: compare the caller against the
# account already recorded in the SELECTED PROFILE's state. No extra config —
# that state file is the source of truth, and a first deploy of an env (no
# state yet, e.g. a fresh src/infra/test) skips the check.
guard-account: require-profile
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
#
# albums_url_hint (D58): the albums app rides the SAME distribution as the
# API, so the Lambda's ALBUMS_URL should be that distribution's own URL — a
# self-reference tofu cannot express (lambda env -> distribution -> function
# URL -> lambda is a cycle). The previous apply's server_url output IS that
# value (a distribution's domain never changes in place), so plan feeds it
# back in as a var. A fresh env's first plan has no output yet and deploys
# the loud albums-url-pending.invalid sentinel; the routine second
# plan/deploy pins the real domain. A tfvars albums_url (custom domain)
# always wins over the hint.
plan: require-profile build-lambda guard-account
	@test -f $(TFDIR)/$(TFVARS) || { \
		echo "missing $(TFDIR)/$(TFVARS)"; \
		echo "  cp $(TFDIR)/ente-sl.tfvars.example $(TFDIR)/$(TFVARS)"; \
		echo "  then fill in region, mail_from, and hashing_key (openssl rand -base64 32)"; \
		echo "  BACK UP hashing_key first — losing it orphans every email->user mapping (D4a)"; \
		exit 1; }
	@HINT=$$($(TF) output -raw server_url 2>/dev/null || true); \
	test -n "$$HINT" || echo ">>> no server_url in state yet — ALBUMS_URL deploys as the pending sentinel; run plan+deploy again after this apply (D58)"; \
	set -x; \
	$(TF) plan -var-file=$(TFVARS) $${HINT:+-var albums_url_hint=$$HINT} -out=$(TFPLAN)

# Applies the SAVED plan, so what ships is exactly what you reviewed.
# The CloudFront distribution takes 5-15 min to reach Deployed; the rest
# of the resources are quick.
# Post-apply, the FREE pricing-plan subscription is chained in (D60):
# pricing-plan is idempotent (already-subscribed is a one-line no-op), and a
# FAILURE must never fail the deploy — IAM propagation or the account's
# 3-distribution FREE budget can transiently refuse — so it warns loudly and
# leaves `make pricing-plan` (the standalone target stays) to the operator.
deploy: require-profile guard-account
	@test -f $(TFDIR)/$(TFPLAN) || { echo "no saved plan — run 'make plan' and read it first"; exit 1; }
	$(TF) apply $(TFPLAN)
	@rm -f $(TFDIR)/$(TFPLAN)
	@$(MAKE) --no-print-directory outputs
	@$(MAKE) --no-print-directory pricing-plan || { \
		echo ""; \
		echo "*** WARNING: the CloudFront FREE pricing-plan subscription DID NOT complete."; \
		echo "*** The deploy itself succeeded. Transient causes (IAM propagation, the"; \
		echo "*** 3-distribution FREE budget, a distribution still deploying) clear on"; \
		echo "*** their own — re-run it by hand:  make pricing-plan"; \
		echo "*** An unsubscribed env silently pays ~\$$6/mo of WAF fees (D47/D58)."; }

outputs: require-profile
	@$(TF) output

# Post-deploy check. With the origin lock (D43) the HEALTHY state is:
#   function-url 403 (app refuses requests without CloudFront's secret header)
#   cloudfront   200
# CloudFront is the disambiguator: 403 on BOTH means the anonymous
# InvokeFunctionUrl permission went missing (or the origin secret is mismatched
# between the lambda env and the distribution's custom_header).
smoke: require-profile
	@FU=$$($(TF) output -raw api_function_url); CF=$$($(TF) output -raw server_url); \
	printf '  function-url /ping -> '; curl -sS -o /dev/null -w '%{http_code}  (403 = origin lock working)\n' "$${FU}ping"; \
	printf '  cloudfront   /ping -> '; curl -sS -o /dev/null -w '%{http_code}  (must be 200)\n' "$$CF/ping"; \
	echo "  point the app at: $$CF"

# CloudFront flat-rate FREE plan (D47, consolidated D58, layout shaped to
# the tier's 5-behavior ceiling D60). One subscription covers exactly one
# distribution + its web ACL, and zeroes what is otherwise the largest fixed
# line on the bill: the WAF web ACL ($5/mo) + rate rule ($1/mo) + all
# CloudFront/WAF request fees. ONE SUBSCRIPTION PER ENVIRONMENT — `make
# deploy` chains this target post-apply (D60; idempotent, non-fatal on
# failure), and it stays runnable standalone (make profile <env>, then this
# target): an unsubscribed env — the test env is the one that slips —
# silently pays the ~$6/mo WAF fees on pay-as-you-go. The FREE plan
# allows at most 3 distributions per AWS account; consolidation (D58) keeps
# prod + test at 2, one spare. The allowances (1M requests, 100 GB transfer
# per month per subscription) see the small-JSON API path plus a few MB of
# albums web assets — photo bytes ride presigned S3 URLs and never cross the
# distribution — and are soft: AWS never bills overage, it emails and may
# eventually slow delivery. FREE activates immediately; no approval step.
#
# A one-time CLI step, NOT a tofu resource: the AWS provider has no
# pricingplanmanager support yet (hashicorp/terraform-provider-aws#49232) —
# fold it into the edge module when that ships. The subscription survives
# `make deploy` — in-place distribution updates included, which is what the
# D58 consolidation is for prod — but dies with the distribution, so re-run
# this after any `make destroy` + re-apply. PricingPlanManager is a single
# us-east-1 endpoint (same story as CLOUDFRONT-scope WAF), hence the pinned
# --region.
PPM = aws pricing-plan-manager --region us-east-1

pricing-plan: require-profile guard-account
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
# the log groups, the distribution and the web-albums bucket (build artifacts
# only — force_destroy, rebuildable via build-web). module.data — the table and
# the objects bucket — is deliberately out of scope; it carries the D57
# delete-protection rails and holds every photo. Costs a redeploy, not a memory.
# Re-applying afterwards mints a NEW CloudFront domain and a NEW function URL:
# every client has to be re-pointed at the new server_url, every share link
# minted before the destroy points at the DEAD domain (tokens stay valid —
# re-copy the link from the app after rebuilding, D52), and ALBUMS_URL needs
# the routine second plan/deploy to pick the new domain up (D58 hint).
destroy: require-profile guard-account
	@echo "==> destroying module.compute + module.edge — table and objects bucket are preserved"
	$(TF) destroy -var-file=$(TFVARS) -target=module.compute -target=module.edge

# There is deliberately no target that destroys module.data.
destroy-data: require-profile
	@echo "REFUSING: module.data is the table and the objects bucket — every photo in the deployment."
	@echo ""
	@echo "The rails are variable-driven since D57. If you genuinely mean this (a TEST"
	@echo "env, or a deliberate final teardown), lift them by hand so that each one is"
	@echo "a separate conscious step:"
	@echo "  1. set delete_protection = false in $(TFDIR)/$(TFVARS), then run"
	@echo "     'make plan' + 'make deploy' with THAT change alone — it disables the"
	@echo "     table's API-level deletion protection and arms force_destroy on the"
	@echo "     objects bucket (protection on, the destroy refuses: the table blocks"
	@echo "     DeleteTable at the AWS API and tofu will not empty the bucket)"
	@echo "  2. then, finally: $(TF) destroy -var-file=$(TFVARS)"
	@echo ""
	@echo "Back up hashing_key and the tfstate before step 1 (D4a)."
	@exit 1
