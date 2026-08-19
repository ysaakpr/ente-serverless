/**
 * CloudFront in front of the Function URL. No OAC — that finding transfers
 * as-is from immich-serverless: with IAM auth the POST body hash breaks; the
 * Function URL stays auth NONE and CloudFront is the canonical path.
 * Bytes never pass through here (presigned S3 does the byte path), so only
 * small JSON crosses this distribution.
 *
 * PriceClass_All is a FREE-plan requirement, not a choice (D47): the
 * subscription was refused for a PriceClass_200 distribution ("resources are
 * not eligible for this subscription tier" — an undocumented gate; the
 * console flipped the class to All when subscribing). Under the flat plan,
 * per-region request pricing is moot anyway, and All buys the nearest edge
 * everywhere. The old PriceClass_200-vs-100 cost analysis lives in
 * AWS-RESOURCES.md §2.1 and matters again only on pay-as-you-go.
 *
 * Security review 2026-08-17 additions (findings 4 and 6):
 *   - the origin injects x-origin-secret, which the app now requires — the
 *     directly-reachable Function URL stops bypassing everything below;
 *   - a WAFv2 rate rule, which is what actually bounds finding 2's write
 *     amplification (TTL bounds the stored bytes; this bounds the request
 *     rate);
 *   - security response headers set at the edge, NOT in the app: the app is
 *     byte-faithful to museum's header set (D29), and HSTS on a
 *     *.cloudfront.net domain is a property of the distribution.
 *
 * Reshaped 2026-08-19 (D47) to fit the CloudFront flat-rate FREE pricing
 * plan, which zeroes the WAF + CloudFront request bill but gates two
 * features this module used: byte-match statements (the rate rule's
 * auth-path scope-down) and custom response-headers policies (no-referrer).
 * Both got FREE-tier substitutes — see the comments at each site. Restore
 * the D43 originals only if the plan is ever cancelled back to
 * pay-as-you-go.
 */

terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = "~> 6.0"
      configuration_aliases = [aws.use1]
    }
  }
}

locals {
  origin_domain = replace(replace(var.api_function_url, "https://", ""), "/", "")
}

# CLOUDFRONT-scope WAF resources only exist in us-east-1, hence the aliased
# provider regardless of where the rest of the stack lives.
resource "aws_wafv2_web_acl" "api" {
  provider = aws.use1
  name     = "ente-sl-${var.env_name}-api"
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # 2000 requests per 5 minutes per IP across ALL routes. D43 scoped this to
  # the unauthenticated POST auth routes at 300/5min via byte-match
  # scope-down statements, but byte match is not in the FREE pricing-plan
  # tier (D47) — plain IP rate limiting is. Unscoped, the limit must clear a
  # real client's initial-backup burst (one API call per registered file;
  # bytes ride presigned S3 and never cross this distribution), so ~6.7
  # req/s sustained. This is a flood ceiling, not a brute-force bound: the
  # per-account auth caps live in the app and are atomic (D42/D45 — OTT 20
  # wrong, SRP 5 attempts, TOTP 5). Blocked requests never reach Lambda and
  # never count against the plan allowance.
  rule {
    name     = "rate-limit-per-ip"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "ente-sl-${var.env_name}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "ente-sl-${var.env_name}-api"
    sampled_requests_enabled   = true
  }
}

# Security headers via the AWS managed SecurityHeadersPolicy — custom
# response-headers policies are not in the FREE pricing-plan tier (D47).
# It keeps D43's HSTS (1y) and nosniff, and carries Referrer-Policy
# strict-origin-when-cross-origin instead of no-referrer: cross-origin
# Referers then carry scheme+host only, so the ?token= URLs (D32) still
# never leak their query string to third parties — what leaks is only that
# the request came from this domain. The extra X-Frame-Options /
# X-XSS-Protection it adds are harmless on a JSON API.
locals {
  managed_security_headers_policy_id = "67f7725c-6f97-4210-82d7-5512b31e9d03"
}

resource "aws_cloudfront_distribution" "api" {
  enabled         = true
  comment         = "ente-sl-${var.env_name} api"
  price_class     = "PriceClass_All"
  is_ipv6_enabled = true
  web_acl_id      = aws_wafv2_web_acl.api.arn

  origin {
    domain_name = local.origin_domain
    origin_id   = "api"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    # Origin lock (finding 4): the app refuses requests without this header,
    # so a WAF/headers bypass via the public Function URL stops working.
    custom_header {
      name  = "x-origin-secret"
      value = var.origin_secret
    }
  }

  default_cache_behavior {
    target_origin_id       = "api"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]

    # Managed-CachingDisabled + Managed-AllViewerExceptHostHeader +
    # Managed-SecurityHeadersPolicy — all AWS managed, all FREE-tier-safe.
    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id   = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
    response_headers_policy_id = local.managed_security_headers_policy_id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
