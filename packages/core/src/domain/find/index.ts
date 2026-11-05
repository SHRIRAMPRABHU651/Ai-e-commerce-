import type { Ctx } from '../../infra/context';
import type { ScheduleDef } from '../../infra/queue';

/** Register this workstream's job handlers (called from registerJobs). */
export function register_find_Jobs(_ctx: Ctx): void {}

/** Default schedules contributed by this workstream (merged into DEFAULT_SCHEDULES). */
export const FIND_SCHEDULES: (ScheduleDef & { risk: 'low' | 'medium' | 'high' })[] = [];
