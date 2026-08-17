/**
 * CloudFront in front of the Function URL. No OAC — that finding transfers
 * as-is from immich-serverless: with IAM auth the POST body hash breaks; the
 * Function URL stays auth NONE and CloudFront is the canonical path.
 * Bytes never pass through here (presigned S3 does the byte path), so only
 * small JSON crosses this distribution.
 *
 * PriceClass_200 over _100 costs nothing worth counting: every region _200
 * adds (India, Asia, Japan, Middle East, South Africa) bills at $0.0120 per
 * 10k HTTPS requests — the same rate as Europe, which _100 already includes.
 * The only dearer regions (Australia $0.0125, South America $0.0220) are in
 * _All, not _200. Worst case is a US-served request at $0.0100 moving to a
 * Mumbai edge at $0.0120: +$0.002 per 10k. The perpetual 1 TB / 10M-request
 * free tier still applies to pay-as-you-go, so in practice this is $0 either
 * way. Buys a nearer edge for Asian viewers on every API round-trip.
 *
 * Security review 2026-08-17 additions (findings 4 and 6):
 *   - the origin injects x-origin-secret, which the app now requires — the
 *     directly-reachable Function URL stops bypassing everything below;
 *   - a WAFv2 rate rule on the unauthenticated POST auth routes, which is
 *     what actually bounds finding 2's write amplification (TTL bounds the
 *     stored bytes; this bounds the request rate);
 *   - a response-headers policy (HSTS, nosniff, Referrer-Policy). Set at the
 *     edge, NOT in the app: the app is byte-faithful to museum's header set
 *     (D29), and HSTS on a *.cloudfront.net domain is a property of the
 *     distribution. no-referrer is the one that earns its place — it stops
 *     the ?token= URLs (D32) riding out in a Referer header.
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

  # 300 requests per 5 minutes per IP, only on the unauthenticated POST auth
  # routes (/users/ott, /users/srp/*, /users/two-factor/*) — one request a
  # second sustained, far above any real client's login behaviour and far
  # below a brute-force or table-stuffing rate.
  rule {
    name     = "rate-limit-unauth-auth-posts"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 300
        aggregate_key_type = "IP"

        scope_down_statement {
          or_statement {
            statement {
              byte_match_statement {
                search_string         = "/users/ott"
                positional_constraint = "STARTS_WITH"
                field_to_match {
                  uri_path {}
                }
                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
            statement {
              byte_match_statement {
                search_string         = "/users/srp/"
                positional_constraint = "STARTS_WITH"
                field_to_match {
                  uri_path {}
                }
                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
            statement {
              byte_match_statement {
                search_string         = "/users/two-factor/"
                positional_constraint = "STARTS_WITH"
                field_to_match {
                  uri_path {}
                }
                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "ente-sl-${var.env_name}-auth-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "ente-sl-${var.env_name}-api"
    sampled_requests_enabled   = true
  }
}

resource "aws_cloudfront_response_headers_policy" "api" {
  name = "ente-sl-${var.env_name}-security-headers"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      override                   = true
    }
    content_type_options {
      override = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
  }
}

resource "aws_cloudfront_distribution" "api" {
  enabled         = true
  comment         = "ente-sl-${var.env_name} api"
  price_class     = "PriceClass_200"
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

    # Managed-CachingDisabled + Managed-AllViewerExceptHostHeader
    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id   = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.api.id
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
