variable "aws_region" {
  description = "Region for all resources."
  type        = string
  default     = "ap-south-1"
}

variable "aws_profile" {
  description = "Local AWS CLI profile used to apply this stack."
  type        = string
  default     = "cdpi"
}

variable "bucket_name" {
  description = "Override the submissions bucket name. Defaults to cdpi-usecase-submissions-<account-id>."
  type        = string
  default     = null
}

variable "slack_webhook_url" {
  description = "Slack incoming webhook the notifier posts to. Set in terraform.tfvars (gitignored) or TF_VAR_slack_webhook_url."
  type        = string
  sensitive   = true
}

variable "allowed_origins" {
  description = "Origins allowed to POST to the submit endpoint (browser CORS)."
  type        = list(string)
  # Pages serves the tool from the custom domain, with HTTPS enforced.
  default = [
    "https://vc.use-case-mapping.cdpi.dev",
  ]
}

variable "max_file_bytes" {
  description = "Largest single attachment accepted, in decoded bytes."
  type        = number
  # Lambda caps a synchronous request at 6 MB. Base64 inflates ~33%, so 3 MiB
  # decoded (~4.2 MB encoded) leaves room for the case JSON alongside it.
  default = 3145728 # 3 MiB
}

variable "max_files_per_submission" {
  description = "Largest number of attachments accepted in one submission. Each export sends one; raising this needs a total-size check to stay under Lambda's 6 MB request cap."
  type        = number
  default     = 1
}

variable "throttle_rate" {
  description = "Steady-state request/second cap on the public submit endpoint."
  type        = number
  default     = 5
}

variable "throttle_burst" {
  description = "Burst request cap on the public submit endpoint."
  type        = number
  default     = 10
}

variable "log_retention_days" {
  description = "CloudWatch log retention for both Lambdas."
  type        = number
  default     = 30
}

variable "noncurrent_version_retention_days" {
  description = "How long superseded object versions are kept before expiry."
  type        = number
  default     = 90
}
