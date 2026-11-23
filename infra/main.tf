terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project   = "vc-use-case-mapping-tool"
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  name   = "cdpi-usecase"
  bucket = coalesce(var.bucket_name, "${local.name}-submissions-${data.aws_caller_identity.current.account_id}")
}

# ---------------------------------------------------------------------------
# S3 — submission store. Private; the only writer is the ingest Lambda.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "submissions" {
  bucket = local.bucket
}

resource "aws_s3_bucket_public_access_block" "submissions" {
  bucket                  = aws_s3_bucket.submissions.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "submissions" {
  bucket = aws_s3_bucket.submissions.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "submissions" {
  bucket = aws_s3_bucket.submissions.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Keeps storage cost flat: old object versions are not retained forever, and
# incomplete multipart uploads are swept up.
resource "aws_s3_bucket_lifecycle_configuration" "submissions" {
  bucket = aws_s3_bucket.submissions.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ---------------------------------------------------------------------------
# Ingest Lambda — receives the export payload from the browser, writes the
# case JSON plus any attached files, then writes manifest.json last.
# ---------------------------------------------------------------------------

data "archive_file" "ingest" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/ingest"
  output_path = "${path.module}/.build/ingest.zip"
}

resource "aws_iam_role" "ingest" {
  name = "${local.name}-ingest"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "ingest" {
  name = "write-submissions"
  role = aws_iam_role.ingest.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.submissions.arn}/submissions/*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.ingest.arn}:*"
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "ingest" {
  name              = "/aws/lambda/${local.name}-ingest"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "ingest" {
  function_name    = "${local.name}-ingest"
  role             = aws_iam_role.ingest.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  filename         = data.archive_file.ingest.output_path
  source_code_hash = data.archive_file.ingest.output_base64sha256
  timeout          = 15
  memory_size      = 512

  environment {
    variables = {
      BUCKET         = aws_s3_bucket.submissions.id
      MAX_FILE_BYTES = tostring(var.max_file_bytes)
      MAX_FILES      = tostring(var.max_files_per_submission)
    }
  }

  depends_on = [aws_cloudwatch_log_group.ingest]
}

# ---------------------------------------------------------------------------
# HTTP API — the CDPI_SUBMIT_ENDPOINT the browser posts to.
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "submit" {
  name          = "${local.name}-submit"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = var.allowed_origins
    allow_methods = ["POST", "OPTIONS"]
    allow_headers = ["content-type"]
    max_age       = 3600
  }
}

resource "aws_apigatewayv2_integration" "submit" {
  api_id                 = aws_apigatewayv2_api.submit.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.ingest.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "submit" {
  api_id    = aws_apigatewayv2_api.submit.id
  route_key = "POST /submit"
  target    = "integrations/${aws_apigatewayv2_integration.submit.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.submit.id
  name        = "$default"
  auto_deploy = true

  # Throttling is the only thing standing between an unauthenticated public
  # endpoint and a large bill. Keep it low; exports are a human-paced action.
  default_route_settings {
    throttling_burst_limit = var.throttle_burst
    throttling_rate_limit  = var.throttle_rate
  }
}

resource "aws_lambda_permission" "apigw_ingest" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.submit.execution_arn}/*/*"
}

# ---------------------------------------------------------------------------
# Notifier Lambda — S3 ObjectCreated -> Slack webhook.
# Fires only on manifest.json (written last), so each submission produces
# exactly one Slack message regardless of how many files it carried.
# ---------------------------------------------------------------------------

data "archive_file" "notifier" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/notifier"
  output_path = "${path.module}/.build/notifier.zip"
}

resource "aws_iam_role" "notifier" {
  name = "${local.name}-notifier"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "notifier" {
  name = "read-submissions"
  role = aws_iam_role.notifier.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.submissions.arn}/submissions/*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.notifier.arn}:*"
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "notifier" {
  name              = "/aws/lambda/${local.name}-notifier"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "notifier" {
  function_name    = "${local.name}-notifier"
  role             = aws_iam_role.notifier.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  filename         = data.archive_file.notifier.output_path
  source_code_hash = data.archive_file.notifier.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      SLACK_WEBHOOK_URL = var.slack_webhook_url
      BUCKET            = aws_s3_bucket.submissions.id
    }
  }

  depends_on = [aws_cloudwatch_log_group.notifier]
}

resource "aws_lambda_permission" "s3_notifier" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.notifier.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.submissions.arn
}

resource "aws_s3_bucket_notification" "submissions" {
  bucket = aws_s3_bucket.submissions.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.notifier.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "submissions/"
    filter_suffix       = "manifest.json"
  }

  depends_on = [aws_lambda_permission.s3_notifier]
}
