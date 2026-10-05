# Setup

## Requirements
Node ≥ 20.11 (22 recommended), npm 10. No Docker or external services needed for development — MongoDB runs embedded.

## Local (recommended)
```bash
npm ci
cp .env.example .env     # optional; sensible dev defaults exist
npm run dev
```
`scripts/dev.mjs` starts an embedded persistent MongoDB (data in `.mongo-data/`), seeds demo data on first run, then API (:4000), worker (:4100 health), and the web app (:3000).

Reset data: stop the stack, `rm -rf .mongo-data`, start again.

## Docker
```bash
docker compose up --build -d
docker compose --profile seed run --rm seed     # demo data (dev only)
```
Web :3000, API :4000, Mongo :27017, Redis :6379.

## Optional integrations in development
- **Gemini** – set `GEMINI_API_KEY`; otherwise a deterministic template provider is used and outputs are labelled `source: template`.
- **Live suppliers/payments/ads** – set the relevant keys and `*_MODE=live` (use sandbox/test credentials). See SUPPLIERS/PAYMENTS/ADS.

## Verify your checkout
```bash
npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```
Playwright uses `/opt/pw-browsers/chromium` when present; otherwise run `npx playwright install chromium` or set `PLAYWRIGHT_CHROMIUM=/path/to/chromium`.
