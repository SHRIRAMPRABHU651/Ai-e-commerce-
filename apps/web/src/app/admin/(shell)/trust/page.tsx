'use client';
import * as React from 'react';
import { Badge, Button, DataTable, Modal } from '@orvia/ui';
import type { Column, Tone } from '@orvia/ui';
import type { ProductRiskResult, SupplierTrustSnapshotView, SupplierTrustResult, TrustComponent, TrustStatus } from '@orvia/types';
import { ErrorBox, FilterSelect, PageHeader, Panel, SearchBox, Toolbar, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface SupplierRow { id: string; name: string; code: string; provider: string; active: boolean; computed: boolean; trust: SupplierTrustSnapshotView | null; status: TrustStatus }
interface ProductRow { productId: string; title: string; slug: string | null; state: string | null; level: string; status: TrustStatus; score: number | null; confidence: number; sampleSize: number; computedAt: string; risk: ProductRiskResult }
interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
interface ProductDetail {
  product: { id: string; title: string };
  overall: { computedAt: string; result: ProductRiskResult } | null;
  destinations: Record<string, { computedAt: string; result: ProductRiskResult }>;
  evidence: { id: string; kind: string; key: string; value: string; provenance: string; source: string; observedAt: string | null; expiresAt: string | null; expired: boolean; superseded: boolean }[];
}

const tone = (s: TrustStatus): Tone => (s === 'established' ? 'ok' : s === 'provisional' ? 'warn' : 'neutral');
const label = (s: TrustStatus) => s.replace('_', ' ');
const pc = (x: number) => `${Math.round(x * 100)}%`;
const levelTone = (l: string): Tone => (l === 'low' ? 'ok' : l === 'medium' ? 'warn' : l === 'high' ? 'coral' : 'neutral');
const STATUS_OPTS: [string, string][] = [['', 'All statuses'], ['insufficient_data', 'Insufficient data'], ['provisional', 'Provisional'], ['established', 'Established']];

function Components({ comps }: { comps: TrustComponent[] }) {
  return (
    <ul className="space-y-3">
      {comps.map((c) => (
        <li key={c.key} className="rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <b className="text-sm">{c.label}</b>
            <span className="text-xs text-ink-3">weight {pc(c.weight)} · n={c.sampleSize} · confidence {pc(c.confidence)}</span>
          </div>
          <p className="mt-1 text-sm">{c.value === null ? <span className="text-ink-3">{c.note ?? 'No data yet'}</span> : <>Value <b>{Math.round(c.value * 100)}</b>{c.observed !== null && <span className="text-ink-3"> (observed {Math.round(c.observed * 100)}, shrunk toward prior)</span>}</>}</p>
          {c.evidence.length > 0 && <ul className="mt-1 space-y-0.5 text-xs text-ink-3">{c.evidence.map((e, i) => <li key={i}>{e.label}: {e.value} <Badge>{e.provenance.replace('_', '-')}</Badge> {e.source}</li>)}</ul>}
        </li>
      ))}
    </ul>
  );
}

function SupplierDetail({ t }: { t: SupplierTrustSnapshotView }) {
  const dests = Object.entries(t.destinations);
  const Block = ({ r, title }: { r: SupplierTrustResult; title: string }) => (
    <div className="mt-4"><h3 className="mb-2 text-sm font-bold">{title}: {r.score === null ? 'no score (not enough history)' : `${r.score}/100`} <Badge tone={tone(r.status)}>{label(r.status)}</Badge></h3>
      <ul className="mb-2 list-disc pl-5 text-xs text-ink-3">{[...r.known, ...r.caveats].map((k) => <li key={k}>{k}</li>)}</ul>
      <Components comps={r.components} /></div>
  );
  return (
    <div>
      <p className="text-sm text-ink-3">Computed {when(t.computedAt)} from {t.sampleSize} resolved shipments. Confidence {pc(t.confidence)}{t.range ? ` · range ${t.range.low}-${t.range.high}` : ''}.</p>
      <Block r={t} title="All destinations" />
      {dests.map(([d, r]) => <Block key={d} r={r} title={`Destination ${d}`} />)}
    </div>
  );
}

function ProductDetailView({ id }: { id: string }) {
  const { data, error, loading } = useFetch<ProductDetail>(`/admin/trust/products/${id}`);
  if (loading) return <p className="text-sm text-ink-3">Loading…</p>;
  if (error || !data) return <ErrorBox message={error ?? 'Not found'} />;
  const all = [['All destinations', data.overall] as const, ...Object.entries(data.destinations).map(([k, v]) => [`Destination ${k}`, v] as const)];
  return (
    <div className="space-y-5">
      {all.map(([t, d]) => d && (
        <div key={t}>
          <h3 className="text-sm font-bold">{t}: {d.result.score === null ? 'no score' : `risk ${d.result.score}/100`} <Badge tone={levelTone(d.result.level)}>{d.result.level}</Badge> <Badge tone={tone(d.result.status)}>{label(d.result.status)}</Badge></h3>
          <ul className="my-2 list-disc pl-5 text-xs text-ink-3">{[...d.result.known, ...d.result.caveats].map((k) => <li key={k}>{k}</li>)}</ul>
          <Components comps={d.result.components} />
        </div>
      ))}
      {!data.overall && <p className="text-sm text-ink-3">No snapshot yet. Run a recompute.</p>}
      <div>
        <h3 className="mb-2 text-sm font-bold">Evidence ({data.evidence.length})</h3>
        {data.evidence.length === 0 ? <p className="text-sm text-ink-3">No recorded evidence. Facts shown to customers are supplier-provided.</p> : (
          <ul className="space-y-1 text-sm">{data.evidence.map((e) => <li key={e.id} className={e.superseded || e.expired ? 'text-ink-3 line-through' : ''}><b>{e.kind}/{e.key}</b>: {e.value} <Badge tone={e.provenance === 'verified' ? 'ok' : 'neutral'}>{e.provenance.replace('_', '-')}</Badge> <span className="text-xs text-ink-3">{e.source}{e.expiresAt ? ` · expires ${when(e.expiresAt)}` : ''}{e.expired ? ' · expired' : ''}{e.superseded ? ' · superseded' : ''}</span></li>)}</ul>
        )}
      </div>
    </div>
  );
}

export default function TrustPage() {
  const { can } = useAdmin();
  const { run, busy } = useAction();
  const [tab, setTab] = React.useState<'suppliers' | 'products'>('suppliers');
  const [status, setStatus] = React.useState('');
  const [q, setQ] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [sel, setSel] = React.useState<SupplierRow | null>(null);
  const [prod, setProd] = React.useState<ProductRow | null>(null);
  const qs = `page=${page}&pageSize=25${status ? `&status=${status}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const sup = useFetch<Page<SupplierRow>>(tab === 'suppliers' ? `/admin/trust/suppliers?${qs}` : null);
  const prods = useFetch<Page<ProductRow>>(tab === 'products' ? `/admin/trust/products?${qs}` : null);
  const cur = tab === 'suppliers' ? sup : prods;

  const recompute = () => run('recompute', async () => { await api('/admin/trust/recompute', { body: { scope: 'all' } }); await Promise.all([sup.reload(), prods.reload()]); }, 'Trust scores recomputed');

  const supCols: Column<SupplierRow>[] = [
    { key: 'n', header: 'Supplier', render: (r) => <div><b>{r.name}</b><p className="text-xs text-ink-3">{r.code} · {r.provider}{r.active ? '' : ' · inactive'}</p></div> },
    { key: 'score', header: 'Score', render: (r) => (r.trust?.score != null ? <b>{r.trust.score}<span className="font-normal text-ink-3">/100{r.trust.range ? ` (${r.trust.range.low}-${r.trust.range.high})` : ''}</span></b> : <span className="text-xs text-ink-3">Not enough delivery history yet</span>) },
    { key: 'st', header: 'Status', render: (r) => <Badge tone={tone(r.status)}>{r.computed ? label(r.status) : 'not computed'}</Badge> },
    { key: 'c', header: 'Confidence', hideBelow: 'md', align: 'right', render: (r) => (r.trust ? pc(r.trust.confidence) : '—') },
    { key: 's', header: 'Samples', hideBelow: 'md', align: 'right', render: (r) => r.trust?.sampleSize ?? 0 },
    { key: 'd', header: 'Destinations', hideBelow: 'lg', render: (r) => (r.trust ? Object.entries(r.trust.destinations).map(([d, x]) => `${d}: ${x.score ?? 'n/a'}`).join(' · ') || '—' : '—') },
    { key: 'at', header: 'Computed', hideBelow: 'lg', render: (r) => when(r.trust?.computedAt) },
  ];
  const prodCols: Column<ProductRow>[] = [
    { key: 't', header: 'Product', render: (r) => <div><b>{r.title}</b><p className="text-xs text-ink-3">{r.state}</p></div> },
    { key: 'l', header: 'Risk', render: (r) => <Badge tone={levelTone(r.level)}>{r.level}</Badge> },
    { key: 'sc', header: 'Score', render: (r) => (r.score === null ? <span className="text-xs text-ink-3">Not enough history</span> : <b>{r.score}</b>) },
    { key: 'st', header: 'Status', render: (r) => <Badge tone={tone(r.status)}>{label(r.status)}</Badge> },
    { key: 'c', header: 'Confidence', hideBelow: 'md', align: 'right', render: (r) => pc(r.confidence) },
    { key: 'n', header: 'Samples', hideBelow: 'md', align: 'right', render: (r) => r.sampleSize },
    { key: 'at', header: 'Computed', hideBelow: 'lg', render: (r) => when(r.computedAt) },
  ];

  return (
    <>
      <PageHeader title="TrustGraph" subtitle="Supplier reliability and product risk computed from real shipments, returns, refunds and reviews. Scores are shown only when there is enough history." actions={can('trust:write') && <Button loading={busy === 'recompute'} onClick={() => void recompute()}>Recompute now</Button>} />
      <Toolbar>
        <div role="group" aria-label="View" className="inline-flex rounded-md bg-sunken p-1">
          {(['suppliers', 'products'] as const).map((t) => <button key={t} aria-pressed={tab === t} onClick={() => { setTab(t); setPage(1); }} className={`h-8 rounded px-3 text-xs font-bold ${tab === t ? 'bg-surface shadow-sm' : 'text-ink-3'}`}>{t === 'suppliers' ? 'Supplier trust' : 'Product risk'}</button>)}
        </div>
        <FilterSelect label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUS_OPTS} />
        <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder={tab === 'suppliers' ? 'Search suppliers' : 'Search products'} />
      </Toolbar>
      {cur.error && <ErrorBox message={cur.error} retry={() => void cur.reload()} />}
      <Panel pad={false}>
        {tab === 'suppliers' ? (
          <DataTable<SupplierRow> columns={supCols} rows={sup.data?.items} rowKey={(r) => r.id} loading={sup.loading} onRowClick={setSel} page={page} pageSize={25} total={sup.data?.total} onPage={setPage}
            empty={{ title: 'No suppliers', body: 'Add a supplier, then recompute to see its trust.' }} />
        ) : (
          <DataTable<ProductRow> columns={prodCols} rows={prods.data?.items} rowKey={(r) => r.productId} loading={prods.loading} onRowClick={setProd} page={page} pageSize={25} total={prods.data?.total} onPage={setPage}
            empty={{ title: 'No product risk snapshots yet', body: can('trust:write') ? 'Use "Recompute now" to compute them from current data.' : 'A trust administrator can compute them.' }} />
        )}
      </Panel>
      <Modal open={!!sel} onClose={() => setSel(null)} title={sel ? `${sel.name}: reliability` : ''} size="lg">
        {sel && (sel.trust ? <SupplierDetail t={sel.trust} /> : <p className="text-sm text-ink-3">Not computed yet. Run a recompute.</p>)}
      </Modal>
      <Modal open={!!prod} onClose={() => setProd(null)} title={prod ? `${prod.title}: risk` : ''} size="lg">
        {prod && <ProductDetailView id={prod.productId} />}
      </Modal>
    </>
  );
}
