# AI

`AIService` (`packages/ai`) is the only way the platform generates text/decisions.

- **Provider**: Gemini REST (`GEMINI_API_KEY`, `GEMINI_MODEL`) with timeout/retry/circuit breaker. Without a key a deterministic `TemplateAIProvider` is used and every output carries `source: 'template'` so the UI/audit can tell.
- **Structured output**: every task has a zod schema; invalid JSON is retried once then falls back.
- **Grounding guards** (`guards.ts`): reject output that invents specs/materials/certifications not in supplier data, uses forbidden claims (medical, "guaranteed", fake scarcity/reviews), or states numbers not present in the provided facts.
- **Tasks**: product titles/descriptions/bullets/SEO, ad copy variants, review-sentiment analysis, support replies, daily brief narrative, copilot summaries.
- **Copilot** (`/admin/copilot`): intent-routed to **database queries**; every number in an answer comes from a query and the response lists its sources. Actions (pause losing products, etc.) are returned as a *plan* that the admin must confirm; execution is audited and honours guardrails.
- **Support chatbot**: answers from the customer's order/shipment data (email-verified for guests), product attributes and policies; escalates to a human ticket when it can't ground an answer.
- **Decision log**: every automated proposal/decision is stored in `ai_decisions` with inputs, reasoning, mode and outcome.

Limits: AI is advisory unless an automation is AUTOMATIC; it never bypasses guardrails, compliance, or approval thresholds.

## Evidence-only
The Copilot `trend_explain` intent explains stored market evidence and says so when evidence is thin; it never invents trends, prices or certifications. See [MARKET_INTELLIGENCE.md](MARKET_INTELLIGENCE.md), [ORGANIC_PRODUCTS.md](ORGANIC_PRODUCTS.md).
