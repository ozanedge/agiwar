# Deploying the realtime server

```bash
# 1. build + push image to ECR (create the repo once)
aws ecr create-repository --repository-name agiwar-server --region us-west-2 --profile skynetops
docker build -f deploy/Dockerfile -t agiwar-server .
# tag + push to <AWS_ACCOUNT_ID>.dkr.ecr.us-west-2.amazonaws.com/agiwar-server:latest
# then set that image in deployment.yaml

# 2. deploy
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/service.yaml

# 3. get the NLB hostname and point DNS at it
kubectl get svc agiwar-server -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
# create rt.agiwar.skynetops.ai -> that hostname (CNAME), terminate TLS for wss://
```

Prereq for `type: LoadBalancer` NLB provisioning: the **AWS Load Balancer Controller** installed
in the cluster (Helm). Add it after `terraform apply`.

The client connects via `VITE_WS_URL=wss://rt.agiwar.skynetops.ai` (set at web build time).
