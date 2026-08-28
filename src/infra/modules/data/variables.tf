variable "env_name" {
  type = string
}

# D59: how long originals sit in Standard before the tier=original lifecycle
# rule moves them to GLACIER_IR. Fresh uploads are the most-viewed, and GIR
# charges $0.03/GB retrieval on exactly those views — while day N in Standard
# costs only ~$0.023/GB-month prorated (~$0.0008/GB per day). Default 7 keeps
# the first week hot; 0 restores the old transition-at-once behavior.
variable "gir_transition_days" {
  type    = number
  default = 7

  validation {
    condition     = var.gir_transition_days >= 0
    error_message = "gir_transition_days must be >= 0."
  }
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

# Who may assume the operator role (ente-sl-<env>-operator) that the tools/ CLI
# runs under — invite.ts and storagePool.ts, which need dynamodb:Scan the
# execution role lacks. Empty (the default) trusts the ACCOUNT ROOT: the
# self-host answer, where the operator owns the account and any IAM principal
# in it that also holds sts:AssumeRole on the role can use it. Set it to
# specific IAM user / SSO-role ARNs to narrow who can assume it.
variable "operator_principal_arns" {
  type    = list(string)
  default = []
}
