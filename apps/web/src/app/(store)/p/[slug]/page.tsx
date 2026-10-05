import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumb } from '@orvia/ui';
import { Accordion, BuyBox, FrequentlyBought, Gallery, Reviews } from '@/components/pdp';
import { ProductShelf, RecentlyViewed, TrackView } from '@/components/shelf';
import { SITE_URL, resolveCountry, sget } from '@/lib/server';
import type { ProductPage } from '@/lib/types';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const d = await sget<ProductPage>(`/products/${slug}`);
  if (!d) return { title: 'Product not found' };
  const p = d.product;
  const desc = p.seo.metaDescription ?? p.description.slice(0, 155);
  return {
    title: p.seo.title ?? p.title, description: desc, alternates: { canonical: `/p/${slug}` },
    openGraph: { type: 'website', title: p.title, description: desc, images: p.images[0] ? [{ url: new URL(p.images[0].url, SITE_URL).toString() }] : undefined, url: `/p/${slug}` },
  };
}

export default async function ProductPageRoute({ params }: Props) {
  const { slug } = await params;
  const country = await resolveCountry();
  const d = await sget<ProductPage>(`/products/${slug}`, { country });
  if (!d) notFound();
  const p = d.product;
  const ld = [
    {
      '@context': 'https://schema.org', '@type': 'Product', name: p.title, description: p.description, image: p.images.map((i) => new URL(i.url, SITE_URL).toString()), sku: p.id, brand: { '@type': 'Brand', name: p.brand },
      ...(p.rating.count ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: p.rating.avg, reviewCount: p.rating.count } } : {}),
      offers: { '@type': 'Offer', url: `${SITE_URL}/p/${slug}`, priceCurrency: p.currency || undefined, price: p.price !== null ? (p.price / 100).toFixed(2) : undefined, availability: p.available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', itemCondition: 'https://schema.org/NewCondition' },
    },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: d.breadcrumbs.map((b, i) => ({ '@type': 'ListItem', position: i + 1, name: b.label, item: `${SITE_URL}${b.href}` })) },
  ];
  const specs = Object.entries(p.attributes).filter(([k]) => k !== 'Top category');
  return (
    <>
      <TrackView productId={p.id} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, '\\u003c') }} />
      <div className="mx-auto max-w-7xl px-4 py-5 sm:py-8">
        <Breadcrumb items={d.breadcrumbs.map((b, i) => ({ label: b.label, href: i < d.breadcrumbs.length - 1 ? b.href : undefined }))} />
        <div className="mt-5 grid gap-8 lg:grid-cols-[1.1fr_1fr] lg:gap-14">
          <Gallery images={p.images} title={p.title} />
          <BuyBox data={d} />
        </div>
        <div className="mx-auto mt-14 grid max-w-7xl gap-10 lg:grid-cols-[1.4fr_1fr]">
          <Accordion items={[
            { id: 'desc', title: 'Description', body: <><p>{p.description}</p>{p.bullets.filter((b) => !p.description.includes(b)).length > 0 && <ul className="mt-4 list-disc space-y-1.5 pl-5">{p.bullets.filter((b) => !p.description.includes(b)).map((b) => <li key={b}>{b}</li>)}</ul>}</> },
            ...(p.benefits.length ? [{ id: 'ben', title: 'Why you’ll like it', body: <ul className="list-disc space-y-1.5 pl-5">{p.benefits.map((b) => <li key={b}>{b}</li>)}</ul> }] : []),
            ...(specs.length ? [{ id: 'spec', title: 'Details', body: <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">{specs.map(([k, v]) => <div key={k} className="flex justify-between gap-4 border-b border-line/60 py-1.5"><dt className="text-ink-3">{k}</dt><dd className="text-right font-semibold">{v}</dd></div>)}</dl> }] : []),
            { id: 'ship', title: 'Shipping & returns', body: <><p>{d.legalNotice}</p><p className="mt-3">Delivery options: {d.shipping.map((s) => `${s.label}`).join(', ')}. Returns accepted within {p.returnWindowDays ?? 30} days of delivery. Tracking is provided as soon as the supplier ships.</p></> },
            ...(p.faqs.length ? [{ id: 'faq', title: 'Questions & answers', body: <div className="space-y-4">{p.faqs.map((f) => <div key={f.q}><p className="font-bold text-ink">{f.q}</p><p>{f.a}</p></div>)}</div> }] : []),
          ]} />
          <FrequentlyBought items={d.frequentlyBoughtTogether} />
        </div>
        <div className="mt-16"><Reviews data={d} /></div>
        {d.similar.length > 0 && <section className="mt-16"><h2 className="mb-5 font-display text-2xl font-semibold tracking-tight">You may also like</h2><ProductShelf products={d.similar} /></section>}
      </div>
      <RecentlyViewed excludeId={p.id} />
      <div className="h-20 sm:hidden" />
    </>
  );
}
