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
