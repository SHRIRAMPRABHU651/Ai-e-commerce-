'use client';
import { Heart, MapPin, Package, RotateCcw, User as UserIcon, LogOut } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';
import { Badge, Button, Card, EmptyState, Field, Input, Link, ProductArt, Skeleton, StatusBadge, Select, cn, useToast, ProductCard, ProductGrid } from '@orvia/ui';
import { api, money } from '@/lib/api';
import { POSTAL_LABEL, REGIONS, REGION_LABEL } from '@/lib/regions';
import type { StoreProduct } from '@/lib/types';
import { useStore } from './providers';

const NAV = [{ href: '/account', label: 'Profile', icon: UserIcon }, { href: '/account/orders', label: 'Orders', icon: Package }, { href: '/account/wishlist', label: 'Wishlist', icon: Heart }, { href: '/account/returns', label: 'Returns', icon: RotateCcw }];

export function AccountNav() {
  const path = usePathname();
  const router = useRouter();
  const { setUser } = useStore();
  return (
    <nav aria-label="Account" className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:flex-col md:px-0">
      {NAV.map((n) => (
        <Link key={n.href} href={n.href} aria-current={path === n.href ? 'page' : undefined} className={cn('flex h-11 shrink-0 items-center gap-2.5 rounded-full px-4 text-sm font-semibold md:rounded-md', path === n.href ? 'bg-pine-50 text-pine-700' : 'text-ink-2 hover:bg-sunken')}><n.icon className="size-4.5" />{n.label}</Link>
      ))}
      <button onClick={async () => { await api('/auth/logout', { body: {} }); setUser(null); router.push('/'); router.refresh(); }} className="flex h-11 shrink-0 items-center gap-2.5 rounded-full px-4 text-sm font-semibold text-ink-3 hover:bg-sunken md:rounded-md"><LogOut className="size-4.5" />Sign out</button>
    </nav>
  );
}

export function useApi<T>(path: string) {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(true);
  const reload = React.useCallback(() => api<T>(path).then(setData).finally(() => setLoading(false)), [path]);
  React.useEffect(() => { void reload(); }, [reload]);
  return { data, loading, reload };
}

export function ProfilePanel() {
  const { user, country, setUser } = useStore();
  const toast = useToast();
  const [name, setName] = React.useState(user?.name ?? '');
  const addrs = useApi<{ items: { _id: string; fullName: string; line1: string; city: string; region: string; postalCode: string; country: string; isDefault: boolean }[] }>('/account/addresses');
  const [adding, setAdding] = React.useState(false);
  const [a, setA] = React.useState({ fullName: user?.name ?? '', line1: '', line2: '', city: '', region: '', postalCode: '', phone: '' });
  return (
    <div className="space-y-6">
      <Card className="p-5 sm:p-6">
        <h2 className="text-lg font-bold">Profile</h2>
        <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); try { await api('/account/profile', { method: 'PATCH', body: { name } }); setUser(user ? { ...user, name } : user); toast.success('Profile updated'); } catch (x) { toast.error((x as Error).message); } }}>
          <Field label="Name" htmlFor="pn"><Input id="pn" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          <Field label="Email" htmlFor="pe" hint={user?.emailVerified ? 'Verified' : 'Not verified — check your inbox'}><Input id="pe" value={user?.email ?? ''} disabled /></Field>
          <div className="sm:col-span-2"><Button type="submit">Save changes</Button></div>
        </form>
      </Card>
      <Card className="p-5 sm:p-6">
        <div className="flex items-center justify-between"><h2 className="flex items-center gap-2 text-lg font-bold"><MapPin className="size-5 text-pine-600" /> Addresses</h2><Button variant="secondary" size="sm" onClick={() => setAdding((x) => !x)}>{adding ? 'Cancel' : 'Add address'}</Button></div>
        {adding && (
          <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); try { await api('/account/addresses', { body: { ...a, country, isDefault: !addrs.data?.items.length } }); setAdding(false); await addrs.reload(); toast.success('Address saved'); } catch (x) { toast.error((x as Error).message); } }}>
            <Input aria-label="Full name" placeholder="Full name" required value={a.fullName} onChange={(e) => setA({ ...a, fullName: e.target.value })} className="sm:col-span-2" />
            <Input aria-label="Address" placeholder="Address" required value={a.line1} onChange={(e) => setA({ ...a, line1: e.target.value })} className="sm:col-span-2" />
            <Input aria-label="City" placeholder="City" required value={a.city} onChange={(e) => setA({ ...a, city: e.target.value })} />
            <Select aria-label={REGION_LABEL[country]} required value={a.region} onChange={(e) => setA({ ...a, region: e.target.value })}><option value="">{REGION_LABEL[country]}…</option>{(REGIONS[country] ?? []).map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select>
            <Input aria-label={POSTAL_LABEL[country]} placeholder={POSTAL_LABEL[country]} required value={a.postalCode} onChange={(e) => setA({ ...a, postalCode: e.target.value })} />
            <Input aria-label="Phone" placeholder="Phone" value={a.phone} onChange={(e) => setA({ ...a, phone: e.target.value })} />
            <div className="sm:col-span-2"><Button type="submit">Save address</Button></div>
          </form>
        )}
        <ul className="mt-4 divide-y divide-line">{addrs.loading ? <Skeleton className="h-16" /> : addrs.data?.items.length ? addrs.data.items.map((x) => (<li key={x._id} className="flex items-start justify-between gap-3 py-3 text-sm"><div><p className="font-semibold">{x.fullName} {x.isDefault && <Badge tone="pine">Default</Badge>}</p><p className="text-ink-3">{x.line1}, {x.city}, {x.region} {x.postalCode}, {x.country}</p></div><button className="font-semibold text-ink-3 hover:text-coral-500" onClick={async () => { await api(`/account/addresses/${x._id}`, { method: 'DELETE' }); await addrs.reload(); }}>Remove</button></li>)) : <li className="py-3 text-sm text-ink-3">No saved addresses.</li>}</ul>
      </Card>
    </div>
  );
}

export function OrdersPanel() {
  const [page, setPage] = React.useState(1);
  const { data, loading } = useApi<{ items: { orderNumber: string; status: string; total: number; currency: string; createdAt: string; itemCount: number; firstItem: { title: string; image?: string } | null }[]; total: number; pageSize: number }>(`/account/orders?page=${page}&pageSize=10`);
  if (loading) return <Skeleton className="h-64" />;
  if (!data?.items.length) return <EmptyState icon={<Package className="size-6" />} title="No orders yet" body="When you place an order it will show up here." action={<Button href="/">Start shopping</Button>} />;
  return (
    <div>
      <ul className="space-y-3">{data.items.map((o) => (
        <li key={o.orderNumber}><Link href={`/orders/${o.orderNumber}`} className="flex items-center gap-4 rounded-xl border border-line bg-surface p-4 shadow-card transition hover:border-line-strong">
          <div className="w-16 shrink-0"><ProductArt src={o.firstItem?.image} alt="" className="rounded-md" /></div>
          <div className="min-w-0 flex-1"><p className="truncate font-semibold">{o.firstItem?.title}{o.itemCount > 1 && ` +${o.itemCount - 1} more`}</p><p className="text-sm text-ink-3">{o.orderNumber} · {new Date(o.createdAt).toLocaleDateString()}</p></div>
          <div className="text-right"><p className="font-bold tabular-nums">{money(o.total, o.currency)}</p><StatusBadge status={o.status} /></div>
        </Link></li>
      ))}</ul>
      {data.total > data.pageSize && <div className="mt-5 flex justify-center gap-2"><Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button variant="secondary" size="sm" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>Next</Button></div>}
    </div>
  );
}

export function WishlistPanel() {
  const { data, loading, reload } = useApi<{ items: StoreProduct[] }>('/account/wishlist');
  const { wishlist, toggleWish, addToCart } = useStore();
  if (loading) return <Skeleton className="h-64" />;
  if (!data?.items.length) return <EmptyState icon={<Heart className="size-6" />} title="Your wishlist is empty" body="Tap the heart on anything you like to save it here." action={<Button href="/">Discover products</Button>} />;
  return <ProductGrid className="lg:grid-cols-3">{data.items.map((p) => <ProductCard key={p.id} p={p} wished={wishlist.has(p.id)} onWish={async (id) => { await toggleWish(id); await reload(); }} onQuickAdd={(x) => void addToCart(x.id, undefined, 1)} />)}</ProductGrid>;
}

export function ReturnsPanel() {
  const { data, loading } = useApi<{ items: { _id: string; status: string; reason: string; createdAt: string; orderId: string }[] }>('/account/returns');
  if (loading) return <Skeleton className="h-40" />;
  return (
    <div>
      <p className="mb-4 text-sm text-ink-3">To start a return, open the order and choose “Return items”. Returns are available within the return window after delivery.</p>
      {!data?.items.length ? <EmptyState icon={<RotateCcw className="size-6" />} title="No returns" action={<Button href="/account/orders" variant="secondary">View orders</Button>} /> : <ul className="space-y-3">{data.items.map((r) => <li key={r._id} className="flex items-center justify-between rounded-xl border border-line bg-surface p-4"><div><p className="font-semibold capitalize">{r.reason.replace(/_/g, ' ')}</p><p className="text-sm text-ink-3">{new Date(r.createdAt).toLocaleDateString()}</p></div><StatusBadge status={r.status} /></li>)}</ul>}
    </div>
  );
}
