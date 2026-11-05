/** Finance settings and saved scenario assumptions, stored in system_settings (keys `finance`, `finance_model`). */
import { SystemSetting } from '@orvia/database';
import { financeSettingsSchema, scenarioAssumptionsSchema, SCENARIO_NAMES } from '@orvia/types';
import type { FinanceSettings, ScenarioInputSet, ScenarioName } from '@orvia/types';
import { z } from 'zod';
import { audit } from '../../infra/audit';
import { DomainError } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { defaultScenarioSets } from './scenario';

export async function getFinanceSettings(_ctx: Pick<Ctx, 'log'>): Promise<FinanceSettings> {
  const doc = await SystemSetting.findOne({ key: 'finance' }).lean();
  const parsed = financeSettingsSchema.safeParse(doc?.value ?? {});
  return parsed.success ? parsed.data : financeSettingsSchema.parse({});
}

export const financeSettingsPatchSchema = financeSettingsSchema.partial();

export async function updateFinanceSettings(ctx: Ctx, patch: Partial<FinanceSettings>, actor: Actor): Promise<FinanceSettings> {
  const checked = financeSettingsPatchSchema.parse(patch);
  const cur = await getFinanceSettings(ctx);
  const next = financeSettingsSchema.parse({ ...cur, ...checked });
  await SystemSetting.updateOne({ key: 'finance' }, { $set: { value: next, updatedBy: actor.id } }, { upsert: true });
  await audit(ctx, actor, { action: 'finance.settings.updated', resource: 'finance_settings', previousValue: cur, newValue: next, reason: 'finance assumptions edited' });
  return next;
}

/** Grant (or clear) the admin override that lets production price from expired FX rates, for at most 24 hours. */
export async function setFxOverride(ctx: Ctx, hours: number | null, actor: Actor, reason: string): Promise<FinanceSettings> {
  if (hours !== null && (hours <= 0 || hours > 24)) throw new DomainError('FX override must be between 1 and 24 hours', 'INVALID', 422);
  const until = hours === null ? null : new Date(ctx.now().getTime() + hours * 3_600_000).toISOString();
  const cur = await getFinanceSettings(ctx);
  const next = financeSettingsSchema.parse({ ...cur, fxOverrideUntil: until });
  await SystemSetting.updateOne({ key: 'finance' }, { $set: { value: next, updatedBy: actor.id } }, { upsert: true });
  await audit(ctx, actor, { action: 'finance.fx.override', resource: 'finance_settings', previousValue: { fxOverrideUntil: cur.fxOverrideUntil }, newValue: { fxOverrideUntil: until }, reason });
  return next;
}

/* ----------------------------- scenario assumptions ----------------------------- */

export const scenarioSetSchema = z.object({
  assumptions: scenarioAssumptionsSchema,
  provenance: z.record(z.string(), z.enum(['placeholder', 'admin', 'measured'])).default({}),
});
export const scenarioSetsSchema = z.object({ conservative: scenarioSetSchema, base: scenarioSetSchema, aggressive: scenarioSetSchema });

export async function getScenarioSets(): Promise<{ sets: Record<ScenarioName, ScenarioInputSet>; saved: boolean }> {
  const doc = await SystemSetting.findOne({ key: 'finance_model' }).lean();
  const parsed = scenarioSetsSchema.safeParse(doc?.value);
  if (!parsed.success) return { sets: defaultScenarioSets(), saved: false };
  return { sets: parsed.data as Record<ScenarioName, ScenarioInputSet>, saved: true };
}

/** Save assumptions. Any field whose value differs from the stored one is marked `admin` provenance. Audited. */
export async function saveScenarioSets(ctx: Ctx, incoming: Record<ScenarioName, { assumptions: unknown }>, actor: Actor): Promise<Record<ScenarioName, ScenarioInputSet>> {
  const { sets: cur } = await getScenarioSets();
  const next = {} as Record<ScenarioName, ScenarioInputSet>;
  for (const n of SCENARIO_NAMES) {
    const a = scenarioAssumptionsSchema.parse(incoming[n].assumptions);
    const prov = { ...cur[n].provenance };
    for (const k of Object.keys(a) as (keyof typeof a)[]) if (a[k] !== cur[n].assumptions[k]) prov[k] = 'admin';
    next[n] = { assumptions: a, provenance: prov };
  }
  await SystemSetting.updateOne({ key: 'finance_model' }, { $set: { value: next, updatedBy: actor.id } }, { upsert: true });
  await audit(ctx, actor, { action: 'finance.model.updated', resource: 'finance_model', previousValue: Object.fromEntries(SCENARIO_NAMES.map((n) => [n, cur[n].assumptions])), newValue: Object.fromEntries(SCENARIO_NAMES.map((n) => [n, next[n].assumptions])), reason: 'objective-model assumptions edited' });
  return next;
}
