# Neither of these carries a default, deliberately. Both name or place resources
# that cannot be renamed or moved after the first apply — the table and bucket
# carry prevent_destroy, so a changed value forces a replacement that tofu will
# refuse. A missing value must fail the plan loudly, not quietly resolve to
# "dev" in us-east-1 and stand up a whole second deployment somewhere you did
# not intend. Both live in ente-sl.tfvars; the make targets always pass it.
variable "region" {
  type = string
}

variable "env_name" {
  type = string
}

# base64 of 32 random bytes; generate once: openssl rand -base64 32
variable "hashing_key" {
  type      = string
  sensitive = true
}

# Must be an SES-verified identity in the target account.
variable "mail_from" {
  type = string
}

# Optional: where CloudWatch alarms go. Null means "same address as mail_from",
# which is the right answer whenever the operator is also the sender. Unlike SES,
# SNS needs no prior verification — but the subscription DOES need confirming
# from the inbox, and silently drops alarms until you click the link.
variable "alarm_email" {
  type    = string
  default = null
}

# Optional overrides for the finding-4 spend ceilings (D43), settable from the
# tfvars — a tfvars value only reaches a module through a root declaration
# like these two, so their absence here silently discards the setting.

# -1 = unreserved (the only deployable value at the default Lambda quota);
# set ~50-100 after a Service Quotas raise. Thumbnail loads burst hard, so
# undersizing this shows up as 429 waves in the gallery.
variable "api_reserved_concurrency" {
  type    = number
  default = -1
}

variable "monthly_budget_usd" {
  type    = number
  default = 25
}

# Optional override for where share links point (D51/D52). Null means "the
# web module's own CloudFront domain", which is right until a custom domain
# fronts the albums app. If set, it must be the ORIGIN only (https://host, no
# path): the server appends /?t=<token>.
variable "albums_url" {
  type    = string
  default = null
}

# Optional overrides for the Phase D public-link knobs (D51); the defaults
# here must match modules/compute/variables.tf, which must match config.ts
# (guard-tested). Same pass-through rule as the D43 knobs above: a tfvars
# value only reaches the module through these declarations.
variable "presign_public_get_expiry_seconds" {
  type    = number
  default = 3600
}

variable "public_link_daily_downloads" {
  type    = number
  default = 10000
}

variable "public_link_daily_uploads" {
  type    = number
  default = 1000
}

variable "public_link_daily_devices" {
  type    = number
  default = 1000
}

# Invite-gated signup (D54/D56): "open" (default) or "invite". Same
# pass-through rule as above — the module validates the value.
variable "signup_mode" {
  type    = string
  default = "open"
}
