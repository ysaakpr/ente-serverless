output "table_name" {
  value = aws_dynamodb_table.this.name
}

output "table_arn" {
  value = aws_dynamodb_table.this.arn
}

output "objects_bucket" {
  value = aws_s3_bucket.objects.bucket
}

output "objects_bucket_arn" {
  value = aws_s3_bucket.objects.arn
}
