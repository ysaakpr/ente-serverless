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

# The stateful half — delete protection is API-level and variable-driven
# (D57): deletion_protection_enabled on the table, force_destroy inverted on
# the objects bucket. Default true; only a test env should ever set it false.
module "data" {
  source                  = "../modules/data"
  env_name                = var.env_name
  delete_protection       = var.delete_protection
  gir_transition_days     = var.gir_transition_days
  operator_principal_arns = var.operator_principal_arns
}

# Where minted share links point (D51/D52/D58/D60): `<albums_url>/?t=<token>`.
# Since D58 the albums app rides the SAME distribution as the API — under the
# /albums* behavior since D60, so the right value is the distribution's own
# URL PLUS the /albums path. Tofu cannot wire the domain declaratively
# (lambda env → distribution → function URL → lambda is a cycle), so
# `make plan` injects albums_url_hint from the previous apply's server_url
# output and the /albums suffix is appended HERE, where the value is
# composed; the tfvars albums_url (a custom domain, full base URL, no suffix
# appended) still wins, and a fresh env's FIRST apply deploys the loud
# .invalid sentinel until the routine second plan/deploy pins the real
# domain (coalesce skips null AND empty string, so the unset-hint ternary's
# "" falls through).
locals {
  albums_url = coalesce(
    var.albums_url,
    var.albums_url_hint != "" ? "${var.albums_url_hint}/albums" : "",
    "https://albums-url-pending.invalid/albums",
  )
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

  albums_url = local.albums_url

  presign_public_get_expiry_seconds = var.presign_public_get_expiry_seconds
  public_link_daily_downloads       = var.public_link_daily_downloads
  public_link_daily_uploads         = var.public_link_daily_uploads
  public_link_daily_devices         = var.public_link_daily_devices

  signup_mode = var.signup_mode

  origin_secret            = random_password.origin_secret.result
  api_reserved_concurrency = var.api_reserved_concurrency
  monthly_budget_usd       = var.monthly_budget_usd
}

# CloudFront — the ONE distribution (D58): its domain is the server_url the
# stock ente app gets pointed at (7-tap custom endpoint), the API rides
# root-path ordered behaviors, and the default behavior serves the albums web
# app from the module's private bucket.
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

# D58 refactor: the albums bucket + OAC moved from the deleted modules/web
# into modules/edge. These keep the deployed resources (and the bucket's
# synced content) in place instead of destroy-and-recreate; the standalone
# albums distribution had no destination and is destroyed by the same plan.
moved {
  from = module.web.aws_s3_bucket.web
  to   = module.edge.aws_s3_bucket.web
}

moved {
  from = module.web.aws_s3_bucket_public_access_block.web
  to   = module.edge.aws_s3_bucket_public_access_block.web
}

moved {
  from = module.web.aws_s3_bucket_policy.web
  to   = module.edge.aws_s3_bucket_policy.web
}

moved {
  from = module.web.aws_cloudfront_origin_access_control.web
  to   = module.edge.aws_cloudfront_origin_access_control.web
}
