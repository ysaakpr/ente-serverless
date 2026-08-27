/**
 * Static hosting for the albums web viewer (Phase F, D52) — the second client
 * in the compatibility contract (plan §3 caveat 5): public links minted by
 * /collections/share-url are `<albums_url>/?t=<token>`, and this module is
 * what serves that URL.
 *
 * A SECOND distribution, not a new behavior on the API one, because ALBUMS_URL
 * is a different BASE URL by contract (museum's apps.public-albums is a
 * separate origin from the API) and the dev env uses default *.cloudfront.net
 * domains — one distribution cannot carry two default domains. It also keeps
 * the API distribution byte-identical to what the D47 FREE pricing plan was
 * subscribed against.
 *
 * Pricing: this distribution deliberately stays on PAY-AS-YOU-GO. The D47
 * FREE-plan subscription covers exactly the API distribution + its web ACL,
 * and static assets sit comfortably inside CloudFront's perpetual free tier
 * (1 TB / 10M requests per month) — a few MB of hashed JS/CSS at
 * personal-link traffic is pennies at worst. No WAF here: a cached static
 * origin has no per-request compute to protect, and a web ACL is $5/mo flat
 * on pay-as-you-go. Rate limiting for /public-collection/* API calls lives on
 * the API distribution's WAF (see modules/edge — FREE-plan constraint notes).
 *
 * Unlike the Lambda origin (where the no-OAC finding transfers from
 * immich-serverless: IAM auth breaks the POST body hash), an S3 origin takes
 * OAC cleanly — the bucket stays fully private and only this distribution
 * can read it.
 */

data "aws_caller_identity" "current" {}

locals {
  prefix = "ente-sl-${var.env_name}"
  suffix = data.aws_caller_identity.current.account_id
}

/**
 * Build artifacts only — `make build-web` regenerates everything in here from
 * the pinned ente release, so unlike the objects bucket this one is
 * deliberately destroyable (force_destroy, no prevent_destroy, no
 * versioning): `make destroy` tears it down with the rest of the stateless
 * half at the cost of a rebuild, never a memory.
 */
resource "aws_s3_bucket" "web" {
  bucket        = "${local.prefix}-web-albums-${local.suffix}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${local.prefix}-web-albums"
  description                       = "albums static bucket — OAC, bucket stays private"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

/**
 * Only CloudFront (this distribution, by ARN) may read objects. Note
 * block_public_policy above does not block this policy: the principal is the
 * cloudfront service, not "*".
 */
resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontServicePrincipalReadOnly"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.web.arn}/*"
        Condition = {
          StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.web.arn }
        }
      }
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.web]
}

locals {
  # AWS managed policies, by well-known ID (same technique as modules/edge):
  # CachingOptimized for the hashed/immutable assets, CachingDisabled for
  # index.html (the one un-hashed file — a stale copy pins users to a dead
  # asset manifest), SecurityHeadersPolicy for HSTS/nosniff at the edge.
  managed_caching_optimized          = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  managed_caching_disabled           = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  managed_security_headers_policy_id = "67f7725c-6f97-4210-82d7-5512b31e9d03"
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  comment             = "ente-sl-${var.env_name} albums web"
  default_root_object = "index.html"
  is_ipv6_enabled     = true

  # Pay-as-you-go (see header) — so the old §2.1 analysis applies again and
  # the class is a real choice. _All buys nothing here: the assets are cached
  # at whatever edge answers, and the albums page's API calls go to the API
  # distribution, which IS PriceClass_All.
  price_class = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "web-albums"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  default_cache_behavior {
    target_origin_id       = "web-albums"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = local.managed_caching_optimized
    response_headers_policy_id = local.managed_security_headers_policy_id
  }

  # index.html must never be cached long: it names the current hashed asset
  # files, so a stale index after a redeploy 404s every asset it references.
  # (deploy-web still invalidates, belt and braces.)
  ordered_cache_behavior {
    path_pattern           = "/index.html"
    target_origin_id       = "web-albums"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = local.managed_caching_disabled
    response_headers_policy_id = local.managed_security_headers_policy_id
  }

  /**
   * SPA fallback: the albums app is a static export whose client router owns
   * the URL space. A path with no matching object comes back from S3 as 403
   * (OAC without s3:ListBucket turns NoSuchKey into AccessDenied) — both it
   * and a plain 404 must serve index.html with a 200 so the app boots and
   * routes. error_caching_min_ttl 0: never cache the fallback decision, or a
   * freshly-synced asset keeps 200-ing index.html for the TTL.
   */
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
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
