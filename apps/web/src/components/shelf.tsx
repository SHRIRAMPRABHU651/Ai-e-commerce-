'use client';
import * as React from 'react';
import { ProductCard, ProductGrid, cn } from '@orvia/ui';
import type { CardProduct } from '@orvia/ui';
import { useStore } from './providers';
import type { StoreProduct } from '@/lib/types';

function useActions() {
  const { wishlist, toggleWish, addToCart, setCartOpen } = useStore();
  return {
    wished: (id: string) => wishlist.has(id),
    onWish: (id: string) => void toggleWish(id),
    onQuickAdd: async (p: CardProduct) => {
      // quick add uses the product's first variant; the server picks it when no sku is given
      const c = await addToCart(p.id, undefined, 1, { silent: true });
      if (c) setCartOpen(true);
    },
  };
}

/** Responsive grid for listing pages. */
export function ProductList({ products, priorityFirst }: { products: StoreProduct[]; priorityFirst?: number }) {
  const a = useActions();
  return (
    <ProductGrid>
      {products.map((p, i) => <ProductCard key={p.id} p={p} wished={a.wished(p.id)} onWish={a.onWish} onQuickAdd={a.onQuickAdd} priority={i < (priorityFirst ?? 0)} />)}
    </ProductGrid>
  );
}

/** Mobile: swipeable shelf with snap; desktop: grid. */
export function ProductShelf({ products, className }: { products: StoreProduct[]; className?: string }) {
  const a = useActions();
  if (!products.length) return null;
  return (
    <>
      <div className={cn('no-scrollbar -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 md:hidden', className)}>
        {products.map((p) => <div key={p.id} className="w-[44vw] max-w-52 shrink-0 snap-start"><ProductCard p={p} wished={a.wished(p.id)} onWish={a.onWish} onQuickAdd={a.onQuickAdd} /></div>)}
      </div>
      <div className="hidden md:block"><ProductGrid>{products.slice(0, 8).map((p) => <ProductCard key={p.id} p={p} wished={a.wished(p.id)} onWish={a.onWish} onQuickAdd={a.onQuickAdd} />)}</ProductGrid></div>
    </>
  );
}

/** Recently viewed (browser-local ids, resolved by the API for the current country). */
export function RecentlyViewed({ excludeId }: { excludeId?: string }) {
  const { country } = useStore();
  const [items, setItems] = React.useState<StoreProduct[]>([]);
  React.useEffect(() => {
    try {
      const ids = (JSON.parse(localStorage.getItem('orvia_viewed') ?? '[]') as string[]).filter((i) => i !== excludeId).slice(0, 8);
      if (!ids.length) return;
      fetch(`/api/v1/recommendations/recently-viewed?ids=${ids.join(',')}&country=${country}`).then((r) => r.json()).then((d: { items: StoreProduct[] }) => setItems(d.items ?? [])).catch(() => undefined);
    } catch { /* ignore */ }
  }, [country, excludeId]);
  if (!items.length) return null;
  return (
    <section className="mx-auto max-w-7xl px-4 pt-14" aria-labelledby="rv">
      <h2 id="rv" className="mb-5 font-display text-2xl font-semibold tracking-tight">Recently viewed</h2>
      <ProductShelf products={items} />
    </section>
  );
}

export function TrackView({ productId }: { productId: string }) {
  const { track } = useStore();
  React.useEffect(() => {
    try {
      const cur = (JSON.parse(localStorage.getItem('orvia_viewed') ?? '[]') as string[]).filter((i) => i !== productId);
      localStorage.setItem('orvia_viewed', JSON.stringify([productId, ...cur].slice(0, 12)));
    } catch { /* ignore */ }
    track('product_view', { productId });
  }, [productId, track]);
  return null;
}

export function TrackPage({ category }: { category?: string }) {
  const { track } = useStore();
  React.useEffect(() => { track('page_view', category ? { category } : {}); }, [track, category]);
  return null;
}
