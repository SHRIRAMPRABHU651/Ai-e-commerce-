terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
  # Configure a remote backend per environment, e.g.:
  # backend "s3" { bucket = "orvia-tfstate", key = "prod/terraform.tfstate", region = "us-east-1", dynamodb_table = "orvia-tflock" }
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "orvia", Environment = var.environment, ManagedBy = "terraform" } }
}
