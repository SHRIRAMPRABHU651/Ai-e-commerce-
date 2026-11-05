'use client';
import { AlertTriangle, CheckCircle2, Circle, Clock, RotateCcw, Upload } from 'lucide-react';
import * as React from 'react';
import { Badge, Button, Card, EmptyState, Field, Link, Select, Skeleton, StatusBadge, Textarea, useToast } from '@orvia/ui';
import { api, ApiError } from '@/lib/api';

/* ------------------------------- shared types ------------------------------- */
interface Step { key: string; label: string; status: 'done' | 'current' | 'pending' | 'problem'; at?: string | null; detail?: string }
interface RefundView { headline: string; steps: Step[]; refunds: { id: string; status: string; amount: number; currency?: string }[] }
interface ReturnView {
  id: string; rmaNumber: string; orderNumber: string; state: string; reasonCode: string; resolution: string; instructions: string | null; evidenceRequired: boolean;
  items: { sku: string; title: string; quantity: number }[]; label: { url: string; carrier?: string; trackingNumber?: string } | null; evidence: { id: string }[];
  fulfilment: { status: string; trackingNumber?: string; carrier?: string } | null; createdAt: string; timeline: { state: string; at: string; note?: string }[];
}
interface Reason { code: string; label: string; group: string; fault: string; evidence: 'required' | 'recommended' | 'none' }
interface EligLine { sku: string; title: string; eligible: boolean; maxQuantity: number; reasons: { code: string; message: string }[]; resolutionsAllowed: string[]; returnMethod: string; needsStaffReview: boolean; notes: string[] }
interface Elig { orderId: string; eligible: boolean; orderReasons: { code: string; message: string }[]; windowDays: number; daysLeft: number | null; lines: EligLine[]; currency: string; evidence: string | null }

const STATE_LABEL: Record<string, string> = { submitted: 'Waiting for review', authorized: 'Approved', in_transit: 'On its way back', received: 'Received', inspected: 'Checked', refund_pending: 'Refund in progress', replacement_pending: 'Replacement being arranged', resolved: 'Completed', rejected: 'Not approved', cancelled: 'Cancelled' };
export const rmaLabel = (s: string) => STATE_LABEL[s] ?? s;

function useGet<T>(path: string | null) {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(!!path);
  const reload = React.useCallback(async () => {
    if (!path) return;
    try { setData(await api<T>(path)); setError(''); } catch (e) { setError((e as ApiError).message); } finally { setLoading(false); }
  }, [path]);
  React.useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload };
}

const Icon = ({ s }: { s: Step['status'] }) => s === 'done' ? <CheckCircle2 className="size-5 text-ok-500" aria-hidden /> : s === 'problem' ? <AlertTriangle className="size-5 text-bad-500" aria-hidden /> : s === 'current' ? <Clock className="size-5 text-pine-600" aria-hidden /> : <Circle className="size-5 text-ink-4" aria-hidden />;

export function RefundTimeline({ view }: { view: RefundView }) {
  if (!view.steps.length) return <p className="text-sm text-ink-3">{view.headline}</p>;
  return (
    <div>
      <p className="font-semibold">{view.headline}</p>
      <ol className="mt-3 space-y-3" aria-label="Refund progress">
        {view.steps.map((s) => (
          <li key={s.key} className="flex gap-3"><Icon s={s.status} /><div><p className={s.status === 'pending' ? 'text-ink-3' : 'font-medium'}>{s.label}</p>{s.detail && <p className="text-sm text-ink-3">{s.detail}</p>}{s.at && <p className="text-xs text-ink-3">{new Date(s.at).toLocaleString()}</p>}</div></li>
        ))}
      </ol>
    </div>
  );
}

/** Drop-in for the order page: shows the latest return and refund status. Renders nothing when there is nothing to show. */
export function AftersalesOrderStatus({ orderNumber }: { orderNumber: string }) {
  const { data, loading } = useGet<{ return: ReturnView | null; refund: RefundView }>(`/aftersales/orders/${encodeURIComponent(orderNumber)}/status`);
  if (loading) return <Skeleton className="mt-6 h-24" />;
  if (!data || (!data.return && !data.refund.refunds.length)) return null;
  return (
    <Card className="mt-6 p-5" aria-label="Return and refund status">
      <div className="mb-3 flex items-center justify-between gap-2"><h2 className="font-semibold">Returns &amp; refunds</h2>{data.return && <Link href={`/account/returns/${data.return.id}`} className="text-sm font-semibold text-pine-700">{data.return.rmaNumber}</Link>}</div>
      <RefundTimeline view={data.refund} />
    </Card>
  );
}

/* ------------------------------ returns list ------------------------------ */
export function ReturnsCenter() {
  const { data, loading, error } = useGet<{ items: ReturnView[] }>('/aftersales/returns');
  if (loading) return <Skeleton className="h-40" />;
  return (
    <div>
      <p className="mb-4 text-sm text-ink-3">To start a return, open the order and choose “Start a return”. We show exactly what can be returned and why before you submit anything.</p>
      {error && <p role="alert" className="mb-3 rounded-lg bg-bad-50 p-3 text-sm text-bad-500">{error}</p>}
      {!data?.items.length ? <EmptyState icon={<RotateCcw className="size-6" />} title="No returns" action={<Button href="/account/orders" variant="secondary">View orders</Button>} /> : (
        <ul className="space-y-3">{data.items.map((r) => (
          <li key={r.id}><Link href={`/account/returns/${r.id}`} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4 hover:bg-sunken">
            <div><p className="font-semibold">{r.rmaNumber} · {r.items.map((i) => `${i.quantity}× ${i.title}`).join(', ')}</p><p className="text-sm text-ink-3">Order {r.orderNumber} · {new Date(r.createdAt).toLocaleDateString()} · {r.resolution}</p></div>
            <Badge>{rmaLabel(r.state)}</Badge>
          </Link></li>
        ))}</ul>
      )}
    </div>
  );
}

/* ------------------------------ evidence upload ------------------------------ */
const MAX_MB = 10;
export function EvidenceUploader({ returnId, count, required, onChange }: { returnId: string; count: number; required: boolean; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const upload = async (file: File) => {
    setErr('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return setErr('Only JPEG, PNG or WebP photos are accepted');
    if (file.size > MAX_MB * 1_000_000) return setErr(`Photo must be smaller than ${MAX_MB} MB`);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/v1/aftersales/returns/${returnId}/evidence`, { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'x-requested-with': 'orvia' } });
      const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!res.ok) throw new Error(j.error?.message ?? 'Upload failed');
      toast.success('Photo added');
      onChange();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div>
      <p className="text-sm font-semibold">Photos {required && <span className="text-bad-500">(required)</span>} <span className="font-normal text-ink-3">· {count}/6 added</span></p>
      <label className="mt-2 flex h-11 w-fit cursor-pointer items-center gap-2 rounded-full border border-line px-4 text-sm font-semibold hover:bg-sunken">
        <Upload className="size-4" aria-hidden />{busy ? 'Uploading…' : 'Add a photo'}
        <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={busy || count >= 6} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
      </label>
      {err && <p role="alert" className="mt-2 text-sm text-bad-500">{err}</p>}
    </div>
  );
}

/* ------------------------------ return detail ------------------------------ */
export function ReturnDetail({ id }: { id: string }) {
  const { data, loading, error, reload } = useGet<ReturnView & { refund: RefundView }>(`/aftersales/returns/${id}`);
  if (loading) return <Skeleton className="h-64" />;
  if (error || !data) return <p role="alert" className="rounded-lg bg-bad-50 p-4 text-bad-500">{error || 'Return not found'}</p>;
  const open = ['submitted', 'authorized', 'in_transit'].includes(data.state);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm text-ink-3">Return {data.rmaNumber} · order {data.orderNumber}</p><h2 className="font-display text-2xl font-semibold">{rmaLabel(data.state)}</h2></div><StatusBadge status={data.state} /></div>
      <Card className="p-5"><h3 className="font-semibold">Items</h3><ul className="mt-2 text-sm">{data.items.map((i) => <li key={i.sku}>{i.quantity}× {i.title}</li>)}</ul><p className="mt-2 text-sm text-ink-3">You asked for a {data.resolution}.</p></Card>
      {data.instructions && <Card className="p-5"><h3 className="font-semibold">What to do next</h3><p className="mt-2 whitespace-pre-line text-sm text-ink-2">{data.instructions}</p>{data.label && <Button className="mt-3" href={data.label.url} variant="secondary">Open return label</Button>}</Card>}
      {data.fulfilment && <Card className="p-5"><h3 className="font-semibold">Replacement</h3><p className="mt-2 text-sm capitalize text-ink-2">Status: {data.fulfilment.status}{data.fulfilment.trackingNumber ? ` · tracking ${data.fulfilment.trackingNumber}` : ''}</p></Card>}
      {open && <Card className="p-5"><EvidenceUploader returnId={data.id} count={data.evidence.length} required={data.evidenceRequired && data.evidence.length === 0} onChange={() => void reload()} /></Card>}
      {data.resolution === 'refund' || data.refund.refunds.length ? <Card className="p-5"><RefundTimeline view={data.refund} /></Card> : null}
    </div>
  );
}

/* ------------------------------ start-a-return wizard ------------------------------ */
export function ReturnWizard({ orderNumber }: { orderNumber: string }) {
  const toast = useToast();
  const reasons = useGet<{ items: Reason[] }>('/aftersales/reasons');
  const [reason, setReason] = React.useState('');
  const elig = useGet<Elig>(reason ? `/aftersales/orders/${encodeURIComponent(orderNumber)}/eligibility?reason=${reason}` : null);
  const base = useGet<Elig>(!reason ? `/aftersales/orders/${encodeURIComponent(orderNumber)}/eligibility` : null);
  const e = reason ? elig.data : base.data;
  const [sel, setSel] = React.useState<Record<string, { quantity: number; condition: string }>>({});
  const [resolution, setResolution] = React.useState('refund');
  const [details, setDetails] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [created, setCreated] = React.useState<{ id: string; rmaNumber: string; evidenceRequired: boolean } | null>(null);
  const [photos, setPhotos] = React.useState(0);

  const meta = reasons.data?.items.find((r) => r.code === reason);
  const chosen = Object.entries(sel).filter(([, v]) => v.quantity > 0);
  const allowed = e ? chosen.map(([sku]) => e.lines.find((l) => l.sku === sku)?.resolutionsAllowed ?? []).reduce<string[] | null>((a, r) => (a ? a.filter((x) => r.includes(x)) : r), null) ?? ['refund'] : ['refund'];
  React.useEffect(() => { if (!allowed.includes(resolution)) setResolution('refund'); }, [allowed, resolution]);
  const toggle = (l: EligLine, on: boolean) => setSel((s) => { const n = { ...s }; if (on) n[l.sku] = { quantity: l.maxQuantity, condition: 'unopened' }; else delete n[l.sku]; return n; });

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api<{ id: string; rmaNumber: string; evidenceRequired: boolean }>('/aftersales/returns', { body: { orderId: e!.orderId, reason, details, resolution, items: chosen.map(([sku, v]) => ({ sku, quantity: v.quantity, condition: v.condition })) } });
      setCreated(r);
    } catch (x) { setErr((x as ApiError).message); toast.error((x as ApiError).message); } finally { setBusy(false); }
  };

  if (created) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl bg-ok-50 p-5 text-ok-500" role="status"><p className="text-lg font-bold">Return {created.rmaNumber} submitted</p><p className="text-sm text-ink-2">Our team reviews it and you will get instructions by email. Nothing needs to be shipped until it is approved.</p></div>
        <Card className="p-5"><EvidenceUploader returnId={created.id} count={photos} required={created.evidenceRequired} onChange={() => setPhotos((n) => n + 1)} /></Card>
        <Button href={`/account/returns/${created.id}`}>Track this return</Button>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <h2 className="font-display text-2xl font-semibold">Start a return · order {orderNumber}</h2>
      <Field label="What went wrong?">
        <Select value={reason} onChange={(ev) => { setReason(ev.target.value); setSel({}); }}>
          <option value="">Choose a reason…</option>
          {reasons.data?.items.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </Select>
      </Field>
      {(elig.loading || base.loading) && <Skeleton className="h-32" />}
      {(elig.error || base.error) && <p role="alert" className="rounded-lg bg-bad-50 p-3 text-sm text-bad-500">{elig.error || base.error}</p>}
      {e && e.orderReasons.length > 0 && <div role="alert" className="rounded-lg bg-warn-50 p-4 text-sm text-ink-2"><p className="font-semibold">This order cannot be returned right now</p><ul className="mt-1 list-disc pl-5">{e.orderReasons.map((r) => <li key={r.code}>{r.message}</li>)}</ul></div>}
      {e && reason && !e.orderReasons.length && (
        <fieldset className="space-y-3"><legend className="mb-1 text-sm font-semibold">Which items?</legend>
          {e.daysLeft !== null && <p className="text-sm text-ink-3">{e.daysLeft} of {e.windowDays} days left in the return window.</p>}
          {e.lines.map((l) => (
            <div key={l.sku} className={`rounded-xl border p-4 ${l.eligible ? 'border-line' : 'border-line bg-sunken'}`}>
              <label className="flex items-start gap-3"><input type="checkbox" className="mt-1 size-5" disabled={!l.eligible} checked={!!sel[l.sku]} onChange={(ev) => toggle(l, ev.target.checked)} /><span className="font-medium">{l.title}</span></label>
              {!l.eligible && <ul className="mt-2 list-disc pl-9 text-sm text-ink-3">{l.reasons.map((r) => <li key={r.code}>{r.message}</li>)}</ul>}
              {l.eligible && l.notes.map((n) => <p key={n} className="mt-1 pl-9 text-sm text-ink-3">{n}</p>)}
              {sel[l.sku] && (
                <div className="mt-3 grid gap-3 pl-9 sm:grid-cols-2">
                  <Field label="Quantity"><Select value={sel[l.sku]!.quantity} onChange={(ev) => setSel((s) => ({ ...s, [l.sku]: { ...s[l.sku]!, quantity: Number(ev.target.value) } }))}>{Array.from({ length: l.maxQuantity }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
                  <Field label="Condition"><Select value={sel[l.sku]!.condition} onChange={(ev) => setSel((s) => ({ ...s, [l.sku]: { ...s[l.sku]!, condition: ev.target.value } }))}><option value="unopened">Unopened</option><option value="opened_unused">Opened, not used</option><option value="used">Used</option><option value="damaged">Damaged</option><option value="defective">Not working</option></Select></Field>
                </div>
              )}
            </div>
          ))}
        </fieldset>
      )}
      {chosen.length > 0 && (
        <>
          <Field label="What would you like?"><Select value={resolution} onChange={(ev) => setResolution(ev.target.value)}><option value="refund">Refund to my original payment method</option>{allowed.includes('replacement') && <option value="replacement">Send a replacement</option>}{allowed.includes('exchange') && <option value="exchange">Exchange for another option</option>}</Select></Field>
          {resolution === 'exchange' && <p className="text-sm text-ink-3">Exchanges are available for options that cost the same or less. Contact support after submitting to choose the option.</p>}
          <Field label="Details (optional)"><Textarea value={details} maxLength={2000} onChange={(ev) => setDetails(ev.target.value)} /></Field>
          {meta?.evidence === 'required' && <p className="rounded-lg bg-sunken p-3 text-sm">A photo showing the problem is required. You can add it on the next step.</p>}
          {err && <p role="alert" className="text-sm text-bad-500">{err}</p>}
          <Button loading={busy} onClick={() => void submit()} block>Submit return request ({chosen.reduce((a, [, v]) => a + v.quantity, 0)} item{chosen.reduce((a, [, v]) => a + v.quantity, 0) > 1 ? 's' : ''})</Button>
          <p className="text-xs text-ink-3">Submitting a request does not guarantee a refund; our team reviews every return. Amounts are calculated from what you paid{e ? ` in ${e.currency}` : ''}.</p>
        </>
      )}
    </div>
  );
}
