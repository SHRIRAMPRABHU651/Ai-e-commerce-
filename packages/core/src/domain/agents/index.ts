import type { Ctx } from '../../infra/context';
import type { ScheduleDef } from '../../infra/queue';
import { agentsMaintenance } from './service';

export * from './framework';
export * from './injection';
export * from './grounding';
export * from './policy';
export * from './executor';
export * from './runner';
export * from './advocate';
export * from './assistant';
export * from './specs';
export * from './service';
export { CUSTOMER_TOOLS } from './tools.customer';
export type { AgentIO } from './tools.customer';
export { STAFF_TOOLS } from './tools.staff';

const DAY = 24 * 3_600_000;

/** Register this workstream's job handlers (called from registerJobs). */
export function register_agents_Jobs(ctx: Ctx): void {
  ctx.queue.register('agents_maintenance', async () => agentsMaintenance(ctx));
}

/** Default schedules contributed by this workstream (merged into DEFAULT_SCHEDULES). */
export const AGENTS_SCHEDULES: (ScheduleDef & { risk: 'low' | 'medium' | 'high' })[] = [
  { name: 'agents_maintenance', everyMs: DAY, job: 'agents_maintenance', description: 'AI agents: expire stale confirmations and delete assistant conversations past their retention (idempotent)', risk: 'low' },
];
