output "server_url" {
  description = "Point the stock ente app at this (7-tap custom endpoint)."
  value       = module.edge.server_url
}

output "api_function_url" {
  value = module.compute.api_function_url
}

output "table_name" {
  value = module.data.table_name
}

output "objects_bucket" {
  value = module.data.objects_bucket
}

# What minted share links actually point at (D52/D58) — the value the Lambda's
# ALBUMS_URL was deployed with: the custom-domain tfvars override if set, else
# this distribution's own URL (same domain as server_url), else the .invalid
# sentinel a fresh env carries until its second plan/deploy (see
# albums_url_hint in variables.tf).
output "albums_url" {
  value = local.albums_url
}

# Both consumed by `make deploy-web` (s3 sync + invalidation on the ONE
# consolidated distribution, D58).
output "web_bucket" {
  value = module.edge.web_bucket
}

output "distribution_id" {
  value = module.edge.distribution_id
}

# Both consumed by `make pricing-plan` (D47) — run once per environment (D58).
output "distribution_arn" {
  value = module.edge.distribution_arn
}

output "web_acl_arn" {
  value = module.edge.web_acl_arn
}
