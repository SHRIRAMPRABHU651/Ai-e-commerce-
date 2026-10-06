'use client';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Badge, Button, Card, DataTable, Modal, ProductArt, StatusBadge } from '@orvia/ui';
import type { Column } from '@orvia/ui';
import { FilterSelect, PageHeader, SearchBox, Toolbar, cur, pctf, useAction, useAdmin, useFetch, ErrorBox } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface Row { id: string; title: string; slug: string; state: string; category: string; image?: string; opportunity: number | null; action: string | null; compliance: string; sold: number; rating: number; markets: { country: string; price: number; currency: string; margin: number; profit: number; stock: number }[] }
const STATES = ['', 'DISCOVERED', 'ANALYZING', 'APPROVED', 'DRAFT', 'IMAGE_REQUIRED', 'READY', 'COMPLIANCE_REVIEW', 'SUPPLIER_REVIEW', 'PRICING_REVIEW', 'PUBLISHED', 'TESTING', 'WINNER', 'SCALING', 'DECLINING', 'PAUSED', 'OUT_OF_STOCK', 'BANNED', 'ARCHIVED'];

export default function ProductsPage() {
  const router = useRouter();
  const { can } = useAdmin();
  const [page, setPage] = React.useState(1);
  const [state, setState] = React.useState('');
  const [q, setQ] = React.useState('');
  const [imp, setImp] = React.useState(false);
  const [attention, setAttention] = React.useState(false);
  const { data, error, loading, reload } = useFetch<{ items: Row[]; total: number }>(`/admin/products?page=${page}&pageSize=20${state ? `&state=${state}` : ''}${attention ? '&images=attention' : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const cols: Column<Row>[] = [
    { key: 'p', header: 'Product', render: (r) => <div className="flex items-center gap-3"><div className="w-11 shrink-0 overflow-hidden rounded-md"><ProductArt src={r.image} alt="" /></div><div className="min-w-0"><p className="max-w-64 truncate font-semibold">{r.title}</p><p className="text-xs text-ink-3">{r.category}</p></div></div> },
    { key: 's', header: 'State', render: (r) => <StatusBadge status={r.state} /> },
    { key: 'o', header: 'Opportunity', hideBelow: 'md', render: (r) => (r.opportunity === null ? '—' : <span className="inline-flex items-center gap-2"><b className="tabular-nums">{r.opportunity.toFixed(0)}</b>{r.action && <StatusBadge status={r.action} />}</span>) },
    { key: 'm', header: 'Price · margin (US / CA / IN)', hideBelow: 'lg', render: (r) => <div className="space-y-0.5 text-xs">{r.markets.map((m) => <div key={m.country} className="tabular-nums"><b>{m.country}</b> {cur(m.price, m.currency)} · <span className={m.margin < 0.2 ? 'font-bold text-coral-500' : ''}>{pctf(m.margin, 0)}</span> · stock {m.stock}</div>)}</div> },
    { key: 'c', header: 'Compliance', hideBelow: 'md', render: (r) => <StatusBadge status={r.compliance} /> },
    { key: 'sold', header: 'Sold', align: 'right', hideBelow: 'md', render: (r) => r.sold },
  ];
  return (
    <>
      <PageHeader title="Products" subtitle="Lifecycle, economics and compliance for every listing." actions={can('products:write') ? <Button onClick={() => setImp(true)}>Import product</Button> : undefined} />
      <Toolbar><Button size="sm" variant={attention ? 'primary' : 'secondary'} aria-pressed={attention} onClick={() => { setAttention(!attention); setPage(1); }}>Needs attention: missing images</Button><SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search products" /><FilterSelect label="State" value={state} onChange={(v) => { setState(v); setPage(1); }} options={STATES.map((s) => [s, s ? s.replace(/_/g, ' ').toLowerCase() : 'All states'])} /></Toolbar>
      {error && !data && <ErrorBox message={error} retry={reload} />}
      <Card><DataTable columns={cols} rows={data?.items} loading={loading} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/admin/products/${r.id}`)} page={page} pageSize={20} total={data?.total} onPage={setPage} /></Card>
      <ImportModal open={imp} onClose={() => setImp(false)} onDone={() => { void reload(); }} />
    </>
  );
}

function ImportModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const sups = useFetch<{ items: { id: string; name: string; apiStatus: string }[] }>(open ? '/admin/suppliers' : null);
  const [sid, setSid] = React.useState('');
  const [q, setQ] = React.useState('');
  const cat = useFetch<{ items: { externalId: string; title: string; category: string; image?: string; baseCostUsd: number; imported: boolean; importStatus: string | null }[] }>(open && sid ? `/admin/suppliers/${sid}/catalog?q=${encodeURIComponent(q)}` : null);
  const { run, busy } = useAction();
  const [result, setResult] = React.useState<{ title: string; state: string; compliance: { status: string; flags: { detail: string }[] }; publish: { outcome: string; problems?: string[] }; contentSource: string } | null>(null);
  React.useEffect(() => { if (open && !sid && sups.data?.items[0]) setSid(sups.data.items[0].id); }, [open, sid, sups.data]);
  return (
    <Modal open={open} onClose={() => { setResult(null); onClose(); }} title="Import from a supplier" size="lg">
      <div className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row"><FilterSelect label="Supplier" value={sid} onChange={setSid} options={(sups.data?.items ?? []).map((s) => [s.id, s.name])} /><SearchBox value={q} onChange={setQ} placeholder="Search the supplier catalogue" /></div>
        {result && <div className="rounded-lg bg-sunken p-4 text-sm"><p className="font-bold">{result.title}</p><p className="mt-1">State <StatusBadge status={result.state} /> · compliance <StatusBadge status={result.compliance.status} /> · publish: <b>{result.publish.outcome}</b> · content: {result.contentSource === 'gemini' ? 'Gemini (validated)' : 'template (source data only)'}</p>{result.compliance.flags.length > 0 && <ul className="mt-2 list-disc pl-5 text-coral-700">{result.compliance.flags.map((f) => <li key={f.detail}>{f.detail}</li>)}</ul>}{result.publish.problems && result.publish.outcome !== 'published' && <ul className="mt-2 list-disc pl-5 text-ink-2">{result.publish.problems.map((p) => <li key={p}>{p}</li>)}</ul>}</div>}
        <ul className="max-h-[50dvh] divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {cat.data?.items.map((i) => (
            <li key={i.externalId} className="flex items-center gap-3 p-3"><div className="w-12 shrink-0 overflow-hidden rounded-md"><ProductArt src={i.image} alt="" /></div><div className="min-w-0 flex-1 text-sm"><p className="truncate font-semibold">{i.title}</p><p className="text-xs text-ink-3">{i.category} · ref cost {cur(i.baseCostUsd, 'USD')}</p></div>{i.imported ? <Badge tone="ok">Imported</Badge> : i.importStatus === 'rejected' ? <Badge tone="coral">Rejected</Badge> : <Button size="sm" loading={busy === i.externalId} onClick={async () => { const r = await run(i.externalId, () => api<typeof result & object>('/admin/products/import', { body: { supplierId: sid, externalId: i.externalId } })); if (r) { setResult({ ...(r as NonNullable<typeof result>), title: i.title }); onDone(); void cat.reload(); } }}>Import</Button>}</li>
          ))}
          {cat.loading && <li className="p-4 text-sm text-ink-3">Loading catalogue…</li>}
        </ul>
        <p className="text-xs text-ink-3">Import fetches source data, generates validated content, runs the compliance agent, syncs supplier offers, prices each country, scores the opportunity and then publishes (or proposes publishing) according to your Auto Publishing mode.</p>
      </div>
    </Modal>
  );
}
