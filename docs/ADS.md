# Advertising

`AdProvider` abstraction with adapters for Meta, TikTok and Google Ads plus a mock. **Nothing is ever launched unless the platform API accepted it** — a failed or partial creation is recorded as `FAILED`/`PARTIAL` and surfaced as an exception; the UI never shows a fake "live" campaign.

| Adapter | What it does today |
|---|---|
| Meta | campaign → ad set → creative → ad (paused-first), metrics pull. Unverified against a live account |
| TikTok | campaign + ad group only (ad creative upload not implemented); metrics pull. Unverified |
| Google | campaign + budget only (assets/ads not implemented); metrics pull. Unverified |
| Mock | full simulated lifecycle with fault injection for tests |

## Safe mode & rules (`packages/ads/src/rules.ts`)
- New product ad tests start with a small daily budget; **hard caps** per campaign/day/total are enforced before any create/budget change (`enforceSpendCaps`).
- `evaluateCampaign`: pause when spend ≥ N× target CPA with no purchases, or ROAS below floor after enough spend; propose scale-up only above target ROAS with sufficient conversions; never raise budget past caps.
- `evaluateTest` / `rankCreatives`: compare creatives on CTR/CPA/ROAS with minimum-sample requirements before declaring a winner.
- `ad_optimization` defaults to **ASSISTED**: the optimizer writes proposals; approving one applies it on the platform (and audits it). In AUTOMATIC it applies inside the same caps.
- Copy comes from the grounded AI service and passes the compliance filter (no unsupported claims).

Credentials: `META_*`, `TIKTOK_*`, `GOOGLE_ADS_*`. Platform policies (ad account approval, pixel/CAPI, product feeds) are operator tasks.

## Capability honesty
See [PROVIDER_CAPABILITIES.md](PROVIDER_CAPABILITIES.md): platforms are NOT_CONFIGURED / UNVERIFIED / VERIFIED / ERROR; no conversion tracking exists, so AI ad spend is proposal-only.
