/**
 * The ONE CloudFront distribution per environment (D58) — it fronts BOTH the
 * API (Lambda Function URL origin) and the albums web viewer (private S3
 * bucket via OAC). Consolidated 2026-08-27 from the former two-distribution
 * layout (API here + a standalone albums distribution in modules/web, D52):
 * the CloudFront flat-rate FREE pricing plan allows at most 3 distributions
 * per account and covers one distribution + one web ACL per subscription, so
 * one distribution per env is what lets prod AND test both ride the $0 plan
 * (2 of 3 used, one spare).
 *
 * Layout of the one distribution (D60 — INVERTED from the first D58 cut):
 *   - The DEFAULT behavior is the API, exactly as it was before D58:
 *     CachingDisabled + AllViewerExceptHostHeader, all 7 methods, https-only,
 *     x-origin-secret injected at the origin. The distribution's domain IS
 *     the server_url real devices are configured with (7-tap custom
 *     endpoint), the Lambda sees unrewritten paths (byte-identical museum
 *     shapes), unknown paths get museum-shaped 404 JSON from the app, and a
 *     new route group in src/app.ts needs NO infra change, ever.
 *   - ONE ordered behavior, `/albums*`, serves the albums web app from the
 *     private S3 bucket (OAC). The web assets live under the `albums/` KEY
 *     PREFIX in the bucket (`make deploy-web` syncs them there) and the app
 *     is built with Next's basePath=/albums (`make build-web` patches the
 *     pinned config), so the request URI maps 1:1 onto the object key — no
 *     origin path, no prefix rewrite. SPA fallback is a viewer-request
 *     CloudFront FUNCTION on THIS behavior only, rewriting extensionless
 *     URIs (bare /albums and /albums/ included) to /albums/index.html.
 *   - WHY inverted: the first D58 cut put the web app on the default
 *     behavior and gave every app.ts route prefix its own ordered behavior —
 *     17 behaviors total — and the FREE pricing plan refused the
 *     subscription with "You're using configuration not available in this
 *     tier: 17 cache behaviors (limit 5)". The FREE tier caps a distribution
 *     at 5 cache behaviors (default + ordered); this layout uses 2. The
 *     ceiling is guard-tested (test/infra/web.test.ts) with the error quoted.
 *   - index.html freshness WITHOUT a dedicated behavior: `make deploy-web`
 *     uploads albums/index.html with `Cache-Control: no-cache` metadata
 *     (and the hashed /_next assets with a 1y immutable max-age) —
 *     CachingOptimized honors origin Cache-Control, so a stale index (which
 *     names the current hashed assets) can outlive a redeploy by at most
 *     CachingOptimized's 1s min TTL. deploy-web's /* invalidation stays the
 *     belt and braces.
 *   - The app.ts namespace must never grow an /albums route group — it would
 *     be shadowed by the ordered behavior. Museum has none today;
 *     guard-tested so it stays that way.
 *   - LOAD-BEARING CONSTRAINT (unchanged from D58): custom_error_response
 *     must NEVER appear on this distribution. Error responses are
 *     DISTRIBUTION-WIDE — a 403/404→index.html mapping (the old modules/web
 *     SPA fallback) would rewrite the API's museum-shaped 404/403 JSON
 *     bodies into HTML for every client. The CloudFront function replaces it
 *     scoped to the /albums* behavior only. Guard-tested.
 *
 * No OAC on the Lambda origin — that finding transfers as-is from
 * immich-serverless: with IAM auth the POST body hash breaks; the Function
 * URL stays auth NONE and CloudFront is the canonical path. The S3 origin
 * takes OAC cleanly and must have it (bucket stays fully private). Photo
 * bytes never pass through here (presigned S3 is the byte path), so only
 * small JSON plus a few MB of static assets cross this distribution.
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

data "aws_caller_identity" "current" {}

locals {
  origin_domain = replace(replace(var.api_function_url, "https://", ""), "/", "")
  prefix        = "ente-sl-${var.env_name}"
  suffix        = data.aws_caller_identity.current.account_id
}

# CLOUDFRONT-scope WAF resources only exist in us-east-1, hence the aliased
# provider regardless of where the rest of the stack lives. Since D58 the ACL
# also fronts the albums web assets — cached responses still count against
# the rate rule (WAF evaluates before the cache), which only errs stricter.
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
  #
  # The /public-collection surface (Phase D/F, plan §4.1a, D52): the anonymous album
  # surface rides this SAME distribution and therefore this same rule — a
  # scraper hammering a leaked link dies at the edge at 2000/5min/IP like any
  # other flood. A TIGHTER path-scoped rate rule is not possible on the FREE
  # plan: scoping a rate statement to the /public-collection prefix needs a
  # byte-match scope-down, which is exactly the feature D47 gave up. The
  # narrower bounds live in the app instead, where they are per-LINK rather
  # than per-IP (D51): token check first as one GetItem (cheap fail),
  # verify-password attempt caps, per-link daily download/upload ceilings,
  # and short public presigns. Restore a 300/5min scoped rule here only if
  # the pricing plan is ever cancelled back to pay-as-you-go.
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

locals {
  # AWS managed policies, by well-known ID. All FREE-tier-safe (D47) —
  # custom response-headers policies are not in the FREE pricing-plan tier,
  # so the managed SecurityHeadersPolicy stands in for D43's no-referrer
  # policy: it keeps HSTS (1y) and nosniff, and carries Referrer-Policy
  # strict-origin-when-cross-origin instead of no-referrer — cross-origin
  # Referers then carry scheme+host only, so the ?token= URLs (D32) still
  # never leak their query string to third parties. The extra
  # X-Frame-Options / X-XSS-Protection it adds are harmless.
  managed_caching_disabled              = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  managed_caching_optimized             = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  managed_all_viewer_except_host_header = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  managed_security_headers_policy_id    = "67f7725c-6f97-4210-82d7-5512b31e9d03"
}

/**
 * Albums web hosting (Phase F, D52; folded into this module by D58). Build
 * artifacts only — `make build-web` regenerates everything in here from the
 * pinned ente release, so unlike the objects bucket this one is deliberately
 * destroyable (force_destroy, no prevent_destroy, no versioning):
 * `make destroy` tears it down with the rest of the stateless half at the
 * cost of a rebuild, never a memory.
 *
 * Since D60 the assets live under the `albums/` KEY PREFIX (deploy-web syncs
 * there): the /albums* viewer URI is the object key, verbatim, so the
 * behavior needs no origin path and the function no asset rewrites.
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
 * Only CloudFront (the one distribution, by ARN) may read objects. Note
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
          StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.api.arn }
        }
      }
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.web]
}

/**
 * SPA fallback for the albums app, scoped to the /albums* behavior ONLY —
 * the replacement for the old distribution-wide custom_error_response
 * mapping, which the consolidated distribution can never carry (it would
 * rewrite the API's museum-shaped 404/403 JSON into HTML — see the header).
 * A URI whose last segment has no extension is a client-router path (bare
 * /albums has last segment "albums", /albums/ has "": both extensionless,
 * both covered) and rewrites to /albums/index.html — the app shell's object
 * key, since the assets live under the albums/ prefix; asset paths (anything
 * with a dot) pass through. The rewrite happens inside the /albums*
 * behavior, so a deep link serves index.html under the CachingOptimized
 * policy — deploy-web uploads index.html with Cache-Control: no-cache (D60),
 * which CachingOptimized honors, and its /* invalidation on every sync stays
 * the belt and braces.
 */
resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "${local.prefix}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "albums SPA fallback: extensionless /albums* URIs -> /albums/index.html (D60)"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var uri = event.request.uri;
      var last = uri.split('/').pop();
      if (last.indexOf('.') === -1) {
        event.request.uri = '/albums/index.html';
      }
      return event.request;
    }
  EOT
}

/**
 * FREE-TIER BEHAVIOR CEILING (D60): the CloudFront flat-rate FREE pricing
 * plan allows AT MOST 5 cache behaviors per distribution (default + ordered
 * combined) — the first D58 cut's 17-behavior layout was refused at
 * subscription time with the exact error: "You're using configuration not
 * available in this tier: 17 cache behaviors (limit 5)". This distribution
 * uses 2 (default → API, /albums* → web bucket); the guard test
 * (test/infra/web.test.ts) fails the build past 5.
 */
resource "aws_cloudfront_distribution" "api" {
  enabled         = true
  comment         = "ente-sl-${var.env_name} api + albums web"
  price_class     = "PriceClass_All"
  is_ipv6_enabled = true
  web_acl_id      = aws_wafv2_web_acl.api.arn

  # Deliberately NO default_root_object: the default behavior is the API, so
  # `/` belongs to the Lambda (museum-shaped 404, exactly as pre-D58) — a
  # root object would silently turn `/` into a web-bucket fetch.

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

  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "web-albums"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  # DEFAULT → the API, byte-identical to the pre-D58 default behavior:
  # Managed-CachingDisabled + Managed-AllViewerExceptHostHeader (a Function
  # URL origin must not receive the viewer Host) + the managed security
  # headers, all 7 methods, https-only, no compression — small JSON either
  # way. Unknown paths reach the Lambda and 404 museum-shaped; new app.ts
  # route groups need no edge change.
  default_cache_behavior {
    target_origin_id       = "api"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]

    cache_policy_id            = local.managed_caching_disabled
    origin_request_policy_id   = local.managed_all_viewer_except_host_header
    response_headers_policy_id = local.managed_security_headers_policy_id
  }

  # /albums* → the albums web app (the ONLY web-facing pattern; src/app.ts
  # must never register an /albums route group — guard-tested). Hashed
  # assets cache long under CachingOptimized; index.html rides the same
  # policy but is uploaded with Cache-Control: no-cache (deploy-web, D60),
  # which the policy honors. redirect-to-https (not https-only): this
  # behavior faces browsers following pasted links, and a redirect beats an
  # error.
  ordered_cache_behavior {
    path_pattern           = "/albums*"
    target_origin_id       = "web-albums"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = local.managed_caching_optimized
    response_headers_policy_id = local.managed_security_headers_policy_id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }
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
