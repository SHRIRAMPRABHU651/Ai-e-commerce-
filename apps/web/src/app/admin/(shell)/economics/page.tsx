'use client';
import * as React from 'react';
import { Badge, Button, Card } from '@orvia/ui';
import { ErrorBox, Loading, PageHeader, cur, pctf, useFetch } from '@/components/admin/kit';
import { api } from '@/lib/api';

type Basis = 'measured' | 'quoted' | 'set' | 'estimated';
interface Cell { value: number; basis: Basis; note?: string }
type Band<T> = Record<'optimistic' | 'expected' | 'pessimistic', T>;
interface Row {
  productId: string; title: string; state: string; country: string; currency: string; supplier: string | null; cpaSource: string; cpaSampleSize: number;
  sellingPrice: Cell; productCost: Cell; shipping: Cell; duties: Cell; paymentFee: Cell; refundAllowance: Cell;
  cac: Band<Cell>; contribution: Band<Cell>; marginPct: Band<Cell>; breakEvenCacPct: Cell; minMarginPct: number;
  verdict: 'CLEARS' | 'FAILS_EXPECTED' | 'PESSIMISTIC_RISK' | 'NO_SUPPLIER'; needsHumanApproval: boolean;
}
interface Sheet { rows: Row[]; minMarginPct: number; cacScenarios: Record<string, number>; legend: Record<Basis, string> }

const MARK: Record<Basis, { glyph: string; label: string; cls: string }> = {
  measured: { glyph: '●', label: 'measured', cls: 'text-ok-500' },
  quoted: { glyph: '◐', label: 'quoted', cls: 'text-ink-2' },
  set: { glyph: '■', label: 'set by operator', cls: 'text-ink-2' },
  estimated: { glyph: '◌', label: 'ESTIMATED', cls: 'text-warn-600' },
};
const VERDICT: Record<Row['verdict'], { tone: 'ok' | 'warn' | 'coral' | 'neutral'; text: string }> = {
  CLEARS: { tone: 'ok', text: 'Clears at all CAC levels' },
  PESSIMISTIC_RISK: { tone: 'warn', text: 'Risk: fails at pessimistic CAC' },
  FAILS_EXPECTED: { tone: 'coral', text: 'Fails expected case — do not sell' },
  NO_SUPPLIER: { tone: 'neutral', text: 'No eligible supplier' },
};

function V({ c, fmt }: { c: Cell; fmt: (n: number) => string }) {
  const m = MARK[c.basis];
  return (
    <span className="whitespace-nowrap tabular-nums" title={`${m.label}${c.note ? ' — ' + c.note : ''}`} data-basis={c.basis}>
      <span aria-hidden className={`mr-1 ${m.cls}`}>{m.glyph}</span>
      {fmt(c.value)}
      <span className="sr-only"> ({m.label})</span>
    </span>
  );
}

export default function EconomicsPage() {
  const { data, error, reload } = useFetch<Sheet>('/admin/economics');
  const [busy, setBusy] = React.useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const r = await api<{ filename: string; csv: string }>('/admin/economics/export');
      const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = r.filename; a.click();
      URL.revokeObjectURL(url);
    } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader
        title="Economics"
        subtitle="The decision sheet: what each product really earns per order at optimistic, expected and pessimistic acquisition cost. Publishing requires the expected case to clear the minimum margin. Acquisition cost stays ESTIMATED until real campaign data exists."
        actions={<Button loading={busy} onClick={() => void download()}>Export CSV</Button>}
      />
      {error && !data && <ErrorBox message={error} retry={reload} />}
      {!data ? <Loading /> : (
        <>
          <Card className="mb-4 p-4 text-sm" role="note" aria-label="Legend">
            <p className="mb-1 font-semibold">How to read this</p>
            <ul className="flex flex-wrap gap-x-6 gap-y-1">
              {(Object.keys(MARK) as Basis[]).map((b) => <li key={b}><span className={`mr-1 ${MARK[b].cls}`} aria-hidden>{MARK[b].glyph}</span><strong>{MARK[b].label}</strong> — {data.legend[b]}</li>)}
            </ul>
            <p className="mt-2 text-ink-3">Minimum margin {pctf(data.minMarginPct, 0)} · CAC scenarios as share of price: {Object.entries(data.cacScenarios).map(([k, v]) => `${k} ${pctf(v, 0)}`).join(' · ')}</p>
          </Card>
          {!data.rows.length ? <Card className="p-6 text-sm text-ink-2">No priced products yet.</Card> : (
            <Card className="relative overflow-x-auto p-0">
              <table className="w-full min-w-[1400px] text-sm" data-testid="economics-table">
                <thead className="bg-sunken text-left text-xs text-ink-3">
                  <tr>
                    {['Product', 'Market', 'Verdict', 'Price', 'Product', 'Shipping', 'Duties', 'Pay fee', 'Refunds', 'CAC 15%', 'CAC exp.', 'CAC 40%', 'Profit exp.', 'Margin opt.', 'Margin exp.', 'Margin pess.', 'Max CAC'].map((h, i) => <th key={i} className="px-3 py-2 font-semibold">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => {
                    const f = (n: number) => cur(n, r.currency);
                    const v = VERDICT[r.verdict];
                    return (
                      <tr key={`${r.productId}-${r.country}`} className="border-t border-line">
                        <td className="max-w-[220px] truncate px-3 py-2 font-medium" title={r.title}>{r.title}<div className="text-xs font-normal text-ink-3">{r.supplier ?? '—'} · {r.state}</div></td>
                        <td className="px-3 py-2">{r.country}</td>
                        <td className="px-3 py-2"><Badge tone={v.tone}>{v.text}</Badge>{r.needsHumanApproval && <div className="mt-1 text-xs text-warn-600">CAC assumed → needs human approval</div>}</td>
                        <td className="px-3 py-2"><V c={r.sellingPrice} fmt={f} /></td>
                        <td className="px-3 py-2"><V c={r.productCost} fmt={f} /></td>
                        <td className="px-3 py-2"><V c={r.shipping} fmt={f} /></td>
                        <td className="px-3 py-2"><V c={r.duties} fmt={f} /></td>
                        <td className="px-3 py-2"><V c={r.paymentFee} fmt={f} /></td>
                        <td className="px-3 py-2"><V c={r.refundAllowance} fmt={f} /></td>
                        <td className="px-3 py-2"><V c={r.cac.optimistic} fmt={f} /></td>
                        <td className="px-3 py-2"><V c={r.cac.expected} fmt={f} /></td>
                        <td className="px-3 py-2"><V c={r.cac.pessimistic} fmt={f} /></td>
                        <td className="px-3 py-2"><V c={r.contribution.expected} fmt={f} /></td>
                        <td className="px-3 py-2"><V c={r.marginPct.optimistic} fmt={(n) => pctf(n)} /></td>
                        <td className="px-3 py-2 font-semibold"><V c={r.marginPct.expected} fmt={(n) => pctf(n)} /></td>
                        <td className={`px-3 py-2 ${r.marginPct.pessimistic.value < r.minMarginPct ? 'text-coral-500' : ''}`}><V c={r.marginPct.pessimistic} fmt={(n) => pctf(n)} /></td>
                        <td className="px-3 py-2"><V c={r.breakEvenCacPct} fmt={(n) => pctf(n)} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </>
  );
}
