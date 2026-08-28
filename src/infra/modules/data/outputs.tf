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

# The role the tools/ CLI assumes (invite + storage-pool provisioning). Point
# an AWS profile's role_arn at this, then run the make targets under it.
output "operator_role_arn" {
  value = aws_iam_role.operator.arn
}
