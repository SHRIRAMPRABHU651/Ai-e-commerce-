# ORVIA workstream brief (temporary coordination file; removed before release)

You are one of several engineers working **in parallel**, each in your own git worktree of the same repo (base branch `production`). The lead merges your branch afterwards. Conflicts are avoided by **file ownership**. Read this fully.

## Product context
Orvia is an AI-operated commerce platform (Fastify API `apps/api`, Next.js storefront + `/admin` in `apps/web`, worker `apps/worker`, domain engine `packages/core`, models `packages/database` (Mongoose), shared types/zod `packages/types`, design system `packages/ui`). Read `README.md`, `docs/LIMITATIONS.md`, `docs/ARCHITECTURE.md`, `docs/ECONOMICS.md`, `docs/SUPPLIERS.md` first. The product is being reinvented into a trust-first, supplier-network commerce platform: ORVIA owns the customer experience, trust, after-sales and repeat purchase; suppliers fulfil. No owned inventory.

## Setup in your worktree
1. `npm ci --no-audit --no-fund` (node_modules are not shared). 
2. Baseline: `npm run typecheck` and `npm run lint` must be clean before you start and when you finish.
3. **Mongo-backed tests cannot run in this sandbox** (the MongoDB binary download is blocked by network policy; do NOT try to download/run any database binary or work around this). So:
   - Put business logic in **pure functions** (no mongoose/IO imports) in their own files and unit-test them in `tests/unit/<area>*.test.ts`. Run them with a DB-less config. Create (outside the repo, e.g. in your scratchpad or `/tmp`) a file `vitest.nodb.config.mjs` exporting `{ root: '<your worktree path>', test: { include: ['tests/unit/<your files>'], env: { NODE_ENV: 'test' } } }` and run `npx vitest run --config <that file>`. (The repo's own `vitest.config.ts` has a globalSetup that starts MongoDB and will fail here; do not edit it.)
   - Also write Mongo-backed integration tests `tests/integration/<area>.test.ts` following `tests/integration/shop-flow.test.ts` / `tests/helpers/*` patterns (they will run in CI). Be careful and precise; they cannot be executed here, so re-read them twice. Say clearly in your report that they were not executed.
4. Verify before finishing: `npm run typecheck`, `npm run lint` (zero warnings), your unit tests, and `npm run build -w @orvia/web` if you touched web code (and `npm run build -w @orvia/api` if you touched the API).

## File ownership rules (strict)
- You own the scaffold files for your area(s), already created and wired (permissions, admin nav entry, route registration in `apps/api/src/server.ts`, job registration + schedules in `packages/core/src/jobs/index.ts`, barrel exports):
  - `packages/types/src/<area>.ts`, `packages/database/src/models.<area>.ts`, `packages/core/src/domain/<area>/**` (export `register_<area>_Jobs(ctx)` and `<AREA>_SCHEDULES`), `apps/api/src/routes/<area>.ts` (export `<area>Routes(app, ctx)`), admin page `apps/web/src/app/admin/(shell)/<slug>/page.tsx` where one exists.
  - Add as many additional files as you need **inside your own namespaces** (e.g. `packages/core/src/domain/<area>/*.ts`, `apps/web/src/components/<area>*.tsx`, `apps/web/src/app/(store)/<your routes>/**`). Prefix new Mongoose collections/models with your area to avoid collisions.
- **Do not edit** another workstream's files. Do **not** edit shared files unless explicitly allowed below. If you need a change in a shared file (e.g. a product-page panel, a nav link), export a ready-to-use component/function and describe the exact integration in your final report; the lead wires it.
- Shared files you must NOT touch: `apps/web/src/components/pdp.tsx`, `chrome.tsx`, `account.tsx`, `apps/web/src/app/(store)/layout.tsx`, `page.tsx`, `packages/auth/src/index.ts` (permissions are pre-added: `trust:*`, `rescue:*`, `customer360:*`, `finance:*`, `creators:*`, `loyalty:*`; reuse existing ones otherwise. Need a new one? ask in your report), `packages/core/src/jobs/index.ts`, `apps/api/src/server.ts`, `packages/database/src/models.ts` (existing models), `packages/core/src/domain/orders.ts` — **unless** your task text below grants a specific exception, in which case keep the edit minimal and localized (additive, small hunks) so git can merge it.
- Existing domain functions may be **imported and called** from your code freely.

## Engineering rules
- Match the surrounding code style, naming and idiom. Zod-validate every route input. Use the `route(app, ctx, {...})` helper in `apps/api/src/http.ts` (auth: `'user'`, `'staff'` with `permission`, `'optional'`, `'none'`). Customer data routes must enforce ownership; staff routes must use permissions. Audit-log money/permission/data-affecting actions with `audit()`.
- **Honesty is a hard requirement.** Never fabricate specifications, certifications, delivery dates, availability, statistics, reviews, customers, supplier responses or trust scores in production code paths. Show "insufficient data" instead of a statistically unreliable score. Distinguish provenance: `verified` / `supplier_provided` / `customer_reported` / `ai_suggested`. AI may suggest and explain; **deterministic code decides** money, payment status, order transitions, tax, authorization, refund eligibility, settlement, inventory. An LLM never authorizes a financial transaction or permission change. Mock/dev-only data must stay behind the existing dev/mock guards and never run in production.
- Real integrations (payment/ads/tracking/FX/supplier) need credentials we do not have: implement the real adapter behind the existing provider interface/config pattern, add the env vars to `packages/config/src/index.ts` + `.env.example` if you need new ones (edits to those two files are allowed, additive only), keep a safe mock/log mode for dev/test that production rejects, and **never claim it was verified**. Document the exact external step required.
- Never log or return secrets/PII beyond need. No raw card data anywhere.
- Performance: indexes on every query you add, pagination on lists, bounded loops (`limit`).
- UI: use `@orvia/ui` components and the existing look (see `apps/web/src/components/admin/kit.tsx`, `apps/web/src/components/account.tsx`). Every page needs loading, error and empty states, validation, permission checks and **real backend data** (no invented stats). Accessible, mobile-first.
- Do not weaken or delete existing tests. Do not change unrelated behaviour.

## Documentation
Write the docs assigned to you (precise, matching what is actually implemented; separate *implemented*, *partially implemented*, *requires external credentials*, *planned*). Use the repo's concise doc style. Do not edit `README.md` (the lead rewrites it).

## Finish
Commit all your work on your worktree branch with clear messages (end each commit message with the two lines: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01YZDSZxRKraZmSuL7E91L26`). Do not push. Your final message must be a compact report: (1) what you built (files, endpoints, models, jobs, pages), (2) exact verification commands run and their results, (3) what could NOT be verified and why, (4) integration instructions for shared files, (5) honest remaining gaps. Work autonomously; do not ask questions; finish the whole assignment.
