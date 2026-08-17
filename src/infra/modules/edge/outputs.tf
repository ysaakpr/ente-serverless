output "server_url" {
  value = "https://${aws_cloudfront_distribution.api.domain_name}"
}
