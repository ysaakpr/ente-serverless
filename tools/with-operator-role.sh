#!/usr/bin/env sh
#
# Run an operator CLI (tools/invite.ts, tools/storagePool.ts) against the
# SELECTED deployment with credentials from that env's operator role (D64).
# The Makefile's invite/pool targets call this so you never have to prefix
# TABLE_NAME=... AWS_PROFILE=... by hand.
#
#   with-operator-role.sh <tofu-dir> <cmd> [args...]
#
# Two paths:
#
#  - LocalStack (AWS_ENDPOINT_URL set), or explicit ENTE_OPS_NO_ASSUME=1: run
#    <cmd> as-is against whatever the environment already points at. LocalStack
#    has no operator role and no STS, so this MUST be a clean bypass.
#
#  - Otherwise, the live path: read the env's operator_role_arn + table_name +
#    region from tofu output, assume the role with your ambient AWS credentials,
#    and run <cmd> with ONLY those session credentials.
#
# Assuming the role needs sts:AssumeRole on it in YOUR identity policy. The role
# trusts the account root by default, so any IAM principal in the account that
# carries that grant qualifies; deployer-policy.json ships it (Sid
# OperatorAssumeRole). AWS_PROFILE / OPERATOR_PROFILE picks which profile's
# creds do the assume. Note: the AWS ACCOUNT ROOT USER cannot assume roles at
# all — use an IAM role/user.
#
# IMPORTANT: before running <cmd> we CLEAR AWS_PROFILE and the inherited static
# key pair, because the @aws-sdk credential chain prefers AWS_PROFILE over the
# AWS_ACCESS_KEY_ID/SECRET env pair when BOTH are set — leaving AWS_PROFILE in
# place would run the tool as your base user (dynamodb:Scan AccessDenied)
# instead of the assumed operator role.
set -eu

if [ "$#" -lt 2 ]; then
  echo "usage: with-operator-role.sh <tofu-dir> <cmd> [args...]" >&2
  exit 2
fi

tfdir=$1
shift

# LocalStack / explicit opt-out: pass straight through, no role, no STS.
if [ -n "${AWS_ENDPOINT_URL:-}" ] || [ "${ENTE_OPS_NO_ASSUME:-}" = "1" ]; then
  echo "with-operator-role: passthrough — no role assumed (TABLE_NAME=${TABLE_NAME:-unset})" >&2
  exec "$@"
fi

out() { tofu -chdir="$tfdir" output -raw "$1" 2>/dev/null; }

role=$(out operator_role_arn) || role=""
if [ -z "$role" ]; then
  echo "with-operator-role: no operator_role_arn output for '$tfdir'." >&2
  echo "  - live env: pick one with 'make profile dev|test' and deploy it (make deploy, D64)," >&2
  echo "    or the deployment predates the operator role — re-deploy to create it." >&2
  echo "  - LocalStack: set AWS_ENDPOINT_URL (the Makefile's LOCALSTACK_ENV does)." >&2
  exit 1
fi

table=$(out table_name) || table=""
if [ -z "$table" ]; then
  echo "with-operator-role: no table_name output for '$tfdir' — is the env deployed?" >&2
  exit 1
fi

region=$(out region) || region=""

creds=$(aws sts assume-role \
  --role-arn "$role" \
  --role-session-name "ente-ops-$(id -u 2>/dev/null || echo op)" \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' \
  --output text) || {
  echo "with-operator-role: could not assume $role" >&2
  echo "  Your AWS identity needs sts:AssumeRole on it. deployer-policy.json grants" >&2
  echo "  this (Sid OperatorAssumeRole) — re-apply the policy to your principal if you" >&2
  echo "  edited it. Pick the assuming profile with AWS_PROFILE / OPERATOR_PROFILE, or" >&2
  echo "  set AWS_ENDPOINT_URL for LocalStack. (The account ROOT USER cannot assume" >&2
  echo "  roles — use an IAM role/user.)" >&2
  exit 1
}

new_key=$(printf '%s' "$creds" | cut -f1)
new_secret=$(printf '%s' "$creds" | cut -f2)
new_token=$(printf '%s' "$creds" | cut -f3)

# Switch the PROCESS identity to the assumed role. Clear AWS_PROFILE (and the
# base static keys, which we replace) so the SDK cannot prefer them over the
# session credentials below. unset under `set -u` is safe even if unset.
unset AWS_PROFILE 2>/dev/null || true
export AWS_ACCESS_KEY_ID="$new_key"
export AWS_SECRET_ACCESS_KEY="$new_secret"
export AWS_SESSION_TOKEN="$new_token"
export TABLE_NAME="$table"
[ -n "$region" ] && export AWS_REGION="$region"

echo "with-operator-role: assumed ${role##*/} -> TABLE_NAME=$table region=${region:-inherited}" >&2
exec "$@"
