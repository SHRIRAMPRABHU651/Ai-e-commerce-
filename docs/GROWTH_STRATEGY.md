# Growth strategy: more customers, more sources, a loop worth sharing

Applies the 24-principle customer-value framework to Orvia (US / Canada / India dropshipping storefront: pet, kids, fashion, gadgets).

**Reading rules.** *Verified* = true in this repo today. *Assumption* = a hypothesis to test. *Estimate* = my reasoning, not data. There are **no market statistics, competitor facts or demand figures in this document**: none were provided and none were researched, so none are invented. The 24 principles are hypotheses about motivation, not facts about Orvia's customers.

## 1. Where Orvia stands (verified)

| Area | State |
|---|---|
| Multi-supplier engine | Verified in tests with two fake supplier APIs: per-country supplier coverage, live offer ranking by expected profit + customer-experience, per-supplier keys/photos/order routing (`docs/SUPPLIERS.md`) |
| Supplier adapters | Mock, generic `rest` adapter, `cj`. **Live adapters have never run against a real account.** AliExpress, DSers, Spocket, Zendrop, Syncee, DropCommerce, Wholesale2B, Modalyst, Printful, Printify have **no adapter** (`docs/LIMITATIONS.md` #12) |
| Discovery | Browse by 4 categories, search, trending, recommendations, wishlist |
| Acquisition | Ads adapters exist but have never run; no measured CPA, so products cannot auto-publish (`LIMITATIONS.md` #17) |
| Sharing / referral | None before this change |

**The honest bottleneck is not features. It is that nothing has touched a real supplier, a real payment or a real shopper yet.** Section 6 puts that first.

## 2. Added in this change

1. **Shop by need** (`/needs`, `GET /api/v1/needs`): nine outcome-led collections (screen-free play, learn & grow, time-savers, travel-ready, happy pets, thoughtful gifts, stand out, work smarter, rest & comfort) generated from catalogue rules. A need with no sellable stock in the shopper's country is hidden, never shown empty. Each need records which framework principles it tests (`packages/types/src/needs.ts`).
2. **Referral loop** (`/account/referrals`, share button on product pages, `?ref=` landing): invited friend gets 10% off a first order; the referrer gets a one-time 10% code **only after the friend's order is delivered, held 14 days in production, and not refunded**. Built on the existing promotion engine, so margin clamping, first-order-only and one-use-per-email apply unchanged. Self-referral and high-fraud orders are rejected and audited. Terms live in `REFERRAL_TERMS`.

Both are intentionally modest. They are the cheapest experiments that test whether customers *want to share* and *shop by outcome*. Neither is proof of virality.

## 3. Segment ranking (assumptions, to be re-ranked by data)

Scored on demand evidence (none yet), feasibility, margin, scalability and defensibility. The ordering is my judgement; change it when click-through and conversion data exist.

| Rank | Segment | Principles | Why this rank |
|---|---|---|---|
| 1 | Parents of young children | 2, 4 (peace of mind), 1, 3, 16 (children's future) | Catalogue already carries safety/age info; repeat purchases likely; but highest compliance duty (age ratings, small parts) |
| 2 | Pet owners | 2, 4 (peace of mind), 13 (simplicity) | Emotional, repeat consumables possible; needs vet-advice disclaimer, no health claims |
| 3 | Gift buyers | 6 (connection), 21 (exclusivity) | Personalised items raise price tolerance; longer fulfilment risk for made-to-order |
| 4 | Busy people / desk workers | 13, 14 (simplicity, time), 10, 18 | Easy to message, crowded and price-driven market |
| 5 | Style seekers | 9, 21, 22 (status, exclusivity, rarity) | Highest returns/sizing risk; claims of rarity only if genuinely true |

**Principles deliberately not targeted now:** investors (11), athletes (23), older adults (12), financially constrained "hope" (8), anxious/lonely segments (5, 6 as an *audience*). The catalogue does not serve them credibly, and several (8, 11) carry exploitation risk. Do not market to those segments without a purpose-built offer.

## 4. Per-segment plan (required output format)

### A. Parents of young children (priority)
- **Target customer:** parents/carers buying for ages ~2-10, plus grandparents as gift buyers. *Assumption.*
- **Core problem:** want activities that are safe, engaging and not another screen; worry about quality and safety of low-cost imports.
- **Customer motivation:** 2 and 4 (peace of mind, security), 3 and 16 (children's future), 1 (dreams).
- **Desired outcome:** practical: a toy that is age-appropriate, arrives when promised, and can be returned. Emotional: confidence they chose well.
- **Proposed solution:** the "Screen-free play" and "Learn & grow" needs, each product showing age range and listed safety standards (already stored in `compliance.safetyInfo`), tracked delivery, local return window.
- **Unique value proposition:** *Kids' play from suppliers we've vetted for safety information, with tracked delivery and easy returns in your country.* Only claim "safety tested" where evidence exists in the product record. The compliance gate already blocks products without it; the claim must never outrun that.
- **Features & benefits:** *Essential:* age range + standards on product page, honest delivery estimate, returns. *Later:* age/gift-finder quiz, bundles by age, reviews with photos.
- **Pricing & revenue:** product margin via the economics engine (CPA is assumed until measured). Bundles to raise basket size. No subscription until repeat behaviour is observed.
- **Marketing strategy:** message = clarity and reassurance, not fear. Headlines: "Play that keeps little hands busy", "Age range and safety info on every toy". Channels: search, parent communities (earned, not astroturfed), email to opted-in customers, referral.
- **Customer acquisition:** *First 10:* personal network and a small paid test to the screen-free page; read every order. *First 100:* one channel only (e.g. one social platform + search), because measured CPA is single-channel by design (`LIMITATIONS.md` #17). *First 1,000:* only if measured CPA, refund rate and repeat rate support it; referral then compounds.
- **Validation plan (cheap):** smoke test, put the need page live with a small paid audience and measure click-through to product, add-to-cart, and checkout start *before buying inventory*. Dropshipping means little stock risk, so the real test is conversion + refund rate. Ask 5-10 parents what would stop them buying.
- **Risks & limitations:** safety/compliance liability; long import delivery times; trust deficit versus known retailers; parents may prefer established brands. Assumption that parents value "screen-free" may be wrong.
- **Execution roadmap:** *First:* verify one real supplier + payment in staging. *Next:* seed 20-30 products with complete safety data; run the smoke test. *Later:* gift finder, bundles.
- **Success metrics:** need-page → product click rate, add-to-cart rate, conversion, refund + complaint rate, delivery-on-time rate, review average, repeat purchase within 90 days.

### B. Pet owners
- **Target / problem / motivation:** pet parents wanting enrichment and easier care. Principles 2, 4, 13.
- **Outcome:** practical, less mess and a more occupied pet. Emotional, feeling like a good owner.
- **Solution & UVP:** "Happy, healthy pets" and "Time-savers" needs. *Everyday pet gear picked for usefulness, with delivery you can track.* Never imply veterinary or health outcomes.
- **Features:** essential: clear size/material info, returns. Later: pet-profile-based recommendations, replenishment reminders for consumables.
- **Pricing:** margin; consumables could justify a subscription, only after repeat purchase is observed.
- **Marketing:** "Keep them busy while you're out", "Cleaner home, less effort". Channels: short video (real supplier media only, per image policy), pet communities, referral.
- **Acquisition / validation:** same staged approach as A. Validate with enrichment-toy click-through and repeat rate.
- **Risks:** crowded, price-led market; product-safety complaints (chewing hazards); shipping time for bulky items.
- **Roadmap & metrics:** as A; plus repeat rate on consumables.

### C. Gift buyers
- **Principles:** 6 (connection), 21 (exclusivity). **Problem:** wants a gift that feels considered, not generic. **Solution:** "Thoughtful gifts" (personalised items). **UVP:** *Gifts made personal*, with honest lead times shown before checkout. **Risks:** made-to-order lead time and returns; personalisation errors. **Validation:** measure conversion on personalised items versus equivalent non-personalised items. **Metrics:** gift-need conversion, delivery-date accuracy, refund rate.

### D. Busy people / desk workers and E. Style seekers
Lower priority until A-C produce data. D tests principles 13/14 through "Time-savers" and "Work smarter". E tests 9/21/22 through "Stand out"; use "rare" or "limited" **only when a supplier genuinely limits supply**: never manufactured scarcity.

## 5. More sources, not one: the plan

The platform already supports many suppliers (verified). What is missing is real, working connections. Order of work:

1. **Make one connection real.** Stage a live CJ account (or whichever supplier you can open first), place a test order, verify field mapping. Until this happens every other source is theory.
2. **Cover each market with its own source.** Coverage cards in *Admin → Suppliers* already warn when a country has none. A product that is only sold where a supplier serves it is better than one that cannot be delivered.
3. **Add sources through the generic REST adapter first** (config only, no code) for any supplier with a JSON API. Suppliers that use signed requests, OAuth, SOAP or CSV feeds need a dedicated adapter: send the API docs.
4. **Cross-source the best sellers.** Source the same product from two suppliers; routing already picks by expected profit and experience and falls back if one fails. That protects margin and availability, which is the reliability customers feel.
5. **Source selection criteria (do not skip):** ships to the target country with tracking, real supplier photos, safety/compliance data for kids and pet items, order API with idempotency, measurable on-time rate. The platform tracks reliability per supplier from real orders.
6. **Do not scrape marketplaces** to populate the catalogue. Use supplier APIs, official feeds, or manual supplier entry (`manualSupplier`), and respect each supplier's terms. A "list from every site in the world" crawler would breach terms and produce unusable data (no tracking, no stock truth).

Which specific suppliers to add is a business decision that needs their current terms and shipping lanes, which I have not verified. The ten planned names in `LIMITATIONS.md` #12 are candidates, not endorsements.

## 6. Roadmap

| Step | What | Gate to continue |
|---|---|---|
| **First (weeks 1-2)** | Run `verify:staging` with real supplier + payment sandbox; one real test order end to end | Order placed, tracked, delivered/refunded without manual fixes |
| **Next (weeks 3-6)** | Seed 20-30 products for ranks 1-2 with full safety and photo data; smoke-test the need pages with a small budget; record measured CPA (single channel) | Click-through → cart → checkout rates exist; refund rate measured |
| **Later** | Second source per country, referral tuning, gift finder, replenishment reminders | Repeat rate and referral rate justify it |

## 7. Virality: what is realistic

Virality is **earned by a product people choose to recommend; it cannot be switched on.** What can be built is a low-friction loop and the measurement to know if it works.

Loop: customer receives a good product → shares link (product page or invite) → friend gets a first-order discount → friend's delivered order rewards the customer.

Track the **referral coefficient** `k = invites per customer × friend conversion rate`. Roughly, `k < 1` means referrals *reduce* paid acquisition cost but do not grow by themselves; only `k > 1` is self-sustaining, and that is rare. Treat "referrals lower our blended CPA" as the realistic goal and measure it. No target number is promised here.

Guardrails already in code: reward after delivery and hold period; one reward per invited email; self-referral rejected; margin clamp; fraud-level check; audit log.

## 8. Risks and reasons customers may not buy

- Unknown brand, long delivery, fear of poor quality: the most likely refusal reasons. Answer with honest delivery windows, tracking, returns, real photos and verified reviews (never fake ones).
- Referral abuse (alias emails, friends-and-family rings): partially mitigated; not eliminated (`LIMITATIONS.md` #19).
- Compliance exposure for kids' and pet products; tax/duty estimates only; export-attestation gate for India.
- Margin: CPA is assumed until measured; discounts for both referral sides reduce margin per first order.
- Messaging risk: scarcity, fear and "guaranteed outcome" language are excluded by design and covered by a test on need copy.

## 9. Questions only you can answer

1. Which country first (US, CA, IN)? It decides the first real supplier and the legal gate.
2. Which segment will you personally validate first (I recommend parents of young children)?
3. Which supplier accounts do you already hold or can open this week?

## 10. Metrics to watch

Acquisition: visitors → need/category click → product → cart → checkout → paid; measured CPA (single channel). Quality: on-time delivery, refund rate, support tickets per 100 orders, review average. Growth: invites sent per customer, invite → first-order conversion, rewarded referrals, `k`, referral-sourced share of orders. Retention: repeat purchase within 90 days.
