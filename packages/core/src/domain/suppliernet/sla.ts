/**
 * Pure SLA computation. The IO layer (performance.ts) gathers raw operational counts from real shipments, disputes,
 * stock checks and health probes; this file turns them into rates and breaches.
 *
 * These are operational FACTS about a supplier, not a reliability/trust score. The `trust` workstream owns scoring and
 * may read `SupplierSlaFacts` (see `toSlaFacts`).
 */
import { slaDefinitionSchema } from '@orvia/types';
import type { SlaDefinition } from '@orvia/types';
import type { SlaWorst } from './gating';

export interface SlaRawFacts {
  windowDays: number;
  /** Shipments assigned to the supplier in the window (excluding rows that never left PENDING_CREATE). */
  assigned: number;
  /** Reached SHIPPED or later. */
  shipped: number;
  /** FAILED (supplier refused / could not fulfil). */
  failed: number;
  /** CANCELLED after assignment (we cannot tell who initiated it; documented). */
  cancelled: number;
  /** Still CREATED beyond the allowed handling time: counted as not fulfilled. */
  overdueUnshipped: number;
  /** Delivered shipments that had an ETA to compare with, and how many arrived by it (+1 day grace). */
  deliveredWithEta: number;
  deliveredOnTime: number;
  /** Delivered shipments (denominator for refund/defect rates). */
  delivered: number;
  refunds: number;
  defects: number;
  /** Stock samples with an observed value, and how many were accurate. */
  stockChecks: number;
  stockAccurate: number;
  /** Smoothed health-probe response time; null when never measured. */
  avgResponseMs: number | null;
}

export interface MetricValue { value: number | null; sample: number }
export interface SlaMetrics {
  fulfilmentRate: MetricValue;
  onTimeRate: MetricValue;
  cancellationRate: MetricValue;
  stockAccuracy: MetricValue;
  refundRate: MetricValue;
  defectRate: MetricValue;
  responseMs: MetricValue;
}

const rate = (num: number, den: number, min: number): MetricValue => ({ value: den >= min ? num / den : null, sample: den });

export function computeSlaMetrics(f: SlaRawFacts, def: SlaDefinition = slaDefinitionSchema.parse({})): SlaMetrics {
  const decided = Math.max(0, f.assigned - f.cancelled); // cancelled orders are judged by cancellationRate, not fulfilment
  return {
    fulfilmentRate: rate(Math.max(0, f.shipped), Math.max(0, decided), def.minSample),
    onTimeRate: rate(f.deliveredOnTime, f.deliveredWithEta, def.minSample),
    cancellationRate: rate(f.cancelled, f.assigned, def.minSample),
    stockAccuracy: rate(f.stockAccurate, f.stockChecks, Math.min(def.minSample, 5)),
    refundRate: rate(f.refunds, f.delivered, def.minSample),
    defectRate: rate(f.defects, f.delivered, def.minSample),
    responseMs: { value: f.avgResponseMs, sample: f.avgResponseMs === null ? 0 : 1 },
  };
}

export interface SlaBreach { metric: keyof SlaMetrics; severity: 'warning' | 'critical'; value: number; target: number; sample: number }

export function evaluateBreaches(m: SlaMetrics, def: SlaDefinition): { breaches: SlaBreach[]; worst: SlaWorst } {
  const out: SlaBreach[] = [];
  const min = (metric: keyof SlaMetrics, target: number) => {
    const v = m[metric];
    if (v.value === null || v.value >= target) return;
    out.push({ metric, severity: target - v.value > def.criticalMargin ? 'critical' : 'warning', value: v.value, target, sample: v.sample });
  };
  const max = (metric: keyof SlaMetrics, target: number, critical: number) => {
    const v = m[metric];
    if (v.value === null || v.value <= target) return;
    out.push({ metric, severity: v.value > critical ? 'critical' : 'warning', value: v.value, target, sample: v.sample });
  };
  min('fulfilmentRate', def.minFulfilmentRate);
  min('onTimeRate', def.minOnTimeRate);
  min('stockAccuracy', def.minStockAccuracy);
  max('cancellationRate', def.maxCancellationRate, def.maxCancellationRate + def.criticalMargin);
  max('refundRate', def.maxRefundRate, def.maxRefundRate + def.criticalMargin);
  max('defectRate', def.maxDefectRate, def.maxDefectRate + def.criticalMargin);
  max('responseMs', def.maxResponseMs, def.maxResponseMs * 2);
  const measured = Object.values(m).some((v) => v.value !== null && v.sample > 0);
  const worst: SlaWorst = out.some((b) => b.severity === 'critical') ? 'critical' : out.length ? 'warning' : measured ? 'ok' : 'insufficient_data';
  return { breaches: out, worst };
}

/** The shape other workstreams (trust) read. Pure and serialisable; `null` means "insufficient data", never zero. */
export interface SupplierSlaFacts {
  supplierId: string;
  computedAt: string | null;
  windowDays: number;
  fulfilmentRate: number | null;
  onTimeRate: number | null;
  cancellationRate: number | null;
  stockAccuracy: number | null;
  refundRate: number | null;
  defectRate: number | null;
  avgResponseMs: number | null;
  samples: { assigned: number; delivered: number; stockChecks: number };
  worst: SlaWorst;
  breaches: { metric: string; severity: string }[];
}

export function toSlaFacts(supplierId: string, snapshot: { computedAt?: Date | string | null; windowDays?: number; metrics?: Partial<SlaMetrics> | null; facts?: Partial<SlaRawFacts> | null; breaches?: { metric: string; severity: string }[]; worst?: SlaWorst } | null): SupplierSlaFacts {
  const m = snapshot?.metrics ?? {};
  const v = (k: keyof SlaMetrics): number | null => m[k]?.value ?? null;
  return {
    supplierId,
    computedAt: snapshot?.computedAt ? new Date(snapshot.computedAt).toISOString() : null,
    windowDays: snapshot?.windowDays ?? 0,
    fulfilmentRate: v('fulfilmentRate'), onTimeRate: v('onTimeRate'), cancellationRate: v('cancellationRate'), stockAccuracy: v('stockAccuracy'),
    refundRate: v('refundRate'), defectRate: v('defectRate'), avgResponseMs: v('responseMs'),
    samples: { assigned: snapshot?.facts?.assigned ?? 0, delivered: snapshot?.facts?.delivered ?? 0, stockChecks: snapshot?.facts?.stockChecks ?? 0 },
    worst: snapshot?.worst ?? 'insufficient_data',
    breaches: (snapshot?.breaches ?? []).map((b) => ({ metric: b.metric, severity: b.severity })),
  };
}

/** A shipment delivered on/before its ETA (+1 day grace) is on time. */
export const deliveredOnTime = (deliveredAt: Date, eta: Date): boolean => deliveredAt.getTime() <= eta.getTime() + 86_400_000;
