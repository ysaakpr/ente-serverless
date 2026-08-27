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

  # Spend ceiling, layer 2 (security review 2026-08-17, finding 4): a hard
  # invocation ceiling so anonymous traffic cannot scale to the account limit.
  # Double edge, stated honestly: once exhausted, legitimate users throttle
  # too — for a single-owner deployment that is a far better failure mode than
  # an unbounded bill. A shared deployment should raise or unset this and lean
  # on the WAF rate rule instead.
  reserved_concurrent_executions = var.api_reserved_concurrency

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
      # Public album links (Phase D/F, D51/D52): where minted links point —
      # `<ALBUMS_URL>/?t=<token>` — normally the web module's distribution.
      ALBUMS_URL = var.albums_url
      # Short public presign + the per-link daily ceilings (plan §4.1/§4.2).
      PRESIGN_PUBLIC_GET_EXPIRY_SECONDS = tostring(var.presign_public_get_expiry_seconds)
      PUBLIC_LINK_DAILY_DOWNLOADS       = tostring(var.public_link_daily_downloads)
      PUBLIC_LINK_DAILY_UPLOADS         = tostring(var.public_link_daily_uploads)
      PUBLIC_LINK_DAILY_DEVICES         = tostring(var.public_link_daily_devices)
      # Origin lock (finding 4): the app 403s any request not carrying this
      # value in x-origin-secret; CloudFront injects it at the origin, so the
      # public Function URL stops bypassing every edge control.
      ORIGIN_SECRET = var.origin_secret
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

/**
 * Alarms. The failure this exists for is the daily purge erroring silently for
 * weeks: it drains the deferred object-sweep queue (D6), so a dead cron means
 * deleted bytes are never reclaimed and the bill grows with no other signal.
 *
 * Scope, so the absence of an alarm is not misread as health: Lambda's `Errors`
 * metric counts FAILED INVOCATIONS — crashes, timeouts, OOM, init failures. It
 * does NOT count application errors that hono handles and returns, so a 500
 * from an SES rejection on POST /users/ott will not fire this. That is a log
 * concern, not an alarm concern.
 */
resource "aws_sns_topic" "alarms" {
  name = "${local.prefix}-alarms"
}

# Confirm the subscription from your inbox — AWS sends a one-click link and the
# subscription stays "pending confirmation", silently dropping alarms, until you do.
resource "aws_sns_topic_subscription" "alarms_email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "api_errors" {
  alarm_name          = "${local.prefix}-api-errors"
  alarm_description   = "The API lambda failed an invocation (crash/timeout/OOM), not an HTTP 4xx/5xx."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.api.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# Daily cron, so a daily window: a 5-minute period would evaluate ~287 empty
# windows between runs and tell you nothing.
# Spend ceiling, layer 1 (finding 4): fixes nothing, but converts a surprise
# invoice into a page. ACTUAL spend, not forecast — a page should mean money
# already left. Budgets publishes through SNS, which needs the explicit topic
# policy below (and that policy REPLACES the account default, so CloudWatch's
# alarm-publish grant must be restated alongside or the Errors alarms go mute).
resource "aws_budgets_budget" "monthly" {
  name         = "${local.prefix}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alarms.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alarms.arn]
  }
}

resource "aws_sns_topic_policy" "alarms" {
  arn = aws_sns_topic.alarms.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowBudgetsPublish"
        Effect    = "Allow"
        Principal = { Service = "budgets.amazonaws.com" }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.alarms.arn
      },
      {
        Sid       = "AllowCloudWatchAlarmsPublish"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.alarms.arn
      }
    ]
  })
}

resource "aws_cloudwatch_metric_alarm" "trash_purge_errors" {
  alarm_name          = "${local.prefix}-trash-purge-errors"
  alarm_description   = "The daily trash/object-sweep worker failed. Unreclaimed bytes keep billing until it succeeds."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.trash_purge.function_name }
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}
