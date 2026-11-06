'use client';
import { BellRing, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Badge, Button, Card, EmptyState, Field, Input, Link, Modal, ProductArt, Skeleton, Switch, useToast } from '@orvia/ui';
import type { PriceHistoryResponse } from '@orvia/types';
import { ApiError, api, money } from '@/lib/api';
import { useApi } from './account';
import { useStore } from './providers';

interface AlertView {
  id: string; productId: string; country: string; currency: string; active: boolean; baselinePrice: number; targetPrice: number | null; dropPercent: number;
  notifyOnDrop: boolean; notifyOnStock: boolean; notifyOnBetterOffer: boolean; lastNotifiedAt: string | null; notifiedCount: number; emailVerified?: boolean;
  product: { slug: string; title: string; image: string | null; price: number; inStock: boolean } | null;
}

/**
 * "Track price" button for a product card or product page: `<TrackPriceButton productId={p.id} price={p.price} currency={p.currency} />`.
 * Signed-out visitors are sent to log in; alerts are only ever emailed to the account that created them.
 */
export function TrackPriceButton({ productId, price, currency, className }: { productId: string; price: number | null; currency: string; className?: string }) {
  const { user } = useStore();
  const toast = useToast();
  const [state, setState] = React.useState<{ loading: boolean; alert: { id: string } | null }>({ loading: !!user, alert: null });
  const [open, setOpen] = React.useState(false);
  const [target, setTarget] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!user) return;
    let live = true;
    api<{ alert: { id: string } | null }>(`/account/price-guard/status?productId=${productId}`).then((r) => live && setState({ loading: false, alert: r.alert })).catch(() => live && setState({ loading: false, alert: null }));
    return () => { live = false; };
  }, [productId, user]);
  if (price == null) return null;
  if (!user) return <Link href={`/login?next=${encodeURIComponent(typeof window === 'undefined' ? '/find' : window.location.pathname + window.location.search)}`} className={className ?? 'inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong px-3 text-xs font-semibold text-ink-2 hover:bg-sunken'}><BellRing className="size-3.5" aria-hidden />Track price</Link>;
  const stop = async () => { setBusy(true); try { await api(`/account/price-guard/alerts/${state.alert!.id}`, { method: 'DELETE' }); setState({ loading: false, alert: null }); toast.success('Stopped tracking'); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  const start = async () => {
    const t = target.trim() ? Number(target) : undefined;
    if (t !== undefined && (!Number.isFinite(t) || t <= 0 || t * 100 >= price)) { toast.error(`Enter a target below the current price (${money(price, currency)})`); return; }
    setBusy(true);
    try {
      const r = await api<AlertView>('/account/price-guard/alerts', { body: { productId, ...(t !== undefined ? { targetPrice: t } : {}) } });
      setState({ loading: false, alert: { id: r.id } });
      setOpen(false);
      toast.success(r.emailVerified === false ? 'Tracking started. Verify your email to receive alerts.' : 'Tracking started. We will email you about changes.');
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Could not start tracking'); } finally { setBusy(false); }
  };
  return (
    <>
      <button type="button" disabled={state.loading || busy} onClick={() => (state.alert ? void stop() : setOpen(true))} aria-pressed={!!state.alert}
        className={className ?? 'inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong px-3 text-xs font-semibold text-ink-2 hover:bg-sunken disabled:opacity-60 aria-pressed:border-pine-600 aria-pressed:bg-pine-50 aria-pressed:text-pine-800'}>
        <BellRing className="size-3.5" aria-hidden />{state.alert ? 'Tracking' : 'Track price'}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Track this price" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void start()} loading={busy}>Start tracking</Button></>}>
        <p className="text-sm text-ink-2">Current price: <b>{money(price, currency)}</b>. We will email you if it drops by at least 5%, when it comes back in stock, or when a comparable product is cheaper. You can change this any time in Price Guard.</p>
        <div className="mt-4"><Field label={`Target price (optional, ${currency})`} htmlFor="tp-target" hint="We tell you when the price is at or below this."><Input id="tp-target" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="e.g. 19.99" /></Field></div>
      </Modal>
    </>
  );
}

/** Honest price history for a product page: renders nothing until we hold at least one observation. */
export function PriceHistoryPanel({ productId, days = 30 }: { productId: string; days?: number }) {
  const { data, loading } = useApi<PriceHistoryResponse>(`/find/price-history/${productId}?days=${days}`);
  if (loading) return <Skeleton className="h-16" />;
  if (!data || data.observations === 0) return null;
  const pts = data.points;
  const min = Math.min(...pts.map((p) => p.price));
  const max = Math.max(...pts.map((p) => p.price));
  const w = 260, h = 48;
  const x = (i: number) => (pts.length === 1 ? w / 2 : (i / (pts.length - 1)) * w);
  const y = (v: number) => (max === min ? h / 2 : h - 4 - ((v - min) / (max - min)) * (h - 8));
  return (
    <section aria-label="Price history" className="rounded-xl border border-line bg-surface p-4">
      <h3 className="text-sm font-bold">Price history</h3>
      {data.statement ? <p className="mt-1 text-sm text-ink-2">{data.statement}</p> : <p className="mt-1 text-sm text-ink-3">We have {data.observations} observation{data.observations === 1 ? '' : 's'} so far, which is not enough to say anything about trends.</p>}
      {pts.length > 1 && (
        <svg viewBox={`0 0 ${w} ${h}`} className="mt-3 h-14 w-full max-w-xs" role="img" aria-label={`Observed prices from ${money(min, data.currency)} to ${money(max, data.currency)}`}>
          <polyline fill="none" stroke="currentColor" strokeWidth="2" className="text-pine-600" points={pts.map((p, i) => `${x(i)},${y(p.price)}`).join(' ')} />
        </svg>
      )}
      <p className="mt-2 text-xs text-ink-3">Based only on prices Orvia itself observed{data.firstObservedAt ? ` since ${new Date(data.firstObservedAt).toLocaleDateString()}` : ''}. We do not show reference or “was” prices.</p>
    </section>
  );
}

/** Notice for a product page when a comparable, cheaper, well-rated product exists. Renders nothing otherwise. */
export function BetterOfferNotice({ productId }: { productId: string }) {
  const { data } = useApi<{ offer: { slug: string; title: string; price: number; currency: string; deliveredEstimate: number; yourDeliveredEstimate: number; savingPct: number; reasons: string[] } | null }>(`/find/better-offer/${productId}`);
  const o = data?.offer;
  if (!o) return null;
  return (
    <aside className="rounded-xl border border-pine-200 bg-pine-50 p-4 text-sm" aria-label="Better verified offer">
      <p className="font-bold text-pine-900">A comparable product costs less</p>
      <p className="mt-1 text-pine-900"><Link href={`/p/${o.slug}`} className="font-semibold underline">{o.title}</Link> is about {money(o.deliveredEstimate, o.currency)} delivered (this one: {money(o.yourDeliveredEstimate, o.currency)}), {o.savingPct}% less.</p>
      <ul className="mt-1 list-disc pl-5 text-pine-800">{o.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      <p className="mt-1 text-xs text-pine-800">It is a different listing: check the details before switching.</p>
    </aside>
  );
}

/** /account/price-guard */
export function PriceGuardPanel() {
  const { data, loading, reload } = useApi<{ items: AlertView[]; limit: number }>('/account/price-guard/alerts');
  const toast = useToast();
  const act = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast.success(ok); await reload(); } catch (e) { toast.error((e as Error).message); } };
  if (loading) return <div className="space-y-3"><Skeleton className="h-28" /><Skeleton className="h-28" /></div>;
  if (!data?.items.length) return <EmptyState icon={<BellRing className="size-6" />} title="You are not tracking any prices" body="Use “Track price” on any product to get an email when the price drops, it comes back in stock, or a comparable product is cheaper." action={<Button href="/find">Find products</Button>} />;
  const unverified = data.items.some((a) => a.emailVerified === false);
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-3">Tracking {data.items.filter((a) => a.active).length} of {data.limit} allowed products. Alerts go only to your account email.</p>
      {unverified && <p role="status" className="rounded-lg bg-saffron-50 p-3 text-sm text-saffron-900">Your email is not verified yet, so we are not sending alerts. Verify it from your profile to start receiving them.</p>}
      <ul className="space-y-3">
        {data.items.map((a) => (
          <li key={a.id}><Card className="p-4">
            <div className="flex gap-3">
              <div className="w-16 shrink-0 overflow-hidden rounded-md"><ProductArt src={a.product?.image ?? undefined} alt={a.product?.title ?? 'Product'} /></div>
              <div className="min-w-0 flex-1">
                {a.product ? <Link href={`/p/${a.product.slug}`} className="line-clamp-2 font-semibold hover:underline">{a.product.title}</Link> : <p className="font-semibold text-ink-3">Product no longer available</p>}
                <p className="mt-0.5 text-sm text-ink-2">{a.product ? <>Now <b>{money(a.product.price, a.currency)}</b> · </> : null}started at {money(a.baselinePrice, a.currency)}{a.targetPrice ? <> · target {money(a.targetPrice, a.currency)}</> : null}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">{a.product && <Badge tone={a.product.inStock ? 'ok' : 'warn'}>{a.product.inStock ? 'In stock' : 'Out of stock'}</Badge>}{!a.active && <Badge>Paused</Badge>}{a.notifiedCount > 0 && <Badge tone="info">{a.notifiedCount} alert{a.notifiedCount === 1 ? '' : 's'} sent</Badge>}</div>
              </div>
              <button type="button" aria-label={`Stop tracking ${a.product?.title ?? 'product'}`} onClick={() => void act(() => api(`/account/price-guard/alerts/${a.id}`, { method: 'DELETE' }), 'Stopped tracking')} className="grid size-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-sunken"><Trash2 className="size-4" /></button>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Switch label="Active" checked={a.active} onChange={(v) => void act(() => api(`/account/price-guard/alerts/${a.id}`, { method: 'PATCH', body: { active: v } }))} />
              <Switch label={`Price drops (${a.dropPercent}%+)`} checked={a.notifyOnDrop} onChange={(v) => void act(() => api(`/account/price-guard/alerts/${a.id}`, { method: 'PATCH', body: { notifyOnDrop: v } }))} />
              <Switch label="Back in stock" checked={a.notifyOnStock} onChange={(v) => void act(() => api(`/account/price-guard/alerts/${a.id}`, { method: 'PATCH', body: { notifyOnStock: v } }))} />
              <Switch label="Cheaper comparable product" checked={a.notifyOnBetterOffer} onChange={(v) => void act(() => api(`/account/price-guard/alerts/${a.id}`, { method: 'PATCH', body: { notifyOnBetterOffer: v } }))} />
            </div>
          </Card></li>
        ))}
      </ul>
    </div>
  );
}
