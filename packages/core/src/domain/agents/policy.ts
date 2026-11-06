/** Pure policy helpers for agents: budgets/cost, escalation triggers, sensitive-topic detection, confirmation tokens, caching keys. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { EscalationReason } from '@orvia/types';
import type { Budget } from './framework';

/* ----------------------------------- budget ----------------------------------- */
/** Rough token estimate (≈4 chars/token). The provider layer does not return usage, so budgets use this estimate. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * USD per 1M tokens (input, output). Configured estimates for budgeting, NOT a billing source.
 * Unknown models use the conservative DEFAULT so a budget can never be under-counted for a priced-up model.
 */
export const MODEL_PRICES_USD_PER_MTOK: Record<string, { in: number; out: number }> = {
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'gemini-2.5-flash-lite': { in: 0.1, out: 0.4 },
  'gemini-2.5-pro': { in: 1.25, out: 10 },
};
export const DEFAULT_MODEL_PRICE = { in: 1.25, out: 10 };

export function costMicros(model: string, tokensIn: number, tokensOut: number): number {
  const p = MODEL_PRICES_USD_PER_MTOK[model] ?? DEFAULT_MODEL_PRICE;
  // USD per Mtok == micro-USD per token
  return Math.ceil(tokensIn * p.in + tokensOut * p.out);
}

export interface Usage {
  tokens: number;
  costMicros: number;
}
export type BudgetVerdict = { ok: true } | { ok: false; reason: 'per_call' | 'daily_tokens' | 'daily_cost' };

/** Decide whether a model call that is projected to use `projectedTokens` may start. Hard stop: no call when it would exceed any limit. */
export function checkBudget(b: Budget, usedToday: Usage, usedThisCall: Usage, projectedTokens: number, projectedCostMicros: number): BudgetVerdict {
  if (usedThisCall.tokens + projectedTokens > b.perCallTokens) return { ok: false, reason: 'per_call' };
  if (usedToday.tokens + usedThisCall.tokens + projectedTokens > b.perDayTokens) return { ok: false, reason: 'daily_tokens' };
  if (usedToday.costMicros + usedThisCall.costMicros + projectedCostMicros > b.perDayCostMicros) return { ok: false, reason: 'daily_cost' };
  return { ok: true };
}

export const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

/* ---------------------------------- escalation ---------------------------------- */
const SENSITIVE: { id: string; re: RegExp }[] = [
  { id: 'legal', re: /\b(lawyer|attorney|sue\b|suing|lawsuit|legal action|court|small claims|consumer protection|trading standards|ombudsman)\b/i },
  { id: 'fraud_dispute', re: /\b(fraud(?:ulent)?|scam(?:med)?|stolen|unauthori[sz]ed (?:charge|payment|transaction)|identity theft|hacked|chargeback|dispute (?:the )?charge)\b/i },
  { id: 'safety', re: /\b(fire|caught fire|burn(?:t|ed|ing)?|smok(?:e|ing)|overheat(?:ed|ing)?|explod|electric shock|injur(?:y|ed)|hospital|choking|allergic reaction|poison|toxic|recall)\b/i },
  { id: 'medical', re: /\b(medical|doctor|medication|prescription|diagnos|pregnan|infant|rash|skin reaction)\b/i },
  { id: 'privacy_rights', re: /\b(gdpr|ccpa|delete my (?:data|account)|data deletion|erase my|right to be forgotten|subject access)\b/i },
  { id: 'harassment', re: /\b(threat(?:en|s)?|harass|abus(?:e|ive)|discriminat|racist|self[- ]harm|suicid)\b/i },
  { id: 'human_requested', re: /\b(human|real person|live agent|speak to (?:a |an )?(?:person|someone|agent|manager)|talk to (?:a |an )?(?:person|someone|agent|manager)|customer service rep|representative|supervisor|manager)\b/i },
];
export interface SensitiveScan {
  sensitive: boolean;
  humanRequested: boolean;
  topics: string[];
}
export function detectSensitive(text: string): SensitiveScan {
  const topics = SENSITIVE.filter((s) => s.re.test(text)).map((s) => s.id);
  const humanRequested = topics.includes('human_requested');
  return { sensitive: topics.some((t) => t !== 'human_requested'), humanRequested, topics };
}

export interface EscalationSignals {
  confidence?: number;
  minConfidence: number;
  sensitive: boolean;
  humanRequested: boolean;
  limitHit: boolean;
  toolRefused: boolean;
  budgetExhausted: boolean;
  groundingFailed: boolean;
  outputInvalid: boolean;
  modelWantsHuman: boolean;
  injectionAttemptedAction: boolean;
}
/** Which human-queue reasons apply to a run. Pure so the triggers are unit-testable. */
export function escalationReasons(s: EscalationSignals): EscalationReason[] {
  const out: EscalationReason[] = [];
  if (s.humanRequested) out.push('customer_requested');
  if (s.sensitive) out.push('sensitive');
  if (s.limitHit) out.push('limit_hit');
  if (s.toolRefused) out.push('tool_refused');
  if (s.budgetExhausted) out.push('budget_exhausted');
  if (s.groundingFailed) out.push('grounding_failed');
  if (s.outputInvalid) out.push('output_invalid');
  if (s.modelWantsHuman) out.push('complex_case');
  if (s.injectionAttemptedAction) out.push('injection_suspected');
  if (s.confidence !== undefined && s.confidence < s.minConfidence) out.push('low_confidence');
  return [...new Set(out)];
}

/* -------------------------------- confirmation tokens -------------------------------- */
const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
};
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const argsHash = (tool: string, args: unknown): string => sha256(`${tool}:${stable(args)}`);

export interface ConfirmationClaims {
  pendingId: string;
  userId: string;
  tool: string;
  argsHash: string;
  expiresAt: Date;
}
/** One-time confirmation token bound to the user, tool and exact arguments. Produced by the server for the UI; the model never sees it. */
export function signConfirmation(secret: string, c: ConfirmationClaims): string {
  return createHmac('sha256', secret).update(`agents-confirm|${c.pendingId}|${c.userId}|${c.tool}|${c.argsHash}|${c.expiresAt.getTime()}`).digest('hex').slice(0, 48);
}
export function verifyConfirmation(secret: string, token: string, c: ConfirmationClaims, now: Date): { ok: true } | { ok: false; reason: 'expired' | 'mismatch' } {
  if (now.getTime() > c.expiresAt.getTime()) return { ok: false, reason: 'expired' };
  const want = Buffer.from(signConfirmation(secret, c));
  const got = Buffer.from(token);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}
export const tokenHash = (token: string): string => sha256(`agents-token:${token}`);

/* ----------------------------------- cache ----------------------------------- */
/** Small TTL cache for identical model prompts. Keys are hashes of the full prompt (which embeds user-scoped tool data), so entries never cross users. */
export class TtlCache<T> {
  private m = new Map<string, { at: number; v: T }>();
  constructor(private readonly ttlMs: number, private readonly max = 500) {}
  get(k: string, now = Date.now()): T | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (now - e.at > this.ttlMs) { this.m.delete(k); return undefined; }
    return e.v;
  }
  set(k: string, v: T, now = Date.now()): void {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
    this.m.set(k, { at: now, v });
  }
  get size(): number { return this.m.size; }
}
