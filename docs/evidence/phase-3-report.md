# Phase 3 report — technical hardening

Date: 2026-10-23 · **Precondition not met:** the plan says Phase 3 starts only after Phase 2 passes. Phase 1 and 2 are blocked on external accounts and real sales (see their reports). On the operator's instruction the engineering items that are verifiable in this sandbox were done anyway; the rest are marked deferred. This changes no business claim: none of it earns a rupee, and none of it retires a limitation about live providers.

## Claimed → proven

| Item | Before | Now | Artifact |
|---|---|---|---|
| 3.1 Hermetic CI | tests download a MongoDB binary at run time (403 on locked-down runners) | CI `verify` job has a `mongo:7` service container and sets `TEST_MONGO_URI`; `globalSetup` already honours it | `.github/workflows/ci.yml`. **Not yet proven on a cold GitHub runner** — no CI run exists for this branch. Local proof that the `TEST_MONGO_URI` path works: see "Hermetic check" below |
| 3.2 Coverage floors | none | `vitest --coverage`, thresholds lines ≥ 80 / branches ≥ 70 on `packages/core`, enforced by `npm run test:coverage` and by `production-check` | measured: **lines 87.46 %, branches 70.73 %** (statements 82.2 %, functions 81.7 %) with 245 tests. Branches were 66.96 % at first — the floor was **not lowered**; 50 tests were added (manual supplier, abandoned carts, trends, discovery, returns, support, copilot) |
| 3.3 Supply chain | no gate | `npm audit --audit-level=high` in `production-check`, CI and the release workflow; Dependabot (npm, actions, terraform); CycloneDX SBOM (`npm run sbom`, 235 prod components) attached to each `v*` release | `.github/dependabot.yml`, `.github/workflows/release.yml`. The first audit found **critical/high** advisories (next, vite, tinypool/vitest, @fastify/static); fixed by upgrading (next 16.4.2, vite 7.3.7, `@fastify/swagger-ui` 6.x, vitest 5.0.5, esbuild 0.28). Re-running with vitest 5 exposed a test whose `expect().resolves` was never awaited — a latent silent-pass, fixed. A SBOM-tool version I added was itself vulnerable and the new gate caught it; upgraded. 3 *moderate* advisories remain in a dev-only transitive dependency (`uuid`, via `autocannon`) |
| 3.4 Performance baseline | none | p95 recorded at 50 concurrent connections | `docs/PERFORMANCE.md`, `docs/evidence/perf-2026-10-23.json`; shared-CPU sandbox, so a regression baseline, not a capacity claim |
| 3.5 Terraform in CI | static structure check only | `production-check` runs `terraform validate` and **fails on CI if the binary is missing**; locally it prints `SKIPPED … NOT validated` instead of passing silently; CI `verify` job installs terraform | `scripts/production-check.mjs`. **Never executed here** (no binary, no network to fetch one) |

## Hermetic check

Ran `failures.test.ts` + `economics.test.ts` (20 tests, all passed) against a standalone `mongod` on port 27555 with `TEST_MONGO_URI=mongodb://127.0.0.1:27555/` while `MONGOMS_DOWNLOAD_MIRROR=http://127.0.0.1:9`, `MONGOMS_VERSION=0.0.1` and `MONGOMS_SYSTEM_BINARY=/nonexistent` made any binary download or lookup impossible. This proves the suite uses the supplied database and attempts no download. It does **not** prove a GitHub runner's service container works; that needs a CI run.

## `LIMITATIONS.md`

Header updated (245 tests, coverage floors, audit). #4 (Terraform unapplied/unvalidated) **unchanged** — nothing was applied or validated. No entry retired.

## Gate checklist

Final local run of `npm run production-check` (2026-10-23, after the last code change): **ALL CHECKS PASSED** —
lint · typecheck · tests + coverage floors · production build · `npm audit --audit-level=high` · production config guard rejects mock providers · no secrets in browser bundle · no secret `NEXT_PUBLIC_` vars · `.env` untracked · no committed credentials · terraform static structure · `terraform validate` (**SKIPPED — binary not installed, NOT validated**) · Playwright E2E desktop + mobile.


- [x] Coverage thresholds enforced and passing
- [x] Clean high-severity audit
- [x] SBOM generated (publication happens on the first `v*` tag — **not exercised**)
- [x] p95 recorded in `docs/PERFORMANCE.md`
- [ ] `production-check` green on a cold CI runner — **deferred: no CI run; green locally only**
- [ ] "Nothing in `LIMITATIONS.md` describes an unverified code path" — **not met**: live adapters (#1, #13), ads (#2, #11), Terraform (#4) and storage (#6) remain unverified by design of the sequence
