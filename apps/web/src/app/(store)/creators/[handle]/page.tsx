import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumb, EmptyState, Link } from '@orvia/ui';
import { AffiliateBanner } from '@/components/creators';
import { SITE_URL, sget } from '@/lib/server';

type Props = { params: Promise<{ handle: string }> };
interface CreatorPage {
  creator: { handle: string; displayName: string; bio: string; avatarUrl: string | null; socialLinks: { platform: string; url: string }[] };
  collections: { slug: string; title: string; description: string; productCount: number; image?: string }[];
  disclosure: string;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  const d = await sget<CreatorPage>(`/creators/${encodeURIComponent(handle)}`);
  if (!d) return { title: 'Creator not found', robots: { index: false } };
  const desc = (d.creator.bio || `Recommendations from ${d.creator.displayName} on Orvia.`).slice(0, 155);
  return { title: `${d.creator.displayName} (@${d.creator.handle})`, description: desc, alternates: { canonical: `/creators/${d.creator.handle}` }, openGraph: { type: 'profile', title: d.creator.displayName, description: desc, url: `/creators/${d.creator.handle}` } };
}

export default async function CreatorPageRoute({ params }: Props) {
  const { handle } = await params;
  const d = await sget<CreatorPage>(`/creators/${encodeURIComponent(handle)}`);
  if (!d) notFound();
  const c = d.creator;
  const ld = { '@context': 'https://schema.org', '@type': 'ProfilePage', mainEntity: { '@type': 'Person', name: c.displayName, alternateName: c.handle, description: c.bio || undefined, image: c.avatarUrl || undefined, url: `${SITE_URL}/creators/${c.handle}`, sameAs: c.socialLinks.map((l) => l.url) } };
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:py-10">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, '\\u003c') }} />
      <Breadcrumb items={[{ label: 'Home', href: '/' }, { label: `@${c.handle}` }]} />
      <div className="mt-4"><AffiliateBanner text={d.disclosure} name={c.displayName} /></div>
      <header className="mt-6 flex items-center gap-4">
        {c.avatarUrl ? <img src={c.avatarUrl} alt="" width={80} height={80} className="size-20 rounded-full object-cover" /> : <div aria-hidden className="grid size-20 place-items-center rounded-full bg-sunken text-2xl font-bold">{c.displayName[0]}</div>}
        <div className="min-w-0">
          <h1 className="font-display text-3xl font-semibold tracking-tight">{c.displayName}</h1>
          <p className="text-ink-3">@{c.handle}</p>
        </div>
      </header>
      {c.bio && <p className="mt-4 max-w-2xl whitespace-pre-wrap text-ink-2">{c.bio}</p>}
      {c.socialLinks.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-3 text-sm">
          {c.socialLinks.map((l) => <li key={l.url}><a href={l.url} rel="nofollow sponsored noopener noreferrer" target="_blank" className="underline">{l.platform}</a></li>)}
        </ul>
      )}
      <h2 className="mb-3 mt-10 font-display text-xl font-semibold">Collections</h2>
      {d.collections.length === 0 ? <EmptyState title="No collections yet" body="This creator hasn’t published a collection yet. Check back soon." /> : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {d.collections.map((col) => (
            <li key={col.slug} className="overflow-hidden rounded-lg border border-line">
              <Link href={`/creators/${c.handle}/${col.slug}`} className="flex gap-4 p-4 hover:bg-sunken">
                {col.image ? <img src={col.image} alt="" width={80} height={80} loading="lazy" className="size-20 shrink-0 rounded-md object-cover" /> : <div aria-hidden className="size-20 shrink-0 rounded-md bg-sunken" />}
                <span className="min-w-0"><span className="block font-semibold">{col.title}</span><span className="mt-0.5 block line-clamp-2 text-sm text-ink-3">{col.description}</span><span className="mt-1 block text-xs text-ink-3">{col.productCount} product{col.productCount === 1 ? '' : 's'}</span></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
