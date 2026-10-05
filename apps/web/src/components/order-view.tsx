'use client';
import { CheckCircle2, ExternalLink, Package } from 'lucide-react';
import * as React from 'react';
import { Button, Card, Field, Input, Link, OrderTimeline, ProductArt, StatusBadge, useToast, Skeleton, Modal, Select, Textarea } from '@orvia/ui';
import { api, ApiError, money } from '@/lib/api';
import type { OrderView } from '@/lib/types';
import { useStore } from './providers';

export function OrderPage({ orderNumber, initialEmail, placed }: { orderNumber: string; initialEmail?: string; placed?: boolean }) {
  const { user } = useStore();
  const toast = useToast();
  const [email, setEmail] = React.useState(initialEmail ?? '');
  const [order, setOrder] = React.useState<OrderView | null>(null);
  const [err, setErr] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [returnOpen, setReturnOpen] = React.useState(false);
  const polls = React.useRef(0);
  const canQuery = !!user || !!email;
  const load = React.useCallback(async (silent = false) => {
    try {
      const o = await api<OrderView>(`/orders/lookup?orderNumber=${encodeURIComponent(orderNumber)}${email ? `&email=${encodeURIComponent(email)}` : ''}`);
      setOrder(o); setErr('');
    } catch (e) { if (!silent) setErr((e as ApiError).message); } finally { setLoading(false); }
  }, [orderNumber, email]);
  React.useEffect(() => { if (canQuery) void load(); else setLoading(false); }, [canQuery, load]);
  // after payment the provider webhook may land a moment later: poll briefly
  React.useEffect(() => {
    if (!order || order.status !== 'PENDING_PAYMENT' || !placed) return;
    const t = setInterval(() => { if (++polls.current > 20) clearInterval(t); else void load(true); }, 3000);
    return () => clearInterval(t);
  }, [order, placed, load]);

  if (loading) return <div className="mx-auto max-w-4xl px-4 py-10"><Skeleton className="h-80" /></div>;
  if (!order) {
    return (
      <div className="mx-auto max-w-md px-4 py-14">
        <h1 className="font-display text-3xl font-semibold">Find your order</h1>
        <p className="mt-2 text-ink-3">Enter the email used at checkout to view order {orderNumber}.</p>
        <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); void load(); }}>
          <Field label="Email" error={err}><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
          <Button type="submit" block>View order</Button>
        </form>
      </div>
    );
  }
  const stamps: Record<string, string | undefined> = {};
  for (const t of order.timeline) stamps[t.status] = t.at;
  const cancel = async () => {
    if (!confirm('Cancel this order? Any payment will be refunded.')) return;
    try { await api(`/orders/${order.orderNumber}/cancel`, { body: { email: email || undefined } }); toast.success('Order cancelled'); await load(); } catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:py-10">
      {placed && order.status !== 'PENDING_PAYMENT' && (
        <div className="mb-6 flex items-start gap-3 rounded-xl bg-ok-50 p-5 text-ok-500" role="status"><CheckCircle2 className="mt-0.5 size-6 shrink-0" /><div><p className="text-lg font-bold">Thank you — your order is confirmed</p><p className="text-sm text-ink-2">We’ve emailed a confirmation to {order.email}. You’ll get tracking as soon as it ships.</p></div></div>
      )}
      {placed && order.status === 'PENDING_PAYMENT' && <div className="mb-6 rounded-xl bg-warn-50 p-5 text-sm text-ink-2" role="status"><b>Confirming your payment…</b> This usually takes a few seconds.</div>}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-sm text-ink-3">Order</p><h1 className="font-display text-3xl font-semibold tracking-tight">{order.orderNumber}</h1><p className="mt-1 text-sm text-ink-3">Placed {new Date(order.createdAt).toLocaleDateString(undefined, { dateStyle: 'long' })}</p></div>
        <StatusBadge status={order.status} />
      </div>
      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          <Card className="p-5 sm:p-6"><h2 className="mb-5 text-lg font-bold">Progress</h2><OrderTimeline status={order.status} timestamps={stamps} /></Card>
          <Card className="p-5 sm:p-6">
            <h2 className="mb-4 flex items-center gap-2 text-lg font-bold"><Package className="size-5 text-pine-600" /> Tracking</h2>
            {order.shipments.length === 0 ? <p className="text-sm text-ink-3">{order.status === 'PENDING_PAYMENT' ? 'Waiting for payment.' : 'We’re preparing your order. Tracking appears here as soon as the supplier ships it — we never show a tracking number until we actually have one.'}</p> : order.shipments.map((s, i) => (
              <div key={i} className="border-t border-line pt-4 first:border-0 first:pt-0">
                <div className="flex flex-wrap items-center gap-2"><StatusBadge status={s.status} />{s.carrier && <span className="text-sm text-ink-2">{s.carrier}</span>}{s.trackingNumber && <code className="rounded bg-sunken px-2 py-0.5 text-sm">{s.trackingNumber}</code>}{s.trackingUrl && <a className="inline-flex items-center gap-1 text-sm font-semibold text-pine-700" href={s.trackingUrl} target="_blank" rel="noopener noreferrer">Carrier site <ExternalLink className="size-3.5" /></a>}</div>
                {s.estimatedDelivery && s.status !== 'DELIVERED' && <p className="mt-2 text-sm text-ink-3">Estimated delivery by {new Date(s.estimatedDelivery).toLocaleDateString(undefined, { dateStyle: 'medium' })}</p>}
                {s.events.length > 0 && <ol className="mt-3 space-y-2 border-l-2 border-line pl-4">{[...s.events].reverse().map((e, k) => <li key={k} className="relative text-sm"><span className="absolute -left-[1.4rem] top-1.5 size-2 rounded-full bg-pine-600" /><b>{e.description}</b>{e.location && <span className="text-ink-3"> · {e.location}</span>}<br /><span className="text-xs text-ink-3">{new Date(e.at).toLocaleString()}</span></li>)}</ol>}
              </div>
            ))}
          </Card>
          <Card className="p-5 sm:p-6">
            <h2 className="mb-4 text-lg font-bold">Items</h2>
            <ul className="divide-y divide-line">{order.items.map((i) => (<li key={i.sku} className="flex gap-4 py-3 first:pt-0 last:pb-0"><div className="w-16 shrink-0"><ProductArt src={i.image} alt="" className="rounded-md" /></div><div className="min-w-0 flex-1 text-sm"><p className="font-semibold">{i.title}</p><p className="text-ink-3">Qty {i.quantity}</p></div><b className="text-sm tabular-nums">{money(i.unitPrice * i.quantity, order.currency)}</b></li>))}</ul>
          </Card>
        </div>
        <aside className="space-y-6">
          <Card className="p-5">
            <h2 className="mb-3 text-lg font-bold">Summary</h2>
            <dl className="space-y-2 text-sm"><div className="flex justify-between"><dt className="text-ink-2">Subtotal</dt><dd className="tabular-nums">{money(order.amounts.subtotal, order.currency)}</dd></div>{order.amounts.discount > 0 && <div className="flex justify-between text-ok-500"><dt>Discount</dt><dd className="tabular-nums">−{money(order.amounts.discount, order.currency)}</dd></div>}<div className="flex justify-between"><dt className="text-ink-2">Shipping</dt><dd className="tabular-nums">{order.amounts.shipping ? money(order.amounts.shipping, order.currency) : 'Free'}</dd></div><div className="flex justify-between"><dt className="text-ink-2">{order.amounts.taxInclusive ? 'Taxes (included)' : 'Tax'}</dt><dd className="tabular-nums">{money(order.amounts.tax, order.currency)}</dd></div><div className="flex justify-between border-t border-line pt-3 text-base font-bold"><dt>Total</dt><dd className="tabular-nums">{money(order.amounts.total, order.currency)}</dd></div></dl>
            <p className="mt-3 text-xs text-ink-3">Payment: <b>{order.payment.status}</b></p>
          </Card>
          <Card className="p-5 text-sm"><h2 className="mb-2 text-lg font-bold">Delivery address</h2><address className="not-italic text-ink-2">{order.address.fullName}<br />{order.address.line1}{order.address.line2 ? `, ${order.address.line2}` : ''}<br />{order.address.city}, {order.address.region} {order.address.postalCode}<br />{order.address.country}</address></Card>
          <div className="space-y-2">
            {order.canCancel && <Button block variant="secondary" onClick={() => void cancel()}>Cancel order</Button>}
            {order.canReturn && user && <Button block variant="secondary" onClick={() => setReturnOpen(true)}>Return items</Button>}
            {order.canReturn && !user && <p className="text-sm text-ink-3"><Link href={`/login?next=/orders/${order.orderNumber}`} className="font-semibold text-pine-700 underline">Sign in</Link> to start a return.</p>}
            {order.returns.length > 0 && <p className="text-sm text-ink-2">Return status: <StatusBadge status={order.returns[order.returns.length - 1]!.status} /></p>}
            <Button block variant="ghost" href="/help">Need help?</Button>
          </div>
        </aside>
      </div>
      <ReturnModal open={returnOpen} onClose={() => setReturnOpen(false)} order={order} onDone={() => { setReturnOpen(false); void load(); }} />
    </div>
  );
}

function ReturnModal({ open, onClose, order, onDone }: { open: boolean; onClose: () => void; order: OrderView; onDone: () => void }) {
  const toast = useToast();
  const [skus, setSkus] = React.useState<Set<string>>(new Set(order.items.map((i) => i.sku)));
  const [reason, setReason] = React.useState('changed_mind');
  const [details, setDetails] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    setBusy(true);
    try { await api('/returns', { body: { orderId: order.id, reason, details, itemSkus: [...skus] } }); toast.success('Return requested — we’ll email you shortly.'); onDone(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Return items" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!skus.size} onClick={() => void submit()}>Request return</Button></>}>
      <div className="space-y-4">
        <fieldset><legend className="mb-2 text-sm font-bold">Items</legend>{order.items.map((i) => (<label key={i.sku} className="flex items-center gap-3 py-1.5 text-sm"><input type="checkbox" checked={skus.has(i.sku)} onChange={() => setSkus((s) => { const n = new Set(s); if (n.has(i.sku)) n.delete(i.sku); else n.add(i.sku); return n; })} className="size-4.5 accent-[var(--pine-600)]" />{i.title}</label>))}</fieldset>
        <Field label="Reason"><Select value={reason} onChange={(e) => setReason(e.target.value)}><option value="changed_mind">Changed my mind</option><option value="damaged">Arrived damaged</option><option value="not_as_described">Not as described</option><option value="wrong_item">Wrong item</option><option value="not_delivered">Not delivered</option><option value="other">Other</option></Select></Field>
        <Field label="Details (optional)"><Textarea value={details} onChange={(e) => setDetails(e.target.value)} maxLength={2000} /></Field>
      </div>
    </Modal>
  );
}
