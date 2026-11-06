import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumb, EmptyState, Link } from '@orvia/ui';
import { AffiliateBanner, CollectionDiscussion } from '@/components/creators';
import { ProductList } from '@/components/shelf';
import { SITE_URL, sget } from '@/lib/server';
import type { StoreProduct } from '@/lib/types';

type Props = { params: Promise<{ handle: string; collection: string }> };
interface CollectionPage {
  creator: { handle: string; displayName: string; avatarUrl: string | null };
  collection: { id: string; slug: string; title: string; description: string; publishedAt: string | null; updatedAt: string | null; discussionEnabled: boolean };
  items: { product: StoreProduct; note: string }[];
  unavailableCount: number;
  disclosure: string;
  comments: { total: number; items: { id: string; displayName: string; body: string; at?: string }[] };
}
const path = (p: { handle: string; collection: string }) => `/creators/${encodeURIComponent(p.handle)}/collections/${encodeURIComponent(p.collection)}`;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await params;
  const d = await sget<CollectionPage>(path(p));
  if (!d) return { title: 'Collection not found', robots: { index: false } };
  const desc = (d.collection.description || `${d.collection.title}: picks by ${d.creator.displayName}. Paid partnership.`).slice(0, 155);
  const url = `/creators/${d.creator.handle}/${d.collection.slug}`;
  const img = d.items[0]?.product.images[0]?.url;
  return { title: `${d.collection.title} by ${d.creator.displayName}`, description: desc, alternates: { canonical: url }, openGraph: { type: 'website', title: d.collection.title, description: desc, url, images: img ? [{ url: new URL(img, SITE_URL).toString() }] : undefined } };
}

export default async function CollectionRoute({ params }: Props) {
  const p = await params;
  const d = await sget<CollectionPage>(path(p));
  if (!d) notFound();
  const url = `${SITE_URL}/creators/${d.creator.handle}/${d.collection.slug}`;
  const ld = [
    { '@context': 'https://schema.org', '@type': 'CollectionPage', name: d.collection.title, description: d.collection.description || undefined, url, author: { '@type': 'Person', name: d.creator.displayName, url: `${SITE_URL}/creators/${d.creator.handle}` }, datePublished: d.collection.publishedAt ?? undefined, dateModified: d.collection.updatedAt ?? undefined, isAccessibleForFree: true },
    { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: d.items.map((i, n) => ({ '@type': 'ListItem', position: n + 1, url: `${SITE_URL}/p/${i.product.slug}`, name: i.product.title })) },
  ];
  const notes = d.items.filter((i) => i.note);
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:py-10">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, '\\u003c') }} />
      <Breadcrumb items={[{ label: 'Home', href: '/' }, { label: `@${d.creator.handle}`, href: `/creators/${d.creator.handle}` }, { label: d.collection.title }]} />
      <div className="mt-4"><AffiliateBanner text={d.disclosure} name={d.creator.displayName} /></div>
      <h1 className="mt-6 font-display text-3xl font-semibold tracking-tight sm:text-4xl">{d.collection.title}</h1>
      <p className="mt-1 text-ink-3">Curated by <Link href={`/creators/${d.creator.handle}`}>{d.creator.displayName}</Link></p>
      {d.collection.description && <p className="mt-3 max-w-2xl whitespace-pre-wrap text-ink-2">{d.collection.description}</p>}
      <div className="mt-6">
        {d.items.length === 0 ? <EmptyState title="Nothing available right now" body="The products in this collection are currently unavailable in your country." /> : <ProductList products={d.items.map((i) => i.product)} priorityFirst={4} />}
      </div>
      {d.unavailableCount > 0 && d.items.length > 0 && <p className="mt-3 text-xs text-ink-3">{d.unavailableCount} item{d.unavailableCount === 1 ? ' is' : 's are'} not available in your country right now.</p>}
      {notes.length > 0 && (
        <section className="mt-10"><h2 className="font-display text-xl font-semibold">Why {d.creator.displayName} picked these</h2>
          <ul className="mt-3 space-y-2 text-sm">{notes.map((n) => <li key={n.product.id}><Link href={`/p/${n.product.slug}`} className="font-semibold">{n.product.title}</Link>: {n.note}</li>)}</ul>
        </section>
      )}
      {d.collection.discussionEnabled && <CollectionDiscussion collectionId={d.collection.id} initial={d.comments.items} total={d.comments.total} />}
    </div>
  );
}
