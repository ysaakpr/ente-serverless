/**
 * The stateless half: the API Lambda (Function URL, auth NONE — the pattern
 * proven by immich-serverless Phase 5) and the trash-purge cron. Plain zip
 * bundles — ente needs no sharp/ffmpeg, so no container image.
 *
 * Build the artifacts before `tofu apply`:
 *   make build-lambda    # esbuild -> dist/lambda/index.mjs, dist/trash-purge/index.mjs
 */

locals {
  prefix = "ente-sl-${var.env_name}"
}

data "archive_file" "api" {
  type        = "zip"
  source_dir  = "${path.module}/../../../../dist/lambda"
  output_path = "${path.module}/../../../../dist/lambda.zip"
}

data "archive_file" "trash_purge" {
  type        = "zip"
  source_dir  = "${path.module}/../../../../dist/trash-purge"
  output_path = "${path.module}/../../../../dist/trash-purge.zip"
}

resource "aws_lambda_function" "api" {
  function_name = "${local.prefix}-api"
  role          = aws_iam_role.api.arn
  runtime       = "nodejs22.x"
  handler       = "index.handler"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 30

  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256

  environment {
    variables = {
      TABLE_NAME              = var.table_name
      BUCKET_NAME             = var.objects_bucket
      HASHING_KEY             = var.hashing_key
      MAIL_FROM               = var.mail_from
      INSTANCE_ID             = local.prefix
      FREE_PLAN_STORAGE_BYTES = tostring(var.free_plan_storage_bytes)
    }
  }
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
}

/**
 * auth NONE does NOT by itself admit anonymous callers: the function still
 * needs a resource-based policy granting lambda:InvokeFunctionUrl to everyone.
 * Creating a public Function URL in the console adds this statement for you
 * (it names it FunctionURLAllowPublicAccess); the API does not, so tofu must.
 * Without it every request 403s — including CloudFront's, which makes the whole
 * deployment look broken at the edge while the lambda itself is fine.
 */
resource "aws_lambda_permission" "api_public_url" {
  statement_id           = "FunctionURLAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_function" "trash_purge" {
  function_name = "${local.prefix}-trash-purge"
  role          = aws_iam_role.api.arn
  runtime       = "nodejs22.x"
  handler       = "index.handler"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 300

  filename         = data.archive_file.trash_purge.output_path
  source_code_hash = data.archive_file.trash_purge.output_base64sha256

  environment {
    variables = {
      TABLE_NAME  = var.table_name
      BUCKET_NAME = var.objects_bucket
      HASHING_KEY = var.hashing_key
    }
  }
}

resource "aws_cloudwatch_event_rule" "trash_purge" {
  name                = "${local.prefix}-trash-purge"
  schedule_expression = "rate(1 day)"
}

resource "aws_cloudwatch_event_target" "trash_purge" {
  rule = aws_cloudwatch_event_rule.trash_purge.name
  arn  = aws_lambda_function.trash_purge.arn
}

resource "aws_lambda_permission" "trash_purge_events" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.trash_purge.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.trash_purge.arn
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${aws_lambda_function.api.function_name}"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "trash_purge" {
  name              = "/aws/lambda/${aws_lambda_function.trash_purge.function_name}"
  retention_in_days = 30
}
