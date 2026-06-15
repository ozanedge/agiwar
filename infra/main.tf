# agiwar infrastructure — a BRAND-NEW EKS cluster in its OWN VPC (max isolation),
# in the shared skynetops AWS account. Independent Terraform state from skynetops-ops.
#
# NOTE: `terraform apply` provisions a paid EKS control plane (~$70+/mo) + NAT + nodes.
# Do not apply without explicit sign-off. `terraform plan` is free to run.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
  # Recommend a remote backend (separate from skynetops-ops state). Fill in and uncomment:
  # backend "s3" {
  #   bucket  = "skynetops-tfstate"
  #   key     = "agiwar/terraform.tfstate"
  #   region  = "us-west-2"
  #   profile = "skynetops"
  # }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile
  default_tags {
    tags = {
      Project = "agiwar"
      Owner   = "owner@example.com"
      Managed = "terraform"
    }
  }
}

data "aws_availability_zones" "available" {}
data "aws_caller_identity" "current" {}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}
