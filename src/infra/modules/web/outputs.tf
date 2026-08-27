# The base URL public links are minted against: the server composes
# `<albums_url>/?t=<token>` (D51), so this output feeds the compute module's
# ALBUMS_URL. Re-creating the distribution mints a NEW domain — every link
# minted before that moment then points at a dead host (the tokens stay valid;
# re-copying the link from the app recovers it).
output "albums_url" {
  value = "https://${aws_cloudfront_distribution.web.domain_name}"
}

# Both consumed by `make deploy-web` (s3 sync + invalidation).
output "web_bucket" {
  value = aws_s3_bucket.web.bucket
}

output "web_distribution_id" {
  value = aws_cloudfront_distribution.web.id
}

output "web_distribution_arn" {
  value = aws_cloudfront_distribution.web.arn
}
