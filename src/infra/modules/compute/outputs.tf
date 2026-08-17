output "api_function_url" {
  value = aws_lambda_function_url.api.function_url
}

output "api_function_name" {
  value = aws_lambda_function.api.function_name
}
