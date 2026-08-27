variable "env_name" {
  type = string
}

# D57: replaces the old lifecycle prevent_destroy blocks, which tofu only
# accepts as literals — a var-driven rail has to live at the AWS API level
# instead. true (the default, right for prod): the table refuses DeleteTable
# for EVERYONE including the console (strictly stronger than prevent_destroy,
# which only ever stopped tofu), and the objects bucket refuses destroy while
# non-empty (force_destroy off — today's effective behavior). false (test
# envs only): `make destroy-data` genuinely tears the data down.
variable "delete_protection" {
  type    = bool
  default = true
}
