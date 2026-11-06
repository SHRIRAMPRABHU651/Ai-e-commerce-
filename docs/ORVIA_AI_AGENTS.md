# ORVIA AI agents

A governed agent platform: 11 specialised agents that read through typed, authorised tools, are audited end to end, have hard budgets and a kill switch, and hand over to people when unsure. Money, eligibility and permissions are decided by deterministic code; a model can only choose among allowlisted read tools and word an answer that is checked against the tool outputs.

Code: `packages/core/src/domain/agents/**` (pure framework + thin IO), routes `apps/api/src/routes/agents.ts`, models `packages/database/src/models.agents.ts`, types `packages/types/src/agents.ts`, admin `/admin/ai-agents`, storefront `apps/web/src/components/assistant.tsx`. It builds on the AI layer in [AI.md](AI.md) (`GeminiProvider`, schema validation, grounding guards) and the Business Copilot (`domain/copilot.ts`, exposed as the read-only tool `copilot_query`, not duplicated).

## Status

| Area | State |
|---|---|
| Framework: spec registry, tool executor, runner, budgets, audit, escalations, kill switch | Implemented |
| Shopping Assistant (deterministic intents + templates, guarded actions, conversations, grounding check) | Implemented |
| Customer Advocate (deterministic recommendation, outcome records, metrics, rating endpoint) | Implemented |
| 9 staff agents (read-only tools, deterministic summaries) | Implemented |
| Admin console `/admin/ai-agents` | Implemented |
| Model-worded answers / model-chosen tools | Implemented, **requires `GEMINI_API_KEY`** (never exercised against the live API in this repo's tests) |
| Mongo-backed integration tests (`tests/integration/agents.test.ts`) | Written, **not executed in the authoring sandbox** (no MongoDB); run in CI |
| Real token accounting from the provider | Planned: the provider layer returns no usage, budgets use an estimate |
| Streaming replies, voice, image input in the assistant | Planned |

## The hard rule

An LLM never authorizes money movement, permission changes or business-rule bypasses. Enforced in code, not in prompts:

- Tools are the only way an agent touches anything. No tool imports or calls a refund, payout, approval, permission or order-state function. A unit test greps the tool sources for those function names and fails if one appears.
- Staff agents have **only** `read` tools (tested). The Copilot is always called with `confirm: false`, so its action plans are discarded.
- `write_guarded` tools (`start_return`, `create_price_alert`, `save_preference`) never run on a model's say-so. The executor creates a **pending action** (arguments stored server-side) and returns `awaiting_confirmation`; the model only learns that. The one-time token goes to the UI. Execution happens in `POST /assistant/confirm`, by the signed-in owner, after the token (HMAC bound to user, tool, exact arguments and expiry) verifies. The executor then re-checks allowlist, audience, verified email, strict arguments and the arguments hash. A confirmation for other arguments or another tool is useless.
- `start_return` calls the existing aftersales `startReturn` (eligibility rules, window, supplier policy). It creates an RMA in `submitted`; staff authorise it and the refund amount is computed by `refundMath` and executed by the guarded `refundOrder` with approval limits. The agent explains eligibility, it does not compute or grant refunds.
- `request_replacement` (class `propose`, also needs confirmation) only creates a **pending** `agents_replacement_requests` row plus an escalation for staff. Approving it in admin records a decision; nothing ships or refunds from it.
- `save_preference` goes through customer360 `saveMemoryItem` (honours the memory switch, limits and retention) and only after confirmation.
- Tool arguments cannot carry identity or approval fields (`userId`, `email`, `role`, `confirmed`, `token`, `approved`, ...): schemas are strict and the executor rejects those keys outright.

## Agents

| Agent | Audience | Purpose | Tools (allowlist) | Timeout | Steps / tool calls / retries | Budget per call / day tokens, day cost | Model chain |
|---|---|---|---|---|---|---|---|
| `product_discovery` | staff | Opportunities from market evidence, unit economics, demand | copilot_query, economics_sheet, events_product_performance, product_performance | 60s | 4/8/1 | 12000 / 300000, $1.50 | flash > flash-lite > template |
| `product_intelligence` | staff | Why products win or lose | product_performance, trust_product_risk, aftersales_analytics, events_product_performance | 60s | 4/8/1 | same | same |
| `supplier_intelligence` | staff | Reliability, SLA breaches, cost drift, return rates | trust_suppliers, supplier_sla, finance_cost_alerts, aftersales_analytics | 60s | 4/8/1 | same | same |
| `customer_advocate` | customer | Fairest policy-permitted resolution for a customer problem | resolution_context, rescue_status, return_eligibility, refund_progress, request_human | 25s | 2/4/1 | 6000 / 600000, $2.50 | flash-lite > flash > template |
| `shopping_assistant` | customer | Find/compare products, orders, returns, refunds, escalate | find_products, compare_products, product_facts, purchase_confidence, request_human, guest_order_lookup, my_orders, get_order, return_eligibility, refund_progress, rescue_status, start_return, request_replacement, create_price_alert, save_preference | 25s | 3/8/1 | 6000 / 600000, $2.50 | flash-lite > flash > template |
| `delivery_rescue` | staff | **Explainer only**: the rescue engine decides | rescue_summary, rescue_case | 60s | 4/8/1 | 12000 / 300000, $1.50 | flash > flash-lite > template |
| `returns` | staff | Return reasons, rates, queue | aftersales_analytics, returns_queue | 60s | 4/8/1 | same | same |
| `pricing_intelligence` | staff | Products failing margin rules, cost drift | economics_sheet, finance_cost_alerts | 60s | 4/8/1 | same | same |
| `marketing_intelligence` | staff | Attribution, funnel drop-offs, ad performance | events_attribution, events_product_performance, copilot_query | 60s | 4/8/1 | same | same |
| `finance_analysis` | staff | KPIs with provenance, reconciliation, cost alerts | finance_overview, finance_cost_alerts, finance_reconciliation | 60s | 4/8/1 | same | same |
| `trust_analysis` | staff | TrustGraph supplier/product risk, optional Fair Deal for one product | trust_suppliers, trust_product_risk, trust_fair_deal | 60s | 4/8/1 | same | same |

Model ids and budgets are constants in `specs.ts`. The model call uses the existing `GeminiProvider` (one instance per id on the configured key); a failing or invalid model falls through the chain and finally to a deterministic template built from the tool outputs.

## Tool matrix

Side-effect classes: `read` (no side effect), `propose` (creates a proposal a person/engine must decide), `write_guarded` (executes only through deterministic domain code after explicit customer confirmation). Audience `guest`/`customer` tools are customer-scoped: the user id and email come from the authenticated session (`AuthContext`), never from arguments or model output.

| Tool | Class | Audience | Staff permission | Needs confirmation | Calls/run | Max output bytes |
|---|---|---|---|---|---|---|
| `find_products` (Find engine, deterministic parse) | read | guest, customer | | | 4 | 12000 |
| `compare_products` | read | guest, customer | | | 2 | 14000 |
| `product_facts` (Digital Product Passport: verified/supplier-provided only) | read | guest, customer | | | 3 | 10000 |
| `purchase_confidence` (delivery window, returns window, caveats) | read | guest, customer | | | 2 | 6000 |
| `request_human` | propose | guest, customer | | | 1 | 400 |
| `guest_order_lookup` (order number + email contract) | read | guest | | | 2 | 6000 |
| `my_orders` | read | customer | | | 2 | 6000 |
| `get_order` (ownership checked) | read | customer | | | 3 | 6000 |
| `return_eligibility` (aftersales rules) | read | customer | | | 3 | 8000 |
| `refund_progress` (refund timeline) | read | customer | | | 2 | 6000 |
| `rescue_status` (Delivery Rescue view) | read | customer | | | 2 | 8000 |
| `resolution_context` (policy + refund math + rescue + recommendation) | read | customer | | | 1 | 8000 |
| `start_return` | write_guarded | customer | | yes | 1 | 1000 |
| `request_replacement` | propose | customer | | yes | 1 | 800 |
| `create_price_alert` (Price Guard) | write_guarded | customer | | yes | 1 | 600 |
| `save_preference` (customer360 memory) | write_guarded | customer | | yes | 1 | 500 |
| `trust_suppliers`, `trust_product_risk`, `trust_fair_deal` | read | staff | trust:read | | 1/1/2 | 8000/8000/6000 |
| `supplier_sla` | read | staff | suppliers:read | | 1 | 8000 |
| `finance_overview`, `finance_cost_alerts`, `finance_reconciliation` | read | staff | finance:read | | 2/1/1 | 8000/6000/6000 |
| `economics_sheet` | read | staff | products:read | | 1 | 10000 |
| `events_attribution`, `events_product_performance` | read | staff | marketing:read | | 1 | 6000/8000 |
| `product_performance` | read | staff | analytics:read | | 1 | 8000 |
| `rescue_summary`, `rescue_case` | read | staff | rescue:read | | 1/2 | 6000/10000 |
| `aftersales_analytics`, `returns_queue` | read | staff | returns:read | | 1 | 8000/6000 |
| `copilot_query` (existing Copilot, `confirm` always false) | read | staff | copilot:use | | 3 | 10000 |

A staff agent run needs `ai:write` (route) **and** the read permission of each tool for the person running it; a missing permission is a refused tool call, shown as a data gap and recorded as an escalation reason.

## Guardrails

- **Allowlist**: a tool not in the spec's `tools` is refused even if it exists (`tool_not_allowlisted` flag).
- **Strict arguments**: Zod `strictObject`; identity/approval keys rejected; per-tool and per-run call limits; per-tool output size limit; output re-validated against the tool's output schema.
- **Prompt injection**: user text, supplier text, reviews and tool outputs are data. User text is sanitised (control/zero-width characters, fence lookalikes) and scanned (`detectInjection`); tool outputs are neutralised (instruction-like phrases replaced with `[removed]`) before any model or template sees them; everything is wrapped in `<untrusted_data>` fences and the system prompt says so. Suspicion is flagged in the run record. None of this is relied on for safety: even a fully compromised model can only request allowlisted tools, which are re-authorised in code, and cannot confirm anything.
- **Response grounding check** (`grounding.ts`): a reply is rejected when it states a price, delivery window/date/promise, stock level or availability, certification/safety claim (CE, UL, FCC, IP rating, organic, hypoallergenic, waterproof, certified...), warranty term or policy fact (N-day returns, free returns/shipping, full refund, lifetime warranty...) that is absent from the same run's tool outputs. Delivery and policy day-counts must come from fields about days/ETA/windows; stock numbers from stock fields. A rejected reply is replaced by the template built from the tool outputs (and a `grounding_failed` escalation is recorded). Templates also pass through the check. The check is intentionally strict; a false rejection costs a plainer answer, a false acceptance would be a fabricated claim.
- **Output schema**: model output must match the spec's compose schema; invalid output is retried up to the spec's `retryLimit`, then the next model, then the template (`output_invalid` escalation).
- **Staff agent grounding**: numbers in the narrative must appear in the tool data (`findUngroundedNumbers`) and forbidden claim patterns are rejected.
- **Timeouts and step limits** per spec; hitting a limit escalates (`limit_hit`).

## Data-access model

- The API layer builds `AuthContext` from the session. Only a signed-in `CUSTOMER` with a **verified email** is `customer`; everyone else (anonymous, unverified, staff browsing the storefront) is `guest`. Account tools require `customer`; guests get product help and the existing order-number + email lookup (which returns status and tracking only).
- Customer tools filter by the session user id in the query (`userId` or verified email), and return the identical "not found" answer for missing and foreign orders (no existence oracle). Tool arguments cannot name another user. Conversations belong to their opener: a signed-in session id cannot be used by another account (it gets a fresh conversation); guest conversations are reachable only through their 128-bit id.
- Confirmation lookups include the user id: another user's pending action id is a 404.
- Staff tools run with the staff member's permissions; customer-facing specs can never include them (tested).
- Fair Deal ranking with supplier names and landed cost is a staff tool only; the customer-facing path uses `purchase_confidence` and the Find ranking.

## Audit and escalation

- Every run writes `agents_runs`: agent, actor type and reference (user id or hashed guest session), input hash and **redacted** input (emails, card-like numbers, phones, long tokens removed), each tool call with a redacted argument summary, outcome and reason, output (redacted, truncated), source (`deterministic` | `model` | `template_fallback`), models used, estimated tokens and cost, model calls, cache hits, flags, notes, escalation id, request id. Kept 365 days. Confirmations are separate `kind: 'confirmation'` rows. Staff runs, kill-switch changes, escalation resolutions, replacement decisions, conversation deletions and confirmed/cancelled actions also write the main audit log.
- Escalations (`agents_escalations`, shown in admin) are created for: `low_confidence` (below the spec's minimum), `sensitive` (legal, fraud/dispute, safety/fire/injury, medical, privacy-rights, harassment), `customer_requested`, `limit_hit`, `tool_refused`, `budget_exhausted` (deduped once per agent per day), `grounding_failed`, `output_invalid`, `complex_case`, `injection_suspected` (only when an injected run also tried a disallowed action), `replacement_request`.

## Cost control

- Deterministic fast paths: obvious intents (track order, refund status, eligibility, search, compare, product facts, previous purchases, human request...) plan their tools without any model call and answer with a template. A model is used only when nothing matched and search found nothing (Assistant), or for staff agents' wording.
- Smaller model first for customer-facing specs (flash-lite), per-call token cap, per-day token and cost caps stored in `agents_usage`; **no model call starts** if it would exceed any cap. On exhaustion the run continues deterministically (outcome `budget_stopped`, escalation recorded) so customers are still served from tool outputs; the spend is hard-stopped.
- Short-TTL (5 min, 500 entries) cache of identical model prompts. The key hashes the full prompt, which embeds the run's tool data, so entries never cross users.
- Tokens are estimated (about 4 characters per token) and cost uses a configured per-model price table, with a conservative default for unknown models. These are budgeting estimates, not a bill; the provider layer does not return usage.

## Shopping Assistant

`POST /api/v1/assistant/message` (optional auth, 20/min per IP, plus 60 runs per actor per hour and 120 messages per conversation per day stored counters). Intent is detected by regex rules; the `find` intent parser and engine run as a tool. It recommends products from Find, explains differences with the compare engine, answers order questions only for the owner, tracks deliveries, explains return eligibility, prepares a return/replacement/price alert/preference **for confirmation**, tracks refund progress, finds previous purchases, answers warranty/certification questions only from verified/supplier-provided passport data (it says what is missing and offers a person), and escalates. Problem messages ("it arrived damaged", "never arrived") from a verified customer with an order are handed to the Customer Advocate.

Conversations (`agents_conversations`): server-issued session id, at most 40 stored messages, redacted text, retention 1 day for guests and 30 days for customers (refreshed on activity, TTL index plus a daily job). Customers delete one (`DELETE /assistant/conversations/:sessionId`) or all (`DELETE /assistant/conversations`); guests can delete the one they hold. The existing `/support/chat` endpoint and `LegacyChatWidget` are unchanged.

## Customer Advocate

`POST /api/v1/assistant/advocate` (verified customer). `resolution_context` gathers the rescue case offers and the engine's own recommendation, aftersales eligibility, refund math (`computeRefund` with the published shipping rule) and policy, then `recommendResolution` lists the options with `permitted` flags and reasons and marks the fairest permitted one:

| Problem | Preference order among permitted options |
|---|---|
| damaged, wrong item | replacement (if the supplier policy allows) > refund (return) > rescue offer > person |
| missing | rescue engine's recommended offer > refund > other rescue offer > person |
| delayed | rescue engine's recommended offer > any rescue offer > keep waiting > person |
| other, order not paid/active | person |

Options the policy forbids are listed as not permitted with the reason and are never recommended. A model may only reword; the card (options, recommendation, amounts) is deterministic. Execution is by the rescue engine (customer consent), the returns flow (staff authorise) and approval limits.

Outcome records (`agents_outcomes`, one per order and problem) store the recommendation. Metrics (`GET /admin/agents/metrics/advocate`) are computed from real records and show **insufficient data** below 30 observations each:

- **Customer satisfaction**: mean post-resolution rating. `POST /assistant/outcomes/:id/rating` is owner-only and returns 409 until the case is resolved by the rescue engine or the aftersales flow.
- **First-contact resolution**: share of resolved cases with a single advocate run and no escalation.
- **Refund accuracy**: (a) the recommendation's class (refund / replacement / wait) equals the final engine/staff outcome; (b) for refund recommendations that ended in a refund, the amounts are identical.
- **Retention**: share of resolved cases whose customer placed another paid order within 90 days; cases whose 90-day window has not elapsed (and have no repeat yet) are excluded.

## Admin `/admin/ai-agents` (permission `ai:write`)

Tabs: **Agents** (catalogue: purpose, tools with side-effect class and permission, limits, model chain, status `ready` / `needs API key` / `killed`, today's tokens and cost against budget, Run and Kill switch), **Run log** (filters, redacted drilldown with tool calls), **Budgets** (usage per agent per day, budget stops), **Escalations** (queue with resolve, plus replacement requests awaiting staff), **Advocate outcomes**. All data is real; empty, loading and error states are shown. The kill switch (`AgentsConfig`, audited with reason) takes effect within seconds; a killed customer-facing agent tells customers it is off.

## Endpoints

Customer: `POST /assistant/message`, `POST /assistant/confirm`, `GET|DELETE /assistant/conversations/:sessionId`, `DELETE /assistant/conversations`, `POST /assistant/advocate`, `POST /assistant/outcomes/:id/rating`.
Admin (all `ai:write`): `GET /admin/agents`, `POST /admin/agents/:id/run`, `POST /admin/agents/:id/kill`, `GET /admin/agents/runs[/:id]`, `GET /admin/agents/usage`, `GET /admin/agents/escalations`, `POST /admin/agents/escalations/:id/resolve`, `GET /admin/agents/metrics/advocate`, `GET /admin/agents/replacement-requests`, `POST /admin/agents/replacement-requests/:id/decide`.
Job: `agents_maintenance` (daily): expires stale confirmations, deletes expired conversations, purges old finished pending actions.

## What needs an API key, what is deterministic

| Needs `GEMINI_API_KEY` | Works without it (deterministic) |
|---|---|
| Model-chosen tools for unmatched Assistant messages; model wording of staff summaries and Advocate explanations | All tool calls and data; intent detection and planning for the listed intents; every template reply and card; staff summaries and findings (rule-based thresholds); grounding checks; recommendations; budgets and audit; escalations; admin console |

Without a key the admin shows `needs API key` and every run is labelled `deterministic`. Nothing is simulated. The Gemini integration is not verified against the live API in this repository; the external step is to set `GEMINI_API_KEY` (and optionally `GEMINI_TIMEOUT_MS`), then watch `source`, cost and `grounding_failed` rates in the run log before relying on model wording.

## Known limits

- Intent detection is regex based; unusual phrasings fall to search or, with a key, to the model. It does not handle several intents in one message.
- Heuristic thresholds in staff summaries (supplier score below 60, on-time rate below 85%, add-to-cart below 2%) are flagged for a human look, not statistical claims.
- Budgets use estimated tokens/cost; the day boundary is UTC. The prompt cache and kill-switch cache are per process.
- Per-actor and per-conversation limits do not stop a guest opening many new conversations; the per-IP route limit does.
- The assistant starts one return item at a time and asks when several items, a quantity, a reason or a condition are unclear. Multi-item returns use the account returns page.
- Approving a replacement request records a decision; carrying it out is a manual step in the Returns console.
- Product-level warranty data exists only where `product_facts` finds it; otherwise the assistant says it is unknown.
- Guarded-action confirmation tokens live in the browser tab's memory; reloading the page drops the prompt (the pending action expires after 15 minutes).

## Tests

- Unit (DB-less): `tests/unit/agents-framework.test.ts` (executor authorization and identity binding, allowlist, schema/size/limit rejection, injection in user text and tool output, confirmation invariants, budget stop, output-schema rejection with retry limits, grounding fallback, cache isolation, kill switch, audience, escalation triggers, audit record), `tests/unit/agents-logic.test.ts` (grounding rejections, policy, registry invariants including the no-money-functions source check, assistant planning and templates, advocate recommendation, metrics sample gating).
- Integration (Mongo, not run in the authoring sandbox): `tests/integration/agents.test.ts` (endpoints, ownership/IDOR, confirmation flow, rate limit, retention/deletion, admin console, kill switch, audit).
