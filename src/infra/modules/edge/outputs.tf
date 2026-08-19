output "server_url" {
  value = "https://${aws_cloudfront_distribution.api.domain_name}"
}

# Consumed by `make pricing-plan` (D47): the AWS provider has no
# pricingplanmanager resource yet, so the CloudFront FREE-plan subscription is
# a one-time CLI step that needs exactly these two ARNs — the plan must cover
# one distribution and one web ACL.
output "distribution_arn" {
  value = aws_cloudfront_distribution.api.arn
}

output "web_acl_arn" {
  value = aws_wafv2_web_acl.api.arn
}
