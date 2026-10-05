import type { Metadata } from 'next';
import { Mail, MessageCircle, Package, RotateCcw, Truck } from 'lucide-react';
import { Accordion } from '@/components/pdp';
import { HelpActions } from '@/components/help-actions';
import { Button, Card, Link } from '@orvia/ui';
import { resolveCountry, sget } from '@/lib/server';
import type { Meta } from '@/lib/types';

export const metadata: Metadata = { title: 'Help center', description: 'Orders, delivery, returns and payments — answers and ways to reach us.', alternates: { canonical: '/help' } };

export default async function Help() {
  const country = await resolveCountry();
  const meta = await sget<Meta>('/meta', { country });
  const c = meta?.countries.find((x) => x.code === country);
  const std = c?.shippingMethods.find((m) => m.code === 'standard');
  const faqs = [
    { id: 'track', title: 'Where is my order?', body: <>Open <Link href="/track" className="font-semibold text-pine-700 underline">Track order</Link> with your order number and email, or sign in to see all orders. Tracking appears once the supplier ships; until then we only show what we really know.</> },
    { id: 'delivery', title: 'How long does delivery take?', body: <>Items ship from the partner warehouse closest to you, so estimates vary by product. {std ? `Standard delivery to ${c?.name} is ${std.minDays}–${std.maxDays} business days after dispatch.` : ''} The estimate for each item is on its page and again at checkout.</> },
    { id: 'returns', title: 'How do returns work?', body: <>You can return items within {c?.returnWindowDays} days of delivery. Open the order, choose “Return items”, and we’ll guide you from there. Refunds go back to your original payment method.</> },
    { id: 'duties', title: 'Will I pay customs or import fees?', body: <>{c?.legalNotice} If a shipment crosses a border and fees apply, we show an estimate before you pay whenever we can.</> },
    { id: 'pay', title: 'Which payment methods can I use?', body: <>In {c?.name}: {c?.paymentMethods.filter((m) => !m.includes('disabled')).map((m) => m.replace(/_/g, ' ')).join(', ')}. Payments are confirmed with the payment provider before we place your order.</> },
    { id: 'cancel', title: 'Can I cancel my order?', body: <>Yes, until it ships — open the order and choose “Cancel order”. Any payment is refunded automatically.</> },
    { id: 'safety', title: 'Are children’s products safe?', body: <>We only list children’s products when the supplier provides safety standard information (for example EN71 or ASTM F963), and we show it on the product page.</> },
  ];
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <h1 className="font-display text-4xl font-semibold tracking-tight">How can we help?</h1>
      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        {[{ i: Package, t: 'Track an order', d: 'Live status and tracking', h: '/track' }, { i: RotateCcw, t: 'Start a return', d: 'Within the return window', h: '/account/orders' }, { i: Truck, t: 'Shipping info', d: 'Times, costs, customs', h: '/legal/shipping' }].map((x) => (
          <Link key={x.t} href={x.h} className="group rounded-xl border border-line bg-surface p-5 shadow-card transition hover:border-pine-500"><x.i className="size-6 text-pine-600" /><p className="mt-3 font-bold">{x.t}</p><p className="text-sm text-ink-3">{x.d}</p></Link>
        ))}
      </div>
      <h2 className="mb-4 mt-12 text-xl font-bold">Common questions</h2>
      <Accordion items={faqs} />
      <Card className="mt-10 flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div><p className="flex items-center gap-2 text-lg font-bold"><MessageCircle className="size-5 text-pine-600" /> Still stuck?</p><p className="mt-1 text-sm text-ink-3">Our assistant can look up orders and answer product questions. A human follows up on anything it can’t resolve.</p></div>
        <HelpActions />
      </Card>
      <p className="mt-6 flex items-center gap-2 text-sm text-ink-3"><Mail className="size-4" /> {c?.name ? `Prefer email? ${'help@orvia.example'}` : ''}</p>
      <Button href="/" variant="ghost" className="mt-6">← Back to shopping</Button>
    </div>
  );
}
