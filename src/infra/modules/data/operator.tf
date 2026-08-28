/**
 * The operator role the CLI tools assume — tools/invite.ts (invite-gated
 * signup + per-user storage, D54) and tools/storagePool.ts (BYO-pool
 * provisioning, D55). These run as a HUMAN operator, never the Lambda, and
 * they need table access the execution role deliberately withholds:
 * dynamodb:Scan, which every `list` subcommand uses and which the API role
 * omits on purpose (a runaway Scan is a self-host footgun, not a request-path
 * need). So the CLI gets its own least-privilege role instead of borrowing
 * ente-sl-<env>-api.
 *
 * Scope — the table (+ indexes) and sts:AssumeRole on the ente-pool-*
 * convention, nothing else:
 *  - Table: Get/Put/Update/Delete/Query/Scan. Scan is the only action beyond
 *    the execution role's set; the rest back putPool/setUserPool/upsertInvite/
 *    setUserStorage and pool-requeue's Query+Update queue drain.
 *  - PoolAssumeRole: `create`/`requeue` validate a role-mode pool by assuming
 *    its bucket role with the OPERATOR's creds (tools/storagePool.ts), so the
 *    operator needs the same assume-role reach as the execution role's
 *    PoolAssumeRole statement — the pool role's trust policy + mandatory
 *    ExternalId stay the real gate (D56 confused-deputy note).
 *  - NO S3: pool validation runs entirely with the pool's assumed-role or
 *    static keys (never this role), and no CLI path touches the central
 *    objects bucket. A keys-mode pool needs no IAM here at all.
 *
 * Trust — operator_principal_arns when set, else the account root. The root
 * default is the self-host answer (the operator owns the account); any IAM
 * principal in the account that also holds sts:AssumeRole on this role can use
 * it. Named ente-sl-* so the deployer policy's IamForExecutionRole statement
 * (iam:CreateRole/PutRolePolicy on arn:aws:iam::*:role/ente-sl-*) can manage
 * it with no deployer-policy change.
 */

data "aws_iam_policy_document" "operator_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type = "AWS"
      identifiers = length(var.operator_principal_arns) > 0 ? var.operator_principal_arns : [
        "arn:aws:iam::${local.suffix}:root",
      ]
    }
  }
}

resource "aws_iam_role" "operator" {
  name               = "${local.prefix}-operator"
  assume_role_policy = data.aws_iam_policy_document.operator_assume.json
}

data "aws_iam_policy_document" "operator" {
  statement {
    sid = "TableItemsAndScan"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan",
    ]
    resources = [aws_dynamodb_table.this.arn, "${aws_dynamodb_table.this.arn}/index/*"]
  }

  # Role-mode pool validation only — same reach and same rationale as the
  # execution role's PoolAssumeRole (the pool role's trust policy + ExternalId
  # is the gate). Keys-mode pools never reach this.
  statement {
    sid       = "PoolAssumeRole"
    actions   = ["sts:AssumeRole"]
    resources = ["arn:aws:iam::*:role/ente-pool-*"]
  }
}

resource "aws_iam_role_policy" "operator" {
  name   = "${local.prefix}-operator"
  role   = aws_iam_role.operator.id
  policy = data.aws_iam_policy_document.operator.json
}
