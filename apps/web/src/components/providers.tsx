'use client';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { LinkProvider, ToastProvider, useToast } from '@orvia/ui';
import { api } from '@/lib/api';
import type { CartView, Meta, User } from '@/lib/types';

interface Store {
  meta: Meta;
  country: string;
  user: User | null;
  setUser: (u: User | null) => void;
  cart: CartView | null;
  cartLoading: boolean;
  refreshCart: () => Promise<void>;
  addToCart: (productId: string, variantSku: string | undefined, quantity: number, opts?: { silent?: boolean }) => Promise<CartView | null>;
  setQty: (productId: string, sku: string, quantity: number) => Promise<void>;
  applyCoupon: (code: string | null) => Promise<void>;
  setCountry: (code: string) => Promise<void>;
  wishlist: Set<string>;
  toggleWish: (productId: string) => Promise<void>;
  cartOpen: boolean;
  setCartOpen: (o: boolean) => void;
  track: (type: string, extra?: Record<string, unknown>) => void;
}
const Ctx = React.createContext<Store | null>(null);
export const useStore = (): Store => {
  const v = React.useContext(Ctx);
  if (!v) throw new Error('useStore outside provider');
  return v;
};

const Link = (p: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <NextLink {...p} />;

function sessionId(): string {
  try {
    let s = sessionStorage.getItem('orvia_sid');
    if (!s) { s = crypto.randomUUID(); sessionStorage.setItem('orvia_sid', s); }
    return s;
  } catch { return 'anon-' + Math.random().toString(36).slice(2, 12); }
}

function Inner({ meta, country, initialUser, children }: { meta: Meta; country: string; initialUser: User | null; children: React.ReactNode }) {
  const router = useRouter();
  const toast = useToast();
  const [user, setUser] = React.useState<User | null>(initialUser);
  const [cart, setCart] = React.useState<CartView | null>(null);
  const [cartLoading, setCartLoading] = React.useState(true);
  const [cartOpen, setCartOpen] = React.useState(false);
  const [wishlist, setWishlist] = React.useState<Set<string>>(new Set());

  const refreshCart = React.useCallback(async () => {
    try { setCart(await api<CartView>(`/cart?country=${country}`)); } catch { /* cart is optional until first interaction */ } finally { setCartLoading(false); }
  }, [country]);

  React.useEffect(() => { void refreshCart(); }, [refreshCart]);
  React.useEffect(() => {
    if (!user) { setWishlist(new Set()); return; }
    api<{ ids: string[] }>('/account/wishlist/ids').then((r) => setWishlist(new Set(r.ids))).catch(() => undefined);
  }, [user]);

  const track = React.useCallback((type: string, extra: Record<string, unknown> = {}) => {
    api('/events', { body: { type, sessionId: sessionId(), ...extra } }).catch(() => undefined);
  }, []);

  const addToCart: Store['addToCart'] = async (productId, variantSku, quantity, opts) => {
    try {
      const c = await api<CartView>(`/cart/items?country=${country}`, { body: { productId, variantSku, quantity } });
      setCart(c);
      track('add_to_cart', { productId });
      if (!opts?.silent) setCartOpen(true);
      return c;
    } catch (e) { toast.error((e as Error).message); return null; }
  };
  const setQty: Store['setQty'] = async (productId, sku, quantity) => {
    try { setCart(await api<CartView>(`/cart/items?country=${country}`, { method: 'PATCH', body: { productId, sku, quantity } })); } catch (e) { toast.error((e as Error).message); }
  };
  const applyCoupon: Store['applyCoupon'] = async (code) => {
    try { setCart(await api<CartView>(`/cart/coupon?country=${country}`, { body: { code } })); } catch (e) { toast.error((e as Error).message); }
  };
  const setCountry: Store['setCountry'] = async (code) => {
    await api('/preferences/country', { method: 'PUT', body: { country: code } });
    router.refresh();
    window.location.reload();
  };
  const toggleWish: Store['toggleWish'] = async (productId) => {
    if (!user) { toast.info('Sign in to save items to your wishlist'); router.push(`/login?next=${encodeURIComponent(window.location.pathname)}`); return; }
    const has = wishlist.has(productId);
    setWishlist((s) => { const n = new Set(s); has ? n.delete(productId) : n.add(productId); return n; });
    try { has ? await api(`/account/wishlist/${productId}`, { method: 'DELETE' }) : await api('/account/wishlist', { body: { productId } }); } catch (e) { toast.error((e as Error).message); }
  };

  const value: Store = { meta, country, user, setUser, cart, cartLoading, refreshCart, addToCart, setQty, applyCoupon, setCountry, wishlist, toggleWish, cartOpen, setCartOpen, track };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function Providers({ meta, country, initialUser, children }: { meta: Meta; country: string; initialUser: User | null; children: React.ReactNode }) {
  return (
    <LinkProvider value={Link}>
      <ToastProvider>
        <Inner meta={meta} country={country} initialUser={initialUser}>{children}</Inner>
      </ToastProvider>
    </LinkProvider>
  );
}
