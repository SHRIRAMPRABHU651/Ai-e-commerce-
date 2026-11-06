/**
 * Governed agent framework: pure types (no mongoose, no IO). An agent can only do what its spec's tool allowlist
 * permits, every tool call is re-validated and re-authorised in code, and the model never supplies identity.
 */
import type { ZodType } from 'zod';
import type { AgentId, EscalationReason, ToolSideEffect } from '@orvia/types';

export type ActorKind = 'guest' | 'customer' | 'staff' | 'system';

/**
 * Who is running the agent. Built by the API layer from the authenticated session. `userId` and `email` here are the ONLY
 * identity a tool ever sees: tool arguments cannot carry them (schemas are strict) and model output is never consulted.
 */
export interface AuthContext {
  kind: ActorKind;
  /** User id for customer/staff. Undefined for guests and system. */
  userId?: string;
  /** Customer: the verified account email. Guest: an email the visitor typed (unverified; used only for the order-number+email contract). */
  email?: string;
  emailVerified?: boolean;
  role?: string;
  /** Staff permission check (from @orvia/auth `can`). */
  can?: (permission: string) => boolean;
  country: string;
  /** Opaque stable reference for audit (user id, hashed guest session, or 'system'). */
  actorRef: string;
  /** Set ONLY by the confirmation endpoint after it verified the one-time token. Never accepted from request bodies or model output. */
  confirmation?: VerifiedConfirmation;
}

export interface VerifiedConfirmation {
  pendingId: string;
  tool: string;
  argsHash: string;
}

export interface ToolLimits {
  /** Maximum calls to this tool inside one run. */
  maxCallsPerRun: number;
  /** Maximum JSON size of the validated output (bytes); larger results are refused, not truncated silently. */
  maxOutputBytes: number;
  timeoutMs?: number;
}

export interface ToolDef<TIO = unknown, I = never, O = unknown> {
  name: string;
  description: string;
  sideEffect: ToolSideEffect;
  /** Who may call it. Customer tools require an authenticated, email-verified session. */
  audience: ActorKind[];
  /** Staff permission required (checked with auth.can). */
  permission?: string;
  /** Extra gate for `propose` tools that still need an explicit customer confirmation (write_guarded always does). */
  requiresConfirmation?: boolean;
  /** STRICT input schema. Must not contain identity fields (userId/email/customerId). */
  input: ZodType<I>;
  output: ZodType<O>;
  /** Human-readable one-liner shown to the customer when the action waits for confirmation. */
  describe?(input: I): string;
  limits: ToolLimits;
  run(io: TIO, input: I, auth: AuthContext): Promise<O>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool<TIO = any> = ToolDef<TIO, any, any>;

export interface ToolCallRecord {
  tool: string;
  sideEffect: ToolSideEffect | 'unknown';
  argsSummary: string;
  outcome: 'ok' | 'refused' | 'error' | 'awaiting_confirmation';
  reason?: string;
  ms: number;
  outputBytes: number;
}

export type ToolResult =
  | { ok: true; tool: string; data: unknown }
  | { ok: false; tool: string; status: 'refused' | 'error' | 'awaiting_confirmation'; reason: string; pendingId?: string };

export interface PendingConfirmation {
  actionId: string;
  /** One-time token for the UI. NEVER included in anything shown to the model. */
  token: string;
  tool: string;
  summary: string;
  expiresAt: Date;
}

/** Storage side of the executor; implemented by the Mongo adapter and by in-memory fakes in tests. */
export interface PendingPort {
  create(p: { agentId: AgentId; tool: string; args: unknown; argsHash: string; summary: string; auth: AuthContext }): Promise<PendingConfirmation>;
}

export interface ExecDeps<TIO> {
  tools: Map<string, AnyTool<TIO>>;
  io: TIO;
  pending?: PendingPort;
  now: () => Date;
}

export interface RunState {
  agentId: AgentId;
  allow: ReadonlySet<string>;
  maxToolCalls: number;
  totalCalls: number;
  perTool: Map<string, number>;
  calls: ToolCallRecord[];
  pending: PendingConfirmation[];
  flags: Set<string>;
  refusals: number;
}

export const newRunState = (agentId: AgentId, allow: readonly string[], maxToolCalls: number): RunState => ({
  agentId, allow: new Set(allow), maxToolCalls, totalCalls: 0, perTool: new Map(), calls: [], pending: [], flags: new Set(), refusals: 0,
});

export interface GroundingResult {
  ok: boolean;
  violations: string[];
}

export interface Budget {
  perCallTokens: number;
  perDayTokens: number;
  /** Micro-USD (1e-6 USD) per day. An estimate from the configured price table, not a bill. */
  perDayCostMicros: number;
}

export type ToolResults = Map<string, { ok: boolean; data?: unknown; reason?: string }[]>;
export interface PlannedCall {
  tool: string;
  args: unknown;
}

export interface GovSpec<I = unknown, C = unknown, O = unknown> {
  id: AgentId;
  name: string;
  purpose: string;
  audience: 'customer_facing' | 'staff';
  /** Explicit tool allowlist. A tool not listed here is refused even if it exists. */
  tools: readonly string[];
  inputSchema: ZodType<I>;
  /** What the model must produce (it never produces ids, money or identity). */
  composeSchema: ZodType<C>;
  timeoutMs: number;
  maxSteps: number;
  maxToolCalls: number;
  retryLimit: number;
  budget: Budget;
  /** Model ids, cheapest/primary first. With no provider key the chain is unavailable and deterministic templates are used. */
  modelChain: readonly string[];
  minConfidence: number;
  systemPrompt: string;
  /** Text the user/staff typed; scanned for injection and sensitive topics. */
  userText(input: I): string;
  /** Deterministic fast path. Return calls to make (no AI), or null when the model should choose tools. */
  plan(input: I, auth: AuthContext, memory: Record<string, unknown>): PlannedCall[] | null;
  /** Second deterministic phase: calls that depend on the first phase's results (e.g. compare the products a search returned). */
  followUp?(input: I, results: ToolResults, auth: AuthContext, memory: Record<string, unknown>): PlannedCall[];
  /** True when, after the planned calls, a model should take over (e.g. nothing matched). */
  needsModel?(input: I, results: ToolResults): boolean;
  /** Whether the model should compose after tool calls (cost control: assistant fast paths skip it). */
  composeWithModel: boolean;
  /** Deterministic output built only from tool results. Used when no model, on any model failure, and when grounding fails. */
  fallback(input: I, results: ToolResults, auth: AuthContext, memory: Record<string, unknown>): C;
  /** Deterministic grounding check of the model-composed output against the tool results. */
  ground(output: C, results: ToolResults): GroundingResult;
  confidence(output: C): number;
  /** Optional: the composed output asks for a human. */
  wantsHuman?(output: C): boolean;
  /** Build the final, UI-facing output (adds cards etc.) from the composed output + tool results. */
  finalize(composed: C, results: ToolResults, auth: AuthContext): O;
  /** Deterministic escalation reasons regardless of confidence. */
  escalationHints?(input: I, results: ToolResults): EscalationReason[];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyGovSpec = GovSpec<any, any, any>;
