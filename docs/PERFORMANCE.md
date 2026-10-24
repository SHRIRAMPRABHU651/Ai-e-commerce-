# Performance baseline

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
