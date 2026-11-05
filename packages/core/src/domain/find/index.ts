import type { Ctx } from '../../infra/context';
import type { ScheduleDef } from '../../infra/queue';
import { runPriceAlerts, runSavedSearchAlerts, snapshotPrices } from './service';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Register this workstream's job handlers (called from registerJobs). All handlers are idempotent (dedupe keys + change-only snapshots). */
export function register_find_Jobs(ctx: Ctx): void {
  ctx.queue.register('find_price_snapshot', async () => snapshotPrices(ctx));
  ctx.queue.register('find_price_alerts', async () => runPriceAlerts(ctx));
  ctx.queue.register('find_saved_search_alerts', async () => runSavedSearchAlerts(ctx));
}

/** Default schedules contributed by this workstream (merged into DEFAULT_SCHEDULES). */
export const FIND_SCHEDULES: (ScheduleDef & { risk: 'low' | 'medium' | 'high' })[] = [
  { name: 'find_price_snapshot', everyMs: DAY, job: 'find_price_snapshot', description: 'Price Guard: snapshot per-country prices of sellable products (only changes, at most daily)', risk: 'low' },
  { name: 'find_price_alerts', everyMs: HOUR, job: 'find_price_alerts', description: 'Price Guard: evaluate price/stock/better-offer alerts and notify the users who created them', risk: 'low' },
  { name: 'find_saved_search_alerts', everyMs: DAY, job: 'find_saved_search_alerts', description: 'Find: notify users of new matches for saved searches they opted in to', risk: 'low' },
];

export { runFind, runImageFind, runCompare, alternativesFor, betterOfferFor, listPresets, getPriceHistory, recordSnapshot, snapshotPrices, runPriceAlerts, runSavedSearchAlerts, invalidateFindCache } from './service';
export { listSavedSearches, createSavedSearch, updateSavedSearch, deleteSavedSearch, listPriceAlerts, alertStatus, createPriceAlert, updatePriceAlert, deletePriceAlert } from './service';
export { parseIntent as parseFindIntent, sanitizeQuery as sanitizeFindQuery } from './intent';
export type { ParsedIntent as FindParsedIntent } from './intent';
export { rankCandidates as rankFindCandidates } from './ranking';
export { buildComparison as buildFindComparison } from './compare';
export { NoopSemanticIndex, TfIdfSemanticIndex } from './semantic';
export type { SemanticIndex } from './semantic';
