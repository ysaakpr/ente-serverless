output "server_url" {
  value = "https://${aws_cloudfront_distribution.api.domain_name}"
}

# server_url + /albums since D60 — the one distribution serves the API on
# its DEFAULT behavior and the albums web app on /albums* (D58 consolidated;
# D60 inverted the layout to fit the FREE plan's 5-behavior ceiling), so
# public links are `https://<this domain>/albums/?t=<token>`. NOTE: this
# output can never feed the compute module's ALBUMS_URL directly — the
# lambda's env → this distribution → the function URL → the lambda is a
# dependency cycle — which is why `make plan` injects the value as
# albums_url_hint from the previous apply's server_url output instead (the
# env roots append the /albums suffix).
output "albums_url" {
  value = "https://${aws_cloudfront_distribution.api.domain_name}/albums"
}

# Consumed by `make pricing-plan` (D47): the AWS provider has no
# pricingplanmanager resource yet, so the CloudFront FREE-plan subscription is
# a one-time CLI step that needs exactly these two ARNs — the plan must cover
# one distribution and one web ACL. Run it once per environment (D58): the
# FREE plan allows at most 3 distributions per account, and consolidation
# keeps prod + test at 2.
output "distribution_arn" {
  value = aws_cloudfront_distribution.api.arn
}

output "web_acl_arn" {
  value = aws_wafv2_web_acl.api.arn
}

# Both consumed by `make deploy-web` (s3 sync + invalidation) — the
# invalidation targets the ONE consolidated distribution (D58).
output "distribution_id" {
  value = aws_cloudfront_distribution.api.id
}

output "web_bucket" {
  value = aws_s3_bucket.web.bucket
}
