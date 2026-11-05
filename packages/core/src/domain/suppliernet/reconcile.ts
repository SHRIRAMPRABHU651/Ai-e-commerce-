/**
 * Pure supplier invoice/statement reconciliation: statement lines vs the supplier order costs ORVIA recorded.
 * Record-only: nothing here moves money. Differences are flagged for a human; settlement is a recorded fact.
 */
import { parseCsv, parseMoney } from '@orvia/suppliers';

export interface RecordedSupplierOrder {
  shipmentId: string;
  orderId: string;
  orderNumber?: string;
  supplierOrderId: string;
  /** Recorded product + shipping + duties, already converted to the statement currency. */
  costMinor: number;
  /** True when an FX conversion was applied (tolerance widens: rates differ by day). */
  fxConverted: boolean;
}

export interface StatementLineIn { supplierOrderId?: string; orderRef?: string; description?: string; amountMinor: number }
export type LineMatch = 'matched' | 'amount_difference' | 'unknown_order' | 'duplicate';
export interface ReconciledLine extends StatementLineIn {
  match: LineMatch;
  recordedMinor?: number;
  diffMinor?: number;
  shipmentId?: string;
  orderId?: string;
}

export interface ReconcileTotals { claimedMinor: number; recordedMinor: number; diffMinor: number; matchedLines: number; flaggedLines: number; missingFromStatement: number }
export interface ReconcileResult {
  lines: ReconciledLine[];
  totals: ReconcileTotals;
  /** Recorded orders in the period the supplier did not bill (possible under-billing or unshipped). */
  missing: RecordedSupplierOrder[];
  status: 'matched' | 'discrepancies';
}

const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase();

/** Tolerance: whichever is larger of `absMinor`, `pct` of the recorded cost (and a wider pct when FX was applied). */
export function withinTolerance(claimed: number, recorded: number, fxConverted: boolean, o: { absMinor?: number; pct?: number; fxPct?: number } = {}): boolean {
  const abs = o.absMinor ?? 1;
  const pct = fxConverted ? (o.fxPct ?? 0.02) : (o.pct ?? 0);
  return Math.abs(claimed - recorded) <= Math.max(abs, Math.round(Math.abs(recorded) * pct));
}

export function reconcileStatement(lines: StatementLineIn[], recorded: RecordedSupplierOrder[], tol: { absMinor?: number; pct?: number; fxPct?: number } = {}): ReconcileResult {
  const bySupplierOrder = new Map(recorded.map((r) => [norm(r.supplierOrderId), r]));
  const byOrderNumber = new Map(recorded.filter((r) => r.orderNumber).map((r) => [norm(r.orderNumber), r]));
  const seen = new Set<string>();
  const out: ReconciledLine[] = [];
  let claimed = 0, recordedSum = 0, matched = 0, flagged = 0;
  for (const l of lines) {
    claimed += l.amountMinor;
    const rec = (l.supplierOrderId && bySupplierOrder.get(norm(l.supplierOrderId))) || (l.orderRef && byOrderNumber.get(norm(l.orderRef))) || undefined;
    if (!rec) { out.push({ ...l, match: 'unknown_order' }); flagged++; continue; }
    const key = norm(rec.supplierOrderId);
    if (seen.has(key)) { out.push({ ...l, match: 'duplicate', recordedMinor: rec.costMinor, shipmentId: rec.shipmentId, orderId: rec.orderId }); flagged++; continue; }
    seen.add(key);
    recordedSum += rec.costMinor;
    const ok = withinTolerance(l.amountMinor, rec.costMinor, rec.fxConverted, tol);
    out.push({ ...l, match: ok ? 'matched' : 'amount_difference', recordedMinor: rec.costMinor, diffMinor: l.amountMinor - rec.costMinor, shipmentId: rec.shipmentId, orderId: rec.orderId });
    if (ok) matched++; else flagged++;
  }
  const missing = recorded.filter((r) => !seen.has(norm(r.supplierOrderId)));
  const status = flagged === 0 && missing.length === 0 ? 'matched' : 'discrepancies';
  return { lines: out, missing, status, totals: { claimedMinor: claimed, recordedMinor: recordedSum, diffMinor: claimed - recordedSum, matchedLines: matched, flaggedLines: flagged, missingFromStatement: missing.length } };
}

/** Total amount in dispute that is still unexplained: sum of positive differences on flagged lines (over-billing) plus unknown/duplicate lines. */
export function disputableAmount(r: ReconcileResult): number {
  return r.lines.reduce((a, l) => {
    if (l.match === 'amount_difference') return a + Math.max(0, l.diffMinor ?? 0);
    if (l.match === 'unknown_order' || l.match === 'duplicate') return a + Math.max(0, l.amountMinor);
    return a;
  }, 0);
}

const ALIASES: Record<'supplierOrderId' | 'orderRef' | 'amount' | 'description', string[]> = {
  supplierOrderId: ['supplier_order_id', 'supplier order id', 'supplier_order', 'supplier order', 'order_id', 'order id', 'supplierorderid'],
  orderRef: ['order_ref', 'order ref', 'reference', 'order_number', 'order number', 'ref', 'customer_reference', 'orvia_order'],
  amount: ['amount', 'total', 'cost', 'charge', 'line_total', 'amount_due', 'price'],
  description: ['description', 'item', 'details', 'note', 'memo'],
};

/** "12.50", "$1,200.00", "-5.00" or "(5.00)" (credit) to signed minor units. */
export function parseSignedMoney(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t) || /-$/.test(t);
  const v = parseMoney(t.replace(/[()]/g, '').replace(/^-|-$/g, ''), 'major');
  return v === null ? null : neg ? -v : v;
}

export function parseStatementCsv(csv: string, maxRows = 2000): { lines: StatementLineIn[]; errors: string[] } {
  const parsed = parseCsv(csv, { maxRows });
  const errors = [...parsed.errors];
  const header = parsed.header.map((h) => h.toLowerCase());
  const col = (k: keyof typeof ALIASES): string | undefined => parsed.header[header.findIndex((h) => ALIASES[k].includes(h))];
  const cAmount = col('amount'), cSo = col('supplierOrderId'), cRef = col('orderRef'), cDesc = col('description');
  if (!cAmount) return { lines: [], errors: [...errors, 'No amount column found (expected one of: amount, total, cost, charge)'] };
  if (!cSo && !cRef) return { lines: [], errors: [...errors, 'No order identifier column found (expected supplier_order_id or order_ref)'] };
  const lines: StatementLineIn[] = [];
  parsed.rows.forEach((r, i) => {
    const amount = parseSignedMoney(r[cAmount] ?? '');
    if (amount === null) { if (errors.length < 50) errors.push(`Row ${i + 2}: invalid amount "${r[cAmount] ?? ''}"`); return; }
    const so = cSo ? r[cSo] : undefined, ref = cRef ? r[cRef] : undefined;
    if (!so && !ref) { if (errors.length < 50) errors.push(`Row ${i + 2}: no order identifier`); return; }
    lines.push({ supplierOrderId: so || undefined, orderRef: ref || undefined, description: cDesc ? r[cDesc] || undefined : undefined, amountMinor: amount });
  });
  return { lines, errors };
}
