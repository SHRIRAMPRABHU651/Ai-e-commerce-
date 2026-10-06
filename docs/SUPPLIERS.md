# Suppliers

## Interface (`packages/suppliers/src/types.ts`)
`SupplierProvider`: `searchProducts`, `getProduct`, `getOffer` (price, stock, shipping options per destination country, handling/delivery estimates), `createOrder` (idempotent), `getOrder`/`getTracking`, `cancelOrder`. Errors are `ProviderError` with `retryable` set — transient (timeout, 5xx, 429) retry with backoff; permanent (invalid SKU, out of stock) do not.

## Adapters
| Adapter | Mode | Status |
|---|---|---|
| `MockSupplierProvider` | `SUPPLIER_MODE=mock` (dev/test only) | 43 demo products (3 deliberately non-compliant to prove filtering), deterministic stock/price/tracking, fault + override injection routes under `/dev/*` |
| `CjDropshippingProvider` | `SUPPLIER_MODE=live` + `CJ_API_KEY` | Written against CJ's public API docs. **Not verified against a live CJ account** — run it in staging with a real key and a test order before trusting it |

Add a supplier: implement the interface, register it in `SupplierRegistry`, add an `Supplier` document (country coverage, reliability seed). Nothing else in the engine is supplier-specific.

## Product images — always the supplier's own
Photos are taken from the supplier API response (CJ: `productImageSet`, `productImage`, `bigImage`, per-variant `variantImage`), stored as absolute https URLs on the supplier CDN, and rendered as-is (`referrerPolicy=no-referrer`). Nothing is stock-photo'd or AI-generated.
- **Gate:** a product with no usable supplier image cannot be published (`canPublish`), listed in search/home/recommendations, or added to a cart.
- **Home page:** hero collage, category tiles and the spotlight banner are built from the live catalogue's supplier photos (top product per category).
- **Demo data:** the mock supplier has no real photographs, so in development it uses procedural illustrations at `/art/:id`, accepted *only* when `SUPPLIER_MODE=mock` outside production. To see real product photos: set `SUPPLIER_MODE=live` + `CJ_API_KEY`, open *Admin → Suppliers → Add supplier* (provider `cj`), then *Products → Import* — the import dialog shows each supplier photo before you import.

## Selection (not "cheapest")
`selectSupplierLive` fetches live offers from every eligible supplier, discards ones that can't ship to the destination or lack stock, and ranks them by **expected profit** (sell price − landed cost − shipping − duty − payment fee − refund-rate allowance − ad allowance) blended with a **customer-experience** score (delivery days, supplier reliability, stock confidence). The chosen supplier is pinned on a pending shipment row before the order call, so retries never re-pick or double-order. If every supplier errors transiently the order stays queued and retries; if the best option would lose money, the order goes to the exception queue (`NEGATIVE_MARGIN`) instead of auto-fulfilling.

## Inventory & price sync
Scheduled rotating sync updates stock/price; products with no available supplier are paused (`OUT_OF_STOCK`/`SUPPLIER_UNAVAILABLE`) and restored automatically. Supplier price spikes above the configured % raise a `PRICE_CHANGE` exception and feed dynamic-pricing proposals.

## Tracking
Tracking numbers/carriers/events are stored **only** if the supplier returned them. Until then customers see "Preparing" — never an invented number.
