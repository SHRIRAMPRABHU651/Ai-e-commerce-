import { Breadcrumb, EmptyState, Link, Button } from '@orvia/ui';
import { Search } from 'lucide-react';
import { CatalogControls, DesktopFilters } from '@/components/catalog';
import { ProductList, TrackPage } from '@/components/shelf';
import { resolveCountry, sget } from '@/lib/server';
import type { Meta, StoreProduct } from '@/lib/types';

interface Result { items: StoreProduct[]; total: number; page: number; pageSize: number; correctedQuery?: string; facets: { categories: { slug: string; count: number }[]; priceRange: { min: number; max: number } | null } }

export async function CatalogView({ title, subtitle, slug, searchParams, basePath }: { title: string; subtitle?: string; slug?: string; searchParams: Record<string, string | undefined>; basePath: string }) {
  const country = await resolveCountry();
  const q = new URLSearchParams();
  const sp = searchParams;
  for (const k of ['q', 'sort', 'minPrice', 'maxPrice', 'minRating', 'inStock', 'page']) if (sp[k]) q.set(k, sp[k]!);
  const category = slug ?? sp['category'];
  if (category) q.set('category', category);
  q.set('pageSize', '24');
  const [res, meta] = await Promise.all([sget<Result>(`/products?${q.toString()}`, { country }), sget<Meta>('/meta', { country })]);
  if (!res || !meta) return null;
  const cur = meta.countries.find((c) => c.code === country)!;
  const top = meta.categories.find((c) => c.slug === slug);
  const parent = meta.categories.find((c) => c.children.some((ch) => ch.slug === slug));
  const names = new Map(meta.categories.flatMap((c) => [[c.slug, c.name] as const, ...c.children.map((ch) => [ch.slug, ch.name] as const)]));
  const facetCats = (top && !top.dynamic ? top.children.map((ch) => ({ slug: ch.slug, label: ch.name, count: res.facets.categories.find((f) => f.slug === ch.slug)?.count })) : res.facets.categories.map((f) => ({ slug: f.slug, label: names.get(f.slug) ?? f.slug, count: f.count })));
  const pages = Math.max(1, Math.ceil(res.total / res.pageSize));
  const href = (p: number) => { const n = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]); n.set('page', String(p)); return `${basePath}?${n.toString()}`; };
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:py-8">
      <TrackPage category={slug} />
      <Breadcrumb items={[{ label: 'Home', href: '/' }, ...(parent ? [{ label: parent.name, href: `/c/${parent.slug}` }] : []), { label: title }]} />
      <div className="mb-6 mt-4">
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-ink-3">{subtitle}</p>}
        {res.correctedQuery && <p className="mt-2 text-sm text-ink-2">Showing results for <b>{res.correctedQuery}</b></p>}
        {top && top.children.length > 0 && <div className="no-scrollbar -mx-4 mt-4 flex gap-2 overflow-x-auto px-4">{top.children.map((ch) => <Link key={ch.slug} href={`/c/${ch.slug}`} className="shrink-0 rounded-full border border-line-strong bg-surface px-4 py-2 text-sm font-semibold text-ink-2 hover:border-pine-500 hover:text-pine-700">{ch.name}</Link>)}</div>}
      </div>
      <div className="grid gap-8 lg:grid-cols-[15rem_1fr]">
        <div className="hidden lg:block"><DesktopFilters categories={facetCats} currency={cur.currency} hideCategoryFilter={!!slug && !top?.dynamic && !!parent} /></div>
        <div>
          <CatalogControls categories={facetCats} currency={cur.currency} total={res.total} hideCategoryFilter={!!slug && !top?.dynamic && !!parent} />
          <div className="mt-5">
            {res.items.length ? <ProductList products={res.items} priorityFirst={4} /> : (
              <EmptyState icon={<Search className="size-6" />} title="No products match" body="Try removing a filter or searching for something more general." action={<Button href="/">Back to home</Button>} />
            )}
          </div>
          {pages > 1 && (
            <nav aria-label="Pagination" className="mt-10 flex items-center justify-center gap-3">
              {res.page > 1 && <Button href={href(res.page - 1)} variant="secondary">← Previous</Button>}
              <span className="text-sm text-ink-3">Page {res.page} of {pages}</span>
              {res.page < pages && <Button href={href(res.page + 1)} variant="secondary">Next →</Button>}
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}
