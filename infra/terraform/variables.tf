variable "region" {
  type    = string
  default = "us-east-1"
}
variable "environment" {
  type        = string
  description = "staging or production"
  default     = "staging"
}
variable "domain_name" {
  type        = string
  description = "Public storefront domain, e.g. shop.example.com (must have a Route53 hosted zone)"
}
variable "hosted_zone_id" { type = string }
variable "api_image" { type = string }
variable "worker_image" { type = string }
variable "web_image" { type = string }
variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}
variable "api_cpu" {
  type    = number
  default = 512
}
variable "api_memory" {
  type    = number
  default = 1024
}
variable "desired_count" {
  type    = number
  default = 2
}
variable "mongodb_uri_secret_arn" {
  type        = string
  description = "Secrets Manager ARN holding the MongoDB Atlas connection string (Atlas is provisioned/peered outside this module)"
}
variable "secret_arns" {
  type        = map(string)
  description = "Env var name => Secrets Manager ARN (JWT_SECRET, STRIPE_SECRET_KEY, GEMINI_API_KEY, ...). Values never live in Terraform state."
  default     = {}
}
variable "alarm_email" {
  type    = string
  default = ""
}

variable "cdn_base_url" {
  type        = string
  description = "Public https base URL of a CDN (e.g. CloudFront distribution) that serves the media bucket. Not provisioned by this module; the API refuses to start in production without it."
  validation {
    condition     = can(regex("^https://", var.cdn_base_url))
    error_message = "cdn_base_url must start with https://"
  }
}
