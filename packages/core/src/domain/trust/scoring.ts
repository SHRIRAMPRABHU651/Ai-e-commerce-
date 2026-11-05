/**
 * TrustGraph scoring: pure functions over aggregated, already-collected inputs (no IO, no mongoose).
 * See docs/ORVIA_TRUSTGRAPH.md for the model, formulas and thresholds.
 *
 * Chain: Product -> Manufacturer -> Supplier -> Order -> Shipment -> Delivery -> Feedback -> Return -> Refund.
 */
import type { ProductRiskResult, RiskLevel, SupplierTrustResult, TrustComponent, TrustEvidenceRef, TrustStatus } from '@orvia/types';
import { COMPONENT_PRIORS, TRUST_THRESHOLDS, dataConfidence, freshness, round3, scoreRange, shrunkRate, statusFor } from './stats';

type ComponentKey = keyof typeof COMPONENT_PRIORS;

/* ------------------------------ supplier ------------------------------ */

export interface SupplierTrustInputs {
  now: Date;
  /** Destination country this slice is scoped to; null = all destinations. */
  destination: string | null;
  shipments: { resolved: number; delivered: number; failed: number; cancelled: number; returned: number };
  /** Delivered shipments that had a promised ETA: how many arrived on or before it (plus grace). */
  onTime: { eligible: number; onTime: number };
  /** Orders attributed to the supplier and how many hit a stock-related problem (STALE_STOCK exceptions, stock failures). */
  stock: { orders: number; issues: number };
  returns: { delivered: number; returns: number; defects: number };
  refunds: { count: number; medianHours: number | null };
  satisfaction: { ratings: number; positive: number };
  disputes: { orders: number; disputes: number };
  /** Offer data freshness: newest sync/confirmation across the supplier's offers. */
  offers: { count: number; newestSyncAt: Date | null; availableCount: number };
  /** Hierarchical priors (e.g. the supplier's global component values when scoring one destination). */
  priors?: Partial<Record<ComponentKey, number>>;
}

export const SUPPLIER_WEIGHTS = {
  fulfilment_success: 0.2,
  on_time_delivery: 0.2,
  cancellation: 0.08,
  stock_accuracy: 0.08,
  defect: 0.12,
  return: 0.08,
  refund_response: 0.06,
  satisfaction: 0.1,
  dispute: 0.05,
  data_freshness: 0.03,
} as const;

/** Half-life (hours) of supplier offer data freshness. */
export const OFFER_FRESHNESS_HALF_LIFE_H = 72;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const ev = (label: string, value: string, provenance: TrustEvidenceRef['provenance'], source: string, observedAt?: Date | null): TrustEvidenceRef => ({ label, value, provenance, source, observedAt: observedAt ? observedAt.toISOString() : null });
const SRC_TX = 'Orvia order, shipment and return records';

function rateComponent(key: ComponentKey, label: string, successes: number, n: number, weight: number, priors: SupplierTrustInputs['priors'], evidence: TrustEvidenceRef[], note?: string): TrustComponent {
  const prior = priors?.[key] ?? COMPONENT_PRIORS[key];
  if (n <= 0) return { key, label, value: null, observed: null, sampleSize: 0, confidence: 0, weight, evidence, note: note ?? 'No observations yet' };
  return { key, label, value: round3(shrunkRate(successes, n, prior)), observed: round3(successes / n), sampleSize: n, confidence: round3(dataConfidence(n)), weight, evidence, note };
}

export function scoreSupplierTrust(i: SupplierTrustInputs): SupplierTrustResult {
  const sh = i.shipments;
  const fulfilN = sh.delivered + sh.returned + sh.failed;
  const comps: TrustComponent[] = [];
  comps.push(rateComponent('fulfilment_success', 'Fulfilment success', sh.delivered + sh.returned, fulfilN, SUPPLIER_WEIGHTS.fulfilment_success, i.priors, [ev('Shipments delivered', `${sh.delivered + sh.returned} of ${fulfilN} resolved`, 'verified', SRC_TX)]));
  comps.push(rateComponent('on_time_delivery', 'On-time delivery vs promised ETA', i.onTime.onTime, i.onTime.eligible, SUPPLIER_WEIGHTS.on_time_delivery, i.priors, [ev('Arrived within promised window', `${i.onTime.onTime} of ${i.onTime.eligible} deliveries with an ETA`, 'verified', SRC_TX)]));
  comps.push(rateComponent('cancellation', 'Low cancellation rate', Math.max(0, sh.resolved - sh.cancelled), sh.resolved, SUPPLIER_WEIGHTS.cancellation, i.priors, [ev('Cancelled shipments', `${sh.cancelled} of ${sh.resolved} resolved`, 'verified', SRC_TX)]));
  comps.push(rateComponent('stock_accuracy', 'Stock accuracy', Math.max(0, i.stock.orders - i.stock.issues), i.stock.orders, SUPPLIER_WEIGHTS.stock_accuracy, i.priors, [ev('Orders with a stock problem', `${i.stock.issues} of ${i.stock.orders}`, 'verified', SRC_TX)]));
  comps.push(rateComponent('defect', 'Low defect rate', Math.max(0, i.returns.delivered - i.returns.defects), i.returns.delivered, SUPPLIER_WEIGHTS.defect, i.priors, [ev('Defect / damaged / not-as-described returns', `${i.returns.defects} of ${i.returns.delivered} delivered`, 'customer_reported', 'Customer return requests')]));
  comps.push(rateComponent('return', 'Low return rate', Math.max(0, i.returns.delivered - i.returns.returns), i.returns.delivered, SUPPLIER_WEIGHTS.return, i.priors, [ev('Returns requested', `${i.returns.returns} of ${i.returns.delivered} delivered`, 'customer_reported', 'Customer return requests')]));
  // Refund response: 0.5 at 72h. Treated as a mean of per-refund scores, shrunk like a rate.
  if (i.refunds.count > 0 && i.refunds.medianHours !== null) {
    const obs = Math.pow(0.5, Math.max(0, i.refunds.medianHours) / 72);
    const prior = i.priors?.refund_response ?? COMPONENT_PRIORS.refund_response;
    comps.push({ key: 'refund_response', label: 'Refund response time', value: round3(shrunkRate(obs * i.refunds.count, i.refunds.count, prior)), observed: round3(obs), sampleSize: i.refunds.count, confidence: round3(dataConfidence(i.refunds.count)), weight: SUPPLIER_WEIGHTS.refund_response, evidence: [ev('Median time to refund', `${Math.round(i.refunds.medianHours)}h over ${i.refunds.count} refunds`, 'verified', SRC_TX)] });
  } else comps.push({ key: 'refund_response', label: 'Refund response time', value: null, observed: null, sampleSize: 0, confidence: 0, weight: SUPPLIER_WEIGHTS.refund_response, evidence: [], note: 'No refunds yet' });
  comps.push(rateComponent('satisfaction', 'Customer satisfaction', i.satisfaction.positive, i.satisfaction.ratings, SUPPLIER_WEIGHTS.satisfaction, i.priors, [ev('Reviews rated 4-5 stars', `${i.satisfaction.positive} of ${i.satisfaction.ratings}`, 'customer_reported', 'Published customer reviews')]));
  comps.push(rateComponent('dispute', 'Dispute history', Math.max(0, i.disputes.orders - i.disputes.disputes), i.disputes.orders, SUPPLIER_WEIGHTS.dispute, i.priors, [ev('Orders with a chargeback, safety or authenticity case', `${i.disputes.disputes} of ${i.disputes.orders}`, 'verified', 'Orvia exception log')]));

  // Data freshness: how recently the supplier's offer data was refreshed. Not a sampled rate.
  const fresh = i.offers.count > 0 && i.offers.newestSyncAt ? freshness(i.offers.newestSyncAt, i.now, OFFER_FRESHNESS_HALF_LIFE_H) : null;
  comps.push({
    key: 'data_freshness', label: 'Offer data freshness', value: fresh === null ? null : round3(fresh), observed: fresh === null ? null : round3(fresh), sampleSize: i.offers.count, confidence: fresh === null ? 0 : 1, weight: SUPPLIER_WEIGHTS.data_freshness,
    evidence: i.offers.count ? [ev('Newest offer sync', i.offers.newestSyncAt ? i.offers.newestSyncAt.toISOString() : 'never', 'supplier_provided', 'Supplier feed', i.offers.newestSyncAt)] : [],
    note: i.offers.count ? undefined : 'No offers for this destination',
  });

  const withData = comps.filter((c) => c.value !== null);
  const wData = withData.reduce((a, c) => a + c.weight, 0);
  const wAll = comps.reduce((a, c) => a + c.weight, 0);
  const raw = wData > 0 ? withData.reduce((a, c) => a + (c.value as number) * c.weight, 0) / wData : null;
  const confidence = round3(comps.reduce((a, c) => a + c.weight * c.confidence, 0) / wAll);
  const stale = fresh !== null && i.offers.newestSyncAt !== null && (i.now.getTime() - i.offers.newestSyncAt.getTime()) / 3_600_000 > TRUST_THRESHOLDS.staleAfterHours;
  const status: TrustStatus = raw === null ? 'insufficient_data' : statusFor(sh.resolved, confidence, { stale });
  const score = status === 'insufficient_data' || raw === null ? null : Math.round(raw * 1000) / 10;

  const known: string[] = [];
  if (sh.resolved > 0) known.push(`${sh.resolved} resolved shipment${sh.resolved === 1 ? '' : 's'}: ${sh.delivered} delivered, ${sh.failed} failed, ${sh.cancelled} cancelled${sh.returned ? `, ${sh.returned} returned` : ''}`);
  else known.push('No completed shipments yet');
  if (i.onTime.eligible > 0) known.push(`${i.onTime.onTime} of ${i.onTime.eligible} deliveries arrived within the promised window`);
  if (i.offers.count > 0) known.push(`${i.offers.availableCount} of ${i.offers.count} offers currently available${i.offers.newestSyncAt ? `, last refreshed ${i.offers.newestSyncAt.toISOString().slice(0, 10)}` : ''}`);
  const caveats: string[] = [];
  if (status === 'insufficient_data') caveats.push(`Not enough delivery history yet (fewer than ${TRUST_THRESHOLDS.minProvisional} resolved shipments); no score is shown.`);
  if (status === 'provisional') caveats.push(`Provisional: based on ${sh.resolved} resolved shipments; established needs ${TRUST_THRESHOLDS.minEstablished}+ and sufficient coverage.`);
  if (stale) caveats.push('Supplier offer data is stale, so this score cannot be marked established.');
  if (i.destination) caveats.push(`Scoped to deliveries to ${i.destination}; missing evidence falls back toward the supplier's overall performance.`);
  const missing = comps.filter((c) => c.value === null).map((c) => c.label.toLowerCase());
  if (missing.length && status !== 'insufficient_data') caveats.push(`No data yet for: ${missing.join(', ')}.`);

  return { score, range: score === null ? null : scoreRange(score, sh.resolved), status, confidence, sampleSize: sh.resolved, components: comps, caveats, known, freshness: fresh === null ? null : round3(fresh), destination: i.destination };
}

/** Component values to use as priors when scoring a destination slice (hierarchical shrinkage). */
export function priorsFromGlobal(global: SupplierTrustResult): Partial<Record<ComponentKey, number>> {
  const out: Partial<Record<ComponentKey, number>> = {};
  for (const c of global.components) if (c.value !== null && c.key in COMPONENT_PRIORS) out[c.key as ComponentKey] = c.value;
  return out;
}

/* ------------------------------ product risk ------------------------------ */

export interface ProductRiskInputs {
  now: Date;
  destination: string | null;
  /** Checklist of customer-relevant product facts and how well each is evidenced. */
  evidence: { key: string; label: string; present: boolean; provenance: 'verified' | 'supplier_provided' | 'customer_reported' | 'ai_suggested' | null }[];
  compliance: { status: 'pending' | 'passed' | 'failed' | 'review'; flags: string[] };
  /** Reliability of suppliers that can serve this product/destination. */
  suppliers: { name: string; score: number | null; status: TrustStatus; confidence: number; sampleSize: number }[];
  shipping: { resolved: number; delivered: number; failed: number; onTimeEligible: number; onTime: number };
  feedback: { ratings: number; positive: number; delivered: number; returns: number; defects: number };
  restrictions: { restricted: boolean; reasons: string[] };
}

export const RISK_WEIGHTS = { evidence_completeness: 0.2, compliance: 0.25, supplier_reliability: 0.2, shipping_history: 0.15, feedback: 0.15, destination: 0.05 } as const;

/** Evidence completeness: verified facts count fully, supplier-provided at 0.6, AI/customer 0.2, absent 0. */
export const EVIDENCE_CREDIT = { verified: 1, supplier_provided: 0.6, customer_reported: 0.3, ai_suggested: 0.2 } as const;

export function scoreProductRisk(i: ProductRiskInputs): ProductRiskResult {
  const comps: TrustComponent[] = [];

  const credit = i.evidence.reduce((a, e) => a + (e.present && e.provenance ? EVIDENCE_CREDIT[e.provenance] : 0), 0);
  const completeness = i.evidence.length ? credit / i.evidence.length : 0;
  const verifiedN = i.evidence.filter((e) => e.present && e.provenance === 'verified').length;
  comps.push({
    key: 'evidence_completeness', label: 'Product evidence completeness', value: round3(completeness), observed: round3(completeness), sampleSize: i.evidence.length, confidence: 1, weight: RISK_WEIGHTS.evidence_completeness,
    evidence: i.evidence.map((e) => ev(e.label, e.present ? 'present' : 'missing', e.provenance ?? 'supplier_provided', e.present ? 'Product record' : 'Not provided')),
    note: `${verifiedN} of ${i.evidence.length} facts independently verified`,
  });

  const cStatus = i.compliance.status;
  const cGood = cStatus === 'passed' ? Math.max(0.4, 1 - 0.15 * i.compliance.flags.length) : cStatus === 'failed' ? 0 : cStatus === 'review' ? 0.35 : 0.5;
  comps.push({
    key: 'compliance', label: 'Compliance checks', value: round3(cGood), observed: round3(cGood), sampleSize: 1, confidence: 1, weight: RISK_WEIGHTS.compliance,
    evidence: [ev('Automated compliance screen', cStatus, 'verified', 'Orvia compliance engine'), ...i.compliance.flags.slice(0, 8).map((f) => ev('Flag', f, 'verified', 'Orvia compliance engine'))],
    note: cStatus === 'pending' ? 'Not yet screened' : 'An automated screen is not a certification',
  });

  const known = i.suppliers.filter((s) => s.score !== null);
  if (i.suppliers.length === 0) comps.push({ key: 'supplier_reliability', label: 'Supplier reliability', value: null, observed: null, sampleSize: 0, confidence: 0, weight: RISK_WEIGHTS.supplier_reliability, evidence: [], note: 'No supplier offers for this destination' });
  else if (!known.length) comps.push({ key: 'supplier_reliability', label: 'Supplier reliability', value: null, observed: null, sampleSize: 0, confidence: 0, weight: RISK_WEIGHTS.supplier_reliability, evidence: i.suppliers.map((s) => ev(s.name, 'Not enough delivery history yet', 'verified', 'TrustGraph')), note: 'Serving suppliers have no scored history yet' });
  else {
    // Weakest known supplier bounds the risk: the order could be routed to any of them.
    const worst = Math.min(...known.map((s) => (s.score as number) / 100));
    const conf = Math.min(...known.map((s) => s.confidence));
    comps.push({ key: 'supplier_reliability', label: 'Supplier reliability', value: round3(worst), observed: round3(worst), sampleSize: Math.min(...known.map((s) => s.sampleSize)), confidence: round3(conf), weight: RISK_WEIGHTS.supplier_reliability, evidence: i.suppliers.map((s) => ev(s.name, s.score === null ? 'Not enough history' : `${Math.round(s.score)}/100 (${s.status})`, 'verified', 'TrustGraph')), note: 'Uses the weakest scored supplier that could fulfil this product' });
  }

  const ship = i.shipping;
  const shipPrior = 0.85;
  const shipN = ship.delivered + ship.failed;
  if (shipN > 0) {
    const success = shrunkRate(ship.delivered, shipN, shipPrior);
    const ot = i.shipping.onTimeEligible > 0 ? shrunkRate(ship.onTime, ship.onTimeEligible, COMPONENT_PRIORS.on_time_delivery) : null;
    const v = ot === null ? success : (success + ot) / 2;
    comps.push({ key: 'shipping_history', label: 'Shipping history for this product', value: round3(v), observed: round3(ship.delivered / shipN), sampleSize: shipN, confidence: round3(dataConfidence(shipN)), weight: RISK_WEIGHTS.shipping_history, evidence: [ev('Delivered', `${ship.delivered} of ${shipN} resolved`, 'verified', SRC_TX), ...(ship.onTimeEligible ? [ev('On time', `${ship.onTime} of ${ship.onTimeEligible}`, 'verified', SRC_TX)] : [])] });
  } else comps.push({ key: 'shipping_history', label: 'Shipping history for this product', value: null, observed: null, sampleSize: 0, confidence: 0, weight: RISK_WEIGHTS.shipping_history, evidence: [], note: 'This product has not shipped yet' });

  const f = i.feedback;
  const fbN = f.ratings + f.delivered;
  if (fbN > 0) {
    const parts: { v: number; n: number }[] = [];
    if (f.ratings > 0) parts.push({ v: shrunkRate(f.positive, f.ratings, COMPONENT_PRIORS.satisfaction), n: f.ratings });
    if (f.delivered > 0) {
      parts.push({ v: shrunkRate(Math.max(0, f.delivered - f.returns), f.delivered, COMPONENT_PRIORS.return), n: f.delivered });
      parts.push({ v: shrunkRate(Math.max(0, f.delivered - f.defects), f.delivered, COMPONENT_PRIORS.defect), n: f.delivered });
    }
    const tot = parts.reduce((a, p) => a + p.n, 0);
    const v = parts.reduce((a, p) => a + p.v * p.n, 0) / tot;
    comps.push({ key: 'feedback', label: 'Customer feedback, returns and defects', value: round3(v), observed: null, sampleSize: Math.max(f.ratings, f.delivered), confidence: round3(dataConfidence(Math.max(f.ratings, f.delivered))), weight: RISK_WEIGHTS.feedback, evidence: [ev('Reviews rated 4-5 stars', `${f.positive} of ${f.ratings}`, 'customer_reported', 'Published customer reviews'), ev('Returns / defects', `${f.returns} returns, ${f.defects} defects of ${f.delivered} delivered`, 'customer_reported', 'Customer return requests')] });
  } else comps.push({ key: 'feedback', label: 'Customer feedback, returns and defects', value: null, observed: null, sampleSize: 0, confidence: 0, weight: RISK_WEIGHTS.feedback, evidence: [], note: 'No feedback yet' });

  comps.push({
    key: 'destination', label: 'Destination restrictions', value: i.restrictions.restricted ? 0 : 1, observed: i.restrictions.restricted ? 0 : 1, sampleSize: 1, confidence: 1, weight: RISK_WEIGHTS.destination,
    evidence: i.restrictions.reasons.length ? i.restrictions.reasons.map((r) => ev('Restriction', r, 'verified', 'Orvia compliance / export gate')) : [ev('Restrictions', 'none recorded', 'verified', 'Orvia compliance / export gate')],
  });

  const withData = comps.filter((c) => c.value !== null);
  const wData = withData.reduce((a, c) => a + c.weight, 0);
  const good = wData ? withData.reduce((a, c) => a + (c.value as number) * c.weight, 0) / wData : null;
  const confidence = round3(comps.reduce((a, c) => a + c.weight * c.confidence, 0) / comps.reduce((a, c) => a + c.weight, 0));
  const txN = ship.delivered + ship.failed + f.ratings;
  const supplierKnown = known.length > 0;

  let status: TrustStatus;
  if (good === null) status = 'insufficient_data';
  else if (txN < TRUST_THRESHOLDS.minProvisional && !supplierKnown) status = 'insufficient_data';
  else if (txN >= 20 && supplierKnown && confidence >= TRUST_THRESHOLDS.minEstablishedConfidence) status = 'established';
  else status = 'provisional';

  const risk = good === null ? null : Math.round((1 - good) * 1000) / 10;
  const score = status === 'insufficient_data' ? null : risk;
  const hard = i.restrictions.restricted || i.compliance.status === 'failed';
  const level: RiskLevel = hard ? 'high' : score === null ? 'unknown' : score < 25 ? 'low' : score < 50 ? 'medium' : 'high';

  const knownLines: string[] = [`${verifiedN} of ${i.evidence.length} product facts are independently verified`, `Compliance screen: ${cStatus}`];
  if (txN > 0) knownLines.push(`${ship.delivered} delivered and ${f.ratings} reviewed order${txN === 1 ? '' : 's'} on record for this product`);
  else knownLines.push('No delivery or review history for this product yet');
  if (i.restrictions.restricted) knownLines.push(...i.restrictions.reasons);
  const caveats: string[] = [];
  if (status === 'insufficient_data') caveats.push('Not enough delivery history yet to compute a risk score; the facts above are what is known.');
  if (status === 'provisional') caveats.push('Provisional: limited transaction history; the risk score will sharpen as orders complete.');
  if (!supplierKnown && i.suppliers.length) caveats.push('Serving suppliers do not have enough history to be scored.');

  return { score, range: score === null ? null : scoreRange(score, txN), status, confidence, sampleSize: txN, components: comps, caveats, known: knownLines, level, destination: i.destination, restricted: i.restrictions.restricted };
}
