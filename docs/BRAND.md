# Brand & design

## Name
Twenty candidate names were weighed for a general-merchandise, multi-country store (pronounceable in en-US/en-CA/en-IN, short, no negative meaning, not category-locked). **Orvia** was chosen: two syllables, easy to say and spell, evokes *orbit/oro/via* (a route to your door), and carries no category lock-in. *This is a working name. No trademark or domain search was performed — do that before launch.*

## Design language
Warm paper (`#faf7f2`) and ink with a deep **pine** primary, **saffron** accent and **coral** for alerts — deliberately away from the default blue/purple SaaS look. **Fraunces** (display serif) for editorial headings, **Manrope** for UI. Generous radius, soft layered shadows, 44px minimum touch targets. All colour comes from CSS variables (`packages/ui/src/theme.css`) with light and dark sets.

## Patterns borrowed from best-in-class marketplaces (not copied)
Sticky header with search + country selector; category rail; trust strip (delivery, returns, secure checkout); product cards with honest compare-at price, rating and delivery estimate; PDP with gallery, variant selectors, sticky mobile buy bar, delivery estimator, specs, reviews with distribution; slide-over cart; single-page checkout with order summary; order timeline; mobile bottom tab bar; filters as drawer on mobile.
Admin: left nav grouped Operate/Grow/Business, metric cards with sparklines, tables that collapse to cards/scroll on mobile, drawers for detail, exception queue, approval queue.

## Responsive & accessible
Verified at 390px and 1440px for every storefront and admin page (no horizontal overflow — enforced by `tests/e2e/responsive.spec.ts`), keyboard focus rings, skip link, labelled controls, alt text, `prefers-reduced-motion`, charts with table views and legends (never colour-only).
Product imagery in the demo is procedurally generated SVG art (`/art/[id]`) — replace with real supplier/product photography (S3) in production.
