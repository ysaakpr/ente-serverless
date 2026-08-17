# All commands run from ente-serverless/. Nothing here needs an AWS account.

LOCALSTACK_ENV = AWS_ENDPOINT_URL=http://127.0.0.1:4567 AWS_REGION=us-east-1 \
	AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
	TABLE_NAME=ente-serverless BUCKET_NAME=ente-objects \
	HASHING_KEY=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=

.PHONY: test test-int typecheck up down bootstrap dev ledger oracle-up oracle-down infra-test

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
