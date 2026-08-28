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

# The role the tools/ CLI assumes (invite + storage-pool provisioning). The
# make targets read this (+ region below) to assume the role and set TABLE_NAME
# automatically; see tools/with-operator-role.sh.
output "operator_role_arn" {
  value = module.data.operator_role_arn
}

# Consumed by tools/with-operator-role.sh — the tools default to us-east-1, so
# the operator CLI must pass the real region explicitly.
output "region" {
  value = var.region
}

# What minted share links actually point at (D52/D58/D60) — the value the
# Lambda's ALBUMS_URL was deployed with: the custom-domain tfvars override if
# set, else this distribution's own URL + /albums (server_url domain, the
# /albums* behavior), else the .invalid sentinel a fresh env carries until
# its second plan/deploy (see albums_url_hint in variables.tf).
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
