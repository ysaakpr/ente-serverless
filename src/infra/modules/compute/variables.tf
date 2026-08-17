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
