provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "ente-serverless"
      Env       = var.env_name
      ManagedBy = "opentofu"
    }
  }
}

# CLOUDFRONT-scope WAF web ACLs can only be created in us-east-1, wherever the
# rest of the stack lives — hence the alias the edge module requires.
provider "aws" {
  alias  = "use1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "ente-serverless"
      Env       = var.env_name
      ManagedBy = "opentofu"
    }
  }
}

# Origin-lock secret (security review 2026-08-17, finding 4): generated once,
# lives only in the state file — deliberately NOT a tfvars value, so it cannot
# end up in a findings doc next to the hostname it protects. Rotating it is
# `tofu taint random_password.origin_secret && make deploy`.
resource "random_password" "origin_secret" {
  length  = 32
  special = false
}

# The stateful half — carries prevent_destroy throughout.
module "data" {
  source   = "../modules/data"
  env_name = var.env_name
}

# The stateless half — destroying it costs a redeploy, not a photo.
module "compute" {
  source   = "../modules/compute"
  env_name = var.env_name

  table_name         = module.data.table_name
  table_arn          = module.data.table_arn
  objects_bucket     = module.data.objects_bucket
  objects_bucket_arn = module.data.objects_bucket_arn

  hashing_key = var.hashing_key
  mail_from   = var.mail_from

  # One address by default: the operator and the sender are the same person on a
  # self-host. Set alarm_email in the tfvars only to split them.
  alarm_email = coalesce(var.alarm_email, var.mail_from)

  origin_secret            = random_password.origin_secret.result
  api_reserved_concurrency = var.api_reserved_concurrency
  monthly_budget_usd       = var.monthly_budget_usd
}

# CloudFront — the URL the stock ente app gets pointed at (7-tap custom endpoint).
module "edge" {
  source   = "../modules/edge"
  env_name = var.env_name

  providers = {
    aws      = aws
    aws.use1 = aws.use1
  }

  api_function_url = module.compute.api_function_url
  origin_secret    = random_password.origin_secret.result
}
