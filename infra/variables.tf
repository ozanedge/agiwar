variable "region" {
  type    = string
  default = "us-west-2"
}

variable "aws_profile" {
  type    = string
  default = "skynetops"
}

variable "cluster_name" {
  type    = string
  default = "agiwar"
}

variable "cluster_version" {
  type    = string
  default = "1.30"
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16" # distinct range from the flight-tracking demo VPC
}
