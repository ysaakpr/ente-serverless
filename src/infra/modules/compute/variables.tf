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

variable "free_plan_storage_bytes" {
  type    = number
  default = 1125899906842624 # 1 PiB — effectively unlimited (decision D11); museum's constant is 10 GiB
}
