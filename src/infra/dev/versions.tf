# Pinned — an unpinned provider is a deploy that changes under you.
terraform {
  required_version = ">= 1.8.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.6"
    }
  }

  # Local state, deliberately — same reasoning as immich-serverless: one
  # maintainer, one account. The state file IS the deployment record.
}
