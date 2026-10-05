'use client';
import { CreditCard, Lock, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, Select, Skeleton, ProductArt, useToast, cn, Link, Breadcrumb } from '@orvia/ui';
import { ShoppingBag } from 'lucide-react';
import { api, ApiError, money } from '@/lib/api';
import { POSTAL_LABEL, REGIONS, REGION_LABEL } from '@/lib/regions';
import type { CartView } from '@/lib/types';
import { useStore } from '@/components/providers';

interface Form { email: string; consent: boolean; fullName: string; phone: string; line1: string; line2: string; city: string; region: string; postalCode: string; shipping: string }
interface PaymentInfo { provider: string; intentId: string; clientSecret?: string; clientConfig: Record<string, string> }
interface Placed { order: { id: string; orderNumber: string; total: number; currency: string }; payment: PaymentInfo | null }

const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now());

export default function CheckoutPage() {
  const { cart, cartLoading, user, country, meta, refreshCart, track } = useStore();
  const router = useRouter();
  const toast = useToast();
  const cfg = meta.countries.find((c) => c.code === country)!;
  const [f, setF] = React.useState<Form>({ email: user?.email ?? '', consent: false, fullName: user?.name ?? '', phone: '', line1: '', line2: '', city: '', region: '', postalCode: '', shipping: 'standard' });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [priced, setPriced] = React.useState<CartView | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [placed, setPlaced] = React.useState<Placed | null>(null);
  const [payError, setPayError] = React.useState('');
  const key = React.useRef('');
  React.useEffect(() => { key.current = sessionStorage.getItem('orvia_checkout_key') || uuid(); sessionStorage.setItem('orvia_checkout_key', key.current); track('checkout_start'); }, [track]);
  React.useEffect(() => { if (user && !f.email) setF((p) => ({ ...p, email: user.email, fullName: p.fullName || user.name })); }, [user, f.email]);

  // re-price when region / shipping method changes (tax + shipping)
  React.useEffect(() => {
    if (!cart?.lines.length) return;
    const t = setTimeout(() => { api<CartView>(`/cart?country=${country}&region=${f.region}&shipping=${f.shipping}`).then(setPriced).catch(() => undefined); }, 150);
    return () => clearTimeout(t);
  }, [cart?.token, cart?.itemCount, cart?.discount, f.region, f.shipping, country]);
  const view = priced ?? cart;
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!/^\S+@\S+\.\S+$/.test(f.email)) e['email'] = 'Enter a valid email address';
    if (!f.fullName.trim()) e['fullName'] = 'Enter the recipient’s full name';
    if (f.line1.trim().length < 5) e['line1'] = 'Enter your street address';
    if (!f.city.trim()) e['city'] = 'Enter your city';
    if (!f.region) e['region'] = `Select your ${REGION_LABEL[country]?.toLowerCase()}`;
    const pc = f.postalCode.trim().toUpperCase();
    if (country === 'US' && !/^\d{5}(-\d{4})?$/.test(pc)) e['postalCode'] = 'ZIP code must be 5 digits';
    if (country === 'CA' && !/^[ABCEGHJ-NPRSTVXY]\d[A-Z][ -]?\d[A-Z]\d$/.test(pc)) e['postalCode'] = 'Enter a valid postal code (e.g. M5X 1A9)';
    if (country === 'IN' && !/^[1-9]\d{5}$/.test(pc)) e['postalCode'] = 'PIN code must be 6 digits';
    setErrors(e);
    if (Object.keys(e).length) document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    return Object.keys(e).length === 0;
  };

  const place = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!validate() || !view) return;
    setBusy(true);
    try {
      await api('/cart/contact', { body: { email: f.email, marketingConsent: f.consent } });
      const res = await api<Placed>('/checkout', { body: { email: f.email, shippingMethod: f.shipping, idempotencyKey: key.current, address: { fullName: f.fullName, line1: f.line1, line2: f.line2, city: f.city, region: f.region, postalCode: f.postalCode, country, phone: f.phone } } });
      setPlaced(res);
    } catch (e) {
      const er = e as ApiError;
      if (er.code === 'CART_CHANGED') { toast.error(er.message); await refreshCart(); } else toast.error(er.message);
    } finally { setBusy(false); }
  };

  const done = async (order: Placed['order']) => {
    sessionStorage.removeItem('orvia_checkout_key');
    await refreshCart();
    router.push(`/orders/${order.orderNumber}?placed=1&email=${encodeURIComponent(f.email)}`);
  };

  if (cartLoading) return <div className="mx-auto max-w-5xl px-4 py-10"><Skeleton className="h-96" /></div>;
  if (!view || !view.lines.length) return <div className="mx-auto max-w-3xl px-4 py-16"><EmptyState icon={<ShoppingBag className="size-6" />} level={1} title="Nothing to check out" action={<Button href="/">Continue shopping</Button>} /></div>;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-10">
      <Breadcrumb items={[{ label: 'Cart', href: '/cart' }, { label: 'Checkout' }]} />
      <h1 className="mb-6 mt-4 font-display text-3xl font-semibold tracking-tight sm:text-4xl">Checkout</h1>
      <div className="grid gap-8 lg:grid-cols-[1fr_24rem]">
        <div>
          {!placed ? (
            <form onSubmit={place} noValidate className="space-y-6">
              <Section n={1} title="Contact">
                <Field label="Email" htmlFor="email" error={errors['email']}><Input id="email" type="email" autoComplete="email" inputMode="email" value={f.email} onChange={set('email')} invalid={!!errors['email']} /></Field>
                <Checkbox className="mt-3" checked={f.consent} onChange={set('consent')} label="Email me order updates, offers and a reminder if I leave something behind (optional)" />
                {!user && <p className="mt-3 text-sm text-ink-3">Have an account? <Link href="/login?next=/checkout" className="font-semibold text-pine-700 underline">Sign in</Link></p>}
              </Section>
              <Section n={2} title={`Shipping address · ${cfg.name}`}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Full name" htmlFor="fullName" error={errors['fullName']} className="sm:col-span-2"><Input id="fullName" autoComplete="name" value={f.fullName} onChange={set('fullName')} invalid={!!errors['fullName']} /></Field>
                  <Field label="Address" htmlFor="line1" error={errors['line1']} className="sm:col-span-2"><Input id="line1" autoComplete="address-line1" value={f.line1} onChange={set('line1')} invalid={!!errors['line1']} /></Field>
                  <Field label="Apartment, suite, etc. (optional)" htmlFor="line2" className="sm:col-span-2"><Input id="line2" autoComplete="address-line2" value={f.line2} onChange={set('line2')} /></Field>
                  <Field label="City" htmlFor="city" error={errors['city']}><Input id="city" autoComplete="address-level2" value={f.city} onChange={set('city')} invalid={!!errors['city']} /></Field>
                  <Field label={REGION_LABEL[country] ?? 'Region'} htmlFor="region" error={errors['region']}>
                    <Select id="region" autoComplete="address-level1" value={f.region} onChange={set('region')} invalid={!!errors['region']}><option value="">Select…</option>{(REGIONS[country] ?? []).map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select>
                  </Field>
                  <Field label={POSTAL_LABEL[country] ?? 'Postal code'} htmlFor="postalCode" error={errors['postalCode']}><Input id="postalCode" autoComplete="postal-code" inputMode={country === 'CA' ? 'text' : 'numeric'} value={f.postalCode} onChange={set('postalCode')} invalid={!!errors['postalCode']} /></Field>
                  <Field label="Phone (for the carrier)" htmlFor="phone"><Input id="phone" type="tel" autoComplete="tel" inputMode="tel" value={f.phone} onChange={set('phone')} /></Field>
                </div>
                <p className="mt-3 text-sm text-ink-3">Shipping to a different country? Change it in the header — prices and delivery depend on where we ship from.</p>
              </Section>
              <Section n={3} title="Delivery">
                <div role="radiogroup" aria-label="Delivery method" className="space-y-2.5">
                  {view.shippingOptions.map((o) => (
                    <label key={o.code} className={cn('flex cursor-pointer items-center gap-3 rounded-lg border p-4', f.shipping === o.code ? 'border-pine-600 bg-pine-50 ring-1 ring-pine-600' : 'border-line-strong hover:bg-sunken/60')}>
                      <input type="radio" name="ship" checked={f.shipping === o.code} onChange={() => setF((p) => ({ ...p, shipping: o.code }))} className="size-4.5 accent-[var(--pine-600)]" />
                      <span className="flex-1"><b className="text-[15px]">{o.label}</b><span className="block text-sm text-ink-3">{o.minDays}–{o.maxDays} business days after dispatch</span></span>
                      <b className="tabular-nums">{o.charge === 0 ? 'Free' : money(o.charge, view.currency)}</b>
                    </label>
                  ))}
                </div>
              </Section>
              <Section n={4} title="Payment">
                <p className="flex items-center gap-2 text-sm text-ink-2"><Lock className="size-4 text-pine-600" /> You’ll enter payment details securely on the next step. We never see or store card numbers.</p>
                {meta.payment.mode === 'mock' && <p className="mt-3"><Badge tone="warn">Test mode — no real money is charged</Badge></p>}
              </Section>
              <Button type="submit" size="lg" block loading={busy}>Continue to payment · {money(view.totals.total, view.currency)}</Button>
            </form>
          ) : (
            <PaymentStep placed={placed} email={f.email} name={f.fullName} mode={meta.payment.mode} stripeKey={meta.payment.stripePublishableKey} onPaid={() => void done(placed.order)} error={payError} setError={setPayError} />
          )}
        </div>
        <aside className="lg:sticky lg:top-32 lg:self-start">
          <Card className="p-5">
            <h2 className="text-lg font-bold">In your order</h2>
            <ul className="mt-4 space-y-3">{view.lines.map((l) => (<li key={l.productId + l.sku} className="flex gap-3"><div className="relative w-16 shrink-0"><ProductArt src={l.image} alt="" className="rounded-md" /><span className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-ink text-[11px] font-bold text-paper">{l.quantity}</span></div><div className="min-w-0 flex-1 text-sm"><p className="line-clamp-2 font-semibold">{l.title}</p>{l.variantLabel && <p className="text-ink-3">{l.variantLabel}</p>}</div><b className="text-sm tabular-nums">{money(l.lineTotal, view.currency)}</b></li>))}</ul>
            <dl className="mt-5 space-y-2 border-t border-line pt-4 text-[15px]">
              <div className="flex justify-between"><dt className="text-ink-2">Subtotal</dt><dd className="tabular-nums">{money(view.subtotal, view.currency)}</dd></div>
              {view.promotions.filter((p) => p.amount > 0).map((p) => <div key={p.name} className="flex justify-between text-ok-500"><dt>{p.name}</dt><dd className="tabular-nums">−{money(p.amount, view.currency)}</dd></div>)}
              <div className="flex justify-between"><dt className="text-ink-2">Shipping</dt><dd className="tabular-nums">{view.totals.shipping === 0 ? 'Free' : money(view.totals.shipping, view.currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-2">{view.totals.taxInclusive ? 'Includes GST' : 'Tax'}</dt><dd className="tabular-nums">{view.totals.tax === 0 && !view.totals.taxInclusive && !f.region ? '—' : money(view.totals.tax, view.currency)}</dd></div>
              <div className="flex items-baseline justify-between border-t border-line pt-3"><dt className="font-bold">Total</dt><dd className="text-2xl font-bold tabular-nums">{money(view.totals.total, view.currency)}</dd></div>
            </dl>
            {view.delivery && <p className="mt-3 text-sm text-ink-2">Estimated arrival <b>{view.delivery.label}</b></p>}
            <p className="mt-4 flex items-center gap-2 text-xs text-ink-3"><ShieldCheck className="size-4" /> {view.legalNotice}</p>
          </Card>
        </aside>
      </div>
    </div>
  );
}

const Section = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
  <section className="rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6" aria-labelledby={`s${n}`}>
    <h2 id={`s${n}`} className="mb-4 flex items-center gap-3 text-lg font-bold"><span className="grid size-7 place-items-center rounded-full bg-pine-600 text-sm text-white">{n}</span>{title}</h2>
    {children}
  </section>
);

function PaymentStep({ placed, email, name, mode, stripeKey, onPaid, error, setError }: { placed: Placed; email: string; name: string; mode: string; stripeKey: string | null; onPaid: () => void; error: string; setError: (s: string) => void }) {
  const p = placed.payment;
  const [busy, setBusy] = React.useState(false);
  if (!p) return <Card className="p-6"><p className="font-bold">This order is no longer awaiting payment.</p><Button className="mt-4" href={`/orders/${placed.order.orderNumber}?email=${encodeURIComponent(email)}`}>View order</Button></Card>;
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="flex items-center gap-2 text-lg font-bold"><CreditCard className="size-5 text-pine-600" /> Payment · {money(placed.order.total, placed.order.currency)}</h2>
      <p className="mt-1 text-sm text-ink-3">Order {placed.order.orderNumber}</p>
      {error && <p role="alert" className="mt-4 rounded-md bg-coral-50 p-3 text-sm text-coral-700">{error}</p>}
      {p.provider === 'mock' && <MockPay intentId={p.intentId} busy={busy} setBusy={setBusy} onPaid={onPaid} setError={setError} />}
      {p.provider === 'stripe' && <StripePay clientSecret={p.clientSecret!} publishableKey={p.clientConfig['publishableKey'] || stripeKey || ''} orderNumber={placed.order.orderNumber} email={email} onPaid={onPaid} setError={setError} />}
      {p.provider === 'razorpay' && <RazorpayPay keyId={p.clientConfig['keyId']!} orderId={p.clientConfig['orderId']!} amount={placed.order.total} currency={placed.order.currency} email={email} name={name} onPaid={onPaid} setError={setError} />}
      <p className="sr-only">{mode}</p>
    </Card>
  );
}

/** DEV ONLY: the mock provider. Success/failure is delivered as a signed webhook, exactly like a real provider. */
function MockPay({ intentId, busy, setBusy, onPaid, setError }: { intentId: string; busy: boolean; setBusy: (b: boolean) => void; onPaid: () => void; setError: (s: string) => void }) {
  const run = async (outcome: 'succeeded' | 'failed') => {
    setBusy(true); setError('');
    try {
      const r = await api<{ outcome: string }>(`/dev/payments/${intentId}/simulate`, { body: { outcome } });
      if (outcome === 'failed') setError('Your card was declined (simulated). Try again with a different outcome.');
      else if (['processed', 'duplicate'].includes(r.outcome)) onPaid();
      else setError(`Payment could not be confirmed (${r.outcome}).`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="mt-5 space-y-4">
      <Badge tone="warn">Test mode — simulated payment provider</Badge>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Card number" className="sm:col-span-2"><Input defaultValue="4242 4242 4242 4242" inputMode="numeric" autoComplete="off" aria-label="Test card number" /></Field>
        <Field label="Expiry"><Input defaultValue="12 / 34" autoComplete="off" /></Field><Field label="CVC"><Input defaultValue="123" autoComplete="off" /></Field>
      </div>
      <Button size="lg" block loading={busy} onClick={() => void run('succeeded')}>Pay now</Button>
      <button className="w-full text-center text-sm font-semibold text-ink-3 hover:text-coral-500" onClick={() => void run('failed')}>Simulate a declined card</button>
    </div>
  );
}

function StripePay({ clientSecret, publishableKey, orderNumber, email, onPaid, setError }: { clientSecret: string; publishableKey: string; orderNumber: string; email: string; onPaid: () => void; setError: (s: string) => void }) {
  const mount = React.useRef<HTMLDivElement>(null);
  const ctl = React.useRef<{ pay: () => Promise<void> } | null>(null);
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    let off = false;
    void (async () => {
      const { loadStripe } = await import('@stripe/stripe-js');
      const stripe = await loadStripe(publishableKey);
      if (!stripe || off || !mount.current) return setError('Payment form failed to load');
      const elements = stripe.elements({ clientSecret });
      elements.create('payment').mount(mount.current);
      ctl.current = { pay: async () => {
        const r = await stripe.confirmPayment({ elements, redirect: 'if_required', confirmParams: { return_url: `${location.origin}/orders/${orderNumber}?placed=1&email=${encodeURIComponent(email)}` } });
        if (r.error) setError(r.error.message ?? 'Payment failed'); else onPaid();
      } };
      setReady(true);
    })().catch((e) => setError((e as Error).message));
    return () => { off = true; };
  }, [clientSecret, publishableKey, orderNumber, email, onPaid, setError]);
  return (<div className="mt-5"><div ref={mount} className="min-h-24" /><Button size="lg" block className="mt-4" disabled={!ready} loading={busy} onClick={async () => { setBusy(true); setError(''); await ctl.current?.pay(); setBusy(false); }}>Pay now</Button></div>);
}

function RazorpayPay({ keyId, orderId, amount, currency, email, name, onPaid, setError }: { keyId: string; orderId: string; amount: number; currency: string; email: string; name: string; onPaid: () => void; setError: (s: string) => void }) {
  const [busy, setBusy] = React.useState(false);
  const open = async () => {
    setBusy(true); setError('');
    try {
      if (!(window as unknown as { Razorpay?: unknown }).Razorpay) await new Promise<void>((res, rej) => { const s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js'; s.onload = () => res(); s.onerror = () => rej(new Error('Could not load Razorpay')); document.body.appendChild(s); });
      const RZP = (window as unknown as { Razorpay: new (o: unknown) => { open: () => void; on: (e: string, cb: (r: { error: { description: string } }) => void) => void } }).Razorpay;
      const rz = new RZP({ key: keyId, order_id: orderId, amount, currency, name: 'Orvia', prefill: { email, name }, theme: { color: '#24574a' }, handler: () => onPaid(), modal: { ondismiss: () => setBusy(false) } });
      rz.on('payment.failed', (r) => { setError(r.error.description); setBusy(false); });
      rz.open();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return <div className="mt-5"><p className="text-sm text-ink-2">UPI, cards, netbanking and wallets are available in the secure Razorpay window.</p><Button size="lg" block className="mt-4" loading={busy} onClick={() => void open()}>Pay with Razorpay</Button></div>;
}
