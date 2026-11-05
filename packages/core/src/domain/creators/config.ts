import { CreatorProgramConfig } from '@orvia/database';
import { DEFAULT_COMMISSION_RULES, DEFAULT_LOYALTY_RULES, commissionRulesSchema, loyaltyRulesSchema } from '@orvia/types';
import type { CommissionRules, LoyaltyRules } from '@orvia/types';
import { DomainError } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { audit } from '../../infra/audit';
import { hashSignal } from './fraudRules';

const KEY = 'default';

/** Effective commission rules: stored overrides validated through zod, falling back to code defaults on absence or corruption. */
export async function getRules(): Promise<CommissionRules> {
  const doc = await CreatorProgramConfig.findOne({ key: KEY }).select('rules').lean();
  if (!doc?.rules) return DEFAULT_COMMISSION_RULES;
  const r = commissionRulesSchema.safeParse(doc.rules);
  return r.success ? r.data : DEFAULT_COMMISSION_RULES;
}
export async function getLoyaltyRules(): Promise<LoyaltyRules> {
  const doc = await CreatorProgramConfig.findOne({ key: KEY }).select('loyalty').lean();
  if (!doc?.loyalty) return DEFAULT_LOYALTY_RULES;
  const r = loyaltyRulesSchema.safeParse(doc.loyalty);
  return r.success ? r.data : DEFAULT_LOYALTY_RULES;
}

export async function setRules(ctx: Ctx, actor: Actor, input: unknown, which: 'rules' | 'loyalty' = 'rules'): Promise<CommissionRules | LoyaltyRules> {
  const parsed = (which === 'rules' ? commissionRulesSchema : loyaltyRulesSchema).safeParse(input);
  if (!parsed.success) throw new DomainError('Invalid rules', 'VALIDATION', 400, parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const prev = which === 'rules' ? await getRules() : await getLoyaltyRules();
  await CreatorProgramConfig.updateOne({ key: KEY }, { $set: { [which]: parsed.data, updatedBy: actor.id }, $setOnInsert: { key: KEY } }, { upsert: true });
  await audit(ctx, actor, { action: which === 'rules' ? 'creators.rules_updated' : 'loyalty.rules_updated', resource: 'creator_program', resourceId: KEY, previousValue: prev, newValue: parsed.data });
  return parsed.data;
}

/** Salted hash of a network/device signal. Raw values are never stored in creator tables. */
export const hashIp = (ctx: Ctx, ip: string | undefined): string | undefined => (ip ? hashSignal(ctx.cfg.JWT_SECRET, 'ip', ip) : undefined);
export const hashDevice = (ctx: Ctx, ua: string | undefined, lang: string | undefined): string | undefined => (ua ? hashSignal(ctx.cfg.JWT_SECRET, 'dev', `${ua}|${lang ?? ''}`) : undefined);
