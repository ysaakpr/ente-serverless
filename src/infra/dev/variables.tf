variable "region" {
  type    = string
  default = "us-east-1"
}

variable "env_name" {
  type    = string
  default = "dev"
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
