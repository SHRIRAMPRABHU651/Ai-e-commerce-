# Honest limitations

Verified in this repo: lint, typecheck, 112 unit/integration/failure/security tests, Playwright E2E (desktop + mobile), production builds. Not verified:

1. **Live provider adapters** (CJ, Stripe, Razorpay, Meta, TikTok, Google Ads, Resend, Twilio, Gemini) have never run against real or sandbox accounts from this repo. Expect to fix field-mapping details during staging verification.
2. **Ads**: Google creates campaign + budget only; TikTok creates campaign + ad group only (no creative upload). Meta creates the full chain paused. Pixel/CAPI/product-feed setup is manual.
3. **Market intelligence**: no real competitor-price/trend provider; discovery and competitor-based pricing use mock signals in dev and need a provider integration for real decisions.
4. **Terraform** is unapplied and unvalidated here (no binary); MongoDB Atlas networking is out of module scope.
5. **Tax & duties** are estimates (regional rate tables, simple duty model). Use a tax service for compliance.
6. **Images**: real product photos come from the live supplier API only (see SUPPLIERS.md); the mock supplier's demo data uses generated SVG art, accepted in development only. The CJ image-field mapping is unverified against a live account. Supplier image URLs are hotlinked (no re-hosting/CDN copy yet), and there's no admin upload UI.
7. **Search** is in-process (typo tolerance via fuzzy matching over an in-memory index) — fine for thousands of products; move to OpenSearch/Atlas Search at scale.
8. **Email/SMS** templates are functional but plain; deliverability setup is yours.
9. Admin tables are server-paginated but not virtualised; very large catalogs may need tuning.
10. Seed/demo data is development-only; production must start empty.
