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
