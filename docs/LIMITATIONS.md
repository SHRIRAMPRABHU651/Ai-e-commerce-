# Honest limitations

Verified in this repo: lint, typecheck, 195 unit/integration/failure/security tests, Playwright E2E (desktop + mobile), production builds. Not verified:

1. **Live provider adapters** (the generic `rest` supplier adapter is tested against fake HTTP suppliers only; real suppliers' payload shapes will need mapping tweaks) (CJ, Stripe, Razorpay, Meta, TikTok, Google Ads, Resend, Twilio, Gemini) have never run against real or sandbox accounts from this repo. Expect to fix field-mapping details during staging verification.
2. **Ads**: Google creates campaign + budget only; TikTok creates campaign + ad group only (no creative upload). Meta creates the full chain paused. Pixel/CAPI/product-feed setup is manual.
3. **Market intelligence**: the crawler/trend engine is tested against a local fake site only; no real public source has been crawled from this repo. Trends reflect the sources you configure. FX is a static table.
4. **Terraform** is unapplied and unvalidated here (no binary; only `npm run terraform:check` static structure checks ran); MongoDB Atlas networking is out of module scope.
5. **Tax & duties** are estimates (regional rate tables, simple duty model). Use a tax service for compliance.
6. **Images**: real product photos come from the live supplier API only (see SUPPLIERS.md); the mock supplier's demo data uses generated SVG art, accepted in development only. The CJ image-field mapping is unverified against a live account. Images are re-hosted into Orvia storage (production never hotlinks); S3Storage has not run against a real bucket, and the CDN is not provisioned by Terraform (`cdn_base_url` is an input).
7. **Search** is in-process (typo tolerance via fuzzy matching over an in-memory index) — fine for thousands of products; move to OpenSearch/Atlas Search at scale.
8. **Email/SMS** templates are functional but plain; deliverability setup is yours.
9. Admin tables are server-paginated but not virtualised; very large catalogs may need tuning.
10. Seed/demo data is development-only; production must start empty.
11. **Ads**: no conversion tracking; AI ad spend is proposal-only; platform status stays UNVERIFIED until a live check passes.
12. **Planned suppliers** (AliExpress, DSers, Spocket, Zendrop, Syncee, DropCommerce, Wholesale2B, Modalyst, Printful, Printify) have no adapter.
13. **Live provider checks** (Stripe/Razorpay/Resend/Twilio/Gemini endpoints used by `verify:staging`) are call shapes written from documentation and unverified against real accounts.
14. **Organic claims**: certificate authenticity is attested by the admin; no certifier registry lookup.
15. **Migration**: on an existing database drop the legacy `orderId_1_lineKey_1` Shipment index before `npm run migrate`.
16. **Legal review** is an operator attestation; Orvia cannot detect it.
