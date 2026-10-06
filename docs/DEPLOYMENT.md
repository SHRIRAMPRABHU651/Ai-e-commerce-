# Deployment

Three stateless containers (`api`, `worker`, `web`) from `infra/docker/Dockerfile` (`--target api|worker|web`), plus MongoDB (Atlas recommended) and optional Redis.

> Terraform in `infra/terraform` was **written but not applied or `terraform validate`d in this repo's build environment** (no Terraform binary available). CI runs `terraform validate` + `fmt -check`; run `terraform plan` in a scratch account first.

## AWS reference architecture (`infra/terraform`)
VPC (2 AZ, public/private subnets, NAT) → ALB (TLS via ACM, HTTP→HTTPS) → ECS Fargate services:
- `web` (3000) — default ALB target; proxies `/api/v1/*` to the API over Cloud Map DNS (`api.orvia-<env>.local`).
- `api` (4000) — ALB rule for `/api/v1/webhooks/*` goes straight to the API; autoscaling on CPU (2→10).
- `worker` (4100) — queue + scheduler; locks are lease-based so running >1 is safe.
ElastiCache Redis (encrypted), S3 media bucket (private, SSE), Secrets Manager → ECS secrets (values never in Terraform state), CloudWatch logs (30d), SNS alarms (ALB 5xx, worker not running), Route53 + ACM. MongoDB Atlas is provisioned outside the module (VPC peering/PrivateLink) — pass its connection-string secret ARN.

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in
terraform init && terraform plan && terraform apply
```

## Release procedure
1. CI green on `main` (lint, typecheck, tests, build, E2E, docker build, terraform validate).
2. **Deploy** workflow (manual, environment-gated, OIDC to AWS): builds & pushes images tagged with the commit SHA, then force-redeploys the ECS services and waits for stability (deployment circuit breaker auto-rolls back).
3. Run `npm run migrate` once (one-off ECS task with the api image) before/after a release that adds indexes. Migrations never drop indexes.
4. Smoke test: `/ready`, place a test order with Stripe test keys in **staging**, verify webhook + supplier sandbox + tracking.
5. Roll back = redeploy the previous image tag.

## Staging vs production
`APP_ENV=staging` keeps live-provider requirements off the *guard* but still hides dev routes. Use sandbox keys in staging. `APP_ENV=production` refuses mock providers.

## Backups & DR
Atlas continuous backup/PITR; S3 versioning optional; the queue is in Mongo, so restoring Mongo restores pending work (idempotent keys prevent duplicate supplier orders on replay).

## Docker Compose (single host)
`docker-compose.prod.yml` runs the three images against external Mongo/Redis with `.env.production`. Put a TLS-terminating proxy (Caddy/nginx/ALB) in front.

## Launch gate additions
Production needs `OBJECT_STORAGE_PROVIDER=s3`, a bucket, and an https `CDN_BASE_URL` (Terraform takes `cdn_base_url`; you provision the CDN). Before an existing database is migrated, drop the legacy `orderId_1_lineKey_1` Shipment index. After deploying to staging run `npm run verify:staging`, then see [PRODUCTION_CERTIFICATION.md](PRODUCTION_CERTIFICATION.md). Terraform: `terraform init && terraform validate && terraform plan` (not run in this repo; `npm run terraform:check` is a static check only).
