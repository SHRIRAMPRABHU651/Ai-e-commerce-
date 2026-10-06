'use client';
import * as React from 'react';
import { Badge, Button, Card, Checkbox, DataTable, Drawer, Field, Input, Modal, Select, StatusBadge, Tabs, Textarea } from '@orvia/ui';
import type { Column } from '@orvia/ui';
import { ErrorBox, FilterSelect, Loading, PageHeader, Panel, SearchBox, Toolbar, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface Topic { id: string; name: string; status: string; trendScore: number; confidence: number; growthPct?: number; sourceCount: number; observationCount: number; firstSeen?: string; lastSeen?: string; country?: string; category?: string; price?: { median: number; low: number; high: number; n: number; confidence: string; velocityPct?: number }; matchedProducts: number }
interface Source { id: string; name: string; type: string; baseUrl?: string; country?: string; category?: string; enabled: boolean; crawlIntervalMinutes: number; robotsRequired: boolean; fetchProductPages: number; lastCrawledAt?: string; lastSuccessAt?: string; lastError?: string; failureCount: number; documentsCollected: number; healthStatus: string; robotsStatus: string; successRate: number; parserConfig?: unknown }
interface Overview { statusCounts: Record<string, number>; documents: number; sources: { total: number; enabled: number; healthy: number; blocked: number; failing: number }; internalDemand: { query: string; last7d: number; previous7d: number; noResults: boolean }[]; priceMovement: { name: string; median: number; velocityPct: number }[]; note: string }
interface Detail { topic: Topic & { components?: Record<string, { score: number; available: boolean; sample: number; note?: string }>; windows?: Record<string, { observations: number; sources: number; sufficient: boolean }> }; explanation: { text: string; warnings: string[] }; documents: { title: string; source: string; sourceUrl?: string; observedAt: string; price?: number; availability: string }[] }

const STATUS_TONE: Record<string, 'ok' | 'pine' | 'neutral' | 'coral' | 'warn'> = { TRENDING: 'ok', RISING: 'pine', STABLE: 'neutral', DECLINING: 'coral', INSUFFICIENT_DATA: 'warn' };
const TABS = [['TRENDING', 'Trending now'], ['RISING', 'Rising'], ['DECLINING', 'Declining'], ['INSUFFICIENT_DATA', 'Emerging / low evidence'], ['', 'All']] as const;
const blank = { id: '', name: '', type: 'RSS', baseUrl: '', country: 'US', category: '', crawlIntervalMinutes: 360, robotsRequired: true, fetchProductPages: 0, parserConfig: '' };
const HINTS: Record<string, string> = {
  HTML_LISTING: '{"itemSelector":"li.product","titleSelector":".title","priceSelector":".price","currency":"USD"}',
  JSON_PUBLIC: '{"list":"data.products","title":"name","price":"price","url":"url","currency":"USD"}',
};

export default function MarketPage() {
  const { can } = useAdmin();
  const [tab, setTab] = React.useState('topics');
  const [status, setStatus] = React.useState('TRENDING');
  const [country, setCountry] = React.useState('');
  const [category, setCategory] = React.useState('');
  const [q, setQ] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [open, setOpen] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<typeof blank | null>(null);
  const { run, busy } = useAction();
  const ov = useFetch<Overview>('/admin/market/overview', 120_000);
  const topics = useFetch<{ items: Topic[]; total: number }>(`/admin/market/topics?page=${page}&pageSize=20${status ? `&status=${status}` : ''}${country ? `&country=${country}` : ''}${category ? `&category=${encodeURIComponent(category)}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const sources = useFetch<{ items: Source[]; types: string[] }>('/admin/market/sources', 60_000);
  const det = useFetch<Detail>(open ? `/admin/market/topics/${open}` : null);
  const writable = can('market:write');

  const tcols: Column<Topic>[] = [
    { key: 'n', header: 'Topic', render: (t) => <div><b>{t.name}</b><p className="text-xs text-ink-3">{[t.country, t.category].filter(Boolean).join(' · ') || 'all markets'} · {t.matchedProducts} Orvia product(s)</p></div> },
    { key: 's', header: 'Status', render: (t) => <Badge tone={STATUS_TONE[t.status] ?? 'neutral'}>{t.status.replace('_', ' ')}</Badge> },
    { key: 'sc', header: 'Score', align: 'right', render: (t) => <b className="tabular-nums">{t.trendScore}</b> },
    { key: 'c', header: 'Confidence', render: (t) => <div className="w-24"><div className="h-1.5 overflow-hidden rounded-full bg-sunken" role="img" aria-label={`Confidence ${Math.round(t.confidence * 100)}%`}><div className={`h-full ${t.confidence >= 0.6 ? 'bg-ok-500' : t.confidence >= 0.35 ? 'bg-saffron-500' : 'bg-coral-500'}`} style={{ width: `${Math.round(t.confidence * 100)}%` }} /></div><span className="text-xs text-ink-3">{Math.round(t.confidence * 100)}%</span></div> },
    { key: 'g', header: 'Velocity', hideBelow: 'md', align: 'right', render: (t) => (t.growthPct === undefined || t.growthPct === null ? '—' : <span className={t.growthPct >= 0 ? 'text-ok-500' : 'text-coral-500'}>{t.growthPct > 0 ? '+' : ''}{t.growthPct}%</span>) },
    { key: 'so', header: 'Sources', hideBelow: 'md', align: 'right', render: (t) => t.sourceCount },
    { key: 'fs', header: 'First / last seen', hideBelow: 'lg', render: (t) => <span className="text-xs">{t.firstSeen ? new Date(t.firstSeen).toLocaleDateString() : '—'} → {t.lastSeen ? new Date(t.lastSeen).toLocaleDateString() : '—'}</span> },
    { key: 'p', header: 'Competitor median', hideBelow: 'lg', align: 'right', render: (t) => (t.price ? <span title={`${t.price.n} observation(s), confidence ${t.price.confidence}`}>${(t.price.median / 100).toFixed(2)} <Badge tone={t.price.confidence === 'LOW' ? 'warn' : 'neutral'}>{t.price.confidence}</Badge></span> : <span className="text-ink-3">no data</span>) },
  ];
  const scols: Column<Source>[] = [
    { key: 'n', header: 'Source', render: (s) => <div><b>{s.name}</b><p className="max-w-64 truncate text-xs text-ink-3" title={s.baseUrl}>{s.type} · {s.baseUrl}</p></div> },
    { key: 'h', header: 'Health', render: (s) => <div><StatusBadge status={s.healthStatus === 'HEALTHY' ? 'ok' : s.healthStatus === 'BLOCKED' ? 'failed' : s.healthStatus.toLowerCase()} label={s.healthStatus} />{s.lastError && <p className="mt-1 max-w-56 truncate text-xs text-coral-500" title={s.lastError}>{s.lastError}</p>}</div> },
    { key: 'r', header: 'robots.txt', hideBelow: 'md', render: (s) => <Badge tone={s.robotsStatus === 'allowed' ? 'ok' : s.robotsStatus === 'unknown' ? 'neutral' : 'coral'}>{s.robotsRequired ? s.robotsStatus : 'not required'}</Badge> },
    { key: 'c', header: 'Country / category', hideBelow: 'md', render: (s) => [s.country, s.category].filter(Boolean).join(' · ') || '—' },
    { key: 'l', header: 'Last crawl', hideBelow: 'lg', render: (s) => when(s.lastCrawledAt) },
    { key: 'd', header: 'Docs', hideBelow: 'lg', align: 'right', render: (s) => s.documentsCollected },
    { key: 'sr', header: 'Success', hideBelow: 'lg', align: 'right', render: (s) => `${Math.round(s.successRate * 100)}%` },
    { key: 'a', header: '', align: 'right', render: (s) => writable && (
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="secondary" loading={busy === 'c' + s.id} onClick={() => void run('c' + s.id, async () => { const r = await api<{ status: string; documents: number; message?: string }>(`/admin/market/sources/${s.id}/crawl`, { body: {} }); await sources.reload(); if (r.status !== 'ok' && r.status !== 'unchanged') throw new Error(`${r.status}: ${r.message ?? ''}`); }, 'Crawled')}>Crawl now</Button>
        <Button size="sm" variant="ghost" onClick={() => setForm({ ...blank, id: s.id, name: s.name, type: s.type, baseUrl: s.baseUrl ?? '', country: s.country ?? '', category: s.category ?? '', crawlIntervalMinutes: s.crawlIntervalMinutes, robotsRequired: s.robotsRequired, fetchProductPages: s.fetchProductPages, parserConfig: s.parserConfig ? JSON.stringify(s.parserConfig, null, 2) : '' })}>Edit</Button>
        <Button size="sm" variant="ghost" onClick={() => void run('t' + s.id, async () => { await api(`/admin/market/sources/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } }); await sources.reload(); })}>{s.enabled ? 'Disable' : 'Enable'}</Button>
      </div>
    ) },
  ];
  const save = () => run('save', async () => {
    if (!form) return;
    let parserConfig: unknown;
    if (form.parserConfig.trim()) { try { parserConfig = JSON.parse(form.parserConfig); } catch { throw new Error('Parser rules must be valid JSON'); } }
    const body = { name: form.name, type: form.type, baseUrl: form.baseUrl || undefined, country: form.country || undefined, category: form.category || undefined, crawlIntervalMinutes: Number(form.crawlIntervalMinutes), robotsRequired: form.robotsRequired, fetchProductPages: Number(form.fetchProductPages), ...(parserConfig ? { parserConfig } : {}) };
    if (form.id) await api(`/admin/market/sources/${form.id}`, { method: 'PATCH', body }); else await api('/admin/market/sources', { body });
    setForm(null);
    await sources.reload();
  }, 'Source saved');

  return (
    <>
      <PageHeader title="Market intelligence" subtitle="Evidence-based trends from public sources you configure plus Orvia’s own search, view, cart and purchase activity. No paid API, no guesses: a topic is only called trending when several sources agree." actions={writable ? <Button variant="secondary" loading={busy === 're'} onClick={() => void run('re', async () => { await api('/admin/market/recompute', { body: {} }); await Promise.all([topics.reload(), ov.reload()]); }, 'Trends recomputed')}>Recompute now</Button> : undefined} />
      {ov.data && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          {[['Trending', ov.data.statusCounts['TRENDING'] ?? 0], ['Rising', ov.data.statusCounts['RISING'] ?? 0], ['Declining', ov.data.statusCounts['DECLINING'] ?? 0], ['Observations', ov.data.documents], ['Sources healthy', `${ov.data.sources.healthy}/${ov.data.sources.enabled}`]].map(([k, v]) => <Card key={String(k)} className="p-4"><p className="text-xs text-ink-3">{k}</p><p className="text-2xl font-bold tabular-nums">{v}</p></Card>)}
        </div>
      )}
      <Tabs tabs={[{ id: 'topics', label: 'Trends' }, { id: 'sources', label: `Sources (${sources.data?.items.length ?? 0})` }, { id: 'demand', label: 'Internal demand & prices' }]} value={tab} onChange={setTab} />
      {tab === 'topics' && (
        <div className="mt-4">
          <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Trend status">{TABS.map(([v, l]) => <button key={v} role="tab" aria-selected={status === v} onClick={() => { setStatus(v); setPage(1); }} className={`rounded-full border px-3 py-1 text-sm ${status === v ? 'border-pine-600 bg-pine-50 font-bold text-pine-700' : 'border-line-strong text-ink-2'}`}>{l}{v && ov.data ? ` · ${ov.data.statusCounts[v] ?? 0}` : ''}</button>)}</div>
          <Toolbar><SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search topics" /><FilterSelect label="Country" value={country} onChange={(v) => { setCountry(v); setPage(1); }} options={[['', 'All countries'], ['US', 'USA'], ['CA', 'Canada'], ['IN', 'India']]} /><Input aria-label="Category" placeholder="Category" value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} className="max-w-40" /></Toolbar>
          {topics.error && !topics.data && <ErrorBox message={topics.error} retry={topics.reload} />}
          <Card><DataTable columns={tcols} rows={topics.data?.items} loading={topics.loading} rowKey={(t) => t.id} onRowClick={(t) => setOpen(t.id)} page={page} pageSize={20} total={topics.data?.total} onPage={setPage} empty={{ title: 'No topics with this status', body: (sources.data?.items.length ?? 0) ? 'Crawls run on a schedule; topics appear once sources have been crawled.' : 'Add a public source (RSS, sitemap, listing page…) under Sources to start collecting evidence.' }} /></Card>
        </div>
      )}
      {tab === 'sources' && (
        <div className="mt-4">
          <div className="mb-3 flex items-center justify-between gap-3"><p className="text-sm text-ink-2">Only publicly accessible pages. Each crawl identifies itself, obeys robots.txt and Crawl-delay, backs off on errors and stops at logins, CAPTCHAs and paywalls.</p>{writable && <Button onClick={() => setForm({ ...blank })}>Add source</Button>}</div>
          {sources.error && !sources.data && <ErrorBox message={sources.error} retry={sources.reload} />}
          <Card><DataTable columns={scols} rows={sources.data?.items} loading={sources.loading} rowKey={(s) => s.id} empty={{ title: 'No sources yet', body: 'Add a public RSS/Atom feed, XML sitemap or listing page.' }} /></Card>
        </div>
      )}
      {tab === 'demand' && (ov.data ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Panel title="What shoppers search for on Orvia" subtitle="Last 7 days vs the 7 days before; searches with no results are unmet demand">
            {ov.data.internalDemand.length ? <ul className="divide-y divide-line text-sm">{ov.data.internalDemand.map((d) => <li key={d.query} className="flex items-center justify-between gap-3 py-2"><span><b>{d.query}</b> {d.noResults && <Badge tone="warn">no results</Badge>}</span><span className="tabular-nums text-ink-2">{d.last7d} <span className="text-ink-3">(prev {d.previous7d})</span></span></li>)}</ul> : <p className="text-sm text-ink-3">No searches recorded yet.</p>}
          </Panel>
          <Panel title="Competitor price movement" subtitle="Median observed price change, topics with ≥3 observations">
            {ov.data.priceMovement.length ? <ul className="divide-y divide-line text-sm">{ov.data.priceMovement.map((m) => <li key={m.name} className="flex items-center justify-between gap-3 py-2"><b>{m.name}</b><span className="tabular-nums">${(m.median / 100).toFixed(2)} <span className={m.velocityPct >= 0 ? 'text-ok-500' : 'text-coral-500'}>{m.velocityPct > 0 ? '+' : ''}{m.velocityPct}%</span></span></li>)}</ul> : <p className="text-sm text-ink-3">Not enough competitor price observations yet (confidence stays LOW and pricing uses safe fallbacks).</p>}
          </Panel>
          <p className="text-xs text-ink-3 lg:col-span-2">{ov.data.note}</p>
        </div>
      ) : <Loading />)}

      <Drawer open={!!open} onClose={() => setOpen(null)} title={det.data?.topic.name ?? 'Topic'} width="sm:max-w-2xl">
        {!det.data ? <div className="p-5"><Loading /></div> : (
          <div className="space-y-5 p-5">
            <div className="flex flex-wrap items-center gap-2"><Badge tone={STATUS_TONE[det.data.topic.status] ?? 'neutral'}>{det.data.topic.status.replace('_', ' ')}</Badge><span className="text-sm">Score <b>{det.data.topic.trendScore}</b> · confidence <b>{Math.round(det.data.topic.confidence * 100)}%</b></span></div>
            <section><h3 className="font-bold">Why</h3><pre className="mt-2 whitespace-pre-wrap rounded-lg bg-sunken p-3 text-sm leading-relaxed">{det.data.explanation.text}</pre>{det.data.explanation.warnings.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-ink-3">{det.data.explanation.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}</section>
            {det.data.topic.components && <section><h3 className="font-bold">Score components</h3><ul className="mt-2 grid gap-1.5 text-sm sm:grid-cols-2">{Object.entries(det.data.topic.components).map(([k, c]) => <li key={k} className="flex items-center justify-between rounded-md border border-line px-3 py-1.5"><span>{k}</span><span className="tabular-nums">{c.available ? Math.round(c.score * 100) : <span className="text-ink-3" title="No data — a neutral value is used">unknown</span>}</span></li>)}</ul></section>}
            {det.data.topic.windows && <section><h3 className="font-bold">Windows</h3><div className="mt-2 flex flex-wrap gap-2 text-xs">{Object.entries(det.data.topic.windows).map(([k, w]) => <span key={k} className={`rounded-full border px-2.5 py-1 ${w.sufficient ? 'border-line-strong' : 'border-dashed text-ink-3'}`} title={w.sufficient ? '' : 'not enough history for this window'}>{k}: {w.observations} obs / {w.sources} src</span>)}</div></section>}
            <section><h3 className="font-bold">Latest observations</h3><ul className="mt-2 divide-y divide-line text-sm">{det.data.documents.map((d, i) => <li key={i} className="py-2"><b>{d.title}</b> <span className="text-ink-3">· {d.source} · {when(d.observedAt)}</span>{d.price ? <span> · ${(d.price / 100).toFixed(2)}</span> : null}{d.sourceUrl && <a className="ml-2 text-pine-700 underline" href={d.sourceUrl} target="_blank" rel="noreferrer noopener">source</a>}</li>)}</ul></section>
          </div>
        )}
      </Drawer>

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? `Edit ${form.name}` : 'Add market source'} size="lg" footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button loading={busy === 'save'} disabled={!form?.name} onClick={() => void save()}>Save</Button></>}>
        {form && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Type"><Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, parserConfig: form.parserConfig || HINTS[e.target.value] || '' })}>{(sources.data?.types ?? ['RSS']).filter((t) => !['SUPPLIER', 'INTERNAL_ANALYTICS'].includes(t)).map((t) => <option key={t}>{t}</option>)}</Select></Field>
              <Field label="URL" className="sm:col-span-2" hint="A public feed, sitemap, listing or product page. Private/internal addresses are rejected."><Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://…" /></Field>
              <Field label="Country"><Select value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}><option value="">All</option><option value="US">USA</option><option value="CA">Canada</option><option value="IN">India</option></Select></Field>
              <Field label="Category"><Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="pet, kids, fashion, gadgets…" /></Field>
              <Field label="Crawl every (minutes)" hint="Minimum 15; failures back off automatically"><Input inputMode="numeric" value={form.crawlIntervalMinutes} onChange={(e) => setForm({ ...form, crawlIntervalMinutes: Number(e.target.value) || 360 })} /></Field>
              {form.type === 'SITEMAP' && <Field label="Product pages to read per crawl" hint="0 = names and dates only"><Input inputMode="numeric" value={form.fetchProductPages} onChange={(e) => setForm({ ...form, fetchProductPages: Number(e.target.value) || 0 })} /></Field>}
            </div>
            <Checkbox checked={form.robotsRequired} onChange={(e) => setForm({ ...form, robotsRequired: (e.target as HTMLInputElement).checked })} label="Respect robots.txt (strongly recommended — turning it off is only for sites you own)" />
            {['HTML_LISTING', 'JSON_PUBLIC'].includes(form.type) && <Field label="Extraction rules (JSON)" hint="CSS selectors for listings, dotted paths for JSON"><Textarea className="min-h-28 font-mono text-xs" value={form.parserConfig} onChange={(e) => setForm({ ...form, parserConfig: e.target.value })} spellCheck={false} /></Field>}
          </div>
        )}
      </Modal>
    </>
  );
}
