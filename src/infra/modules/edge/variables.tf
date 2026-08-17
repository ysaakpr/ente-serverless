variable "env_name" {
  type = string
}

variable "api_function_url" {
  type = string
}

# Injected as x-origin-secret on every origin request; must match the app's
# ORIGIN_SECRET (finding 4 origin lock).
variable "origin_secret" {
  type      = string
  sensitive = true
}
