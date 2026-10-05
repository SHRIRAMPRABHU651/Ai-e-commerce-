'use client';
import * as React from 'react';
import { BarList, Button, Card, DataTable, Field, MetricCard, Modal, Select, StatusBadge, Tabs, Textarea } from '@orvia/ui';
import type { Column } from '@orvia/ui';
import { ErrorBox, Loading, PageHeader, Panel, RangeSelect, pctf, rangeQs, useAction, useAdmin, useFetch, usd, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface Row { campaignId: string; name: string; platform: string; status: string; country: string; product: string; dailyBudget: number; impressions: number; clicks: number; spend: number; purchases: number; revenue: number; ctr: number; cpc: number; cpm: number; cpa: number | null; roas: number; recommendation: string; reason: string }
interface Agg { key: string; spend: number; revenue: number; purchases: number; roas: number; cpa: number | null; ctr: number }
interface D { mode: string; accounts: Record<string, { configured: boolean }>; rows: Row[]; campaigns: { _id: string; name: string; platform: string; status: string; country: string; dailyBudget: number; failureReason?: string; test?: { verdict: string } }[]; byCountry: Agg[]; byProduct: Agg[]; totals: { spend: number; revenue: number; purchases: number; roas: number; cpa: number | null; ctr: number; cpc: number; cpm: number }; creatives: { id: string; concept?: string; headline?: string; status?: string; spend: number; roas: number; ctr: number; purchases: number }[] }

export default function MarketingPage() {
  const { can } = useAdmin();
  const [preset, setPreset] = React.useState('30d');
  const [from, setFrom] = React.useState(''); const [to, setTo] = React.useState('');
  const [tab, setTab] = React.useState('campaigns');
  const { data: d, error, reload } = useFetch<D>(`/admin/marketing?${rangeQs(preset, from, to)}`, 120_000);
  const { run, busy } = useAction();
  const [gen, setGen] = React.useState(false);
  if (error && !d) return <ErrorBox message={error} retry={reload} />;
  if (!d) return <Loading rows={5} />;
  const act = (id: string, action: string) => run(id + action, async () => { await api(`/admin/marketing/campaigns/${id}/action`, { body: { action, reason: 'manual from marketing dashboard' } }); await reload(); }, 'Applied on the ad platform');
  const cols: Column<Row>[] = [
    { key: 'n', header: 'Campaign', render: (r) => <div><b className="block max-w-56 truncate">{r.name}</b><p className="text-xs text-ink-3">{r.platform} · {r.country}</p></div> },
    { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'sp', header: 'Spend', align: 'right', render: (r) => usd(r.spend) },
    { key: 'rv', header: 'Revenue', align: 'right', hideBelow: 'md', render: (r) => usd(r.revenue) },
    { key: 'r', header: 'ROAS', align: 'right', render: (r) => <b>{r.roas.toFixed(2)}</b> },
    { key: 'cpa', header: 'CPA', align: 'right', hideBelow: 'lg', render: (r) => (r.cpa ? usd(r.cpa) : '—') },
    { key: 'ctr', header: 'CTR', align: 'right', hideBelow: 'lg', render: (r) => pctf(r.ctr, 2) },
    { key: 'cpc', header: 'CPC', align: 'right', hideBelow: 'lg', render: (r) => usd(r.cpc) },
    { key: 'cpm', header: 'CPM', align: 'right', hideBelow: 'lg', render: (r) => usd(r.cpm) },
    { key: 'pu', header: 'Conv.', align: 'right', hideBelow: 'md', render: (r) => r.purchases },
    { key: 'rec', header: 'AI says', render: (r) => <span title={r.reason}><StatusBadge status={r.recommendation} /></span> },
    { key: 'a', header: '', align: 'right', render: (r) => can('ads:write') && <div className="flex justify-end gap-1">{r.status === 'active' ? <Button size="sm" variant="secondary" loading={busy === r.campaignId + 'PAUSE'} onClick={() => void act(r.campaignId, 'PAUSE')}>Pause</Button> : r.status === 'paused' ? <Button size="sm" variant="secondary" loading={busy === r.campaignId + 'RESUME'} onClick={() => void act(r.campaignId, 'RESUME')}>Resume</Button> : null}</div> },
  ];
  const t = d.totals;
  return (
    <>
      <PageHeader title="Marketing" subtitle={`Campaigns, creatives and attribution. Ad network mode: ${d.mode}${d.mode === 'mock' ? ' (simulated metrics — development only)' : ''}.`} actions={<><RangeSelect value={preset} onChange={setPreset} from={from} to={to} onDates={(f, x) => { setFrom(f); setTo(x); }} />{can('marketing:write') && <Button variant="secondary" onClick={() => setGen(true)}>Generate content</Button>}</>} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <MetricCard label="Spend" value={usd(t.spend)} /><MetricCard label="Revenue (attributed)" value={usd(t.revenue)} /><MetricCard label="ROAS" value={t.roas.toFixed(2) + '×'} /><MetricCard label="CPA" value={t.cpa ? usd(t.cpa) : '—'} /><MetricCard label="CTR" value={pctf(t.ctr, 2)} /><MetricCard label="CPC" value={usd(t.cpc)} /><MetricCard label="CPM" value={usd(t.cpm)} />
      </div>
      <div className="mt-5 flex flex-wrap gap-2 text-xs">{Object.entries(d.accounts).map(([k, v]) => <span key={k} className="inline-flex items-center gap-1.5 rounded-full bg-sunken px-3 py-1.5 font-semibold capitalize"><span className={`size-2 rounded-full ${v.configured ? 'bg-ok-500' : 'bg-line-strong'}`} />{k}: {v.configured ? 'connected' : 'not connected'}</span>)}</div>
      <Tabs className="mt-4" tabs={[{ id: 'campaigns', label: 'Campaigns' }, { id: 'country', label: 'By country' }, { id: 'product', label: 'By product' }, { id: 'creative', label: 'Creatives' }]} value={tab} onChange={setTab} />
      <div className="pt-4">
        {tab === 'campaigns' && <Card><DataTable columns={cols} rows={d.rows} rowKey={(r) => r.campaignId} empty={{ title: 'No ad activity in this range', body: 'Start an ad test from a product page.' }} /></Card>}
        {tab === 'country' && <Panel title="ROAS by country"><BarList rows={d.byCountry.map((c) => ({ label: c.key, value: c.roas, sub: `${usd(c.spend)} spend` }))} format={(n) => n.toFixed(2) + '×'} /></Panel>}
        {tab === 'product' && <Panel title="ROAS by product"><BarList rows={d.byProduct.map((c) => ({ label: c.key, value: c.roas, sub: `${usd(c.spend)} spend` }))} format={(n) => n.toFixed(2) + '×'} /></Panel>}
        {tab === 'creative' && <Panel title="Creative performance" subtitle="Winners need a sufficient sample before being crowned"><ul className="divide-y divide-line">{d.creatives.map((c) => <li key={c.id} className="flex items-center justify-between gap-3 py-3 text-sm"><div className="min-w-0"><p className="truncate font-semibold">{c.headline}</p><p className="text-xs capitalize text-ink-3">{c.concept?.replace(/_/g, ' ')}</p></div><span className="flex shrink-0 items-center gap-3 tabular-nums"><span>ROAS <b>{c.roas.toFixed(2)}</b></span><span className="hidden sm:inline">CTR {pctf(c.ctr, 2)}</span><StatusBadge status={c.status ?? 'draft'} /></span></li>)}</ul></Panel>}
      </div>
      {d.campaigns.some((c) => c.status === 'failed') && <Panel className="mt-4" title="Failed launches"><ul className="space-y-2 text-sm">{d.campaigns.filter((c) => c.status === 'failed').map((c) => <li key={c._id}><b>{c.name}</b> — <span className="text-coral-500">{c.failureReason}</span> <span className="text-ink-3">(never shown as live)</span></li>)}</ul></Panel>}
      <ContentModal open={gen} onClose={() => setGen(false)} />
      <span className="hidden">{when(null)}</span>
    </>
  );
}

function ContentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const prods = useFetch<{ items: { id: string; title: string }[] }>(open ? '/admin/products?pageSize=60&state=PUBLISHED' : null);
  const [pid, setPid] = React.useState('');
  const [kind, setKind] = React.useState('email');
  const [out, setOut] = React.useState<{ text: string; source: string } | null>(null);
  const { run, busy } = useAction();
  return (
    <Modal open={open} onClose={onClose} title="Marketing content generator" size="lg">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Product"><Select value={pid} onChange={(e) => setPid(e.target.value)}><option value="">Choose…</option>{prods.data?.items.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</Select></Field><Field label="Format"><Select value={kind} onChange={(e) => setKind(e.target.value)}>{['email', 'blog', 'push', 'instagram', 'tiktok', 'facebook', 'google_ad'].map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</Select></Field></div>
        <Button disabled={!pid} loading={busy === 'g'} onClick={async () => { const r = await run('g', () => api<{ text: string; source: string }>('/admin/marketing/content', { body: { productId: pid, kind } })); if (r) setOut(r); }}>Generate</Button>
        {out && <><p className="text-xs text-ink-3">Source: {out.source === 'gemini' ? 'Gemini, validated against the product data' : 'deterministic template built only from the product record'}. Specs not present in the source are rejected.</p><Textarea readOnly value={out.text} className="min-h-64 font-mono text-[13px]" /></>}
      </div>
    </Modal>
  );
}
