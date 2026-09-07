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
  default = [
    "https://centre-for-dpi.github.io",
  ]
}

variable "max_file_bytes" {
  description = "Largest single attachment accepted, in decoded bytes."
  type        = number
  default     = 4194304 # 4 MiB
}

variable "max_files_per_submission" {
  description = "Largest number of attachments accepted in one submission."
  type        = number
  default     = 5
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
