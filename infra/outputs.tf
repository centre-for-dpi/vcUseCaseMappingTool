output "submit_endpoint" {
  description = "Value for CDPI_SUBMIT_ENDPOINT in index.html."
  value       = "${aws_apigatewayv2_api.submit.api_endpoint}/submit"
}

output "view_endpoint" {
  description = "Value for CDPI_VIEW_ENDPOINT in index.html."
  value       = "${aws_apigatewayv2_api.submit.api_endpoint}/view"
}

output "bucket_name" {
  description = "S3 bucket holding submissions."
  value       = aws_s3_bucket.submissions.id
}

output "ingest_log_group" {
  value = aws_cloudwatch_log_group.ingest.name
}

output "notifier_log_group" {
  value = aws_cloudwatch_log_group.notifier.name
}

output "viewer_log_group" {
  value = aws_cloudwatch_log_group.viewer.name
}
