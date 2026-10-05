'use client';
import { ShoppingBag, Tag, Truck } from 'lucide-react';
import * as React from 'react';
import { Breadcrumb, Button, Card, EmptyState, Input, Link, PriceDisplay, ProductArt, QuantityStepper, Skeleton } from '@orvia/ui';
import { money } from '@/lib/api';
import { useStore } from '@/components/providers';

export default function CartPage() {
  const { cart, cartLoading, setQty, applyCoupon, meta, country } = useStore();
  const [code, setCode] = React.useState('');
  const cfg = meta.countries.find((c) => c.code === country)!;
  if (cartLoading) return <div className="mx-auto max-w-7xl px-4 py-10"><Skeleton className="h-64" /></div>;
  if (!cart || !cart.lines.length) return <div className="mx-auto max-w-3xl px-4 py-16"><EmptyState icon={<ShoppingBag className="size-6" />} title="Your cart is empty" body="Add a few things you love and they’ll show up here." action={<Button href="/">Continue shopping</Button>} /></div>;
  const std = cfg.shippingMethods.find((m) => m.code === 'standard');
  const progress = std?.freeOver ? Math.min(100, ((cart.subtotal - cart.discount) / std.freeOver) * 100) : 100;
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:py-10">
      <Breadcrumb items={[{ label: 'Home', href: '/' }, { label: 'Cart' }]} />
      <h1 className="mb-6 mt-4 font-display text-3xl font-semibold tracking-tight sm:text-4xl">Your cart</h1>
      <div className="grid gap-8 lg:grid-cols-[1fr_24rem]">
        <div>
          {std?.freeOver ? (
            <Card className="mb-4 p-4"><p className="flex items-center gap-2 text-sm"><Truck className="size-4 text-pine-600" />{cart.freeShippingRemaining ? <>Add <b>{money(cart.freeShippingRemaining, cart.currency)}</b> for free shipping</> : <b className="text-ok-500">You’ve unlocked free shipping 🎉</b>}</p><div className="mt-2.5 h-1.5 rounded-full bg-sunken"><div className="h-full rounded-full bg-pine-600 transition-all" style={{ width: `${progress}%` }} /></div></Card>
          ) : null}
          {cart.issues.length > 0 && <div role="alert" className="mb-4 rounded-lg bg-coral-50 p-4 text-sm text-coral-700"><b>Some items need attention:</b><ul className="mt-1 list-disc pl-5">{cart.issues.map((i) => <li key={i}>{i}</li>)}</ul></div>}
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {cart.lines.map((l) => (
              <li key={l.productId + l.sku} className="flex gap-4 p-4 sm:p-5">
                <Link href={`/p/${l.slug}`} className="w-24 shrink-0 overflow-hidden rounded-lg sm:w-28"><ProductArt src={l.image} alt={l.title} /></Link>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex justify-between gap-3"><div className="min-w-0"><Link href={`/p/${l.slug}`} className="line-clamp-2 font-semibold leading-snug hover:text-pine-700">{l.title}</Link>{l.variantLabel && <p className="text-sm text-ink-3">{l.variantLabel}</p>}</div><span className="shrink-0 font-bold tabular-nums">{money(l.lineTotal, cart.currency)}</span></div>
                  {l.issue && <p className="mt-1 text-sm font-semibold text-coral-500">{l.issue}</p>}
                  <p className="mt-0.5 text-sm text-ink-3">{money(l.unitPrice, cart.currency)} each</p>
                  <div className="mt-auto flex items-center justify-between pt-3"><QuantityStepper value={l.quantity} max={Math.max(1, l.maxQty)} onChange={(n) => void setQty(l.productId, l.sku, n)} /><button onClick={() => void setQty(l.productId, l.sku, 0)} className="text-sm font-semibold text-ink-3 hover:text-coral-500">Remove</button></div>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <aside className="lg:sticky lg:top-32 lg:self-start">
          <Card className="p-5">
            <h2 className="text-lg font-bold">Order summary</h2>
            <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (code.trim()) { void applyCoupon(code.trim()); setCode(''); } }}>
              <div className="relative flex-1"><Tag className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" /><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Promo code" aria-label="Promo code" className="pl-9 uppercase" /></div>
              <Button variant="secondary" type="submit">Apply</Button>
            </form>
            {cart.couponError && <p role="alert" className="mt-2 text-sm text-coral-500">{cart.couponError}</p>}
            {cart.couponCode && !cart.couponError && <p className="mt-2 flex items-center justify-between text-sm text-ok-500"><span>Code <b>{cart.couponCode}</b> applied</span><button className="font-semibold underline" onClick={() => void applyCoupon(null)}>Remove</button></p>}
            <dl className="mt-5 space-y-2.5 text-[15px]">
              <div className="flex justify-between"><dt className="text-ink-2">Subtotal</dt><dd className="tabular-nums">{money(cart.subtotal, cart.currency)}</dd></div>
              {cart.promotions.filter((p) => p.amount > 0).map((p) => <div key={p.name} className="flex justify-between text-ok-500"><dt>{p.name}</dt><dd className="tabular-nums">−{money(p.amount, cart.currency)}</dd></div>)}
              <div className="flex justify-between"><dt className="text-ink-2">Shipping</dt><dd className="tabular-nums">{cart.totals.shipping === 0 ? 'Free' : money(cart.totals.shipping, cart.currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-2">{cart.totals.taxInclusive ? 'Taxes' : 'Estimated tax'}</dt><dd className="text-ink-3">{cart.totals.taxInclusive ? 'Included' : 'At checkout'}</dd></div>
              <div className="flex items-baseline justify-between border-t border-line pt-3"><dt className="font-bold">Total</dt><dd><PriceDisplay price={cart.totals.total - (cart.totals.taxInclusive ? 0 : cart.totals.tax)} currency={cart.currency} size="lg" /></dd></div>
            </dl>
            {cart.delivery && <p className="mt-3 flex items-center gap-2 text-sm text-ink-2"><Truck className="size-4 text-pine-600" /> Estimated arrival {cart.delivery.label}</p>}
            <Button size="lg" block className="mt-5" href="/checkout" disabled={cart.checkoutBlocked}>Checkout</Button>
            <p className="mt-3 text-center text-xs text-ink-3">{cart.legalNotice}</p>
          </Card>
        </aside>
      </div>
    </div>
  );
}
