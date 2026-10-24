# Hardening checkpoint — review findings closed

Date: 2026-10-24 · Responds to the independent review of `04efef3`.

| # | Finding | Fix | Evidence |
|---|---|---|---|
| 1 | **Blocker:** export-attestation gate bypassable with `force` (retry API, exception "approve fulfilment", AI executor, change-supplier); forced retry also resolved the legal exception | `force` waives operational holds only. The gate no longer reads `force`; forced retry no longer resolves `EXPORT_ATTESTATION` exceptions; a second check runs immediately before the supplier call, outside the supplier try/catch | `tests/integration/export-gate.test.ts` — **fails on the old code** (verified by restoring the old `orders.ts`: both tests red), passes now |
| 2 | **Blocker:** skipped Terraform step recorded as `PASS` in `.certification.json`; launch readiness read every `PASS`-or-not | Steps have a distinct `SKIP`; `.certification.json` stores it and sets `partial`; `certificationStatus()` makes SKIP/partial/unknown **INCOMPLETE (WARN)**, any FAIL a FAIL, never PASS; the script prints `NOT A FULL CERTIFICATION` | `tests/unit/certification.test.ts` (pure cases + a real `production-check --only "terraform validate"` run; also asserts hard FAIL with `CI=true`) |
| 3 | **CI had no runner-backed evidence** | Root cause: `ci.yml` (from the baseline) and my `release.yml` were **invalid YAML** (`${{ }}` inside an unquoted flow mapping), so GitHub created runs with zero jobs. Fixed; first real runs below | CI run history |
| 4a | Measured 0% refund treated as missing | Provenance (`refundSource === 'measured'` and sample > 0) decides, not magnitude | `economics.test.ts` › "measured zero refund rate is a measurement" |
| 4b | Cross-platform CAC double counts | Platform-reported purchases are **capped at real paid, non-demo orders** per product+country before any roll-up; with no real orders there is no measurement. Residual limit (organic buyers, single-customer dedupe) documented in `LIMITATIONS.md` #17; keep to one channel | `economics.test.ts` › "platform-claimed purchases are capped at real orders" |

## Things the first real CI run surfaced (all fixed)

- `terraform validate` **passed on a real runner** (first ever evidence); `terraform fmt -check` failed → `main.tf` formatted, provider lock committed.
- My certification test depended on build output that does not exist before tests on a clean runner → made hermetic with `production-check --only`.
- Overnight, `npm audit` gained a **high** advisory in `undici` and one in `zod` (<4.6.6, memory exhaustion on oversized collections; no 3.x fix). `undici` fixed by `npm audit fix`. `zod` **migrated 3 → 4.6.7**: `z.record` two-arg form, `ZodType<O, I>` generics, built-in `toJSONSchema` replaces `zod-to-json-schema`, and `.default({})` → `.prefault({})` where an object's inner defaults must still apply (zod 4 no longer parses defaults).

## Not changed by this checkpoint

Phase 1 (live supplier / payment / S3 / Terraform apply) and Phase 2 (real sales) remain **not done**; `LIMITATIONS.md` #1, #4, #6, #13 stand. `terraform validate` is now proven on a GitHub runner, but nothing has been planned or applied against an account.

## Runner-backed CI evidence

[CI run 40061120584](https://github.com/SHRIRAMPRABHU651/Ai-e-commerce-/actions/runs/40061120584) on commit `6944403` (pull request into the default branch) — **all four jobs green**:

| Job | Steps proven on a clean GitHub runner |
|---|---|
| `verify` | `npm ci`, lint, typecheck, `test:coverage` (253 tests + coverage floors, against the `mongo:7` **service container**, no binary download), build, `npm audit --audit-level=high`, `terraform` setup, `production-check --scan-only` (secret scans, production-config guard, `terraform validate`) |
| `terraform` | `init -backend=false`, `validate`, `fmt -check -recursive` |
| `docker` | image builds for api / worker / web |
| `e2e` | Playwright desktop + mobile (incl. `/admin/economics`) |

Earlier runs on this PR failed for real, fixable reasons (terraform fmt, a build-dependent test, a new `undici` advisory) — see the section above.
