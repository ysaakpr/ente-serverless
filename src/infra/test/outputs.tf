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

# The albums web app (Phase F, D52). albums_url is what share links are
# minted against; the bucket and distribution id feed `make deploy-web`.
output "albums_url" {
  value = module.web.albums_url
}

output "web_bucket" {
  value = module.web.web_bucket
}

output "web_distribution_id" {
  value = module.web.web_distribution_id
}

# Both consumed by `make pricing-plan` (D47).
output "distribution_arn" {
  value = module.edge.distribution_arn
}

output "web_acl_arn" {
  value = module.edge.web_acl_arn
}
