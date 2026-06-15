# agiwar infrastructure

Brand-new EKS cluster in its **own VPC** (`10.42.0.0/16`), in the shared skynetops AWS account
(`<AWS_ACCOUNT_ID>`, us-west-2). Fully isolated from the flight-tracking demo.

## Prereqs
- Terraform >= 1.6, AWS profile `skynetops`
- The `terraform-aws-modules` VPC + EKS modules (fetched on `terraform init`)

## Usage
```bash
cd infra
terraform init
terraform plan        # free — review before spending
# terraform apply     # provisions a paid control plane (~$70+/mo) + NAT + nodes — needs sign-off
```

After apply:
```bash
$(terraform output -raw configure_kubectl)        # point kubectl at the cluster
kubectl apply -f ../deploy/k8s/                    # deploy the realtime server
```

## Before apply — confirm
- Account SCP blocks public **Lambda Function URLs**. We use a load balancer (Service type
  LoadBalancer / Ingress), not a Function URL — confirm public LB ingress is permitted.
- DNS: create `rt.agiwar.skynetops.ai` pointing at the load balancer the cluster provisions.
- Consider an S3 remote backend (separate key from skynetops-ops) — see `main.tf`.
