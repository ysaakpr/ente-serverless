# Pinned — an unpinned provider is a deploy that changes under you.
terraform {
  # 1.10 brings the S3 backend's native lock file (use_lockfile) — no
  # DynamoDB lock table to create or pay for.
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.6"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state in the central bucket (D67). Partial on purpose: bucket, key,
  # region and locking are passed by `make infra-init` (BACKEND_ARGS), so no
  # account id is committed and both envs share one definition. Bucket:
  # ente-sl-tfstate-<account>, key state/<profile>/terraform.tfstate.
  backend "s3" {}
}
