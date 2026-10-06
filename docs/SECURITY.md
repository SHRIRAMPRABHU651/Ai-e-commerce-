# Security

## Controls implemented (and tested in `tests/integration/security.test.ts`)
| Area | Control |
|---|---|
| Transport/headers | helmet defaults on the API; strict security headers on the web app (CSP-friendly, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`); HSTS from helmet on the API (add HSTS at your CDN/ALB for the web origin) |
| AuthN | scrypt password hashing, JWT (HS256 via `jose`) in an httpOnly SameSite=Lax cookie, session rows server-side (revocable), email verification + password reset tokens (hashed, single-use, expiring), account lockout after repeated failures |
| AuthZ | role→permission matrix enforced per route; customers can only read their own orders/returns; guest order lookup needs order number **and** matching email and returns the same 404 for "wrong email" and "no such order" |
| CSRF | state-changing cookie-authenticated requests require `x-requested-with: orvia` + same-site `Origin`; webhooks are signature-authenticated instead |
| Injection | zod validation on every input; keys containing `$` or `.` are rejected (Mongo operator injection); no string concatenation into queries; regex input escaped |
| Abuse | per-IP rate limits (stricter on login, register, search, lookup, checkout, reviews, chat); per-account lockout |
| Webhooks | HMAC/signature verification on the *raw* body, event-id dedupe, replay-safe, then provider re-fetch before state change |
| Secrets | read only from environment/Secrets Manager by API/worker; `integrationStatus` returns booleans never values; stored provider credentials AES-256-GCM encrypted; a release gate scans the browser bundle for secret variable names |
| Data | order financial fields immutable; audit log for every sensitive action (actor, before/after, reason, request id); PII minimised in logs |
| Fraud | rule-based score at checkout (velocity, address mismatch, high value, disposable email, …) → hold into the exception queue above a threshold |
| Compliance | product compliance filter blocks weapons, replica/counterfeit goods, regulated health claims, etc. before import/publish |
| Production guard | refuses to boot with mock providers, weak JWT secret, insecure cookies or seed-on-start |

## Operator responsibilities
- Use a long random `JWT_SECRET` and rotate it on staff offboarding (rotation logs everyone out).
- Put the API behind TLS + a WAF/CDN; set `TRUST_PROXY=true` only when a trusted proxy sets `X-Forwarded-For`.
- Restrict MongoDB network access; enable backups/PITR.
- Rotate seed/demo staff passwords — **never run `seed` against production** (it is blocked by config, but don't try).
- Review *Admin → Audit logs* and the exception queue daily.
- Tax, customs, consumer-law and advertising-policy compliance are the operator's responsibility; the app provides estimates and guard-rails, not legal advice.

## Reporting a vulnerability
Open a private security advisory on the repository. Don't file public issues for vulnerabilities.

## Added controls
SSRF-guarded fetching (images, crawler), HTML-escaped emails, robots-respecting crawler, per-supplier encrypted credentials, launch-gate endpoint behind `METRICS_TOKEN`, organic-claim evidence gates, production refuses `ALLOW_PRIVATE_FETCH`.
