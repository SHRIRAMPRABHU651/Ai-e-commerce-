/**
 * Pure payout-statement builder. Line items are derived ONLY from ledger entries, so the statement total
 * reconciles to the ledger by construction (and `reconciles` proves it against the payout amount).
 * No customer PII: orders are shown by a short reference only.
 */
export interface StatementEntry {
  id: string;
  kind: 'commission' | 'clawback' | 'adjustment';
  status: string;
  amount: number;
  currency: string;
  orderRef?: string;
  orderedAt?: Date | null;
  deliveredAt?: Date | null;
  holdUntil?: Date | null;
  netBase?: number;
  rate?: number;
  rateSource?: string;
  capped?: string[];
  note?: string;
}
export interface StatementLine { ref: string; kind: string; date: string; netBase: number | null; rate: number | null; heldUntil: string | null; note: string; amount: number }
export interface Statement {
  creatorHandle: string;
  currency: string;
  period: string;
  payoutId?: string;
  lines: StatementLine[];
  totals: { commissions: number; clawbacks: number; adjustments: number; net: number };
  payoutAmount: number | null;
  reconciles: boolean;
  disclosure: string;
}

const iso = (d?: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function buildStatement(i: { handle: string; currency: string; period: string; payoutId?: string; payoutAmount?: number | null; entries: StatementEntry[]; disclosure: string }): Statement {
  const entries = i.entries.filter((e) => e.currency === i.currency && e.status !== 'reversed');
  const lines: StatementLine[] = entries
    .map((e) => ({
      ref: e.orderRef ?? '—', kind: e.kind, date: iso(e.deliveredAt ?? e.orderedAt) ?? '—', netBase: e.netBase ?? null, rate: e.rate ?? null, heldUntil: iso(e.holdUntil),
      note: [e.note, e.capped?.length ? `capped: ${e.capped.join(', ')}` : '', e.rateSource ? `rate source: ${e.rateSource}` : ''].filter(Boolean).join('; '), amount: e.amount,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  const sum = (k: string) => lines.filter((l) => l.kind === k).reduce((a, l) => a + l.amount, 0);
  const totals = { commissions: sum('commission'), clawbacks: sum('clawback'), adjustments: sum('adjustment'), net: lines.reduce((a, l) => a + l.amount, 0) };
  const payoutAmount = i.payoutAmount ?? null;
  return { creatorHandle: i.handle, currency: i.currency, period: i.period, payoutId: i.payoutId, lines, totals, payoutAmount, reconciles: payoutAmount === null ? true : payoutAmount === totals.net, disclosure: i.disclosure };
}

const fmt = (minor: number, currency: string) => new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency }).format(minor / 100);
const csvCell = (v: string | number | null): string => {
  let s = v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function statementCsv(s: Statement): string {
  const rows = [['order_ref', 'type', 'date', 'net_base', 'rate_pct', 'held_until', 'note', 'amount']];
  for (const l of s.lines) rows.push([l.ref, l.kind, l.date, l.netBase === null ? '' : (l.netBase / 100).toFixed(2), l.rate === null ? '' : (l.rate * 100).toFixed(2), l.heldUntil ?? '', l.note, (l.amount / 100).toFixed(2)]);
  rows.push(['', 'TOTAL', '', '', '', '', `${s.currency} net of clawbacks and adjustments`, (s.totals.net / 100).toFixed(2)]);
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Standalone printable HTML (no scripts, no external assets). */
export function statementHtml(s: Statement): string {
  const rows = s.lines.map((l) => `<tr><td>${esc(l.ref)}</td><td>${esc(l.kind)}</td><td>${esc(l.date)}</td><td class="n">${l.netBase === null ? '' : fmt(l.netBase, s.currency)}</td><td class="n">${l.rate === null ? '' : (l.rate * 100).toFixed(2) + '%'}</td><td>${esc(l.heldUntil ?? '')}</td><td>${esc(l.note)}</td><td class="n">${fmt(l.amount, s.currency)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Payout statement ${esc(s.creatorHandle)}</title><meta name="robots" content="noindex"><style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#111}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}.n{text-align:right;font-variant-numeric:tabular-nums}tfoot td{font-weight:700}p.d{margin-top:1.5rem;font-size:12px;color:#444}@media print{body{margin:0}}</style></head><body><h1>Payout statement</h1><p>Creator: <strong>@${esc(s.creatorHandle)}</strong> &middot; Currency: ${esc(s.currency)} &middot; Period: ${esc(s.period)}${s.payoutId ? ` &middot; Payout ${esc(s.payoutId)}` : ''}</p><table><thead><tr><th>Order</th><th>Type</th><th>Date</th><th class="n">Net base</th><th class="n">Rate</th><th>Held until</th><th>Notes</th><th class="n">Amount</th></tr></thead><tbody>${rows || '<tr><td colspan="8">No entries</td></tr>'}</tbody><tfoot><tr><td colspan="7">Commissions</td><td class="n">${fmt(s.totals.commissions, s.currency)}</td></tr><tr><td colspan="7">Clawbacks (refunds / returns / chargebacks)</td><td class="n">${fmt(s.totals.clawbacks, s.currency)}</td></tr><tr><td colspan="7">Adjustments</td><td class="n">${fmt(s.totals.adjustments, s.currency)}</td></tr><tr><td colspan="7">Net</td><td class="n">${fmt(s.totals.net, s.currency)}</td></tr></tfoot></table><p class="d">Commission is a percentage of the net order value (after discounts, refunds, tax and shipping), not of the sale total. ${esc(s.disclosure)}</p></body></html>`;
}
