'use client';
import { TrendingUp, Activity, AlertTriangle, BarChart3, Bell, Bot, Boxes, Cpu, CreditCard, FileClock, Globe, Headset, LayoutDashboard, LogOut, Megaphone, Menu, Moon, MousePointerClick, Package, RotateCcw, Settings, ShoppingBag, Star, Sun, Tag, Truck, Users, Warehouse, Layers, Store } from 'lucide-react';
import NextLink from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';
import { Drawer, IconButton, Skeleton, cn } from '@orvia/ui';
import { api } from '@/lib/api';
import { Logo } from '../logo';
import { AdminLinks, AdminProvider, useFetch } from './kit';
import type { Staff } from './kit';

const NAV: { group: string; items: { href: string; label: string; icon: typeof Package; perm: string }[] }[] = [
  { group: 'Operate', items: [
    { href: '/admin', label: 'Overview', icon: LayoutDashboard, perm: 'overview:read' },
    { href: '/admin/orders', label: 'Orders', icon: ShoppingBag, perm: 'orders:read' },
    { href: '/admin/exceptions', label: 'Exceptions', icon: AlertTriangle, perm: 'exceptions:read' },
    { href: '/admin/products', label: 'Products', icon: Package, perm: 'products:read' },
    { href: '/admin/categories', label: 'Categories', icon: Layers, perm: 'products:read' },
    { href: '/admin/suppliers', label: 'Suppliers', icon: Warehouse, perm: 'suppliers:read' },
    { href: '/admin/inventory', label: 'Inventory', icon: Boxes, perm: 'inventory:read' },
    { href: '/admin/customers', label: 'Customers', icon: Users, perm: 'customers:read' },
  ] },
  { group: 'Grow', items: [
    { href: '/admin/market', label: 'Market intel', icon: TrendingUp, perm: 'market:read' },
    { href: '/admin/marketing', label: 'Marketing', icon: Megaphone, perm: 'marketing:read' },
    { href: '/admin/ads', label: 'Ads', icon: MousePointerClick, perm: 'ads:read' },
    { href: '/admin/promotions', label: 'Promotions', icon: Tag, perm: 'promotions:read' },
    { href: '/admin/analytics', label: 'Analytics', icon: BarChart3, perm: 'analytics:read' },
    { href: '/admin/copilot', label: 'AI Copilot', icon: Bot, perm: 'copilot:use' },
    { href: '/admin/automation', label: 'Automation', icon: Cpu, perm: 'automation:read' },
  ] },
  { group: 'Business', items: [
    { href: '/admin/countries', label: 'Countries', icon: Globe, perm: 'countries:read' },
    { href: '/admin/payments', label: 'Payments', icon: CreditCard, perm: 'payments:read' },
    { href: '/admin/shipping', label: 'Shipping', icon: Truck, perm: 'shipping:read' },
    { href: '/admin/returns', label: 'Returns', icon: RotateCcw, perm: 'returns:read' },
    { href: '/admin/reviews', label: 'Reviews', icon: Star, perm: 'reviews:read' },
    { href: '/admin/support', label: 'Support', icon: Headset, perm: 'support:read' },
    { href: '/admin/settings', label: 'Settings', icon: Settings, perm: 'settings:read' },
    { href: '/admin/audit', label: 'Audit logs', icon: FileClock, perm: 'audit:read' },
  ] },
];

function Nav({ perms, onNavigate, badges }: { perms: string[]; onNavigate?: () => void; badges: Record<string, number> }) {
  const path = usePathname();
  return (
    <nav aria-label="Admin" className="space-y-6 px-3 py-4">
      {NAV.map((g) => {
        const items = g.items.filter((i) => perms.includes(i.perm));
        if (!items.length) return null;
        return (
          <div key={g.group}>
            <p className="mb-1.5 px-3 text-[11px] font-bold uppercase tracking-widest text-ink-3">{g.group}</p>
            <ul className="space-y-0.5">{items.map((i) => {
              const active = i.href === '/admin' ? path === '/admin' : path.startsWith(i.href);
              const b = badges[i.href];
              return <li key={i.href}><NextLink href={i.href} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={cn('flex h-10 items-center gap-3 rounded-md px-3 text-sm font-semibold', active ? 'bg-pine-50 text-pine-700' : 'text-ink-2 hover:bg-sunken')}><i.icon className="size-[18px] shrink-0" />{i.label}{b ? <span className="ml-auto rounded-full bg-coral-500 px-1.5 py-0.5 text-[11px] font-bold leading-none text-white">{b}</span> : null}</NextLink></li>;
            })}</ul>
          </div>
        );
      })}
    </nav>
  );
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [me, setMe] = React.useState<{ user: Staff; permissions: string[] } | null | undefined>(undefined);
  const [open, setOpen] = React.useState(false);
  const [dark, setDark] = React.useState(false);
  React.useEffect(() => {
    api<{ user: Staff | null; permissions: string[] }>('/auth/me').then((r) => (r.user && r.user.role !== 'CUSTOMER' ? setMe({ user: r.user, permissions: r.permissions }) : (setMe(null), router.replace('/admin/login')))).catch(() => { setMe(null); router.replace('/admin/login'); });
    try { const t = localStorage.getItem('orvia_theme'); if (t) { document.documentElement.dataset.theme = t; setDark(t === 'dark'); } } catch { /* ignore */ }
  }, [router]);
  const live = useFetch<{ live: { openExceptions: number } } | null>(me ? '/admin/exceptions?pageSize=1' : null, 60_000);
  const exCount = (live.data as unknown as { total?: number } | null)?.total ?? 0;
  const toggle = () => { const n = dark ? 'light' : 'dark'; setDark(!dark); document.documentElement.dataset.theme = n; try { localStorage.setItem('orvia_theme', n); } catch { /* ignore */ } };
  if (me === undefined) return <div className="p-8"><Skeleton className="h-96" /></div>;
  if (me === null) return null;
  const ctx = { user: me.user, permissions: me.permissions, can: (p: string) => me.permissions.includes(p) };
  const title = NAV.flatMap((g) => g.items).find((i) => (i.href === '/admin' ? path === '/admin' : path.startsWith(i.href)))?.label ?? 'Admin';
  return (
    <AdminLinks>
      <AdminProvider value={ctx}>
        <div className="min-h-dvh bg-paper lg:grid lg:grid-cols-[15.5rem_1fr]">
          <aside className="sticky top-0 hidden h-dvh flex-col overflow-y-auto border-r border-line bg-surface lg:flex">
            <NextLink href="/admin" className="flex h-16 shrink-0 items-center gap-2.5 border-b border-line px-5"><Logo className="[&>span:last-child]:text-[22px]" /><span className="rounded bg-pine-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-pine-700">Ops</span></NextLink>
            <Nav perms={me.permissions} badges={{ '/admin/exceptions': exCount }} />
            <div className="mt-auto border-t border-line p-3"><NextLink href="/" className="flex h-10 items-center gap-3 rounded-md px-3 text-sm font-semibold text-ink-2 hover:bg-sunken"><Store className="size-[18px]" /> View storefront</NextLink></div>
          </aside>
          <div className="min-w-0">
            <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line bg-paper/90 px-4 backdrop-blur sm:px-6">
              <IconButton label="Open menu" className="lg:hidden" onClick={() => setOpen(true)}><Menu className="size-5" /></IconButton>
              <p className="text-[15px] font-bold lg:hidden">{title}</p>
              <div className="ml-auto flex items-center gap-1">
                <span className="hidden items-center gap-1.5 rounded-full bg-sunken px-3 py-1.5 text-xs font-semibold text-ink-2 sm:flex"><Activity className="size-3.5 text-ok-500" />{process.env.NODE_ENV === 'production' ? 'Live' : 'Development'}</span>
                <IconButton label={dark ? 'Light theme' : 'Dark theme'} onClick={toggle}>{dark ? <Sun className="size-5" /> : <Moon className="size-5" />}</IconButton>
                <NextLink href="/admin/exceptions" aria-label="Exceptions" className="relative inline-flex size-11 items-center justify-center rounded-full text-ink-2 hover:bg-sunken"><Bell className="size-5" />{exCount > 0 && <span className="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-coral-500" />}</NextLink>
                <div className="ml-1 hidden text-right sm:block"><p className="text-sm font-bold leading-tight">{me.user.name}</p><p className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{me.user.role.replace('_', ' ')}</p></div>
                <IconButton label="Sign out" onClick={async () => { await api('/auth/logout', { body: {} }); router.replace('/admin/login'); }}><LogOut className="size-5" /></IconButton>
              </div>
            </header>
            <main id="main" className="px-4 py-5 sm:px-6 sm:py-7 xl:px-8">{children}</main>
          </div>
        </div>
        <Drawer open={open} onClose={() => setOpen(false)} title="Menu" side="left"><Nav perms={me.permissions} onNavigate={() => setOpen(false)} badges={{ '/admin/exceptions': exCount }} /></Drawer>
      </AdminProvider>
    </AdminLinks>
  );
}
