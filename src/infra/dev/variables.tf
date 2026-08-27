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

# Optional override for where share links point (D51/D52/D58/D60). Null
# means "this deployment's own distribution domain + /albums" (the albums
# app rides the same distribution as the API since D58, under the /albums*
# behavior since D60 — see albums_url_hint below), which is right until a
# custom domain fronts the stack. If set, it must be the full base URL the
# viewer is served at, WITHOUT a trailing slash (e.g.
# https://albums.example.com — the server appends /?t=<token>); it is used
# verbatim, no /albums suffix is appended.
variable "albums_url" {
  type    = string
  default = null
}

# NOT a tfvars value — injected by `make plan` as
# `-var albums_url_hint=$(tofu output -raw server_url)`. The albums app is
# served by the SAME distribution as the API (D58) under /albums (D60), so
# ALBUMS_URL should be that distribution's own URL + /albums (the suffix is
# appended in the env root's coalesce) — a value tofu cannot wire
# declaratively (lambda env → distribution → function URL → lambda is a
# dependency cycle). The hint feeds the previous apply's server_url back in
# at plan time: a distribution's domain never changes in place, so the value
# is stable from the first apply on. Empty (a fresh env's first plan, or a
# bare `tofu plan`) falls through to the loud .invalid sentinel; the routine
# next plan/deploy pins the real domain.
variable "albums_url_hint" {
  type    = string
  default = ""
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

# D59: days originals spend in Standard before the lifecycle rule moves them
# to GLACIER_IR. Same pass-through rule as above — the module validates >= 0.
# Tradeoff: day N in Standard ≈ $0.023/GB-mo prorated, vs GIR retrieval at
# $0.03/GB on early views — and fresh uploads are the most-viewed.
variable "gir_transition_days" {
  type    = number
  default = 7
}

# D57: API-level delete protection for the stateful half. true (the default,
# right for prod): the table refuses DeleteTable at the AWS API level —
# console included — and the objects bucket refuses destroy while non-empty.
# false (test envs only): teardown genuinely deletes the data. NEVER set
# false in a production tfvars.
variable "delete_protection" {
  type    = bool
  default = true
}
