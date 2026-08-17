variable "env_name" {
  type = string
}

variable "table_name" {
  type = string
}

variable "table_arn" {
  type = string
}

variable "objects_bucket" {
  type = string
}

variable "objects_bucket_arn" {
  type = string
}

variable "hashing_key" {
  type      = string
  sensitive = true
}

variable "mail_from" {
  type    = string
  default = "verify@ente.local"
}

# Where alarm notifications go. Defaults to mail_from at the env level, since on
# a self-host the operator and the sender are the same person.
variable "alarm_email" {
  type = string
}

variable "free_plan_storage_bytes" {
  type    = number
  default = 10995116277760 # 10 TiB (decision D11, revised 2026-08-17); museum's constant is 10 GiB
}

# Security review 2026-08-17, finding 4 — the three spend/abuse knobs.

# Hard cap on concurrent API invocations. -1 = no reservation, which is the
# only value that deploys on an account still at the default Lambda quota:
# AWS insists 10 executions stay UNRESERVED account-wide, so a fresh account
# (total limit 10) cannot reserve anything — and that account-wide 10 is
# itself a tighter invocation ceiling than the 50 this knob intends. Once the
# quota is raised (Service Quotas -> Lambda -> Concurrent executions), set
# this to ~50 in the tfvars: generous for a single-owner photo backend, and
# turns "unbounded bill" into "throttled during a flood".
variable "api_reserved_concurrency" {
  type    = number
  default = -1
}

# ACTUAL-spend budget that pages through the alarms topic at 80% and 100%.
variable "monthly_budget_usd" {
  type    = number
  default = 25
}

# Shared secret CloudFront injects at the origin; the app refuses requests
# without it. Generated in the env root (random_password), never in tfvars.
variable "origin_secret" {
  type      = string
  sensitive = true
}
