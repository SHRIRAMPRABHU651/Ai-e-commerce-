# Supplier onboarding

1. **Add** the supplier (Admin → Suppliers): code, provider (`cj`, `rest`, `manual`), `servesCountries`, `priority`. Credentials are encrypted at rest (`ENCRYPTION_KEY`) and never returned by the API.
2. **REST suppliers**: supply the endpoint/field mapping (dot-paths). Path placeholders are URL-encoded.
3. **Validate**: run the validation suite (connection, catalog, product, inventory, price, shipping, order, tracking). The order test requires typing `PLACE TEST ORDER` and a sandbox, or an explicit live acknowledgement.
4. **Mode**: leave `MANUAL`/`ASSISTED` until validation passes; `AUTOMATED` is refused otherwise.
5. **Manual suppliers**: operators enter offers (they expire) and record fulfillment by hand.
6. **Monitor**: health checks run on a schedule; FAILING suppliers are skipped and orders fail over without duplicate fulfillment. Daily reconciliation raises `RECONCILIATION` exceptions.
7. **Selection**: offers are ranked on landed cost plus delivery, reliability, stock confidence, tracking, returns, destination fit and risk (weights in Settings → sourcing).

Planned providers with **no adapter yet**: AliExpress, DSers, Spocket, Zendrop, Syncee, DropCommerce, Wholesale2B, Modalyst, Printful, Printify — use the `rest` adapter or `manual` until one is built.
