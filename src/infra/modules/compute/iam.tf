/**
 * One execution role for both functions. Scoped to the table (+indexes) and
 * the objects bucket; SES send restricted to the configured identity.
 * NO s3:DeleteObject except for the purge path — the API deletes objects only
 * through trash purge/permanent delete, which shares this role (accepted for
 * core; split roles when the worker grows).
 */

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "ente-sl-${var.env_name}-api"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "api" {
  statement {
    sid = "Table"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [var.table_arn, "${var.table_arn}/index/*"]
  }

  statement {
    sid = "Objects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:PutObjectTagging",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${var.objects_bucket_arn}/*"]
  }

  statement {
    sid       = "ObjectsBucket"
    actions   = ["s3:ListBucket", "s3:ListBucketMultipartUploads"]
    resources = [var.objects_bucket_arn]
  }

  # BYO storage pools (H2, D55; scoped D56): the execution role — shared by
  # the API lambda AND the trash-purge worker — assumes each pool's
  # bucket-access role. Scoped to the ente-pool-* NAMING CONVENTION instead of
  # "*": each pool role's trust policy + mandatory ExternalId remains the real
  # gate, but a pool role whose trust policy names the ACCOUNT ROOT (a common
  # operator shortcut) is assumable by ANY principal in that account holding
  # sts:AssumeRole on "*" — the name scope keeps this deployment's reach to
  # roles that opted into the convention, without the per-pool ARN churn that
  # made enumeration unattractive. pool-create refuses role ARNs outside the
  # convention (tools/storagePool.ts).
  statement {
    sid       = "PoolAssumeRole"
    actions   = ["sts:AssumeRole"]
    resources = ["arn:aws:iam::*:role/ente-pool-*"]
  }

  statement {
    sid       = "Mail"
    actions   = ["ses:SendEmail"]
    resources = ["*"]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:*:*:log-group:/aws/lambda/ente-sl-${var.env_name}-*"]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "ente-sl-${var.env_name}-api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}
