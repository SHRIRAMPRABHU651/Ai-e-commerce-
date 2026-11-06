# Performance

Two separate things live here. Do not mix them up:

1. **Scenario load tests (this build): results PENDING.** `scripts/load-scenarios.mjs` and `scripts/load-jobs.ts` were written and syntax/type-checked in an environment that could not run MongoDB, so **no number from them exists yet**. The targets below are hypotheses *to be validated*, not measurements and not promises. Replace "pending" with real output only after someone runs the commands in "How to run" and commits the resulting `perf-results.json` with the hardware noted.
2. **The older local baseline** (`npm run perf`, section "Earlier local baseline" at the end) is a real measurement from one sandbox on 2026-10-23. It covers three endpoints only and is not a capacity claim.

## Scenario load tests

| Scenario | What it exercises | Requests per iteration | Target p95 (to be validated) | Target error rate | Writes data? | Result |
|---|---|---|---:|---:|---|---|
| `search` | `GET /products?q=` over 10 rotating terms incl. a typo | 1 | 400 ms | 0.5% | no | pending |
| `browse` | `GET /products?page=1..3` + `GET /products/:slug` | 2 | 350 ms | 0.5% | no | pending |
| `find` | `POST /find` (ORVIA Find) over 6 rotating natural-language queries | 1 | 900 ms | 1% | no | pending |
| `cart` | `POST /cart/items`, `GET /cart`, `PATCH` qty 2, `PATCH` qty 0, per guest cart | 4 | 300 ms | 0.5% | guest carts | pending |
| `checkout` | `POST /cart/items` then `POST /checkout` (unique idempotency key, order creation + payment intent) | 2 | 1 200 ms | 1% | **orders** (unpaid, mock payment only) | pending |
| `support` | `POST /support/chat` (grounded assistant, no LLM configured) | 1 | 1 500 ms | 1% | support tickets | pending |
| jobs: order intake | cart, checkout and mock payment through the API handlers | n/a | >= 10 orders/s | n/a | in-process | pending |
| jobs: fulfilment drain | queued jobs that place mock-supplier orders | n/a | >= 10 jobs/s | n/a | in-process | pending |
| jobs: tracking update | `syncTracking` over every active shipment | n/a | >= 25 shipments/s | n/a | in-process | pending |
| jobs: supplier sync | `syncProductOffers` over published products | n/a | >= 5 products/s | n/a | in-process | pending |

Why these targets: they are starting points for a single API replica next to a dedicated MongoDB (storefront reads should feel instant under about 400 ms at the 95th percentile; order creation may be slower because it performs a sequence of writes). Edit them in `TARGETS` at the top of each script once real data says otherwise. The job rates use *mock* suppliers that answer in-process, so they bound ORVIA's own overhead (domain logic + MongoDB) and say **nothing** about real supplier API latency or their rate limits.

What each run prints and records, per scenario: requests/s, **p50 / p95 / p99** (exact percentiles over every response time, not histogram buckets), max, status-code histogram, **error rate** (everything that is not 2xx and not 429, plus network errors and timeouts), the **429 share**, and a verdict against the target (`within target`, `MISSES target`, or `INCONCLUSIVE` when more than 20% of responses were 429). Output goes to `perf-results.json` (ignored by version control): key `load` from the scenario script, key `jobs` from the job script, key `results` from the older `npm run perf`; the new scripts merge into an existing file. A scenario "within target" on one run proves nothing about another host, and the output states which environment produced it.

### Rate limits are a security control and stay on

Search, Find, support and checkout are rate limited per client IP by design (for example checkout 20/min, Find 30/min). The harness gives every simulated shopper its own `X-Forwarded-For`, which only works when the API trusts the proxy header (`TRUST_PROXY=true`, set for the local stack). On a staging deployment behind a load balancer that overwrites `X-Forwarded-For`, either (a) run the load generator from enough distinct source IPs, or (b) raise the limits on that staging environment only. Do not loosen limits in code. A high 429 share makes the run `INCONCLUSIVE` instead of pretending the API was fast.

### How to run

Local (ephemeral MongoDB via `mongodb-memory-server`, seeded, built API on port 4360; needs the MongoDB binary download to be allowed, so it does not work in network-restricted sandboxes):

```bash
npm ci && npm run build -w @orvia/api
npm run load -- --connections 25 --duration 20                    # every scenario
npm run load -- --scenario search,browse,find --connections 50    # read-only subset
MONGODB_URI=mongodb://127.0.0.1:27017/orvia_load npm run load:jobs -- --orders 100 --products 30
```

Against **staging** (never production):

1. Deploy the API to staging with the mock payment provider and mock suppliers (`PAYMENT_MODE=mock`, `SUPPLIER_MODE=mock`) and seed it (`npm run seed` against the staging database). The `checkout` scenario refuses to run unless `GET /api/v1/meta` reports `payment.mode = mock`, so it cannot create orders against a live payment configuration.
2. Read-only scenarios need nothing else:

   ```bash
   node scripts/load-scenarios.mjs --target https://staging-api.example.com --scenario search,browse,find --connections 25 --duration 30
   ```
3. Scenarios that write (`cart`, `checkout`, `support`) need an explicit opt-in:

   ```bash
   node scripts/load-scenarios.mjs --target https://staging-api.example.com --allow-writes --scenario cart,checkout,support --connections 10 --duration 30
   ```
4. Or start the **Load test (manual)** GitHub Actions workflow (`.github/workflows/load.yml`, `workflow_dispatch` only) and download the `perf-results` artifact. The runner is a shared machine, so treat its numbers as relative, not absolute.
5. Job throughput needs direct database access to a **throwaway** database whose name ends in `_load` or `_perf` (the script drops it and refuses anything else): `MONGODB_URI=mongodb://<host>/orvia_load npm run load:jobs`.
6. Ramp gradually (10, 25, 50 connections), keep the generator off the API host when possible, watch API and MongoDB CPU/memory and the `/metrics` endpoint during the run, and record the instance sizes next to the results.
7. Add `--strict` to make the process exit 1 when any scenario misses its target (only sensible on a dedicated, quiet performance environment).

### Status

| Item | Status |
|---|---|
| Scenario scripts written; syntax and plumbing checked against a local HTTP stub (request methods, paths, cookies, summary maths) | done; the stub numbers were discarded and mean nothing |
| Scenario scripts executed against the real API + MongoDB | **not executed (no MongoDB binary in the authoring sandbox)** |
| `load-jobs.ts` executed | **not executed** (needs MongoDB); only its safety guard (refuses a database not named `_load`/`_perf`) was exercised |
| Any measured p50/p95/p99, RPS, error rate or job throughput for these scenarios | **pending until run** |
| Targets met | **unknown** |

---

## Earlier local baseline (`npm run perf`)

Reproduce: `npm run build && npm run perf -- --connections 50 --duration 15` (writes `perf-results.json`; the committed run is `docs/evidence/perf-2026-10-23.json`).

**Read these as a floor-of-honesty, not a capacity claim.** The API, MongoDB (an in-process `mongodb-memory-server`), the seed data (≈35 products) and the load generator all shared one 4-vCPU / 17 GB Xeon sandbox (Node 22), so the load generator competes with the system under test. A dedicated MongoDB and separate load host will be faster; real network latency and a real payment/supplier round-trip are not included. Latency is client-measured, per request, exact percentiles (not histogram buckets).

## Result — 50 concurrent connections, 15 s per scenario, 2026-10-23

| Scenario | req/s | p50 | **p95** | p99 | errors / non-2xx |
|---|---:|---:|---:|---:|---|
| `GET /api/v1/products?pageSize=24&country=US` | 197 | 243 ms | **323 ms** | 773 ms | 0 / 0 (2 949 × 200) |
| `GET /api/v1/products/:slug?country=US` | 128 | 374 ms | **478 ms** | 927 ms | 0 / 0 (1 926 × 200) |
| Journey: `POST /cart/items` → `POST /checkout` (mock payment) | 85 | 630 ms | **876 ms** | 1 190 ms | 0 / 0 (649 × 200, 620 × 201) |

Notes
- Checkout is rate-limited to 20/min **per client IP** by design (`429` otherwise — the first run saw 1 900 of them). The harness therefore gives each simulated shopper its own `X-Forwarded-For` (`TRUST_PROXY=true`), as real shoppers on distinct IPs would. Nothing in the rate limiter was loosened in the product.
- `max` latencies (1.4–3.1 s) are first-hit / GC outliers inside a shared-CPU sandbox, kept in the JSON.
- No target SLO is asserted. `GET /products` serving 24 items in 323 ms p95 under 50 concurrent users on shared hardware is a **baseline to regress against**, not a pass mark. In-process search (LIMITATIONS #7) and the lack of a response cache are the obvious first suspects if it needs to improve.
