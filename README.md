# Orvia — AI-operated commerce platform

Orvia is a complete storefront **and** an operations console ("commerce OS") for a multi-country dropshipping business (US, Canada, India — extensible). It runs the repeatable work — sourcing, content, pricing, order routing, tracking, support, ad rules, reporting — automatically, and escalates the genuinely ambiguous cases to a human exception queue.

> **Status — read this first.** Everything in this repo builds and passes its automated checks (lint, typecheck, 121 unit/integration/failure/security tests, 42 Playwright desktop+mobile E2E tests). It runs end-to-end **against mock providers** (supplier, payments, ads, notifications) that are refused in production. The live adapters (CJ Dropshipping, Stripe, Razorpay, Meta/TikTok/Google Ads, Resend, Twilio, Gemini) are written against the vendors' public docs but **have not been exercised against live sandbox accounts** from this repo. Treat them as "implemented, needs staging verification" — see [docs/LIMITATIONS.md](docs/LIMITATIONS.md). Do not take real money before completing the [launch checklist](docs/OPERATIONS.md#launch-checklist).

## Quick start (no Docker needed)

```bash
npm ci
npm run dev        # MongoDB (embedded) + seed + API + worker + web
```

| What | Where |
|---|---|
| Storefront | http://localhost:3000 |
| Admin console | http://localhost:3000/admin — `owner@orvia.test` / `Orvia-Demo-2026!` |
| API + OpenAPI docs | http://localhost:4000/docs (dev only) |

Other staff logins (same password): `admin@`, `marketing@`, `ops@`, `support@`, `analyst@orvia.test`. Seed data is **demo data for development only** and is never loaded in production.

Place a test order: add anything to the cart → checkout → "Pay now" (the mock provider delivers a *signed webhook* exactly as a real PSP would). The worker then picks a supplier, places the supplier order, and tracking advances on an accelerated clock (`MOCK_TIME_SCALE`).

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | whole stack with hot reload |
| `npm run build` | production bundles (api, worker, web) |
| `npm test` | 121 unit/integration/failure/security tests (in-memory Mongo) |
| `npm run e2e` | 42 Playwright tests, desktop + mobile: full purchase→delivery journey, responsive/a11y on every key page (builds if needed) |
| `npm run lint` / `typecheck` | eslint (zero warnings) / tsc everywhere |
| `npm run seed` / `migrate` / `worker` | demo data / indexes / worker only |
| `npm run production-check` | release gate: lint, typecheck, tests, build, config guard, secret scans, E2E |
| `make help` | Makefile aliases + Docker targets |

## Repository map

```
apps/api      Fastify API (zod-validated routes, OpenAPI)        apps/worker   queue + scheduler process
apps/web      Next.js storefront + /admin console                packages/ui   design system (tokens, components, charts)
packages/core domain engine: orders, pricing, fraud, agents…     packages/{types,config,database,auth,analytics}
packages/suppliers|payments|ads|ai|notifications|shipping        adapters behind provider interfaces (mock + live)
infra/        Dockerfile, Terraform (AWS)                         tests/        unit, integration, e2e
docs/         architecture, setup, deployment, security, API, …   scripts/      dev, seed, migrate, e2e, production-check
```

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Setup](docs/SETUP.md) · [Environment](docs/ENVIRONMENT.md) · [Deployment](docs/DEPLOYMENT.md) · [Security](docs/SECURITY.md) · [API](docs/API.md) · [Suppliers](docs/SUPPLIERS.md) · [Payments](docs/PAYMENTS.md) · [Ads](docs/ADS.md) · [AI](docs/AI.md) · [Operations](docs/OPERATIONS.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Brand & design](docs/BRAND.md) · [Limitations](docs/LIMITATIONS.md)
