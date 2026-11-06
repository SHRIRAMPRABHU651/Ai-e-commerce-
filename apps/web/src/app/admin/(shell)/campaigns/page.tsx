'use client';
import * as React from 'react';
import { Badge, Button, Card, Field, Input, Select, Tabs, Textarea } from '@orvia/ui';
import { ErrorBox, Loading, PageHeader, Panel, pctf, useAction, useAdmin, useFetch, usd, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

const PROVIDERS = ['meta', 'tiktok', 'ga4', 'google_ads'];
const Empty = ({ children }: { children: React.ReactNode }) => <p className="py-6 text-center text-sm text-ink-3">{children}</p>;

interface Health { mode: string; suppressedNoConsentLast24h: number; providers: { provider: string; label: string; enabled: boolean; configured: boolean; missingCredentials: string[]; mode: string | null; pending: number; dead: number; sentLast24h: number; lastSuccessAt: string | null; lastError: string | null }[] }
function HealthTab() {
  const { can } = useAdmin();
  const { data, error, reload } = useFetch<Health>('/admin/campaigns/health', 30_000);
  const { run, busy } = useAction();
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className="space-y-4">
      <Card className="p-4 text-sm text-ink-2">Events mode: <b>{data.mode}</b>{data.mode === 'log' && ' (events are recorded, nothing is delivered to platforms)'}. Without recorded consent events are suppressed and never sent ({data.suppressedNoConsentLast24h} suppressed in 24h). All adapters are implemented against public vendor docs and <b>unverified against live accounts</b>.</Card>
      <div className="grid gap-4 md:grid-cols-2">
        {data.providers.map((p) => (
          <Panel key={p.provider} title={p.label} action={<Badge tone={!p.enabled ? 'neutral' : p.configured ? 'ok' : 'warn'}>{!p.enabled ? 'not enabled' : p.configured ? 'configured' : 'credentials missing'}</Badge>}>
            <dl className="grid grid-cols-2 gap-y-1 text-sm"><dt className="text-ink-3">Mode</dt><dd>{p.mode ?? '—'}</dd><dt className="text-ink-3">Outbox depth</dt><dd>{p.pending}</dd><dt className="text-ink-3">Dead letters</dt><dd className={p.dead ? 'font-bold text-coral-500' : ''}>{p.dead}</dd><dt className="text-ink-3">Sent (24h)</dt><dd>{p.sentLast24h}</dd><dt className="text-ink-3">Last success</dt><dd>{when(p.lastSuccessAt)}</dd></dl>
            {p.missingCredentials.length > 0 && <p className="mt-2 text-xs text-ink-3">Missing: {p.missingCredentials.join(', ')}</p>}
            {p.lastError && <p className="mt-2 break-words text-xs text-coral-500">Last error: {p.lastError}</p>}
            {can('marketing:write') && p.dead > 0 && <Button className="mt-3" size="sm" loading={busy === p.provider} onClick={() => void run(p.provider, async () => { await api('/admin/campaigns/outbox/retry', { body: { provider: p.provider } }); await reload(); }, 'Dead letters re-queued')}>Retry dead letters</Button>}
          </Panel>
        ))}
      </div>
    </div>
  );
}

interface Outbox { total: number; items: { id: string; provider: string; name: string; status: string; attempts: number; nextAttemptAt: string; sentAt?: string; lastError?: string; skipReason?: string; source?: string; event: { eventId: string; data: Record<string, unknown>; user: Record<string, unknown> } }[] }
function StreamTab() {
  const { can } = useAdmin();
  const [status, setStatus] = React.useState(''); const [provider, setProvider] = React.useState(''); const [page, setPage] = React.useState(1);
  const qs = `page=${page}&pageSize=25${status ? `&status=${status}` : ''}${provider ? `&provider=${provider}` : ''}`;
  const { data, error, reload } = useFetch<Outbox>(`/admin/campaigns/outbox?${qs}`);
  const { run, busy } = useAction();
  return (
    <Panel title="Event stream" subtitle="Recent outbox events. Identifiers are shown as truncated hashes; no raw email or phone is ever stored." action={<div className="flex gap-2"><Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option>{['pending', 'sending', 'sent', 'dead', 'skipped', 'suppressed'].map((s) => <option key={s}>{s}</option>)}</Select><Select aria-label="Provider" value={provider} onChange={(e) => { setProvider(e.target.value); setPage(1); }}><option value="">All providers</option>{PROVIDERS.map((s) => <option key={s}>{s}</option>)}</Select></div>}>
      {error && !data ? <ErrorBox message={error} retry={reload} /> : !data ? <Loading /> : !data.items.length ? <Empty>No events yet. Events appear once a provider is enabled (EVENTS_PROVIDERS) and orders are paid.</Empty> : (
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="text-ink-3"><th className="py-2">Event</th><th>Provider</th><th>Status</th><th>Tries</th><th>Detail</th><th /></tr></thead><tbody>
          {data.items.map((r) => (<tr key={r.id} className="border-t border-line align-top"><td className="py-2"><p className="font-semibold">{r.name}</p><p className="break-all text-xs text-ink-3">{r.event.eventId}</p></td><td>{r.provider}</td><td><Badge tone={r.status === 'sent' ? 'ok' : r.status === 'dead' ? 'coral' : r.status === 'pending' ? 'info' : 'neutral'}>{r.status}</Badge></td><td>{r.attempts}</td><td className="max-w-xs break-words text-xs text-ink-3">{r.skipReason ?? r.lastError ?? (r.sentAt ? `sent ${when(r.sentAt)}` : `next ${when(r.nextAttemptAt)}`)}</td><td>{can('marketing:write') && r.status === 'dead' && <Button size="sm" variant="secondary" loading={busy === r.id} onClick={() => void run(r.id, async () => { await api('/admin/campaigns/outbox/retry', { body: { id: r.id } }); await reload(); }, 'Re-queued')}>Retry</Button>}</td></tr>))}
        </tbody></table></div>
      )}
      {data && data.total > 25 && <div className="mt-3 flex items-center gap-2 text-sm"><Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><span>Page {page} of {Math.ceil(data.total / 25)}</span><Button size="sm" variant="secondary" disabled={page * 25 >= data.total} onClick={() => setPage(page + 1)}>Next</Button></div>}
    </Panel>
  );
}

interface Rule { field: string; op: string; value: unknown }
interface Seg { items: { id: string; name: string; description?: string; rules: Rule[] }[]; presets: { name: string; description: string; rules: Rule[] }[] }
interface Preview { count: number; emailableCount: number; sample: string[]; truncated: boolean }
const ruleText = (r: Rule) => `${r.field} ${r.op} ${Array.isArray(r.value) ? (r.value as string[]).join('/') : String(r.value)}`;
function SegmentsTab() {
  const { can } = useAdmin();
  const { data, error, reload } = useFetch<Seg>('/admin/campaigns/segments');
  const { run, busy } = useAction();
  const [prev, setPrev] = React.useState<Record<string, Preview>>({});
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading />;
  const preview = (key: string, rules: Rule[]) => run(`p${key}`, async () => { setPrev((p) => ({ ...p, [key]: undefined as never })); const r = await api<Preview>('/admin/campaigns/segments/preview', { body: { rules } }); setPrev((p) => ({ ...p, [key]: r })); });
  const card = (key: string, name: string, desc: string | undefined, rules: Rule[], save?: boolean) => (
    <Card key={key} className="p-4"><p className="font-bold">{name}</p><p className="text-sm text-ink-3">{desc}</p><p className="mt-1 text-xs text-ink-3">{rules.map(ruleText).join(' AND ')}</p>
      {prev[key] && <p className="mt-2 text-sm"><b>{prev[key].count}</b> match, <b>{prev[key].emailableCount}</b> with marketing consent{prev[key].truncated && ' (scan truncated at 20,000 customers)'}. Sample: {prev[key].sample.join(', ') || '—'}</p>}
      <div className="mt-3 flex gap-2"><Button size="sm" variant="secondary" loading={busy === `p${key}`} onClick={() => void preview(key, rules)}>Count</Button>{save && can('marketing:write') && <Button size="sm" loading={busy === `s${key}`} onClick={() => void run(`s${key}`, async () => { await api('/admin/campaigns/segments', { body: { name, description: desc, rules } }); await reload(); }, 'Segment saved')}>Save</Button>}</div></Card>
  );
  return (
    <div className="space-y-4">
      <Panel title="Your segments" subtitle="Rules run on real order and customer data when you press Count (nothing is cached or invented).">
        {!data.items.length ? <Empty>No saved segments. Save one from the presets below.</Empty> : <div className="grid gap-3 md:grid-cols-2">{data.items.map((s) => card(s.id, s.name, s.description, s.rules))}</div>}
      </Panel>
      <Panel title="Presets">{<div className="grid gap-3 md:grid-cols-2">{data.presets.map((s) => card(`preset-${s.name}`, s.name, s.description, s.rules, true))}</div>}</Panel>
    </div>
  );
}

interface Camp { total: number; dailyLimit: number; items: { id: string; name: string; status: string; subject: string; segmentId: string; scheduledAt?: string; plan?: { eligible: number; excludedNoConsent: number; excludedUnsubscribed: number; excludedFrequency: number; excludedCap: number } }[] }
interface CampResults { delivery: { sent: number; loggedNotDelivered: number; failed: number; skippedNoProvider: number; queued: number }; clicks: { uniqueClickers: number; totalClicks: number }; recipients: { planned: number; skippedAtSend: number }; note: string }
function EmailTab() {
  const { can } = useAdmin();
  const { data, error, reload } = useFetch<Camp>('/admin/campaigns/email?pageSize=50');
  const segs = useFetch<Seg>('/admin/campaigns/segments');
  const { run, busy } = useAction();
  const [f, setF] = React.useState({ name: '', segmentId: '', subject: '', message: '', ctaLabel: '', ctaUrl: '', maxRecipients: '1000' });
  const [res, setRes] = React.useState<Record<string, CampResults>>({});
  const [when_, setWhen] = React.useState('');
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading />;
  const valid = f.name.length >= 2 && f.segmentId && f.subject.length >= 2 && f.message.length >= 2;
  return (
    <div className="space-y-4">
      {can('marketing:write') && (
        <Panel title="New campaign" subtitle={`Only customers with recorded marketing consent who have not unsubscribed are emailed. Daily limit ${data.dailyLimit}; 3-day per-recipient cap.`}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Segment"><Select value={f.segmentId} onChange={(e) => setF({ ...f, segmentId: e.target.value })}><option value="">Choose…</option>{segs.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
            <Field label="Subject"><Input value={f.subject} maxLength={140} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
            <Field label="Max recipients"><Input inputMode="numeric" value={f.maxRecipients} onChange={(e) => setF({ ...f, maxRecipients: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Field label="Message" hint="Plain text; blank line starts a new paragraph. An unsubscribe footer is added automatically."><Textarea rows={5} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field></div>
            <Field label="Button label (optional)"><Input value={f.ctaLabel} onChange={(e) => setF({ ...f, ctaLabel: e.target.value })} /></Field>
            <Field label="Button link (store URL, optional)"><Input value={f.ctaUrl} placeholder="https://…" onChange={(e) => setF({ ...f, ctaUrl: e.target.value })} /></Field>
          </div>
          <Button className="mt-4" disabled={!valid} loading={busy === 'create'} onClick={() => void run('create', async () => { await api('/admin/campaigns/email', { body: { ...f, maxRecipients: Number(f.maxRecipients) || 1000, ctaLabel: f.ctaLabel || undefined, ctaUrl: f.ctaUrl || undefined } }); setF({ ...f, name: '', subject: '', message: '' }); await reload(); }, 'Draft created')}>Create draft</Button>
        </Panel>
      )}
      <Panel title="Campaigns">
        {!data.items.length ? <Empty>No campaigns yet.</Empty> : <div className="space-y-3">{data.items.map((c) => (
          <Card key={c.id} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-bold">{c.name}</p><p className="text-sm text-ink-3">{c.subject}</p></div><Badge tone={c.status === 'sent' ? 'ok' : c.status === 'sending' ? 'info' : c.status === 'failed' || c.status === 'cancelled' ? 'coral' : 'neutral'}>{c.status}{c.scheduledAt && c.status === 'scheduled' ? ` · ${when(c.scheduledAt)}` : ''}</Badge></div>
            {c.plan && <p className="mt-2 text-xs text-ink-3">Planned {c.plan.eligible} · excluded: no consent {c.plan.excludedNoConsent}, unsubscribed {c.plan.excludedUnsubscribed}, recently emailed {c.plan.excludedFrequency}, caps {c.plan.excludedCap}</p>}
            {res[c.id] && <p className="mt-2 text-sm">Sent {res[c.id]!.delivery.sent} · dev-log (not delivered) {res[c.id]!.delivery.loggedNotDelivered} · failed {res[c.id]!.delivery.failed} · queued {res[c.id]!.delivery.queued} · skipped at send {res[c.id]!.recipients.skippedAtSend} · clicks {res[c.id]!.clicks.totalClicks} ({res[c.id]!.clicks.uniqueClickers} people). <span className="text-xs text-ink-3">{res[c.id]!.note}</span></p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" loading={busy === `r${c.id}`} onClick={() => void run(`r${c.id}`, async () => { const r = await api<CampResults>(`/admin/campaigns/email/${c.id}/results`); setRes((x) => ({ ...x, [c.id]: r })); })}>Results</Button>
              {can('marketing:write') && ['draft', 'scheduled'].includes(c.status) && <>
                <Button size="sm" variant="secondary" loading={busy === `t${c.id}`} onClick={() => void run(`t${c.id}`, async () => { await api(`/admin/campaigns/email/${c.id}/test-send`, { body: {} }); }, 'Test sent to your own account email')}>Test send</Button>
                <Button size="sm" loading={busy === `s${c.id}`} onClick={() => { if (window.confirm('Send now to all consenting members of this segment?')) void run(`s${c.id}`, async () => { await api(`/admin/campaigns/email/${c.id}/send`, { body: {} }); await reload(); }, 'Sending started'); }}>Send now</Button>
                <Input aria-label="Schedule time" type="datetime-local" className="w-auto" value={when_} onChange={(e) => setWhen(e.target.value)} />
                <Button size="sm" variant="secondary" disabled={!when_} loading={busy === `c${c.id}`} onClick={() => void run(`c${c.id}`, async () => { await api(`/admin/campaigns/email/${c.id}/schedule`, { body: { scheduledAt: new Date(when_).toISOString() } }); await reload(); }, 'Scheduled')}>Schedule</Button>
              </>}
              {can('marketing:write') && ['draft', 'scheduled', 'sending'].includes(c.status) && <Button size="sm" variant="secondary" loading={busy === `x${c.id}`} onClick={() => void run(`x${c.id}`, async () => { await api(`/admin/campaigns/email/${c.id}/cancel`, { body: {} }); await reload(); }, 'Cancelled')}>Cancel</Button>}
            </div>
          </Card>))}</div>}
      </Panel>
    </div>
  );
}

interface Exps { items: { key: string; name: string; status: string; conversionEvent: string; variants: { key: string; weight: number }[] }[] }
interface ExpRes { overall: string; variants: { key: string; exposures: number; conversions: number; rate: number | null; verdict: string; summary: string }[] }
function ExperimentsTab() {
  const { can } = useAdmin();
  const { data, error, reload } = useFetch<Exps>('/admin/campaigns/experiments');
  const { run, busy } = useAction();
  const [res, setRes] = React.useState<Record<string, ExpRes>>({});
  const [f, setF] = React.useState({ key: '', name: '', conversionEvent: 'purchase', variants: 'control:50,variant-b:50' });
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading />;
  const parse = () => f.variants.split(',').map((s) => { const [k, w] = s.split(':'); return { key: (k ?? '').trim(), weight: Number(w) || 50 }; });
  return (
    <div className="space-y-4">
      <Card className="p-4 text-sm text-ink-2">Experiments only measure. Nothing is ever shipped automatically; a person changes the page after reading the result. Pages call <code>useExperiment(&apos;key&apos;)</code> and render the control while the variant is null.</Card>
      {can('marketing:write') && <Panel title="New experiment"><div className="grid gap-3 sm:grid-cols-2">
        <Field label="Key" hint="lowercase, digits, - or _"><Input value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} /></Field><Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Conversion event"><Select value={f.conversionEvent} onChange={(e) => setF({ ...f, conversionEvent: e.target.value })}>{['add_to_cart', 'begin_checkout', 'purchase', 'signup', 'custom'].map((s) => <option key={s}>{s}</option>)}</Select></Field>
        <Field label="Variants (first = control)" hint="key:weight, comma separated"><Input value={f.variants} onChange={(e) => setF({ ...f, variants: e.target.value })} /></Field></div>
        <Button className="mt-4" loading={busy === 'create'} disabled={!f.key || !f.name} onClick={() => void run('create', async () => { await api('/admin/campaigns/experiments', { body: { key: f.key, name: f.name, conversionEvent: f.conversionEvent, variants: parse() } }); await reload(); }, 'Experiment created (draft)')}>Create</Button></Panel>}
      <Panel title="Experiments">{!data.items.length ? <Empty>No experiments yet.</Empty> : <div className="space-y-3">{data.items.map((e) => (
        <Card key={e.key} className="p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-bold">{e.name} <span className="text-xs font-normal text-ink-3">{e.key}</span></p><p className="text-xs text-ink-3">Goal: {e.conversionEvent} · {e.variants.map((v) => `${v.key} ${v.weight}`).join(' / ')}</p></div><Badge tone={e.status === 'running' ? 'ok' : 'neutral'}>{e.status}</Badge></div>
          {res[e.key] && <div className="mt-3 space-y-1 text-sm"><p className="font-semibold">{res[e.key]!.overall}</p>{res[e.key]!.variants.map((v) => <p key={v.key}><b>{v.key}</b>: {v.exposures} visitors, {v.conversions} conversions ({pctf(v.rate)}). <span className="text-ink-3">{v.summary}</span></p>)}</div>}
          <div className="mt-3 flex gap-2"><Button size="sm" variant="secondary" loading={busy === `r${e.key}`} onClick={() => void run(`r${e.key}`, async () => { const r = await api<ExpRes>(`/admin/campaigns/experiments/${e.key}/results`); setRes((x) => ({ ...x, [e.key]: r })); })}>Results</Button>
            {can('marketing:write') && e.status === 'draft' && <Button size="sm" loading={busy === `a${e.key}`} onClick={() => void run(`a${e.key}`, async () => { await api(`/admin/campaigns/experiments/${e.key}/start`, { body: {} }); await reload(); }, 'Started')}>Start</Button>}
            {can('marketing:write') && e.status === 'running' && <Button size="sm" variant="secondary" loading={busy === `b${e.key}`} onClick={() => void run(`b${e.key}`, async () => { await api(`/admin/campaigns/experiments/${e.key}/stop`, { body: {} }); await reload(); }, 'Stopped')}>Stop</Button>}</div></Card>))}</div>}</Panel>
    </div>
  );
}

interface Attr { model: string; days: number; totalOrders: number; attributionCoverage: number | null; caveats: string[]; channels: { channel: string; orders: number; netSalesUsd: number; contributionKnownOrders: number; contributionUsd: number; adSpendUsd: number; cacUsd: number | null; retainedContributionUsd: number | null; contributionPerOrderAfterCacUsd: number | null; guidance: string }[]; measuredCpaStore: { channel: string; cpaUsd: number | null; orders: number }[] }
interface Prod { items: { productId: string; title: string; views: number; carts: number; orders: number; netSalesUsd: number; contributionUsd: number; viewToCart: number | null; cartToOrder: number | null }[] }
interface Life { consentedCartsByStage: { stage: number; carts: number }[]; cartsWithEmail: number; convertedCarts: number; note: string }
function ReportsTab() {
  const [days, setDays] = React.useState('30'); const [model, setModel] = React.useState('last');
  const a = useFetch<Attr>(`/admin/campaigns/attribution?days=${days}&model=${model}`);
  const p = useFetch<Prod>(`/admin/campaigns/products?days=${days}`);
  const l = useFetch<Life>('/admin/campaigns/lifecycle');
  return (
    <div className="space-y-4">
      <div className="flex gap-2"><Select aria-label="Window" value={days} onChange={(e) => setDays(e.target.value)}>{['7', '30', '90'].map((d) => <option key={d} value={d}>{d} days</option>)}</Select><Select aria-label="Attribution model" value={model} onChange={(e) => setModel(e.target.value)}><option value="last">Last touch</option><option value="first">First touch</option></Select></div>
      <Panel title="Channels: contribution after ad spend" subtitle="Guidance is by retained contribution, not clicks or platform ROAS. Proposal-only: nothing here changes any budget.">
        {a.error && !a.data ? <ErrorBox message={a.error} retry={a.reload} /> : !a.data ? <Loading /> : !a.data.channels.length ? <Empty>No paid orders in this window.</Empty> : <>
          <p className="mb-2 text-xs text-ink-3">{a.data.totalOrders} paid orders · attribution coverage {pctf(a.data.attributionCoverage, 0)}</p>
          <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="text-ink-3"><th className="py-2">Channel</th><th>Orders</th><th>Net sales</th><th>Contribution</th><th>Ad spend</th><th>CAC</th><th>Retained</th><th>Guidance</th></tr></thead><tbody>
            {a.data.channels.map((c) => <tr key={c.channel} className="border-t border-line align-top"><td className="py-2 font-semibold">{c.channel}</td><td>{c.orders}</td><td>{usd(c.netSalesUsd)}</td><td>{c.contributionKnownOrders ? usd(c.contributionUsd) : '—'}</td><td>{c.adSpendUsd ? usd(c.adSpendUsd) : '—'}</td><td>{usd(c.cacUsd)}</td><td className={c.retainedContributionUsd !== null && c.retainedContributionUsd < 0 ? 'font-bold text-coral-500' : ''}>{usd(c.retainedContributionUsd)}</td><td className="max-w-xs text-xs text-ink-3">{c.guidance}</td></tr>)}
          </tbody></table></div>
          {a.data.measuredCpaStore.length > 0 && <p className="mt-3 text-xs text-ink-3">Existing measured store CPA (read-only): {a.data.measuredCpaStore.map((m) => `${m.channel} ${usd(m.cpaUsd)} (${m.orders} orders)`).join(' · ')}</p>}
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-ink-3">{a.data.caveats.map((c) => <li key={c}>{c}</li>)}</ul></>}
      </Panel>
      <Panel title="Product performance: views to carts to orders to net sales">
        {p.error && !p.data ? <ErrorBox message={p.error} retry={p.reload} /> : !p.data ? <Loading /> : !p.data.items.length ? <Empty>No product activity in this window.</Empty> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="text-ink-3"><th className="py-2">Product</th><th>Views</th><th>Carts</th><th>Orders</th><th>Net sales</th><th>Contribution</th></tr></thead><tbody>{p.data.items.map((r) => <tr key={r.productId} className="border-t border-line"><td className="py-2">{r.title}</td><td>{r.views}</td><td>{r.carts} <span className="text-xs text-ink-3">({pctf(r.viewToCart)})</span></td><td>{r.orders} <span className="text-xs text-ink-3">({pctf(r.cartToOrder)})</span></td><td>{usd(r.netSalesUsd)}</td><td>{usd(r.contributionUsd)}</td></tr>)}</tbody></table></div>}
      </Panel>
      <Panel title="Lifecycle: abandoned carts" subtitle="Existing consent-based recovery sequence.">
        {l.error && !l.data ? <ErrorBox message={l.error} retry={l.reload} /> : !l.data ? <Loading /> : <p className="text-sm">Carts with email: <b>{l.data.cartsWithEmail}</b> · converted carts: <b>{l.data.convertedCarts}</b> · opted-in carts by stage: {l.data.consentedCartsByStage.length ? l.data.consentedCartsByStage.map((s) => `stage ${s.stage}: ${s.carts}`).join(', ') : 'none'}. <span className="text-xs text-ink-3">{l.data.note}</span></p>}
      </Panel>
    </div>
  );
}

interface Feeds { countries: { country: string; listed: number; excluded: Record<string, number>; google: string; meta: string }[] }
function FeedsTab() {
  const { data, error, reload } = useFetch<Feeds>('/admin/campaigns/feeds');
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading />;
  return (
    <Panel title="Product feeds" subtitle="Generated from the live sellable catalogue: real images, valid prices, honest availability, no compare-at prices. Add these URLs in Merchant Center / Meta Commerce Manager.">
      <div className="space-y-3">{data.countries.map((c) => <Card key={c.country} className="p-4 text-sm"><p className="font-bold">{c.country}: {c.listed} products listed</p><p className="text-xs text-ink-3">Excluded: {Object.entries(c.excluded).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}</p><p className="mt-2 flex flex-wrap gap-3"><a className="underline" href={`/feeds/google/${c.country}.xml`} target="_blank" rel="noreferrer">Google Merchant (XML)</a><a className="underline" href={`/feeds/meta/${c.country}.csv`} target="_blank" rel="noreferrer">Meta catalogue (CSV)</a></p></Card>)}</div>
      <p className="mt-3 text-xs text-ink-3">The storefront serves one URL per page for every country (country comes from a cookie / geo header), so feeds link to that URL and no hreflang is emitted.</p>
    </Panel>
  );
}

export default function Page() {
  const [tab, setTab] = React.useState('health');
  return (
    <>
      <PageHeader title="Tracking & campaigns" subtitle="Conversion events, consent, segments, email campaigns, experiments, attribution and feeds." />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ id: 'health', label: 'Integrations' }, { id: 'stream', label: 'Event stream' }, { id: 'segments', label: 'Segments' }, { id: 'email', label: 'Email' }, { id: 'experiments', label: 'Experiments' }, { id: 'reports', label: 'Attribution' }, { id: 'feeds', label: 'Feeds' }]} />
      {tab === 'health' && <HealthTab />}{tab === 'stream' && <StreamTab />}{tab === 'segments' && <SegmentsTab />}{tab === 'email' && <EmailTab />}{tab === 'experiments' && <ExperimentsTab />}{tab === 'reports' && <ReportsTab />}{tab === 'feeds' && <FeedsTab />}
    </>
  );
}
