'use client';
import * as React from 'react';
import { Badge, Button, DataTable, EmptyState, Field, Input, Modal, Select, Tabs, Textarea } from '@orvia/ui';
import type { Column } from '@orvia/ui';
import { ErrorBox, Loading, PageHeader, Panel, pctf, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

const STATES = ['invited', 'profile_submitted', 'documents', 'technical_integration', 'verification', 'probation', 'approved', 'suspended'];
const TYPES = ['api', 'feed', 'manual', 'manufacturer', 'wholesaler', 'regional_distributor', 'print_on_demand', 'local_fulfilment'];
const tone = (s?: string | null) => (s === 'approved' || s === 'passed' || s === 'ok' || s === 'verified' || s === 'matched' ? 'ok' : s === 'suspended' || s === 'failed' || s === 'critical' || s === 'rejected' ? 'coral' : s === 'warning' || s === 'discrepancies' || s === 'expired' ? 'warn' : 'neutral') as 'ok' | 'coral' | 'warn' | 'neutral';

interface Sup { id: string; code: string; name: string; provider: string; state?: string; supplierType?: string; productionReady: boolean; productionReadyUntil?: string; sla?: { worst?: string } | null }
interface Overview { pipeline: { state: string; count: number }[]; suppliers: Sup[]; enforcement: { enforced: boolean; appEnv: string }; adapters: { definitions: { key: string; name: string; integrationStatus: string; orderingMode: string; notes: string }[]; planned: { name: string }[] } }
interface Step { kind: string; required: boolean; status: string; effective: string; validUntil?: string; evidence: { at: string; operator: string; method: string; outcome: string; summary: string }[] }
interface Detail { supplier: { code: string; name: string; provider: string; sandbox?: boolean }; profile: { state: string; history: { to: string; at: string; by: string; reason?: string }[] } | null; documents: { id: string; kind: string; title: string; status: string; expiresAt?: string }[]; verification: { readiness: { ready: boolean; missing: string[]; validUntil?: string }; steps: Step[] }; credentials: { fields: string[]; lastRotatedAt?: string; rotationDue: boolean }; users: { email: string }[] }

function Pipeline({ onOpen }: { onOpen: (id: string) => void }) {
  const { can } = useAdmin();
  const { data, error, loading, reload } = useFetch<Overview>('/admin/supplier-network/overview', 60_000);
  const { run, busy } = useAction();
  const [inv, setInv] = React.useState<{ code: string; name: string; email: string; supplierType: string; provider: string } | null>(null);
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? 'Could not load'} retry={reload} />;
  const cols: Column<Sup>[] = [
    { key: 'n', header: 'Supplier', render: (s) => <div><p className="font-semibold">{s.name}</p><p className="text-xs text-ink-3">{s.code} · {s.provider}</p></div> },
    { key: 's', header: 'State', render: (s) => <Badge tone={tone(s.state)}>{s.state ?? 'legacy'}</Badge> },
    { key: 't', header: 'Type', hideBelow: 'md', render: (s) => s.supplierType ?? '—' },
    { key: 'p', header: 'Production ready', render: (s) => <Badge tone={s.productionReady ? 'ok' : 'neutral'}>{s.productionReady ? `until ${when(s.productionReadyUntil)}` : 'no'}</Badge> },
    { key: 'l', header: 'SLA', hideBelow: 'md', render: (s) => <Badge tone={tone(s.sla?.worst)}>{s.sla?.worst ?? 'no data'}</Badge> },
  ];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">{data.pipeline.map((p) => <div key={p.state} className="rounded-lg border border-line bg-surface p-3"><p className="text-[11px] font-bold uppercase text-ink-3">{p.state.replace('_', ' ')}</p><p className="text-xl font-bold">{p.count}</p></div>)}</div>
      <p className="text-sm text-ink-3">Production routing guard: <b>{data.enforcement.enforced ? 'ENFORCED' : 'off'}</b> (APP_ENV={data.enforcement.appEnv}). When enforced, only approved + production-ready suppliers receive new orders.</p>
      <Panel title="Suppliers" action={can('suppliers:write') ? <Button size="sm" onClick={() => setInv({ code: '', name: '', email: '', supplierType: 'manual', provider: 'manual' })}>Invite supplier</Button> : undefined} pad={false}>
        <DataTable columns={cols} rows={data.suppliers} rowKey={(s) => s.id} onRowClick={(s) => onOpen(s.id)} empty={{ title: 'No suppliers in the network yet', body: 'Invite a supplier to start onboarding.' }} />
      </Panel>
      <Panel title="Adapter coverage" subtitle="What each adapter is honestly able to do. None of them has been verified against a live vendor from this repository.">
        <ul className="space-y-2 text-sm">{data.adapters.definitions.map((a) => <li key={a.key}><b>{a.name}</b> <Badge>{a.integrationStatus}</Badge> <span className="text-ink-3">orders: {a.orderingMode}</span><p className="text-ink-3">{a.notes}</p></li>)}</ul>
        <p className="mt-3 text-xs text-ink-3">No adapter yet: {data.adapters.planned.map((p) => p.name).join(', ')}.</p>
      </Panel>
      <Modal open={!!inv} onClose={() => setInv(null)} title="Invite supplier" footer={<Button loading={busy === 'inv'} onClick={() => inv && run('inv', async () => { await api('/admin/supplier-network/suppliers', { body: { ...inv, servesCountries: [] } }); setInv(null); await reload(); }, 'Invitation sent')}>Send invitation</Button>}>
        {inv && <div className="space-y-3">
          <Field label="Code (lowercase, dashes)"><Input value={inv.code} onChange={(e) => setInv({ ...inv, code: e.target.value })} /></Field>
          <Field label="Company name"><Input value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} /></Field>
          <Field label="Contact email"><Input type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></Field>
          <Field label="Supplier type"><Select value={inv.supplierType} onChange={(e) => setInv({ ...inv, supplierType: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
          <Field label="Adapter"><Select value={inv.provider} onChange={(e) => setInv({ ...inv, provider: e.target.value })}>{['manual', 'rest', 'feed', 'cj'].map((t) => <option key={t}>{t}</option>)}</Select></Field>
        </div>}
      </Modal>
    </div>
  );
}

function SupplierDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAdmin();
  const { data, error, loading, reload } = useFetch<Detail>(`/admin/supplier-network/suppliers/${id}`);
  const { run, busy } = useAction();
  const [attest, setAttest] = React.useState<{ kind: string; summary: string; outcome: string; ref: string; refType: string; quoted: string; charged: string } | null>(null);
  const [to, setTo] = React.useState('');
  const [reason, setReason] = React.useState('');
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? 'Could not load'} retry={reload} />;
  const w = can('suppliers:write');
  const b = `/admin/supplier-network/suppliers/${id}`;
  const probe = (kind: string) => run(`p${kind}`, async () => {
    const body: Record<string, unknown> = {};
    if (kind === 'test_order_placement') {
      const live = !data.supplier.sandbox && data.supplier.provider !== 'mock';
      const c = window.prompt(live ? 'This supplier has no sandbox. A REAL, PAID order will be placed. Type PLACE LIVE TEST ORDER to continue:' : 'Type PLACE TEST ORDER to place a sandbox/test order:');
      if (!c) return;
      const addr = window.prompt('Test delivery address as: Full name; line1; city; postal code; country (2 letters)');
      const [fullName, line1, city, postalCode, country] = (addr ?? '').split(';').map((x) => x.trim());
      if (!country) throw new Error('Address incomplete');
      Object.assign(body, { confirm: c, acknowledgeLiveCost: live, address: { fullName, line1, city, region: '', postalCode, country } });
    }
    if (kind === 'cancellation') { const c = window.prompt('Type CANCEL TEST ORDER to cancel the test order'); if (!c) return; body['confirm'] = c; }
    const r = await api<{ outcome: string; summary: string }>(`${b}/verification/${kind}/probe`, { body });
    if (r.outcome === 'fail') throw new Error(r.summary);
    await reload();
  }, 'Probe recorded');
  const submitAttest = () => attest && run('attest', async () => {
    const ref = attest.ref.trim();
    const refs: Record<string, string> = ref ? { [attest.refType]: ref } : {};
    const metrics = attest.kind === 'price_quote_accuracy' ? { quotedMinor: Number(attest.quoted), chargedMinor: Number(attest.charged) } : undefined;
    await api(`${b}/verification/${attest.kind}/attest`, { body: { summary: attest.summary, outcome: attest.outcome, ...refs, ...(metrics ? { metrics } : {}) } });
    setAttest(null); await reload();
  }, 'Evidence recorded');
  const AUTO = ['catalogue_availability', 'price_quote_accuracy', 'stock_accuracy_sample', 'test_order_placement', 'cancellation', 'shipment_tracking'];
  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" onClick={onClose}>← All suppliers</Button>
      <h2 className="text-xl font-bold">{data.supplier.name} <Badge tone={tone(data.profile?.state)}>{data.profile?.state}</Badge></h2>
      <Panel title="Verification checklist" subtitle={data.verification.readiness.ready ? `Production-ready until ${when(data.verification.readiness.validUntil)}` : `Not production-ready. Missing: ${data.verification.readiness.missing.join(', ') || '—'}. An API that merely responds is not enough.`}>
        <ul className="divide-y divide-line">{data.verification.steps.map((s) => (
          <li key={s.kind} className="py-3">
            <div className="flex flex-wrap items-center gap-2"><b className="text-sm">{s.kind.replace(/_/g, ' ')}</b>{!s.required && <Badge>not required</Badge>}<Badge tone={tone(s.effective)}>{s.effective}</Badge>{s.validUntil && <span className="text-xs text-ink-3">valid until {when(s.validUntil)}</span>}
              {w && <span className="ml-auto flex gap-2">{AUTO.includes(s.kind) && <Button size="sm" variant="secondary" loading={busy === `p${s.kind}`} onClick={() => probe(s.kind)}>Run probe</Button>}<Button size="sm" variant="secondary" onClick={() => setAttest({ kind: s.kind, summary: '', outcome: 'pass', ref: '', refType: 'supplierOrderId', quoted: '', charged: '' })}>Attest</Button></span>}</div>
            {s.evidence.length === 0 ? <p className="mt-1 text-xs text-ink-3">No evidence recorded.</p> : <ul className="mt-1 space-y-0.5 text-xs text-ink-2">{s.evidence.slice(-3).map((e, i) => <li key={i}><Badge tone={tone(e.outcome === 'pass' ? 'passed' : e.outcome === 'fail' ? 'failed' : undefined)}>{e.outcome}</Badge> {when(e.at)} · {e.method} · {e.operator}: {e.summary}</li>)}</ul>}
          </li>))}</ul>
      </Panel>
      <Panel title="Onboarding" subtitle="Each move is gated: documents, integration and verification must be satisfied.">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Move to"><Select value={to} onChange={(e) => setTo(e.target.value)}><option value="">Select…</option>{STATES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
          <Field label="Reason (required to suspend)"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Button disabled={!w || !to} loading={busy === 'tr'} onClick={() => run('tr', async () => { await api(`${b}/transition`, { body: { to, reason: reason || undefined } }); setTo(''); await reload(); }, 'State updated')}>Apply</Button>
        </div>
        <ul className="mt-3 text-xs text-ink-3">{data.profile?.history.slice(-6).map((h, i) => <li key={i}>{when(h.at)}: → {h.to} ({h.by}){h.reason ? ` — ${h.reason}` : ''}</li>)}</ul>
      </Panel>
      <div className="grid gap-5 md:grid-cols-2">
        <Panel title="Documents">{data.documents.length === 0 ? <p className="text-sm text-ink-3">No documents uploaded.</p> : <ul className="space-y-2 text-sm">{data.documents.map((d) => <li key={d.id} className="flex flex-wrap items-center gap-2"><a className="font-semibold underline" href={`/api/v1${b}/documents/${d.id}/file`}>{d.title}</a><Badge>{d.kind}</Badge><Badge tone={tone(d.status)}>{d.status}</Badge>{d.expiresAt && <span className="text-xs text-ink-3">expires {when(d.expiresAt)}</span>}
          {w && d.status === 'pending' && <span className="ml-auto flex gap-1"><Button size="sm" variant="secondary" onClick={() => run('d', async () => { await api(`/admin/supplier-network/documents/${d.id}/review`, { body: { decision: 'verified' } }); await reload(); })}>Verify</Button><Button size="sm" variant="secondary" onClick={() => { const n = window.prompt('Reason for rejection'); if (n) void run('d', async () => { await api(`/admin/supplier-network/documents/${d.id}/review`, { body: { decision: 'rejected', note: n } }); await reload(); }); }}>Reject</Button></span>}</li>)}</ul>}</Panel>
        <Panel title="Credentials" subtitle="Stored encrypted. Values are never shown.">
          <p className="text-sm">Fields set: {data.credentials.fields.join(', ') || 'none'}</p><p className="text-sm text-ink-3">Last rotated: {when(data.credentials.lastRotatedAt)} {data.credentials.rotationDue && <Badge tone="warn">rotation due</Badge>}</p>
          {w && <Button size="sm" className="mt-2" variant="secondary" onClick={() => { const k = window.prompt('New API key (not displayed again)'); if (k) void run('rot', async () => { await api(`${b}/credentials/rotate`, { body: { credentials: { apiKey: k } } }); await reload(); }, 'Credentials rotated'); }}>Rotate API key</Button>}
        </Panel>
      </div>
      <Modal open={!!attest} onClose={() => setAttest(null)} title={`Attest: ${attest?.kind.replace(/_/g, ' ')}`} footer={<Button loading={busy === 'attest'} onClick={submitAttest}>Record evidence</Button>}>
        {attest && <div className="space-y-3">
          <Field label="What was checked, and what you saw (10+ chars)"><Textarea value={attest.summary} onChange={(e) => setAttest({ ...attest, summary: e.target.value })} /></Field>
          <Field label="Outcome"><Select value={attest.outcome} onChange={(e) => setAttest({ ...attest, outcome: e.target.value })}><option>pass</option><option>fail</option></Select></Field>
          <div className="grid grid-cols-2 gap-2"><Field label="Reference type"><Select value={attest.refType} onChange={(e) => setAttest({ ...attest, refType: e.target.value })}>{['supplierOrderId', 'orderId', 'shipmentId', 'documentId', 'externalReference'].map((t) => <option key={t}>{t}</option>)}</Select></Field><Field label="Reference"><Input value={attest.ref} onChange={(e) => setAttest({ ...attest, ref: e.target.value })} /></Field></div>
          {attest.kind === 'price_quote_accuracy' && <div className="grid grid-cols-2 gap-2"><Field label="Quoted (minor units)"><Input value={attest.quoted} onChange={(e) => setAttest({ ...attest, quoted: e.target.value })} /></Field><Field label="Charged (minor units)"><Input value={attest.charged} onChange={(e) => setAttest({ ...attest, charged: e.target.value })} /></Field></div>}
        </div>}
      </Modal>
    </div>
  );
}

function Matching() {
  const { can } = useAdmin();
  const { data, error, loading, reload } = useFetch<{ items: { _id: string; score: number; confidence: string; reasons: { detail: string }[]; conflicts: string[]; product?: { title: string }; supplierProduct?: { title: string; externalId: string }; supplier?: { name: string } }[] }>('/admin/supplier-network/matches');
  const { run } = useAction();
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? ''} retry={reload} />;
  if (!data.items.length) return <EmptyState title="No candidate matches awaiting review" body="Ingest a supplier catalogue to propose matches. Nothing is ever linked without your approval." />;
  return <ul className="space-y-3">{data.items.map((m) => (
    <li key={m._id} className="rounded-lg border border-line bg-surface p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2"><b>{m.supplier?.name}: {m.supplierProduct?.title}</b><span>→</span><b>{m.product?.title}</b><Badge tone={m.confidence === 'high' ? 'ok' : m.confidence === 'medium' ? 'warn' : 'neutral'}>{pctf(m.score, 0)} {m.confidence}</Badge></div>
      <ul className="mt-1 list-disc pl-5 text-xs text-ink-2">{m.reasons.map((r, i) => <li key={i}>{r.detail}</li>)}{m.conflicts.map((c, i) => <li key={`c${i}`} className="text-coral-700">Conflict: {c}</li>)}</ul>
      {can('suppliers:write') && <div className="mt-2 flex gap-2"><Button size="sm" onClick={() => run('m', async () => { await api(`/admin/supplier-network/matches/${m._id}/decide`, { body: { decision: 'approve' } }); await reload(); }, 'Linked')}>Approve link</Button><Button size="sm" variant="secondary" onClick={() => run('m', async () => { await api(`/admin/supplier-network/matches/${m._id}/decide`, { body: { decision: 'reject' } }); await reload(); })}>Reject</Button></div>}
    </li>))}</ul>;
}

interface QuoteRow { supplierCode: string; supplierName: string; offer: { currency: string; productCost: number; shippingCost: number; totalMinor: number; minDays: number; maxDays: number; stock: number } | null; freshness: { label: string; source: string; ageMinutes: number | null }; routableInProduction: boolean; routingBlock: string | null; sla: { worst: string; onTimeRate: number | null } }
function Quotes() {
  const [f, setF] = React.useState({ productId: '', country: 'US', live: false });
  const [go, setGo] = React.useState<string | null>(null);
  const { data, error, loading } = useFetch<{ rows: QuoteRow[]; note: string }>(go);
  const cur = (n: number, c: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(n / 100);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2"><Field label="Product id"><Input value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value.trim() })} placeholder="24-char product id" /></Field><Field label="Destination"><Select value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}>{['US', 'CA', 'IN'].map((c) => <option key={c}>{c}</option>)}</Select></Field><label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" checked={f.live} onChange={(e) => setF({ ...f, live: e.target.checked })} />Query suppliers live</label><Button disabled={!/^[a-f\d]{24}$/i.test(f.productId)} onClick={() => setGo(`/admin/supplier-network/quotes?productId=${f.productId}&country=${f.country}&live=${f.live}`)}>Compare</Button></div>
      {go && loading && <Loading />}{go && error && <ErrorBox message={error} />}
      {data && (data.rows.length === 0 ? <EmptyState title="No suppliers linked to this product" /> : <>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs uppercase text-ink-3"><tr><th className="p-2">Supplier</th><th>Total</th><th>Delivery</th><th>Stock</th><th>Freshness</th><th>SLA</th><th>Prod. routable</th></tr></thead><tbody>{data.rows.map((r) => <tr key={r.supplierCode} className="border-t border-line"><td className="p-2 font-semibold">{r.supplierName}</td><td>{r.offer ? `${cur(r.offer.totalMinor, r.offer.currency)} (${cur(r.offer.productCost, r.offer.currency)} + ${cur(r.offer.shippingCost, r.offer.currency)} ship)` : '—'}</td><td>{r.offer ? `${r.offer.minDays}-${r.offer.maxDays} d` : '—'}</td><td>{r.offer?.stock ?? '—'}</td><td><Badge tone={r.freshness.label === 'live' || r.freshness.label === 'fresh' ? 'ok' : 'warn'}>{r.freshness.label}</Badge> <span className="text-xs text-ink-3">{r.freshness.source}{r.freshness.ageMinutes !== null ? ` · ${r.freshness.ageMinutes}m` : ''}</span></td><td>{r.sla.worst === 'insufficient_data' ? <span className="text-xs text-ink-3">insufficient data</span> : <Badge tone={tone(r.sla.worst)}>{r.sla.worst}</Badge>}</td><td title={r.routingBlock ?? ''}><Badge tone={r.routableInProduction ? 'ok' : 'neutral'}>{r.routableInProduction ? 'yes' : 'no'}</Badge></td></tr>)}</tbody></table></div>
        <p className="text-xs text-ink-3">{data.note}</p></>)}
    </div>
  );
}

interface Snap { supplierId: string; supplier?: { name: string; code: string }; snapshot: { computedAt: string; worst: string; metrics: Record<string, { value: number | null; sample: number }>; breaches: { metric: string; severity: string }[] } }
function SlaBoard() {
  const { data, error, loading, reload } = useFetch<{ items: Snap[] }>('/admin/supplier-network/sla');
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? ''} retry={reload} />;
  if (!data.items.length) return <EmptyState title="No SLA snapshots yet" body="The SLA job runs for probation and approved suppliers. Rates stay 'insufficient data' until there are enough real orders." />;
  const keys = ['fulfilmentRate', 'onTimeRate', 'cancellationRate', 'stockAccuracy', 'refundRate', 'defectRate'];
  return <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs uppercase text-ink-3"><tr><th className="p-2">Supplier</th><th>Status</th>{keys.map((k) => <th key={k}>{k.replace('Rate', '')}</th>)}<th>Computed</th></tr></thead><tbody>{data.items.map((i) => <tr key={i.supplierId} className="border-t border-line"><td className="p-2 font-semibold">{i.supplier?.name}</td><td><Badge tone={tone(i.snapshot.worst)}>{i.snapshot.worst}</Badge></td>{keys.map((k) => { const m = i.snapshot.metrics?.[k]; return <td key={k}>{m?.value == null ? <span className="text-xs text-ink-3">n/a ({m?.sample ?? 0})</span> : pctf(m.value, 0)}</td>; })}<td className="text-xs">{when(i.snapshot.computedAt)}</td></tr>)}</tbody></table></div>;
}

interface Disp { _id: string; number: string; supplierId: string; type: string; state: string; amountMinor: number; currency: string; summary: string; creditedMinor?: number }
function Disputes() {
  const { can } = useAdmin();
  const { data, error, loading, reload } = useFetch<{ items: Disp[] }>('/admin/supplier-network/disputes');
  const { run } = useAction();
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? ''} retry={reload} />;
  const next: Record<string, string[]> = { open: ['awaiting_supplier', 'escalated', 'rejected'], awaiting_supplier: ['escalated'], awaiting_orvia: ['awaiting_supplier', 'resolved_credit', 'resolved_no_action', 'rejected', 'escalated'], escalated: ['awaiting_supplier', 'resolved_credit', 'resolved_no_action', 'rejected'], resolved_credit: ['closed'], resolved_no_action: ['closed'], rejected: ['closed'] };
  const move = (d: Disp, to: string) => { const note = to === 'awaiting_supplier' || to === 'closed' || to === 'escalated' ? undefined : window.prompt('Resolution note'); const credited = to === 'resolved_credit' ? Number(window.prompt('Credited amount (minor units)') ?? 0) : undefined; void run('d', async () => { await api(`/admin/supplier-network/disputes/${d._id}/transition`, { body: { to, note: note ?? undefined, creditedMinor: credited } }); await reload(); }); };
  if (!data.items.length) return <EmptyState title="No supplier disputes" />;
  return <ul className="space-y-2">{data.items.map((d) => <li key={d._id} className="rounded-lg border border-line bg-surface p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><b>{d.number}</b><Badge>{d.type}</Badge><Badge tone={tone(d.state)}>{d.state}</Badge><span className="text-ink-3">{(d.amountMinor / 100).toFixed(2)} {d.currency}</span></div><p className="mt-1 text-ink-2">{d.summary}</p>{can('suppliers:write') && <div className="mt-2 flex flex-wrap gap-2">{(next[d.state] ?? []).map((t) => <Button key={t} size="sm" variant="secondary" onClick={() => move(d, t)}>{t.replace(/_/g, ' ')}</Button>)}</div>}</li>)}</ul>;
}

interface Stmt { _id: string; supplierId: string; number: string; currency: string; status: string; totals?: { claimedMinor: number; recordedMinor: number; diffMinor: number; flaggedLines: number; missingFromStatement: number }; disputedMinor?: number }
function Payables() {
  const { can } = useAdmin();
  const { data, error, loading, reload } = useFetch<{ items: Stmt[] }>('/admin/supplier-network/statements');
  const { run } = useAction();
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? ''} retry={reload} />;
  const m = (n?: number) => (n === undefined ? '—' : (n / 100).toFixed(2));
  if (!data.items.length) return <EmptyState title="No supplier statements" body="Statements arrive from the supplier portal, CSV upload or manual entry and are matched against the supplier order costs ORVIA recorded. Settlement is record-only." />;
  return <ul className="space-y-2">{data.items.map((s) => <li key={s._id} className="rounded-lg border border-line bg-surface p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><b>{s.number}</b><Badge tone={tone(s.status)}>{s.status}</Badge><span className="text-ink-3">claimed {m(s.totals?.claimedMinor)} vs recorded {m(s.totals?.recordedMinor)} {s.currency} (diff {m(s.totals?.diffMinor)}) · {s.totals?.flaggedLines ?? 0} flagged · {s.totals?.missingFromStatement ?? 0} unbilled</span></div>
    {can('suppliers:write') && s.status !== 'settled' && <div className="mt-2 flex gap-2">
      {(s.status === 'discrepancies') && <Button size="sm" variant="secondary" onClick={() => { const t = window.prompt('Dispute summary (10+ chars)'); if (t) void run('s', async () => { await api(`/admin/supplier-network/statements/${s._id}/dispute`, { body: { summary: t } }); await reload(); }, 'Dispute opened'); }}>Dispute differences</Button>}
      {(s.status === 'matched' || s.status === 'disputed') && <Button size="sm" onClick={() => { const r = window.prompt('Payment reference (recorded only; no payment is made here)'); if (r) void run('s', async () => { await api(`/admin/supplier-network/statements/${s._id}/settle`, { body: { reference: r, amountMinor: Math.max(0, (s.totals?.claimedMinor ?? 0) - (s.disputedMinor ?? 0)) } }); await reload(); }, 'Settlement recorded'); }}>Record settlement</Button>}
    </div>}</li>)}</ul>;
}

export default function Page() {
  const [tab, setTab] = React.useState('pipeline');
  const [open, setOpen] = React.useState<string | null>(null);
  return (
    <div>
      <PageHeader title="Supplier network" subtitle="Onboarding, verification with evidence, matching, quotes, SLAs, disputes and payables." />
      {open ? <SupplierDetail id={open} onClose={() => setOpen(null)} /> : (
        <>
          <Tabs value={tab} onChange={setTab} className="mb-4" tabs={[{ id: 'pipeline', label: 'Pipeline' }, { id: 'matching', label: 'Matching' }, { id: 'quotes', label: 'Quotes' }, { id: 'sla', label: 'SLA board' }, { id: 'disputes', label: 'Disputes' }, { id: 'payables', label: 'Payables' }]} />
          {tab === 'pipeline' && <Pipeline onOpen={setOpen} />}{tab === 'matching' && <Matching />}{tab === 'quotes' && <Quotes />}{tab === 'sla' && <SlaBoard />}{tab === 'disputes' && <Disputes />}{tab === 'payables' && <Payables />}
        </>
      )}
    </div>
  );
}
