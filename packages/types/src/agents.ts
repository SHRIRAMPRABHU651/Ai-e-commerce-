/** agents: shared types and zod schemas for the governed AI agent platform (owned by the agents workstream). */
import { z } from 'zod';
import { countrySchema, objectId } from './schemas';

export const AGENT_IDS = [
  'product_discovery', 'product_intelligence', 'supplier_intelligence', 'customer_advocate', 'shopping_assistant', 'delivery_rescue',
  'returns', 'pricing_intelligence', 'marketing_intelligence', 'finance_analysis', 'trust_analysis',
] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export const agentIdSchema = z.enum(AGENT_IDS);

/** read = no side effect; propose = creates a proposal a human/deterministic engine must decide; write_guarded = executes ONLY through deterministic domain code after explicit confirmation. */
export const TOOL_SIDE_EFFECTS = ['read', 'propose', 'write_guarded'] as const;
export type ToolSideEffect = (typeof TOOL_SIDE_EFFECTS)[number];

export const AGENT_RUN_OUTCOMES = ['success', 'fallback', 'refused', 'error', 'killed', 'budget_stopped', 'escalated', 'awaiting_confirmation'] as const;
export type AgentRunOutcome = (typeof AGENT_RUN_OUTCOMES)[number];

export const ESCALATION_REASONS = [
  'low_confidence', 'sensitive', 'limit_hit', 'tool_refused', 'budget_exhausted', 'customer_requested', 'injection_suspected', 'grounding_failed', 'replacement_request', 'output_invalid', 'complex_case',
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];
export const ESCALATION_STATUSES = ['open', 'resolved'] as const;

export const PENDING_ACTION_STATES = ['pending', 'executing', 'executed', 'cancelled', 'expired', 'failed'] as const;
export const REPLACEMENT_STATES = ['pending', 'approved', 'rejected'] as const;

/** Minimum resolved cases behind a customer-advocate metric before it is shown. */
export const ADVOCATE_MIN_SAMPLE = 30;

/* --------------------------------- requests --------------------------------- */
export const assistantMessageSchema = z.object({
  message: z.string().trim().min(1).max(1000),
  /** Server-issued conversation id (returned by the previous reply). Omit to start a new conversation. */
  sessionId: z.string().regex(/^[a-f\d]{32}$/).optional(),
  country: countrySchema.optional(),
  /** Guest order lookup contract: order number + the email on the order. Never used to bind a signed-in identity. */
  email: z.string().email().max(254).optional(),
  orderNumber: z.string().trim().max(40).optional(),
});
export type AssistantMessageInput = z.infer<typeof assistantMessageSchema>;

export const assistantConfirmSchema = z.object({
  actionId: objectId,
  /** One-time token returned with the pending action. Produced by the server, never by the model. */
  token: z.string().regex(/^[a-f\d]{40,64}$/),
  decision: z.enum(['confirm', 'cancel']),
});
export const assistantRatingSchema = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(500).optional() });
export const advocateRequestSchema = z.object({
  orderNumber: z.string().trim().min(3).max(40),
  problem: z.enum(['delayed', 'damaged', 'missing', 'wrong_item', 'other']),
  details: z.string().trim().max(1000).default(''),
});

export const adminRunSchema = z.object({
  /** Optional focus / question. Treated as data, never as instructions. */
  focus: z.string().trim().max(500).optional(),
  days: z.number().int().min(1).max(180).default(30),
  limit: z.number().int().min(1).max(50).default(10),
  subjectId: objectId.optional(),
});
export type AdminRunInput = z.infer<typeof adminRunSchema>;

export const runsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  agentId: agentIdSchema.optional(),
  outcome: z.enum(AGENT_RUN_OUTCOMES).optional(),
  actorType: z.enum(['guest', 'customer', 'staff', 'system']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export const escalationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(ESCALATION_STATUSES).optional(),
  agentId: agentIdSchema.optional(),
});
export const escalationResolveSchema = z.object({ note: z.string().trim().min(3).max(1000) });
export const killSwitchSchema = z.object({ enabled: z.boolean(), reason: z.string().trim().min(3).max(300) });
export const usageQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(60).default(14) });
export const replacementDecisionSchema = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().min(3).max(500) });
export const replacementQuerySchema = z.object({ status: z.enum(REPLACEMENT_STATES).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });

/* ------------------------- staff agent structured output ------------------------- */
export const staffFindingSchema = z.object({
  title: z.string().min(1).max(160),
  detail: z.string().min(1).max(800),
  severity: z.enum(['info', 'watch', 'attention']).default('info'),
  evidence: z.array(z.string().max(200)).max(6).default([]),
});
export const staffRecommendationSchema = z.object({
  action: z.string().min(1).max(240),
  rationale: z.string().min(1).max(500),
  /** Always true: an agent recommends; a person or a deterministic engine decides. */
  requiresApproval: z.literal(true).default(true),
});
export const staffAgentOutputSchema = z.object({
  summary: z.string().min(1).max(1200),
  findings: z.array(staffFindingSchema).max(12),
  recommendations: z.array(staffRecommendationSchema).max(8),
  confidence: z.number().min(0).max(1),
  dataGaps: z.array(z.string().max(240)).max(8).default([]),
});
export type StaffAgentOutput = z.infer<typeof staffAgentOutputSchema>;

/* ------------------------------ assistant response ------------------------------ */
export type AssistantCard =
  | { type: 'products'; items: { id: string; slug: string; title: string; image: string | null; price: number; currency: string; rating: number | null; inStock: boolean; delivery: string | null; why: string[] }[] }
  | { type: 'order'; orderNumber: string; status: string; total: number | null; currency: string; items: { title: string; quantity: number }[]; shipments: { status: string; carrier: string | null; trackingNumber: string | null; trackingUrl: string | null; estimatedDelivery: string | null }[] }
  | { type: 'orders'; items: { orderNumber: string; status: string; createdAt: string; firstItem: string | null; itemCount: number }[] }
  | { type: 'comparison'; products: string[]; differences: string[]; rows: { label: string; values: (string | null)[] }[] }
  | { type: 'eligibility'; orderNumber: string; eligible: boolean; lines: { sku: string; title: string; eligible: boolean; reasons: string[] }[]; windowDays: number | null }
  | { type: 'refund'; orderNumber: string; headline: string; steps: { label: string; status: string; detail?: string }[] }
  | { type: 'facts'; product: string; facts: { label: string; value: string; provenance: string }[]; missing: string[] }
  | { type: 'resolution'; outcomeId: string | null; recommended: string | null; options: { kind: string; label: string; reason: string; permitted: boolean }[] };

export interface AssistantPending {
  actionId: string;
  token: string;
  tool: string;
  summary: string;
  expiresAt: string;
}
export interface AssistantReply {
  sessionId: string;
  reply: string;
  cards: AssistantCard[];
  pending: AssistantPending[];
  escalated: boolean;
  escalationNote?: string;
  source: 'deterministic' | 'model' | 'template_fallback';
  /** True when an AI model produced or reworded the reply. */
  aiUsed: boolean;
  suggestions: string[];
  identity: 'guest' | 'customer';
}
