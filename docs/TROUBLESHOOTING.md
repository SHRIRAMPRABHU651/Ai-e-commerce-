# Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| API exits: `Unsafe production configuration: …` | You're in `APP_ENV=production` with a mock mode, short/dev `JWT_SECRET`, insecure cookies or `SEED_ON_START`. Fix the variables named in the message. |
| Web shows empty pages / 500 on server components | API unreachable. Check `API_URL`, `curl $API_URL/ready`, CORS/WEB_URL values. |
| `/ready` returns 503 | MongoDB unreachable. Redis being down only reports `degraded` (rate limits fall back to memory). |
| Order stays `PAID`, no supplier order | `order_fulfillment` is ASSISTED/OFF (production default) → approve in *Automation → Approvals*; or an exception exists (fraud/negative margin/supplier failure) → *Exceptions*. |
| No tracking number | Supplier hasn't issued one yet (we never invent it). Use *Shipping → Sync tracking now*. In dev tracking advances with `MOCK_TIME_SCALE`. |
| Paid but order not marked paid | Webhook not delivered/verified. Check provider dashboard, `STRIPE_WEBHOOK_SECRET`, and that the endpoint is reachable; `payment_verification` job reconciles within ~5 min. |
| `403 CSRF` on API calls from scripts | Send `x-requested-with: orvia` and a same-site `Origin` for cookie-authenticated mutations (or use a Bearer token). |
| `429 RATE_LIMITED` | Per-IP limit. Behind a proxy set `TRUST_PROXY=true` so client IPs are real. |
| Seed fails with Mongo pool timeouts in a script | Don't run the embedded MongoDB while the parent process is blocked (`spawnSync`); use async spawn (see `scripts/e2e.mjs`). |
| Playwright can't launch browser | `npx playwright install chromium` or `PLAYWRIGHT_CHROMIUM=/path/to/chromium`. |
| Dev: port in use | `API_PORT`, `WORKER_PORT`, and `next dev -p` are configurable; stop stale `tsx`/`next` processes. |
| Gemini outputs look generic | No `GEMINI_API_KEY` → template provider (`source: template`). |
