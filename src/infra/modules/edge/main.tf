/**
 * CloudFront in front of the Function URL. No OAC — that finding transfers
 * as-is from immich-serverless: with IAM auth the POST body hash breaks; the
 * Function URL stays auth NONE and CloudFront is the canonical path.
 * Bytes never pass through here (presigned S3 does the byte path), so the
 * cheap price class is fine.
 */

locals {
  origin_domain = replace(replace(var.api_function_url, "https://", ""), "/", "")
}

resource "aws_cloudfront_distribution" "api" {
  enabled         = true
  comment         = "ente-sl-${var.env_name} api"
  price_class     = "PriceClass_100"
  is_ipv6_enabled = true

  origin {
    domain_name = local.origin_domain
    origin_id   = "api"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "api"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]

    # Managed-CachingDisabled + Managed-AllViewerExceptHostHeader
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
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
