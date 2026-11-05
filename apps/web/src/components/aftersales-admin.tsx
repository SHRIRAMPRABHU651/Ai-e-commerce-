'use client';
import * as React from 'react';
import { Badge, Button, Card, DataTable, Field, Input, Modal, Select, StatusBadge, Tabs, Textarea } from '@orvia/ui';
import type { Column } from '@orvia/ui';
import { ErrorBox, FilterSelect, Loading, PageHeader, Panel, Toolbar, cur, pctf, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const label = (s?: string) => (s ?? '').replace(/_/g, ' ');
const RMA_STATES = ['submitted', 'authorized', 'in_transit', 'received', 'inspected', 'refund_pending', 'replacement_pending', 'resolved', 'rejected', 'cancelled'];

/* ------------------------------ RMA detail ------------------------------ */
function RmaModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useAdmin();
  const { data: r, error, loading, reload } = useFetch<Row>(`/admin/aftersales/returns/${id}`);
  const { run, busy } = useAction();
  const [note, setNote] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const act = (key: string, path: string, body: unknown, ok: string) => run(key, async () => { await api(`/admin/aftersales/returns/${id}/${path}`, { body }); await reload(); onChanged(); }, ok);
  const w = can('returns:write');
  const state = r?.state as string | undefined;
  const calc = r?.refundPreview as Row | null | undefined;
  const cc = (r?.currency as string) ?? 'USD';
  return (
    <Modal open onClose={onClose} title={r ? `${r.rmaNumber} · order ${r.orderNumber}` : 'Return'} size="lg">
      {loading && <Loading />}
      {error && <ErrorBox message={error} retry={reload} />}
      {r && (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2"><StatusBadge status={r.state} /><Badge>{r.resolution}</Badge><Badge>{label(r.reasonCode)}</Badge>{r.needsStaffReview && <Badge>needs supplier/carrier check</Badge>}</div>
          {r.details && <p className="rounded-lg bg-sunken p-3">“{r.details}”</p>}
          <ul>{(r.items as Row[]).map((i) => <li key={i.sku}>{i.quantity}× {i.title} <span className="text-ink-3">({label(i.condition)}{i.acceptedQuantity !== undefined ? `, accepted ${i.acceptedQuantity}` : ''})</span></li>)}</ul>
          <div>
            <p className="font-semibold">Photos ({(r.evidence as Row[]).length}){r.evidenceRequired && !(r.evidence as Row[]).length && <span className="ml-2 text-bad-500">required before authorizing</span>}</p>
            <div className="mt-2 flex flex-wrap gap-2">{(r.evidence as Row[]).map((e) => <a key={e.id} href={`/api/v1/admin/aftersales/returns/${id}/evidence/${e.id}`} target="_blank" rel="noreferrer"><img src={`/api/v1/admin/aftersales/returns/${id}/evidence/${e.id}`} alt="Customer evidence" className="size-20 rounded-lg border border-line object-cover" /></a>)}</div>
          </div>
          {r.instructions && <p className="whitespace-pre-line rounded-lg bg-sunken p-3 text-ink-2">{r.instructions}</p>}
          {r.label?.url && <p>Label ({label(r.label.source)}): <a className="font-semibold text-pine-700 underline" href={r.label.url} target="_blank" rel="noreferrer">open</a></p>}
          {calc && (
            <div className="rounded-lg border border-line p-3">
              <p className="font-semibold">Refund calculation (deterministic)</p>
              <dl className="mt-1 grid grid-cols-2 gap-x-4 sm:grid-cols-4">
                <dt className="text-ink-3">Goods</dt><dd>{cur(calc.goods, cc)}</dd><dt className="text-ink-3">Discount share</dt><dd>-{cur(calc.discountShare, cc)}</dd>
                <dt className="text-ink-3">Shipping</dt><dd>{cur(calc.shipping, cc)}</dd><dt className="text-ink-3">Tax</dt><dd>{cur(calc.tax, cc)}</dd>
                <dt className="text-ink-3">Fees</dt><dd>-{cur(calc.restockingFee + calc.returnShippingDeduction, cc)}</dd><dt className="font-semibold">Refundable</dt><dd className="font-semibold">{cur(calc.refundable, cc)}</dd>
              </dl>
              {calc.cappedByRemaining && <p className="mt-1 text-warn-500">Capped by what is left to refund on the order.</p>}
            </div>
          )}
          {r.refund && <p>Refund: <StatusBadge status={r.refund.status} /> {cur(r.refund.amount, cc)} {r.refund.status === 'pending_approval' && can('refunds:approve') && <Button size="sm" className="ml-2" loading={busy === 'appr'} onClick={() => void run('appr', async () => { await api(`/admin/refunds/${r.refund._id}/approve`, { body: {} }); await reload(); onChanged(); }, 'Refund approved')}>Approve refund</Button>}</p>}
          {r.fulfilment && <p>Replacement: {r.fulfilment.status} {r.fulfilment.trackingNumber ?? ''}</p>}
          <details><summary className="cursor-pointer font-semibold">Timeline &amp; notes</summary>
            <ul className="mt-2 space-y-1">{(r.timeline as Row[]).map((t, i) => <li key={i}><span className="text-ink-3">{when(t.at)}</span> {label(t.state)} {t.note && `— ${t.note}`} <span className="text-ink-3">({t.actor})</span></li>)}</ul>
            <ul className="mt-2 space-y-1">{(r.notes as Row[]).map((n, i) => <li key={i} className="rounded bg-sunken p-2">{n.text} <span className="text-ink-3">{n.internal ? 'internal' : 'customer-visible'} · {n.by}</span></li>)}</ul>
          </details>
          {w && state && !['resolved', 'rejected', 'cancelled'].includes(state) && (
            <div className="space-y-3 border-t border-line pt-3">
              <Field label="Note (required to reject)"><Textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
              <div className="flex flex-wrap gap-2">
                {state === 'submitted' && <Button loading={busy === 'auth'} onClick={() => void act('auth', 'authorize', { note }, 'RMA authorized')}>Authorize RMA</Button>}
                {['authorized', 'in_transit'].includes(state) && <Button variant="secondary" loading={busy === 'rec'} onClick={() => void act('rec', 'received', { note }, 'Marked received')}>Mark received</Button>}
                {state === 'received' && <><Button loading={busy === 'ins'} onClick={() => void act('ins', 'inspect', { outcome: 'accepted', note }, 'Inspection recorded')}>Accept goods</Button><Button variant="secondary" loading={busy === 'insr'} onClick={() => void act('insr', 'inspect', { outcome: 'rejected', note: note || 'Item not acceptable' }, 'Return rejected')}>Fail inspection</Button></>}
                {(['authorized', 'inspected'].includes(state) || (state === 'refund_pending' && !r.refundId)) && can('refunds:write') && r.resolution === 'refund' && <><Input aria-label="Override amount (minor units)" className="w-40" placeholder="Max (auto)" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} /><Button loading={busy === 'ref'} onClick={() => void act('ref', 'refund', { note, ...(amount ? { amount: Number(amount) } : {}) }, 'Refund requested')}>Issue refund</Button></>}
                {['authorized', 'inspected'].includes(state) && r.resolution !== 'refund' && <Button loading={busy === 'rep'} onClick={() => void act('rep', 'replacement', {}, `${r.resolution} approved`)}>Approve {r.resolution}</Button>}
                {state === 'replacement_pending' && <Button loading={busy === 'ship'} onClick={() => void act('ship', 'replacement-shipment', { delivered: true }, 'Marked delivered')}>Mark replacement delivered</Button>}
                {note.trim().length >= 3 && <Button variant="ghost" loading={busy === 'note'} onClick={() => void act('note', 'notes', { text: note, internal: true }, 'Note saved')}>Save as internal note</Button>}
                {['submitted', 'authorized', 'in_transit', 'received', 'inspected'].includes(state) && <Button variant="ghost" loading={busy === 'rej'} disabled={note.trim().length < 3} onClick={() => void act('rej', 'reject', { note }, 'Return rejected')}>Reject</Button>}
              </div>
              <p className="text-xs text-ink-3">Refunds run through the guarded refund function: amounts above the auto-approve limit by non-admin staff wait for approval. Every action is audited.</p>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function Queue() {
  const [state, setState] = React.useState('submitted');
  const [page, setPage] = React.useState(1);
  const [open, setOpen] = React.useState<string | null>(null);
  const { data, error, loading, reload } = useFetch<{ items: Row[]; total: number }>(`/admin/aftersales/returns?page=${page}&pageSize=25${state ? `&state=${state}` : ''}`);
  const cols: Column<Row>[] = [
    { key: 'o', header: 'RMA / order', render: (r) => <div><b>{r.rmaNumber}</b><p className="text-xs text-ink-3">{r.orderNumber} · {r.email}</p></div> },
    { key: 'r', header: 'Reason', render: (r) => <span className="capitalize">{label(r.reasonCode)}</span> },
    { key: 'x', header: 'Wants', hideBelow: 'md', render: (r) => <span className="capitalize">{r.resolution}</span> },
    { key: 's', header: 'State', render: (r) => <StatusBadge status={r.state} /> },
    { key: 'd', header: 'Requested', hideBelow: 'md', render: (r) => when(r.createdAt) },
    { key: 'a', header: '', align: 'right', render: (r) => <Button size="sm" variant="secondary" onClick={() => setOpen(r._id)}>Open</Button> },
  ];
  return (
    <>
      <Toolbar><FilterSelect label="State" value={state} onChange={(v) => { setState(v); setPage(1); }} options={[['', 'All'], ...RMA_STATES.map((s): [string, string] => [s, label(s)])]} /></Toolbar>
      {error && !data && <ErrorBox message={error} retry={reload} />}
      <Card><DataTable columns={cols} rows={data?.items} loading={loading} rowKey={(r) => r._id} page={page} pageSize={25} total={data?.total} onPage={setPage} empty={{ title: 'No returns in this state' }} /></Card>
      {open && <RmaModal id={open} onClose={() => setOpen(null)} onChanged={() => void reload()} />}
    </>
  );
}

/* ------------------------------ chargebacks ------------------------------ */
function Chargebacks() {
  const { can } = useAdmin();
  const [page, setPage] = React.useState(1);
  const m = useFetch<Row>('/admin/aftersales/chargebacks/metrics');
  const { data, error, loading, reload } = useFetch<{ items: Row[]; total: number }>(`/admin/aftersales/chargebacks?page=${page}&pageSize=25`);
  const { run, busy } = useAction();
  const [sel, setSel] = React.useState<Row | null>(null);
  const [text, setText] = React.useState('');
  const [cat, setCat] = React.useState('other');
  const call = (key: string, path: string, body: unknown, ok: string) => run(key, async () => { await api(`/admin/aftersales/chargebacks/${sel!._id}/${path}`, { body }); setText(''); setSel(null); await reload(); }, ok);
  const cols: Column<Row>[] = [
    { key: 'o', header: 'Dispute', render: (r) => <div><b>{r.disputeId}</b><p className="text-xs text-ink-3">{r.provider} · {r.orderNumber ?? 'order not matched'}</p></div> },
    { key: 'a', header: 'Amount', align: 'right', render: (r) => cur(r.amount, r.currency || 'USD') },
    { key: 'r', header: 'Reason', hideBelow: 'md', render: (r) => label(r.reason) },
    { key: 's', header: 'State', render: (r) => <StatusBadge status={r.state} /> },
    { key: 'd', header: 'Evidence due', render: (r) => <span className={r.deadline === 'overdue' ? 'font-semibold text-bad-500' : r.deadline === 'due_soon' ? 'font-semibold text-warn-500' : ''}>{when(r.evidenceDueBy)}</span> },
    { key: 'x', header: '', align: 'right', render: (r) => can('refunds:approve') && ['needs_response', 'evidence_recorded', 'warning'].includes(r.state) && <Button size="sm" variant="secondary" onClick={() => setSel(r)}>Respond</Button> },
  ];
  const rate = m.data?.rate as Row | undefined;
  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Panel title="Chargeback rate">{!rate ? '—' : rate.reliable ? <b className="text-xl">{pctf(rate.countRate, 2)}</b> : <span className="text-sm text-ink-3">Insufficient data ({rate.transactions} transactions)</span>}</Panel>
        <Panel title="Open / overdue"><b className="text-xl">{m.data?.open ?? '—'}</b> <span className="text-ink-3">/ {m.data?.overdue ?? '—'}</span></Panel>
        <Panel title="Won / lost"><b className="text-xl">{m.data?.won ?? '—'}</b> <span className="text-ink-3">/ {m.data?.lost ?? '—'}</span></Panel>
        <Panel title="Reserve held">{(m.data?.reserve as Row[] | undefined)?.length ? (m.data!.reserve as Row[]).map((x) => <p key={x.currency}><b>{cur(x.held, x.currency || 'USD')}</b></p>) : <span className="text-ink-3">None</span>}</Panel>
      </div>
      {m.data?.attention && <p role="alert" className="mb-3 rounded-lg bg-warn-50 p-3 text-sm">The dispute rate is above {pctf(m.data.attentionRate, 2)}. Card networks monitor dispute ratios; review the causes.</p>}
      {error && !data && <ErrorBox message={error} retry={reload} />}
      <Card><DataTable columns={cols} rows={data?.items} loading={loading} rowKey={(r) => r._id} page={page} pageSize={25} total={data?.total} onPage={setPage} empty={{ title: 'No chargebacks', body: 'Disputes appear here automatically from verified Stripe/Razorpay webhooks.' }} /></Card>
      <Modal open={!!sel} onClose={() => setSel(null)} title={sel ? `Respond to ${sel.disputeId}` : ''} size="lg">
        {sel && (
          <div className="space-y-3 text-sm">
            <p>{cur(sel.amount, sel.currency || 'USD')} · {label(sel.reason)} · due {when(sel.evidenceDueBy)}</p>
            <ul className="space-y-1">{(sel.evidence as Row[] ?? []).map((e, i) => <li key={i} className="rounded bg-sunken p-2"><b>{label(e.category)}</b>: {e.text}</li>)}</ul>
            {sel.submission?.status && sel.submission.status !== 'not_submitted' && <p>Submission: <b>{label(sel.submission.status)}</b> {sel.submission.error}</p>}
            <Field label="Evidence type"><Select value={cat} onChange={(e) => setCat(e.target.value)}>{['shipping_proof', 'delivery_proof', 'customer_communication', 'product_description', 'refund_policy', 'other'].map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select></Field>
            <Field label="Evidence text"><Textarea value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} /></Field>
            <div className="flex flex-wrap gap-2">
              <Button disabled={text.trim().length < 5} loading={busy === 'ev'} onClick={() => void call('ev', 'evidence', { text, category: cat }, 'Evidence recorded')}>Record evidence</Button>
              <Button variant="secondary" loading={busy === 'sub'} onClick={() => void call('sub', 'submit', {}, 'Submission attempted')}>Send to provider</Button>
              <Button variant="ghost" loading={busy === 'acc'} onClick={() => { if (confirm('Accept this dispute? The disputed amount is lost.')) void call('acc', 'accept', {}, 'Dispute accepted'); }}>Accept loss</Button>
            </div>
            <p className="text-xs text-ink-3">Evidence is recorded here first. Sending it to the provider API is unverified without live credentials — always confirm in the provider dashboard before the deadline.</p>
          </div>
        )}
      </Modal>
    </>
  );
}

/* --------------------------------- claims --------------------------------- */
const NEXT: Record<string, string[]> = { draft: ['submitted', 'written_off'], submitted: ['acknowledged', 'accepted', 'partially_accepted', 'rejected', 'written_off'], acknowledged: ['accepted', 'partially_accepted', 'rejected', 'written_off'], accepted: ['recovered', 'written_off'], partially_accepted: ['recovered', 'written_off'], rejected: ['submitted', 'written_off'] };
function Claims() {
  const { can } = useAdmin();
  const [page, setPage] = React.useState(1);
  const { data, error, loading, reload } = useFetch<{ items: Row[]; total: number; totals: Row[] }>(`/admin/aftersales/claims?page=${page}&pageSize=25`);
  const { run, busy } = useAction();
  const move = (c: Row, to: string) => {
    const approvedAmount = to === 'partially_accepted' ? Number(prompt('Approved amount (minor units)', '') ?? '') : undefined;
    const recoveredAmount = to === 'recovered' ? Number(prompt('Recovered amount (minor units)', String(c.approvedAmount ?? '')) ?? '') : undefined;
    return run(c._id + to, async () => { await api(`/admin/aftersales/claims/${c._id}/transition`, { body: { to, approvedAmount, recoveredAmount, note: '' } }); await reload(); }, `Claim ${label(to)}`);
  };
  const cols: Column<Row>[] = [
    { key: 'n', header: 'Claim', render: (r) => <div><b>{r.claimNumber}</b><p className="text-xs text-ink-3">{r.supplierName} · {label(r.kind)}</p></div> },
    { key: 'a', header: 'Claimed / approved / recovered', render: (r) => `${cur(r.claimedAmount, r.currency)} / ${cur(r.approvedAmount, r.currency)} / ${cur(r.recoveredAmount, r.currency)}` },
    { key: 's', header: 'State', render: (r) => <StatusBadge status={r.state} /> },
    { key: 'd', header: 'Due', hideBelow: 'md', render: (r) => when(r.dueBy) },
    { key: 'x', header: '', align: 'right', render: (r) => can('returns:write') && <div className="flex flex-wrap justify-end gap-1">{(NEXT[r.state] ?? []).map((t) => <Button key={t} size="sm" variant="ghost" loading={busy === r._id + t} onClick={() => void move(r, t)}>{label(t)}</Button>)}</div> },
  ];
  return (
    <>
      <p className="mb-3 text-sm text-ink-3">Claims against suppliers for defects, non-delivery and wrong items. Open a claim from the API (<code>POST /admin/aftersales/claims</code>) or the return queue; amounts never exceed what was paid to the supplier.</p>
      {error && !data && <ErrorBox message={error} retry={reload} />}
      <Card><DataTable columns={cols} rows={data?.items} loading={loading} rowKey={(r) => r._id} page={page} pageSize={25} total={data?.total} onPage={setPage} empty={{ title: 'No supplier claims' }} /></Card>
    </>
  );
}

/* -------------------------------- analytics -------------------------------- */
function Analytics() {
  const [days, setDays] = React.useState('90');
  const { data, error, loading, reload } = useFetch<Row>(`/admin/aftersales/analytics?days=${days}`);
  const rate = (v: number | null) => (v === null ? <span className="text-ink-3">insufficient data</span> : pctf(v, 1));
  return (
    <>
      <Toolbar><FilterSelect label="Window" value={days} onChange={setDays} options={[['30', '30 days'], ['90', '90 days'], ['365', '1 year']]} /></Toolbar>
      {loading && <Loading />}
      {error && <ErrorBox message={error} retry={reload} />}
      {data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title={`Returns (${data.totalReturns})`} subtitle={data.legacyReturnsWithoutDetail ? `${data.legacyReturnsWithoutDetail} older returns have no reason detail` : undefined}>
            {!data.byReason.length ? <p className="text-sm text-ink-3">No returns in this window.</p> : <ul className="space-y-1 text-sm">{(data.byReason as Row[]).map((r) => <li key={r.reason} className="flex justify-between"><span className="capitalize">{label(r.reason)}</span><b>{r.count}</b></li>)}</ul>}
          </Panel>
          <Panel title="By country (returns ÷ orders)">
            <ul className="space-y-1 text-sm">{(data.byCountry as Row[]).map((r) => <li key={r.country} className="flex justify-between"><span>{r.country} · {r.returns}/{r.orders}</span><b>{rate(r.rate)}</b></li>)}</ul>
          </Panel>
          <Panel title="By product (returned ÷ sold units)">
            {!data.byProduct.length ? <p className="text-sm text-ink-3">None.</p> : <ul className="space-y-1 text-sm">{(data.byProduct as Row[]).map((r) => <li key={r.id} className="flex justify-between gap-2"><span className="truncate">{r.name} · {r.returnedUnits}/{r.soldUnits}</span><b>{rate(r.rate)}</b></li>)}</ul>}
          </Panel>
          <Panel title="By supplier (returned ÷ shipped units)">
            {!data.bySupplier.length ? <p className="text-sm text-ink-3">None.</p> : <ul className="space-y-1 text-sm">{(data.bySupplier as Row[]).map((r) => <li key={r.id} className="flex justify-between gap-2"><span className="truncate">{r.name} · {r.returnedUnits}/{r.soldUnits}</span><b>{rate(r.rate)}</b></li>)}</ul>}
          </Panel>
          <p className="text-xs text-ink-3 lg:col-span-2">{data.note} Minimum sample: {data.minSampleForRates}.</p>
        </div>
      )}
    </>
  );
}

/* ------------------------------ supplier policy ------------------------------ */
function Suppliers() {
  const { can } = useAdmin();
  const sup = useFetch<{ suppliers?: Row[]; items?: Row[] }>('/admin/suppliers');
  const list = (sup.data?.suppliers ?? sup.data?.items ?? []) as Row[];
  const [id, setId] = React.useState('');
  const pol = useFetch<Row>(id ? `/admin/aftersales/suppliers/${id}/policy` : null);
  const [f, setF] = React.useState<Row>({});
  React.useEffect(() => { if (pol.data) setF(pol.data); }, [pol.data]);
  const { run, busy } = useAction();
  const save = () => run('save', async () => {
    await api(`/admin/aftersales/suppliers/${id}/policy`, { method: 'PUT', body: { supportsReturns: f.supportsReturns ?? 'unknown', supportsReplacement: !!f.supportsReplacement, supportsExchange: !!f.supportsExchange, defectOnly: !!f.defectOnly, instructions: f.instructions ?? '', ...(f.returnWindowDays ? { returnWindowDays: Number(f.returnWindowDays) } : {}), ...(f.claimWindowDays ? { claimWindowDays: Number(f.claimWindowDays) } : {}) } });
    await pol.reload();
  }, 'Supplier return policy saved');
  return (
    <Card className="space-y-4 p-5">
      <p className="text-sm text-ink-3">What each supplier actually accepts. Customers are never offered a return, replacement or exchange the supplier is not recorded as supporting; “unknown” sends every return to staff review.</p>
      <Field label="Supplier"><Select value={id} onChange={(e) => setId(e.target.value)}><option value="">Choose…</option>{list.map((s) => <option key={s._id ?? s.id} value={s._id ?? s.id}>{s.name}</option>)}</Select></Field>
      {sup.error && <ErrorBox message={sup.error} retry={sup.reload} />}
      {id && pol.loading && <Loading rows={2} />}
      {id && pol.data && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Accepts returns"><Select value={f.supportsReturns ?? 'unknown'} onChange={(e) => setF({ ...f, supportsReturns: e.target.value })}><option value="unknown">Unknown</option><option value="yes">Yes</option><option value="no">No</option></Select></Field>
          <Field label="Return window (days, optional)"><Input inputMode="numeric" value={f.returnWindowDays ?? ''} onChange={(e) => setF({ ...f, returnWindowDays: e.target.value.replace(/\D/g, '') })} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!f.supportsReplacement} onChange={(e) => setF({ ...f, supportsReplacement: e.target.checked })} />Supports replacements</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!f.supportsExchange} onChange={(e) => setF({ ...f, supportsExchange: e.target.checked })} />Supports exchanges</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!f.defectOnly} onChange={(e) => setF({ ...f, defectOnly: e.target.checked })} />Defects / wrong items only</label>
          <Field label="Claim window (days, optional)"><Input inputMode="numeric" value={f.claimWindowDays ?? ''} onChange={(e) => setF({ ...f, claimWindowDays: e.target.value.replace(/\D/g, '') })} /></Field>
          <div className="sm:col-span-2"><Field label="Return instructions shown to customers"><Textarea maxLength={2000} value={f.instructions ?? ''} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></Field></div>
          {can('returns:write') && <Button loading={busy === 'save'} onClick={() => void save()}>Save</Button>}
        </div>
      )}
    </Card>
  );
}

/* --------------- requests created before the RMA workflow (original flow) --------------- */
function LegacyReturns() {
  const { can } = useAdmin();
  const [status, setStatus] = React.useState('requested');
  const [page, setPage] = React.useState(1);
  const { data, error, loading, reload } = useFetch<{ items: Row[]; total: number }>(`/admin/returns?page=${page}&pageSize=25${status ? `&status=${status}` : ''}`);
  const { run, busy } = useAction();
  const decide = (id: string, decision: string, ok: string) => run(id + decision, async () => { await api(`/admin/returns/${id}/decision`, { body: { decision, note: decision } }); await reload(); }, ok);
  const cols: Column<Row>[] = [
    { key: 'o', header: 'Order', render: (r) => <div><b>{r.orderNumber}</b><p className="text-xs text-ink-3">{r.email}</p></div> },
    { key: 'r', header: 'Reason', render: (r) => <span className="capitalize">{label(r.reason)}</span> },
    { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'd', header: 'Requested', hideBelow: 'md', render: (r) => when(r.createdAt) },
    { key: 'a', header: '', align: 'right', render: (r) => can('returns:write') && ['requested', 'approved'].includes(r.status) && <div className="flex justify-end gap-1.5">{r.status === 'requested' && <Button size="sm" variant="secondary" loading={busy === r._id + 'approve'} onClick={() => void decide(r._id, 'approve', 'Return approved')}>Approve</Button>}<Button size="sm" loading={busy === r._id + 'refund'} onClick={() => void decide(r._id, 'refund', 'Refund issued')}>Refund</Button>{r.status === 'requested' && <Button size="sm" variant="ghost" loading={busy === r._id + 'reject'} onClick={() => void decide(r._id, 'reject', 'Return rejected')}>Reject</Button>}</div> },
  ];
  return (
    <>
      <p className="mb-3 text-sm text-ink-3">Requests made through the original one-step flow (and any not yet linked to an RMA). New requests use the Return queue.</p>
      <Toolbar><FilterSelect label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[['', 'All'], ['requested', 'Requested'], ['approved', 'Approved'], ['refunded', 'Refunded'], ['rejected', 'Rejected']]} /></Toolbar>
      {error && !data && <ErrorBox message={error} retry={reload} />}
      <Card><DataTable columns={cols} rows={data?.items} loading={loading} rowKey={(r) => r._id} page={page} pageSize={25} total={data?.total} onPage={setPage} empty={{ title: 'No requests' }} /></Card>
    </>
  );
}

export function AftersalesAdmin() {
  const [tab, setTab] = React.useState('queue');
  return (
    <>
      <PageHeader title="Returns & after-sales" subtitle="RMA queue, refunds, supplier recovery, chargebacks and return analytics. Refunds above the auto-approve limit need an approver." />
      <Tabs value={tab} onChange={setTab} className="mb-4" tabs={[{ id: 'queue', label: 'Return queue' }, { id: 'chargebacks', label: 'Chargebacks' }, { id: 'claims', label: 'Supplier claims' }, { id: 'analytics', label: 'Analytics' }, { id: 'suppliers', label: 'Supplier policies' }, { id: 'legacy', label: 'Original requests' }]} />
      {tab === 'queue' && <Queue />}
      {tab === 'chargebacks' && <Chargebacks />}
      {tab === 'claims' && <Claims />}
      {tab === 'analytics' && <Analytics />}
      {tab === 'suppliers' && <Suppliers />}
      {tab === 'legacy' && <LegacyReturns />}
    </>
  );
}
