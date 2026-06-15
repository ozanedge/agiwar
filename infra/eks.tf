# Brand-new EKS cluster for agiwar's realtime game server.
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.20"

  cluster_name    = var.cluster_name
  cluster_version = var.cluster_version

  cluster_endpoint_public_access = true # kubectl access; tighten with CIDRs later

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  enable_cluster_creator_admin_permissions = true

  eks_managed_node_groups = {
    game = {
      # realtime sim is CPU/latency-sensitive, low memory; small on-demand pool to start
      instance_types = ["t3.medium"]
      min_size       = 1
      max_size       = 3
      desired_size   = 2
      capacity_type  = "ON_DEMAND"
    }
  }
}

# The realtime server calls Bedrock from inside the cluster — grant the node role access.
# (For least privilege, move this to an IRSA role bound to the server's ServiceAccount.)
resource "aws_iam_role_policy" "bedrock_invoke" {
  name = "agiwar-bedrock-invoke"
  role = module.eks.eks_managed_node_groups["game"].iam_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["bedrock:InvokeModel"]
      # Cross-region inference profile + the underlying foundation models it routes to.
      Resource = [
        "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/us.anthropic.claude-sonnet-4-6",
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*"
      ]
    }]
  })
}
