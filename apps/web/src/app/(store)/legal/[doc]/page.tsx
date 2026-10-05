import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { resolveCountry, sget } from '@/lib/server';
import type { Meta } from '@/lib/types';

const DOCS: Record<string, string> = { returns: 'Returns & refunds', shipping: 'Shipping & delivery', privacy: 'Privacy', terms: 'Terms of sale' };
export async function generateMetadata({ params }: { params: Promise<{ doc: string }> }): Promise<Metadata> {
  const { doc } = await params;
  return { title: DOCS[doc] ?? 'Legal' };
}

export default async function Legal({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  if (!DOCS[doc]) notFound();
  const country = await resolveCountry();
  const meta = await sget<Meta>('/meta', { country });
  const c = meta?.countries.find((x) => x.code === country);
  const body: Record<string, React.ReactNode> = {
    returns: <><p>You can return most items within <b>{c?.returnWindowDays} days</b> of delivery. Start the return from your order page. Once approved and received, we refund the original payment method. Items damaged on arrival or not as described are refunded in full.</p><p>Personalised items are only returnable if faulty. Refund timing depends on your bank or payment provider (typically 5–10 business days).</p></>,
    shipping: <><p>Orders are fulfilled by partner warehouses. We choose the partner that gives the best combination of price, speed and reliability for your address.</p><ul className="list-disc space-y-1 pl-5">{c?.shippingMethods.map((m) => <li key={m.code}>{m.label}: {m.minDays}–{m.maxDays} business days after dispatch</li>)}</ul><p>{c?.legalNotice}</p></>,
    privacy: <><p>We collect only what we need to take and deliver your order: contact details, shipping address and order history. Payments are processed by our payment provider; we never see or store full card numbers.</p><p>We email you about your orders. Marketing emails (including cart reminders) are sent only if you opt in at checkout, and you can opt out at any time.</p></>,
    terms: <><p>Prices are shown in {c?.currency}. {c?.taxInclusive ? 'Prices include applicable taxes.' : 'Sales tax or VAT is calculated at checkout based on your address.'} An order is accepted when payment is confirmed. We may cancel and refund an order if an item becomes unavailable or a pricing error occurs.</p></>,
  };
  return (
    <article className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <h1 className="font-display text-4xl font-semibold tracking-tight">{DOCS[doc]}</h1>
      <div className="mt-6 space-y-4 text-[16px] leading-relaxed text-ink-2">{body[doc]}</div>
      <p className="mt-10 text-sm text-ink-3">This summary applies to {c?.name}. Last updated {new Date().toLocaleDateString(undefined, { dateStyle: 'long' })}.</p>
    </article>
  );
}
