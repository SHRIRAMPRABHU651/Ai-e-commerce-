'use client';
import NextLink from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';
import { Badge, Button, Card, EmptyState, Field, Input, Select, Skeleton, Textarea, ToastProvider, cn } from '@orvia/ui';
import { ErrorBox, Loading, useAction, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface Me { user: { id: string; name: string; email: string; role: string } | null }
const NAV = [['/supplier', 'Dashboard'], ['/supplier/orders', 'Orders'], ['/supplier/stock', 'Stock & prices'], ['/supplier/documents', 'Documents'], ['/supplier/verification', 'Verification'], ['/supplier/statements', 'Statements'], ['/supplier/disputes', 'Disputes & returns']] as const;

/** Separate portal chrome. Only SUPPLIER-role users get in; staff and customers are sent to the supplier sign-in (the API enforces this again on every call). */
export function PortalShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [state, setState] = React.useState<'loading' | 'ok' | 'denied'>('loading');
  const [name, setName] = React.useState('');
  React.useEffect(() => {
    api<Me>('/auth/me').then((r) => { if (r.user?.role === 'SUPPLIER') { setName(r.user.name); setState('ok'); } else { setState('denied'); router.replace('/supplier/login'); } }).catch(() => { setState('denied'); router.replace('/supplier/login'); });
  }, [router]);
  if (state !== 'ok') return <div className="p-8"><Skeleton className="h-64" /></div>;
  return (
    <ToastProvider>
      <div className="min-h-dvh bg-paper">
        <header className="border-b border-line bg-surface"><div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3"><b className="text-lg">Orvia Supplier Portal</b><span className="ml-auto text-sm text-ink-3">{name}</span><Button size="sm" variant="secondary" onClick={async () => { await api('/auth/logout', { body: {} }); router.replace('/supplier/login'); }}>Sign out</Button></div>
          <nav aria-label="Portal" className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 pb-2">{NAV.map(([h, l]) => <NextLink key={h} href={h} aria-current={path === h ? 'page' : undefined} className={cn('whitespace-nowrap rounded-md px-3 py-2 text-sm font-semibold', path === h ? 'bg-pine-50 text-pine-700' : 'text-ink-2 hover:bg-sunken')}>{l}</NextLink>)}</nav></header>
        <main id="main" className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </div>
    </ToastProvider>
  );
}

export function PortalLogin() {
  const router = useRouter();
  const [f, setF] = React.useState({ email: '', password: '' });
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      await api('/auth/login', { body: f });
      const me = await api<Me>('/auth/me');
      if (me.user?.role !== 'SUPPLIER') { await api('/auth/logout', { body: {} }); setErr('This sign-in is for supplier accounts only.'); return; }
      router.replace('/supplier');
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  return (
    <main id="main" className="mx-auto mt-16 max-w-sm px-4"><Card className="p-6"><h1 className="mb-4 text-xl font-bold">Supplier sign-in</h1>
      <form onSubmit={submit} className="space-y-3"><Field label="Email"><Input type="email" autoComplete="username" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field><Field label="Password"><Input type="password" autoComplete="current-password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        {err && <p role="alert" className="text-sm text-coral-700">{err}</p>}<Button type="submit" loading={busy} block>Sign in</Button>
        <p className="text-xs text-ink-3">First time? Use the link in your invitation email to set a password.</p></form></Card></main>
  );
}

export function PortalDashboard() {
  const { data, error, loading, reload } = useFetch<{ supplier: { name: string; state: string | null; productionReady: boolean; canConfirmOrders: boolean }; ordersToFulfil: { toShip: number; awaitingAcceptance: number }; openDisputes: number; openReturnRequests: number; sla: { facts: { worst: string; fulfilmentRate: number | null; onTimeRate: number | null; computedAt: string | null } }; verification: { ready: boolean; missing: string[] } }>('/supplier/dashboard', 60_000);
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? 'Could not load'} retry={reload} />;
  const pc = (n: number | null) => (n === null ? 'insufficient data' : `${(n * 100).toFixed(0)}%`);
  const tile = (l: string, v: React.ReactNode, href: string) => <NextLink href={href} className="rounded-lg border border-line bg-surface p-4 hover:bg-sunken"><p className="text-xs font-bold uppercase text-ink-3">{l}</p><p className="mt-1 text-2xl font-bold">{v}</p></NextLink>;
  return (
    <div className="space-y-5"><h1 className="text-2xl font-bold">{data.supplier.name}</h1>
      <p className="text-sm text-ink-2">Status: <Badge>{data.supplier.state ?? 'n/a'}</Badge> {data.verification.ready ? <Badge tone="ok">verification current</Badge> : <Badge tone="warn">verification incomplete: {data.verification.missing.join(', ') || '—'}</Badge>}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{tile('To ship', data.ordersToFulfil.toShip, '/supplier/orders')}{tile('Awaiting acceptance', data.ordersToFulfil.awaitingAcceptance, '/supplier/orders')}{tile('Open disputes', data.openDisputes, '/supplier/disputes')}{tile('Return requests', data.openReturnRequests, '/supplier/disputes')}</div>
      <Card className="p-4 text-sm"><h2 className="font-bold">Your SLA</h2><p className="mt-1">Overall: <Badge tone={data.sla.facts.worst === 'ok' ? 'ok' : data.sla.facts.worst === 'insufficient_data' ? 'neutral' : 'warn'}>{data.sla.facts.worst.replace('_', ' ')}</Badge> · fulfilment {pc(data.sla.facts.fulfilmentRate)} · on-time {pc(data.sla.facts.onTimeRate)}</p><p className="mt-1 text-xs text-ink-3">Computed from real shipments {data.sla.facts.computedAt ? `(${when(data.sla.facts.computedAt)})` : '— not yet computed'}. Rates need a minimum number of orders before they are shown.</p></Card>
    </div>
  );
}

interface OrderRow { shipmentId: string; orderNumber?: string; status: string; product?: string; quantity?: number; trackingNumber?: string; carrier?: string; shipTo?: Record<string, string> }
interface Queue { orderId: string; orderNumber: string; lineKey: string; product: string; quantity: number; shipTo: Record<string, string> }
export function PortalOrders() {
  const { data, error, loading, reload } = useFetch<{ items: OrderRow[]; awaitingAcceptance: Queue[] }>('/supplier/orders?pageSize=50');
  const { run, busy } = useAction();
  const [ship, setShip] = React.useState<{ id: string; tracking: string; carrier: string } | null>(null);
  const [acc, setAcc] = React.useState<{ q: Queue; ref: string } | null>(null);
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? 'Could not load'} retry={reload} />;
  const addr = (a?: Record<string, string>) => a && Object.values(a).join(', ');
  return (
    <div className="space-y-6"><h1 className="text-2xl font-bold">Orders</h1>
      {data.awaitingAcceptance.length > 0 && <section><h2 className="mb-2 font-bold">Awaiting your acceptance</h2><ul className="space-y-2">{data.awaitingAcceptance.map((q) => <li key={q.orderId + q.lineKey} className="rounded-lg border border-line bg-surface p-3 text-sm"><b>{q.orderNumber}</b> · {q.product} × {q.quantity}<p className="text-ink-3">Ship to: {addr(q.shipTo)}</p>
        {acc?.q === q ? <div className="mt-2 flex flex-wrap items-end gap-2"><Field label="Your order reference"><Input value={acc.ref} onChange={(e) => setAcc({ q, ref: e.target.value })} /></Field><Button loading={busy === 'acc'} onClick={() => run('acc', async () => { await api('/supplier/orders/accept', { body: { orderId: q.orderId, lineKey: q.lineKey, supplierOrderId: acc.ref } }); setAcc(null); await reload(); }, 'Order accepted')}>Confirm</Button></div> : <Button size="sm" className="mt-2" onClick={() => setAcc({ q, ref: '' })}>Accept order</Button>}</li>)}</ul></section>}
      <section><h2 className="mb-2 font-bold">Your orders</h2>{data.items.length === 0 ? <EmptyState title="No orders yet" /> : <ul className="space-y-2">{data.items.map((o) => <li key={o.shipmentId} className="rounded-lg border border-line bg-surface p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><b>{o.orderNumber}</b><span>{o.product} × {o.quantity}</span><Badge>{o.status}</Badge>{o.trackingNumber && <span className="text-ink-3">{o.carrier} {o.trackingNumber}</span>}</div>
        {o.shipTo && <p className="mt-1 text-ink-3">Ship to: {addr(o.shipTo)}</p>}
        {o.status === 'CREATED' || o.status === 'SHIPPED' ? (ship?.id === o.shipmentId ? <div className="mt-2 flex flex-wrap items-end gap-2"><Field label="Carrier"><Input value={ship.carrier} onChange={(e) => setShip({ ...ship, carrier: e.target.value })} /></Field><Field label="Tracking number"><Input value={ship.tracking} onChange={(e) => setShip({ ...ship, tracking: e.target.value })} /></Field><Button loading={busy === 'ship'} onClick={() => run('ship', async () => { await api(`/supplier/shipments/${o.shipmentId}/ship`, { body: { trackingNumber: ship.tracking, carrier: ship.carrier } }); setShip(null); await reload(); }, 'Marked as shipped')}>Mark shipped</Button></div> : <Button size="sm" variant="secondary" className="mt-2" onClick={() => setShip({ id: o.shipmentId, tracking: o.trackingNumber ?? '', carrier: o.carrier ?? '' })}>{o.status === 'CREATED' ? 'Mark shipped' : 'Update tracking'}</Button>) : null}</li>)}</ul>}</section>
    </div>
  );
}

export function PortalStock() {
  const [csv, setCsv] = React.useState('external_id,price,shipping,stock,min_days,max_days,currency\n');
  const { run, busy } = useAction();
  const [res, setRes] = React.useState<{ applied: number; rejected: number; errors: string[] } | null>(null);
  return (
    <div className="space-y-3"><h1 className="text-2xl font-bold">Stock &amp; prices</h1>
      <p className="text-sm text-ink-3">For manual suppliers: paste or upload a CSV with columns <code>external_id, price, stock</code> (optional <code>shipping, min_days, max_days, currency</code>). Prices are in major units (19.99). Only products already linked to ORVIA are accepted; uploaded offers expire if not re-confirmed.</p>
      <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
      <Textarea rows={10} value={csv} onChange={(e) => setCsv(e.target.value)} aria-label="CSV" />
      <Button loading={busy === 'up'} onClick={() => run('up', async () => setRes(await api('/supplier/offers/upload', { body: { csv } })), 'Upload processed')}>Upload</Button>
      {res && <div className="rounded-lg border border-line p-3 text-sm"><p>{res.applied} applied, {res.rejected} rejected.</p><ul className="list-disc pl-5 text-coral-700">{res.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></div>}
    </div>
  );
}

export function PortalDocuments() {
  const { data, error, loading, reload } = useFetch<{ items: { id: string; kind: string; title: string; status: string; expiresAt?: string; reviewNote?: string }[]; maxBytes: number }>('/supplier/documents');
  const { run, busy } = useAction();
  const [f, setF] = React.useState({ kind: 'business_registration', title: '', expiresAt: '' });
  const file = React.useRef<HTMLInputElement>(null);
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? ''} retry={reload} />;
  const upload = () => run('doc', async () => {
    const x = file.current?.files?.[0];
    if (!x) throw new Error('Choose a file (PDF, JPEG, PNG or WebP)');
    const fd = new FormData();
    fd.append('kind', f.kind); fd.append('title', f.title); if (f.expiresAt) fd.append('expiresAt', f.expiresAt); fd.append('file', x);
    const res = await fetch('/api/v1/supplier/documents', { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'x-requested-with': 'orvia' } });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? 'Upload failed');
    await reload();
  }, 'Document uploaded');
  return (
    <div className="space-y-4"><h1 className="text-2xl font-bold">Documents</h1>
      <Card className="space-y-3 p-4"><div className="grid gap-3 sm:grid-cols-3"><Field label="Type"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['business_registration', 'tax_certificate', 'product_certificate', 'insurance', 'bank_confirmation', 'quality_report', 'other'].map((k) => <option key={k}>{k}</option>)}</Select></Field><Field label="Title"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field><Field label="Expires (optional)"><Input type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></Field></div><input ref={file} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" aria-label="Document file" /><Button loading={busy === 'doc'} disabled={f.title.length < 2} onClick={upload}>Upload</Button></Card>
      {data.items.length === 0 ? <EmptyState title="No documents yet" body="Upload your business registration to continue onboarding." /> : <ul className="space-y-2">{data.items.map((d) => <li key={d.id} className="rounded-lg border border-line bg-surface p-3 text-sm"><a className="font-semibold underline" href={`/api/v1/supplier/documents/${d.id}/file`}>{d.title}</a> <Badge>{d.kind}</Badge> <Badge tone={d.status === 'verified' ? 'ok' : d.status === 'rejected' ? 'coral' : 'neutral'}>{d.status}</Badge>{d.expiresAt && <span className="ml-2 text-xs text-ink-3">expires {when(d.expiresAt)}</span>}{d.reviewNote && <p className="text-xs text-ink-3">Reviewer: {d.reviewNote}</p>}</li>)}</ul>}
    </div>
  );
}

export function PortalVerification() {
  const { data, error, loading, reload } = useFetch<{ state: string | null; ready: boolean; validUntil?: string; steps: { kind: string; required: boolean; effective: string; validUntil?: string }[] }>('/supplier/verification');
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? ''} retry={reload} />;
  return (
    <div className="space-y-3"><h1 className="text-2xl font-bold">Verification</h1><p className="text-sm">Onboarding state: <Badge>{data.state}</Badge> {data.ready ? <Badge tone="ok">production ready until {when(data.validUntil)}</Badge> : <Badge tone="warn">not production ready</Badge>}</p>
      <ul className="divide-y divide-line rounded-lg border border-line bg-surface">{data.steps.map((s) => <li key={s.kind} className="flex flex-wrap items-center gap-2 p-3 text-sm"><b>{s.kind.replace(/_/g, ' ')}</b>{!s.required && <Badge>not required</Badge>}<Badge tone={s.effective === 'passed' ? 'ok' : s.effective === 'failed' ? 'coral' : 'neutral'}>{s.effective.replace('_', ' ')}</Badge>{s.validUntil && s.effective === 'passed' && <span className="text-xs text-ink-3">valid until {when(s.validUntil)}</span>}</li>)}</ul>
      <p className="text-xs text-ink-3">ORVIA staff run and record these checks. An API that simply responds does not make a supplier production ready.</p></div>
  );
}

export function PortalStatements() {
  const { data, error, loading, reload } = useFetch<{ items: { id: string; number: string; currency: string; status: string; totals?: { claimedMinor: number; recordedMinor: number; flaggedLines: number } }[] }>('/supplier/statements');
  const { run, busy } = useAction();
  const [f, setF] = React.useState({ number: '', currency: 'USD', csv: 'supplier_order_id,amount,description\n' });
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? ''} retry={reload} />;
  const m = (n?: number) => (n === undefined ? '—' : (n / 100).toFixed(2));
  return (
    <div className="space-y-4"><h1 className="text-2xl font-bold">Statements</h1>
      <Card className="space-y-3 p-4"><h2 className="font-bold">Submit a statement (CSV)</h2><div className="grid gap-3 sm:grid-cols-2"><Field label="Statement number"><Input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} /></Field><Field label="Currency"><Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option>USD</option><option>CAD</option><option>INR</option></Select></Field></div><Textarea rows={6} aria-label="Statement CSV" value={f.csv} onChange={(e) => setF({ ...f, csv: e.target.value })} /><Button loading={busy === 'st'} disabled={!f.number} onClick={() => run('st', async () => { await api('/supplier/statements', { body: f }); await reload(); }, 'Statement submitted and reconciled')}>Submit</Button></Card>
      {data.items.length === 0 ? <EmptyState title="No statements yet" /> : <ul className="space-y-2">{data.items.map((s) => <li key={s.id} className="rounded-lg border border-line bg-surface p-3 text-sm"><b>{s.number}</b> <Badge tone={s.status === 'matched' || s.status === 'settled' ? 'ok' : s.status === 'submitted' ? 'neutral' : 'warn'}>{s.status}</Badge> <span className="text-ink-3">claimed {m(s.totals?.claimedMinor)} · ORVIA recorded {m(s.totals?.recordedMinor)} {s.currency} · {s.totals?.flaggedLines ?? 0} line(s) differ</span></li>)}</ul>}</div>
  );
}

export function PortalDisputes() {
  const d = useFetch<{ items: { _id: string; number: string; type: string; state: string; summary: string }[] }>('/supplier/disputes');
  const r = useFetch<{ items: { _id: string; number: string; state: string; reason: string; rmaNumber?: string }[] }>('/supplier/returns');
  const { run } = useAction();
  if (d.loading || r.loading) return <Loading />;
  if (d.error || r.error) return <ErrorBox message={d.error ?? r.error ?? ''} retry={() => { void d.reload(); void r.reload(); }} />;
  return (
    <div className="space-y-6"><section><h1 className="mb-2 text-2xl font-bold">Disputes</h1>{!d.data?.items.length ? <EmptyState title="No disputes" /> : <ul className="space-y-2">{d.data.items.map((x) => <li key={x._id} className="rounded-lg border border-line bg-surface p-3 text-sm"><b>{x.number}</b> <Badge>{x.type}</Badge> <Badge>{x.state}</Badge><p className="text-ink-2">{x.summary}</p>{x.state === 'awaiting_supplier' && <Button size="sm" className="mt-2" onClick={() => { const n = window.prompt('Your response / evidence (3+ characters)'); if (n) void run('r', async () => { await api(`/supplier/disputes/${x._id}/respond`, { body: { note: n } }); await d.reload(); }, 'Response sent'); }}>Respond</Button>}</li>)}</ul>}</section>
      <section><h2 className="mb-2 text-xl font-bold">Return requests</h2>{!r.data?.items.length ? <EmptyState title="No return requests" /> : <ul className="space-y-2">{r.data.items.map((x) => <li key={x._id} className="rounded-lg border border-line bg-surface p-3 text-sm"><b>{x.number}</b> <Badge>{x.state}</Badge> {x.rmaNumber && <span>RMA {x.rmaNumber}</span>}<p className="text-ink-2">{x.reason}</p>{x.state === 'requested' && <div className="mt-2 flex gap-2"><Button size="sm" onClick={() => { const n = window.prompt('RMA number'); if (n) void run('a', async () => { await api(`/supplier/returns/${x._id}/decide`, { body: { to: 'authorized', rmaNumber: n } }); await r.reload(); }, 'Return authorised'); }}>Authorise</Button><Button size="sm" variant="secondary" onClick={() => { const n = window.prompt('Reason for rejecting (5+ characters)'); if (n) void run('a', async () => { await api(`/supplier/returns/${x._id}/decide`, { body: { to: 'rejected', note: n } }); await r.reload(); }, 'Return rejected'); }}>Reject</Button></div>}</li>)}</ul>}</section></div>
  );
}
