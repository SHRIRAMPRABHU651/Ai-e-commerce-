# ORVIA design system

Source of truth: `packages/ui/src/theme.css` (tokens), `packages/ui/src/*.tsx` (components), `apps/web/src/app/globals.css` (Tailwind v4 import). Brand rationale: `docs/BRAND.md`.

## Tokens (as implemented)

| Group | Tokens |
|---|---|
| Surfaces | `paper` (canvas), `surface` (cards), `sunken` (wells), `line`, `line-strong` |
| Text | `ink`, `ink-2` (secondary), `ink-3` (muted) |
| Brand | `pine-50/100/200/500/600/700/800/900`; `on-fill` = text colour on solid pine/coral fills (white in light, near-black in dark) |
| Accents | `saffron-50/500/700` (offers), `coral-50/500/700` (errors, danger) |
| Status | `ok-50/500`, `warn-50/500`, `info-50/500` |
| Data viz | `series-1..4` (categorical, per theme), `grid` |
| Type | `--font-sans` Manrope Variable (UI), `--font-display` Fraunces Variable (headings, `.font-display`) |
| Radius | `sm 6px`, `md 10px`, `lg 14px`, `xl 20px` |
| Shadow | `shadow-card`, `shadow-pop` |
| Spacing | Tailwind 4px scale; page gutter `px-4`; content width `max-w-7xl` (store) / `max-w-6xl` (portals) |
| Motion | `--ease-out`, `--dur-fast 120ms`, `--dur-base 200ms`, `--dur-slow 400ms`; keyframes `orvia-fade`, `orvia-slide-up`, `orvia-slide-left`, `orvia-shimmer`. Animation is cut to about 0 under `prefers-reduced-motion: reduce`. |

Use token utilities (`bg-surface`, `text-ink-2`, `border-line`, `text-on-fill`). Do not hard-code hex or `text-white`/`bg-white`: they do not follow the theme and fail contrast in dark mode.

## Theming

- Light is the default. Dark follows `prefers-color-scheme: dark` unless the user chose a theme.
- `<ThemeToggle />` (`@orvia/ui`) sets `data-theme="light|dark"` on `<html>` and stores the choice under `localStorage["orvia_theme"]` in try/catch (blocked storage still toggles for the page view).
- No flash: the root layout inlines `THEME_INIT_SCRIPT` (`packages/ui/src/theme-script.ts`) in `<head>`; it applies a stored choice before first paint. With no stored choice CSS media queries apply the OS preference.
- Toggle is in the storefront header, the admin shell and the supplier portal header. Account and creator pages sit inside the storefront chrome.
- `viewport.themeColor` is set for both schemes.

## Components inventory (`@orvia/ui`)

- Core (`core.tsx`): `Button` (6 variants, 3 sizes, `loading`, `href`), `IconButton` (requires `label`), `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `QuantityStepper`, `Card`, `Skeleton`, `Spinner`, `EmptyState`, `Badge`, `StatusBadge`, `Breadcrumb`, `Tabs`, `Pagination`, `Modal`, `Drawer`, `Dropdown`, `Tooltip`, `ToastProvider`/`useToast`.
- States (`states.tsx`): `ErrorState` (role=alert, retry), `ThemeToggle`, `ProductCompare` (accessible comparison table, used by `/compare`).
- Data (`data.tsx`): `Table`, `DataTable` (horizontal scroll, `hideBelow` columns, keyboard row activation, skeleton rows, empty state, pagination), `LineChart`, `BarList`, `FunnelChart`, `Legend`, `ChartTabs` (charts have table views).
- Commerce (`commerce.tsx`): `ProductCard`, `ProductGrid`, `ProductGridSkeleton`, `ProductArt`, `PriceDisplay`, `Rating`, `SectionHeader` (accepts `id` for `aria-labelledby`), `SearchBar`, `CountrySelector`, `FilterPanel`, `OrderTimeline`, `MetricCard`, `Sparkline`, `AIInsightCard`, `AutomationCard`.
- App-level: `components/trust.tsx` (`TrustBadge`, purchase confidence), `components/find*.tsx`.

## Accessibility rules

1. Colour pairs meet the table below. `tests/unit/design-contrast.test.ts` reads `theme.css` and fails if a pair regresses in either theme.
2. Touch targets are at least 44px: `IconButton` 44, `Button` md/lg 44-48, `Button sm` is 36 on fine pointers and 44 on coarse pointers (`pointer-coarse:`); pagination buttons and dialog close buttons likewise.
3. One focus style: 2px `pine-500` outline, 2px offset, on `:focus-visible`; system `Highlight` under forced colours.
4. `Modal`/`Drawer`: `role="dialog"`, `aria-modal`, `aria-label`, Escape closes, Tab and Shift+Tab are trapped (focus is pulled back in if it escapes), focus returns to the trigger, body scroll is locked.
5. Toasts: container is `aria-live="polite"` `role="status"`; error toasts are also `role="alert"`.
6. Form errors use `Field` (`role="alert"`, text not colour only). Icon-only buttons need `label`.
7. Landmarks: skip link to `#main`, one `<main id="main">`, labelled navs (Categories, Primary, Account, Admin, Portal). The current page uses `aria-current="page"` (now also in the category nav).
8. One `h1` per page; sections are `h2` via `SectionHeader`.
9. Motion respects `prefers-reduced-motion`; charts expose table views and legends.
10. Product images use the product title as alt; decorative icons are `aria-hidden`.

### Contrast (WCAG 2.x, computed from the tokens)

| Foreground on background | Use | Min | Light | Dark |
|---|---|---|---|---|
| `ink` on `paper` | body text | 4.5 | 16.72 | 16.73 |
| `ink` on `surface` | card text | 4.5 | 17.58 | 15.43 |
| `ink-2` on `paper` | secondary text | 4.5 | 8.82 | 10.83 |
| `ink-2` on `sunken` | secondary text on sunken | 4.5 | 8.16 | 9.25 |
| `ink-3` on `paper` | muted text | 4.5 | 5.13 | 6.73 |
| `ink-3` on `surface` | muted text on cards | 4.5 | 5.39 | 6.21 |
| `ink-3` on `sunken` | muted text on sunken | 4.5 | 4.75 | 5.75 |
| `paper` on `ink` | tooltip / accent button | 4.5 | 16.72 | 16.73 |
| `pine-700` on `paper` | link / active nav text | 4.5 | 10.32 | 11.27 |
| `pine-700` on `pine-50` | soft button / active nav | 4.5 | 9.81 | 9.62 |
| `pine-600` on `surface` | brand text on cards | 4.5 | 8.28 | 8.49 |
| `on-fill` on `pine-600` | primary button | 4.5 | 8.28 | 8.73 |
| `on-fill` on `pine-700` | Find pill, toast | 4.5 | 10.85 | 10.68 |
| `on-fill` on `coral-500` | danger button / error toast | 4.5 | 5.32 | 6.58 |
| `coral-500` on `surface` | error text | 4.5 | 5.32 | 6.40 |
| `coral-500` on `paper` | error text on canvas | 4.5 | 5.06 | 6.95 |
| `coral-700` on `coral-50` | error badge | 4.5 | 7.80 | 8.80 |
| `saffron-700` on `saffron-50` | offer badge | 4.5 | 5.50 | 9.32 |
| `ok-500` on `ok-50` | success badge | 4.5 | 4.70 | 7.15 |
| `warn-500` on `warn-50` | warning badge | 4.5 | 5.59 | 7.83 |
| `info-500` on `info-50` | info badge | 4.5 | 5.17 | 6.80 |
| `pine-100` on `pine-900` | announcement bar | 4.5 | 12.93 | 11.61 |
| `pine-500` on `paper` | focus ring (non-text, min 3) | 3 | 5.76 | 7.17 |

Fixes made from this audit: white text on pine/coral fills failed in dark mode (light fills), so those use `text-on-fill`; light `warn-500` darkened (`#9a6700` to `#855900`); the undefined `pine-800` token used by Find components was added. `line`/`line-strong` borders are decorative (inputs also have visible labels).

## Surfaces

All five share tokens and `@orvia/ui` with distinct chrome:

| Surface | Routes | Layout / navigation |
|---|---|---|
| Storefront | `/`, `/c`, `/p`, `/search`, `/find`, `/compare`, `/cart`, `/checkout`, `/needs` | `(store)/layout.tsx`: announcement bar, sticky header (search, Find, country, theme, account, cart), category nav, mobile bottom tab bar, cart drawer, support chat, footer |
| Account / aftercare | `/account/**`, `/orders`, `/track` | Storefront chrome plus `AccountNav` (side list on desktop, scrolling pills on mobile) |
| Creator portal | `/creator`, `/creators/**` | Storefront chrome; single-page portal |
| Supplier portal | `/supplier/**` | Own layout: compact top bar with theme toggle, horizontal portal nav, no storefront chrome, `max-w-6xl` |
| Admin | `/admin/**` | Own shell: grouped, permission-filtered left nav, drawer nav on mobile, sticky top bar with theme toggle |

## Homepage

Server-rendered. The hero has a plain HTML `GET /find` form (works without JavaScript) that opens `/find?q=`; then categories, shop by need, a "Shop with confidence" row linking Find, Price Guard (`/account/price-guard`) and Compare, then the existing data-driven shelves. The trust strip states only verifiable facts (tracked delivery, return window from the country config, payment confirmed server-side, online order help). Testimonials render only when the API returns verified-buyer reviews.

## Implemented vs not

Implemented: tokens, dark/light with toggle and no flash, contrast test, touch targets, focus-trap hardening, `ErrorState`, `ProductCompare`, homepage Find box and paths, category-nav active state, theme toggle on three surfaces.

Not implemented / gaps:
- Creator collections teaser on the homepage: there is no public listing endpoint (only `GET /creators/:handle`), so it is intentionally absent.
- Supplier trust on the homepage: TrustGraph is exposed per product (`TrustBadge`), not as a public aggregate, so none is shown on the homepage.
- 16px font size on mobile form fields (avoids iOS zoom) is not enforced globally.
- No automated axe or visual-regression runs; e2e specs were not executed in this environment.
- The store layout renders a second "Skip to content" link besides the root layout's (harmless; outside this workstream's files).
