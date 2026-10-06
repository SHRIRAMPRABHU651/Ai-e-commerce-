# Production certification

"Production ready" is a claim backed by evidence, not a feeling. Orvia is **NOT READY** until every item below is green on the release commit.

## What can be verified without credentials (CI / any machine)
| Check | Command |
|---|---|
| Install | `npm ci` |
| Lint / typecheck | `npm run lint`, `npm run typecheck` |
| Unit + integration + failure + security tests | `npm test` |
| Production build | `npm run build` |
| Production guard refuses mocks / weak secrets | `npm run production-check` |
| Secret scan (bundle, repo, NEXT_PUBLIC_) | `npm run production-check` |
| Terraform structure (static only) | `npm run terraform:check` |
| E2E desktop + mobile | `npm run e2e` |

`npm run production-check` runs all of the above and writes `.certification.json`; `npm run certify` stores it so `/admin/launch-readiness` shows it.

## What needs real credentials (staging)
Run `npm run verify:staging` against a staging deployment with sandbox/test credentials. It runs the launch gate with **live read-only** provider calls (Stripe balance, Razorpay payments list, Resend domains, Twilio account, Gemini models, ad-platform health checks, storage write/read) and supplier health checks. It never creates orders, charges or campaigns, and exits non-zero while any blocker remains.

Things only a human can confirm and which stay blockers until attested: legal review (Admin → Launch readiness → Business & legal), email domain SPF/DKIM, a real supplier tracking number (supplier validation suite, `PLACE TEST ORDER` against a sandbox or acknowledged live order), Stripe/Razorpay test payment + webhook + refund in the provider dashboard, `terraform validate && terraform plan`.

## Verdict
`GET /admin/launch-readiness` (staff, `launch:read`) and `GET /api/v1/launch-gate` (bearer `METRICS_TOKEN`; 200 = GO, 503 = NO_GO). A single blocking FAIL makes the verdict NO-GO. Warnings need an owner's decision.

## Not covered by any automated check
Live adapter payload shapes (CJ, REST suppliers), real-bucket S3 behaviour, CDN configuration, real tax/duty accuracy, load behaviour. See LIMITATIONS.md.
