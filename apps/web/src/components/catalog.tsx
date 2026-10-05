'use client';
import { SlidersHorizontal, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { Button, Drawer, FilterPanel, Select, cn } from '@orvia/ui';
import type { FilterState } from '@orvia/ui';

export function CatalogControls({ categories, currency, total, hideCategoryFilter }: { categories: { slug: string; label: string; count?: number }[]; currency: string; total: number; hideCategoryFilter?: boolean }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const [sheet, setSheet] = React.useState(false);
  const filters: FilterState = { category: sp.get('category') ?? undefined, minPrice: sp.get('minPrice') ?? undefined, maxPrice: sp.get('maxPrice') ?? undefined, minRating: sp.get('minRating') ?? undefined, inStock: sp.get('inStock') === 'true' || undefined };
  const push = (next: Record<string, string | undefined>) => {
    const q = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(next)) { if (v === undefined || v === '') q.delete(k); else q.set(k, v); }
    q.delete('page');
    router.push(`${path}?${q.toString()}`, { scroll: false });
  };
  const apply = (f: FilterState) => push({ category: hideCategoryFilter ? undefined : f.category, minPrice: f.minPrice, maxPrice: f.maxPrice, minRating: f.minRating, inStock: f.inStock ? 'true' : undefined });
  const active = [filters.minPrice || filters.maxPrice ? 'price' : null, filters.minRating ? 'rating' : null, filters.inStock ? 'stock' : null, !hideCategoryFilter && filters.category ? 'category' : null].filter(Boolean).length;
  const panel = <FilterPanel value={filters} onChange={apply} categories={hideCategoryFilter ? [] : categories} currency={currency} />;
  return (
    <>
      <div className="sticky top-16 z-30 -mx-4 flex items-center justify-between gap-3 border-b border-line bg-paper/95 px-4 py-3 backdrop-blur md:top-[6.75rem] lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
        <p className="text-sm text-ink-3"><b className="text-ink">{total}</b> {total === 1 ? 'product' : 'products'}</p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" className="lg:hidden" onClick={() => setSheet(true)}><SlidersHorizontal className="size-4" /> Filters{active ? ` (${active})` : ''}</Button>
          <label className="sr-only" htmlFor="sort">Sort by</label>
          <Select id="sort" value={sp.get('sort') ?? 'relevance'} onChange={(e) => push({ sort: e.target.value === 'relevance' ? undefined : e.target.value })} className="h-9 w-auto min-w-40 text-sm">
            <option value="relevance">Relevance</option><option value="trending">Trending</option><option value="newest">Newest</option><option value="bestselling">Best selling</option><option value="rating">Top rated</option><option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option>
          </Select>
        </div>
      </div>
      {active > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {filters.minPrice || filters.maxPrice ? <Chip onX={() => apply({ ...filters, minPrice: undefined, maxPrice: undefined })}>Price {filters.minPrice ?? 0}–{filters.maxPrice ?? '∞'}</Chip> : null}
          {filters.minRating ? <Chip onX={() => apply({ ...filters, minRating: undefined })}>{filters.minRating}★ & up</Chip> : null}
          {filters.inStock ? <Chip onX={() => apply({ ...filters, inStock: undefined })}>In stock</Chip> : null}
          {!hideCategoryFilter && filters.category ? <Chip onX={() => apply({ ...filters, category: undefined })}>{categories.find((c) => c.slug === filters.category)?.label ?? filters.category}</Chip> : null}
        </div>
      )}
      <Drawer open={sheet} onClose={() => setSheet(false)} title="Filters" side="bottom" footer={<Button block onClick={() => setSheet(false)}>Show {total} results</Button>}><div className="p-5">{panel}</div></Drawer>
    </>
  );
}

export function DesktopFilters({ categories, currency, hideCategoryFilter }: { categories: { slug: string; label: string; count?: number }[]; currency: string; hideCategoryFilter?: boolean }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const filters: FilterState = { category: sp.get('category') ?? undefined, minPrice: sp.get('minPrice') ?? undefined, maxPrice: sp.get('maxPrice') ?? undefined, minRating: sp.get('minRating') ?? undefined, inStock: sp.get('inStock') === 'true' || undefined };
  const apply = (f: FilterState) => {
    const q = new URLSearchParams(sp.toString());
    const set = (k: string, v?: string) => (v ? q.set(k, v) : q.delete(k));
    set('category', hideCategoryFilter ? undefined : f.category); set('minPrice', f.minPrice); set('maxPrice', f.maxPrice); set('minRating', f.minRating); set('inStock', f.inStock ? 'true' : undefined);
    q.delete('page');
    router.push(`${path}?${q.toString()}`, { scroll: false });
  };
  return <div className="sticky top-32"><p className="mb-5 text-sm font-bold uppercase tracking-wide text-ink-3">Filter</p><FilterPanel value={filters} onChange={apply} categories={hideCategoryFilter ? [] : categories} currency={currency} /></div>;
}

const Chip = ({ children, onX }: { children: React.ReactNode; onX: () => void }) => (
  <button onClick={onX} className={cn('inline-flex h-8 items-center gap-1.5 rounded-full bg-pine-50 px-3 text-xs font-semibold text-pine-700 hover:bg-pine-100')}>{children}<X className="size-3.5" aria-label="Remove filter" /></button>
);
