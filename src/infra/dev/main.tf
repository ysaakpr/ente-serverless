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
}

# CloudFront — the URL the stock ente app gets pointed at (7-tap custom endpoint).
module "edge" {
  source   = "../modules/edge"
  env_name = var.env_name

  api_function_url = module.compute.api_function_url
}
