'use client';
import * as React from 'react';
import { Badge, Button, DataTable, Drawer, Field, Input, Modal, StatusBadge, Textarea, Tabs, Card } from '@orvia/ui';
import type { Column } from '@orvia/ui';
import { FilterSelect, PageHeader, SearchBox, Toolbar, cur, useAction, useAdmin, useFetch, when, ErrorBox, Loading } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface Row { id: string; orderNumber: string; customer: string; email: string; country: string; currency: string; product: string; total: number; supplier: string | null; paymentStatus: string; fulfillment: string; tracking: string | null; profit: number | null; status: string; fraud?: string; exceptionOpen: boolean; createdAt: string }
interface Detail { order: { _id: string; orderNumber: string; status: string; items: { title: string; quantity: number; unitPrice: number; lineKey: string }[]; amounts: { subtotal: number; discount: number; shipping: number; tax: number; total: number }; currency: string; costs: { supplierCost: number; shippingCost: number; duties: number; paymentFee: number; refunded: number }; profit: { contribution: number; margin: number }; fraud?: { score: number; level: string; signals: string[] }; address: { fullName: string; line1: string; city: string; region: string; postalCode: string; country: string }; email: string; payment: { status: string; provider: string }; timeline: { status: string; at: string; note?: string; actor?: string }[]; fulfillment: { state: string; attempts: number; lastError?: string } }; shipments: { _id: string; lineKey: string; supplierName?: string; supplierOrderId?: string; status: string; trackingNumber?: string; carrier?: string; lastError?: string; events: { description: string; at: string }[] }[]; exceptions: { _id: string; kind: string; issue: string; status: string; priority: string }[]; refunds: { amount: number; status: string; reason: string }[]; audit: { _id: string; action: string; timestamp: string; actor: string; reason?: string }[] }
const STATUSES = ['', 'PENDING_PAYMENT', 'PAID', 'SUPPLIER_PROCESSING', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED', 'REFUND_REQUESTED', 'REFUNDED', 'EXCEPTION'];

export default function OrdersPage() {
  const [page, setPage] = React.useState(1);
  const [status, setStatus] = React.useState('');
  const [country, setCountry] = React.useState('');
  const [q, setQ] = React.useState('');
  const [sel, setSel] = React.useState<string | null>(null);
  const qs = `page=${page}&pageSize=20${status ? `&status=${status}` : ''}${country ? `&country=${country}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const { data, error, loading, reload } = useFetch<{ items: Row[]; total: number; pageSize: number }>(`/admin/orders?${qs}`, 30_000);
  const cols: Column<Row>[] = [
    { key: 'n', header: 'Order', render: (r) => <div><b>{r.orderNumber}</b><p className="text-xs text-ink-3">{when(r.createdAt)}</p></div> },
    { key: 'c', header: 'Customer', render: (r) => <div className="max-w-44 truncate">{r.customer}<p className="truncate text-xs text-ink-3">{r.email}</p></div> },
    { key: 'co', header: 'Country', hideBelow: 'md', render: (r) => r.country },
    { key: 'p', header: 'Product', hideBelow: 'lg', render: (r) => <span className="block max-w-52 truncate">{r.product}</span> },
    { key: 's', header: 'Supplier', hideBelow: 'lg', render: (r) => r.supplier ?? <span className="text-ink-3">—</span> },
    { key: 'pay', header: 'Payment', hideBelow: 'md', render: (r) => <StatusBadge status={r.paymentStatus} /> },
    { key: 't', header: 'Tracking', hideBelow: 'lg', render: (r) => (r.tracking ? <code className="text-xs">{r.tracking}</code> : <span className="text-ink-3">—</span>) },
    { key: 'pr', header: 'Profit', align: 'right', hideBelow: 'md', render: (r) => (r.profit === null ? <span className="text-ink-3" title="Costs known after supplier order">pending</span> : <span className={r.profit < 0 ? 'font-bold text-coral-500' : ''}>{cur(r.profit, r.currency)}</span>) },
    { key: 'tot', header: 'Total', align: 'right', render: (r) => <b>{cur(r.total, r.currency)}</b> },
    { key: 'st', header: 'Status', render: (r) => <div className="flex items-center gap-1.5"><StatusBadge status={r.status} />{r.fraud === 'high' && <Badge tone="coral">fraud</Badge>}</div> },
  ];
  return (
    <>
      <PageHeader title="Orders" subtitle="Every order, its supplier, tracking and real profit once costs are known." />
      <Toolbar>
        <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Order # or email" />
        <FilterSelect label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUSES.map((s) => [s, s ? s.replace(/_/g, ' ').toLowerCase() : 'All statuses'])} />
        <FilterSelect label="Country" value={country} onChange={(v) => { setCountry(v); setPage(1); }} options={[['', 'All countries'], ['US', 'USA'], ['CA', 'Canada'], ['IN', 'India']]} />
      </Toolbar>
      {error && !data && <ErrorBox message={error} retry={reload} />}
      <Card><DataTable columns={cols} rows={data?.items} loading={loading} rowKey={(r) => r.id} onRowClick={(r) => setSel(r.id)} page={page} pageSize={20} total={data?.total} onPage={setPage} empty={{ title: 'No orders match' }} /></Card>
      <OrderDrawer id={sel} onClose={() => setSel(null)} onChanged={reload} />
    </>
  );
}

function OrderDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const { can } = useAdmin();
  const { data, loading, reload } = useFetch<Detail>(id ? `/admin/orders/${id}` : null);
  const { run, busy } = useAction();
  const [modal, setModal] = React.useState<null | 'cancel' | 'refund' | 'contact'>(null);
  const [text, setText] = React.useState('');
  const [subject, setSubject] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const o = data?.order;
  const done = async () => { setModal(null); setText(''); setSubject(''); setAmount(''); await reload(); onChanged(); };
  const post = (path: string, body: unknown, ok: string, key: string) => run(key, async () => { await api(path, { body }); await done(); }, ok);
  return (
    <>
      <Drawer open={!!id} onClose={onClose} title={o ? `Order ${o.orderNumber}` : 'Order'} width="sm:max-w-2xl">
        {loading || !o || !data ? <div className="p-5"><Loading /></div> : (
          <div className="space-y-6 p-5">
            <div className="flex flex-wrap items-center gap-2"><StatusBadge status={o.status} /><Badge>{o.payment.provider ?? 'no provider'} · {o.payment.status}</Badge><Badge>fulfilment: {o.fulfillment.state}</Badge>{o.fraud && <Badge tone={o.fraud.level === 'high' ? 'coral' : o.fraud.level === 'medium' ? 'warn' : 'ok'}>fraud {o.fraud.level} ({o.fraud.score})</Badge>}</div>
            <div className="flex flex-wrap gap-2">
              {can('orders:write') && <Button size="sm" variant="secondary" loading={busy === 'retry'} onClick={() => post(`/admin/orders/${o._id}/retry-fulfillment`, { force: false }, 'Fulfilment queued', 'retry')}>Retry supplier order</Button>}
              {can('orders:write') && (o.fraud?.level === 'high' || o.status === 'EXCEPTION') && <Button size="sm" variant="soft" loading={busy === 'force'} onClick={() => post(`/admin/orders/${o._id}/retry-fulfillment`, { force: true }, 'Approved — fulfilment queued', 'force')}>Approve & fulfil</Button>}
              {can('orders:write') && <Button size="sm" variant="secondary" onClick={() => setModal('contact')}>Contact customer</Button>}
              {can('refunds:write') && <Button size="sm" variant="secondary" onClick={() => setModal('refund')}>Refund</Button>}
              {can('orders:write') && !['CANCELLED', 'REFUNDED'].includes(o.status) && <Button size="sm" variant="danger" onClick={() => setModal('cancel')}>Cancel order</Button>}
            </div>
            <section><h3 className="mb-2 text-sm font-bold">Items & economics</h3>
              <table className="w-full text-sm"><tbody>
                {o.items.map((i) => <tr key={i.lineKey} className="border-b border-line"><td className="py-2">{i.quantity}× {i.title}</td><td className="py-2 text-right tabular-nums">{cur(i.unitPrice * i.quantity, o.currency)}</td></tr>)}
                {[['Subtotal', o.amounts.subtotal], ['Discount', -o.amounts.discount], ['Shipping charged', o.amounts.shipping], ['Tax', o.amounts.tax], ['Total paid', o.amounts.total]].map(([k, v]) => <tr key={k as string}><td className="py-1 text-ink-3">{k}</td><td className="py-1 text-right tabular-nums">{cur(v as number, o.currency)}</td></tr>)}
              </tbody></table>
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-sunken p-3 text-sm sm:grid-cols-4">
                {[['Supplier cost', o.costs.supplierCost], ['Supplier shipping', o.costs.shippingCost], ['Duties', o.costs.duties], ['Payment fee', o.costs.paymentFee]].map(([k, v]) => <div key={k as string}><p className="text-xs text-ink-3">{k}</p><p className="font-bold tabular-nums">{cur(v as number, o.currency)}</p></div>)}
                <div className="col-span-2 sm:col-span-4 border-t border-line pt-2"><p className="text-xs text-ink-3">Contribution profit (before ads)</p><p className={`text-lg font-bold tabular-nums ${o.profit.contribution < 0 ? 'text-coral-500' : ''}`}>{o.fulfillment.state === 'placed' ? `${cur(o.profit.contribution, o.currency)} · ${(o.profit.margin * 100).toFixed(1)}%` : 'Known once the supplier order is placed'}</p></div>
              </div>
            </section>
            <section><h3 className="mb-2 text-sm font-bold">Supplier orders & tracking</h3>
              {data.shipments.length === 0 ? <p className="text-sm text-ink-3">No supplier order yet.{o.fulfillment.lastError ? ` Last error: ${o.fulfillment.lastError}` : ''}</p> : data.shipments.map((s) => (
                <div key={s._id} className="mb-3 rounded-lg border border-line p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><b>{s.supplierName}</b><StatusBadge status={s.status} />{s.supplierOrderId && <code className="text-xs">{s.supplierOrderId}</code>}</div>{s.trackingNumber && <p className="mt-1 text-ink-2">{s.carrier} · <code>{s.trackingNumber}</code></p>}{s.lastError && <p className="mt-1 text-coral-500">{s.lastError}</p>}
                  {can('orders:write') && ['CREATED', 'FAILED'].includes(s.status) && <Button size="sm" variant="ghost" className="mt-2" loading={busy === s._id} onClick={() => post(`/admin/orders/${o._id}/change-supplier`, { lineKey: s.lineKey }, 'Re-placing with the next best supplier', s._id)}>Change supplier</Button>}</div>
              ))}
            </section>
            {data.exceptions.length > 0 && <section><h3 className="mb-2 text-sm font-bold">Exceptions</h3>{data.exceptions.map((e) => <p key={e._id} className="mb-1.5 text-sm"><StatusBadge status={e.status} /> <b>{e.kind}</b> — {e.issue}</p>)}</section>}
            {data.refunds.length > 0 && <section><h3 className="mb-2 text-sm font-bold">Refunds</h3>{data.refunds.map((r, i) => <p key={i} className="text-sm">{cur(r.amount, o.currency)} · <StatusBadge status={r.status} /> · {r.reason}</p>)}</section>}
            <section><h3 className="mb-2 text-sm font-bold">Ship to</h3><p className="text-sm text-ink-2">{o.address.fullName}, {o.address.line1}, {o.address.city}, {o.address.region} {o.address.postalCode}, {o.address.country} · {o.email}</p></section>
            <section><h3 className="mb-2 text-sm font-bold">Audit trail</h3><ul className="space-y-1.5 text-sm">{data.audit.slice(0, 12).map((a) => <li key={a._id} className="text-ink-2"><span className="text-xs text-ink-3">{when(a.timestamp)}</span> · <b>{a.action}</b> by {a.actor}{a.reason ? ` — ${a.reason}` : ''}</li>)}</ul></section>
          </div>
        )}
      </Drawer>
      <Modal open={modal === 'cancel'} onClose={() => setModal(null)} title="Cancel order" size="sm" footer={<><Button variant="secondary" onClick={() => setModal(null)}>Keep order</Button><Button variant="danger" loading={busy === 'cancel'} disabled={text.length < 3} onClick={() => post(`/admin/orders/${id}/cancel`, { reason: text }, 'Order cancelled', 'cancel')}>Cancel & refund</Button></>}><p className="mb-3 text-sm text-ink-2">Cancels at the supplier (if not shipped) and refunds the customer.</p><Field label="Reason"><Input value={text} onChange={(e) => setText(e.target.value)} /></Field></Modal>
      <Modal open={modal === 'refund'} onClose={() => setModal(null)} title="Refund" size="sm" footer={<><Button variant="secondary" onClick={() => setModal(null)}>Close</Button><Button loading={busy === 'refund'} disabled={text.length < 3} onClick={() => post(`/admin/orders/${id}/refund`, { reason: text, ...(amount ? { amount: Math.round(Number(amount) * 100) } : {}) }, 'Refund recorded', 'refund')}>Issue refund</Button></>}><div className="space-y-3"><Field label="Amount (blank = full)" hint={`In ${o?.currency}`}><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field><Field label="Reason"><Input value={text} onChange={(e) => setText(e.target.value)} /></Field></div></Modal>
      <Modal open={modal === 'contact'} onClose={() => setModal(null)} title="Contact customer" footer={<><Button variant="secondary" onClick={() => setModal(null)}>Close</Button><Button loading={busy === 'contact'} disabled={text.length < 3 || subject.length < 3} onClick={() => post(`/admin/orders/${id}/contact`, { subject, message: text }, 'Message queued', 'contact')}>Send</Button></>}><div className="space-y-3"><Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field><Field label="Message"><Textarea value={text} onChange={(e) => setText(e.target.value)} /></Field></div></Modal>
    </>
  );
}
void Tabs;
