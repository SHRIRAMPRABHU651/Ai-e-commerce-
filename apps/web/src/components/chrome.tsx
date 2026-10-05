'use client';
import { Heart, Home, LayoutGrid, MessageCircle, Search, ShoppingBag, User as UserIcon, X, Send, ShieldCheck, Truck, RotateCcw, Headphones } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';
import { Button, CountrySelector, Drawer, IconButton, Input, Link, SearchBar, cn, PriceDisplay, QuantityStepper, ProductArt } from '@orvia/ui';
import { api } from '@/lib/api';
import { money } from '@/lib/api';
import { Logo } from './logo';
import { useStore } from './providers';

/* ------------------------------ Announcement bar ------------------------------ */
export function AnnouncementBar() {
  const { meta, country } = useStore();
  const c = meta.countries.find((x) => x.code === country);
  const std = c?.shippingMethods.find((m) => m.code === 'standard');
  return (
    <div className="bg-pine-900 text-[13px] text-pine-100">
      <div className="mx-auto flex max-w-7xl items-center justify-center gap-x-6 gap-y-1 px-4 py-2 text-center">
        {std?.freeOver ? <span>Free standard shipping over <b className="text-white">{money(std.freeOver, c!.currency)}</b></span> : <span>Tracked delivery on every order</span>}
        <span className="hidden sm:inline">· {c?.returnWindowDays ?? 30}-day returns</span>
        <span className="hidden md:inline">· Shipping to {c?.name}</span>
      </div>
    </div>
  );
}

/* ----------------------------------- Header ----------------------------------- */
function useSuggest(q: string) {
  const [s, setS] = React.useState<{ label: string; slug?: string }[]>([]);
  React.useEffect(() => {
    if (q.trim().length < 2) { setS([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<{ suggestions: { label: string; slug?: string }[] }>(`/search/suggest?q=${encodeURIComponent(q)}`, { signal: ctrl.signal }).then((r) => setS(r.suggestions)).catch(() => undefined);
    }, 180);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q]);
  return s;
}

export function Header() {
  const { meta, country, setCountry, cart, setCartOpen, user } = useStore();
  const router = useRouter();
  const [q, setQ] = React.useState('');
  const [mobileSearch, setMobileSearch] = React.useState(false);
  const suggestions = useSuggest(q);
  const go = (v: string) => { setMobileSearch(false); if (v) router.push(`/search?q=${encodeURIComponent(v)}`); };
  const pick = (s: { label: string; slug?: string }) => { setMobileSearch(false); setQ(''); router.push(s.slug ? `/p/${s.slug}` : `/search?q=${encodeURIComponent(s.label)}`); };
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 px-4 sm:gap-4">
        <Link href="/" aria-label="Orvia home" className="shrink-0"><Logo /></Link>
        <div className="mx-auto hidden w-full max-w-xl md:block"><SearchBar value={q} onChange={setQ} onSubmit={go} suggestions={suggestions} onPick={pick} /></div>
        <div className="ml-auto flex items-center gap-0.5 md:ml-0">
          <IconButton label="Search" className="md:hidden" onClick={() => setMobileSearch(true)}><Search className="size-5" /></IconButton>
          <CountrySelector value={country} countries={meta.countries} onChange={(c) => void setCountry(c)} />
          <Link href={user ? '/account/wishlist' : '/login'} aria-label="Wishlist" className="hidden size-11 items-center justify-center rounded-full text-ink-2 hover:bg-sunken sm:inline-flex"><Heart className="size-5" /></Link>
          <Link href={user ? '/account' : '/login'} aria-label={user ? 'Account' : 'Sign in'} className="hidden h-11 items-center gap-2 rounded-full px-3 text-sm font-semibold text-ink-2 hover:bg-sunken sm:inline-flex"><UserIcon className="size-5" /><span className="hidden lg:inline">{user ? user.name.split(' ')[0] : 'Sign in'}</span></Link>
          <IconButton label={`Cart, ${cart?.itemCount ?? 0} items`} badge={cart?.itemCount} onClick={() => setCartOpen(true)}><ShoppingBag className="size-5" /></IconButton>
        </div>
      </div>
      <nav aria-label="Categories" className="hidden border-t border-line/70 md:block">
        <ul className="mx-auto flex max-w-7xl items-center gap-1 px-4">
          {meta.categories.map((c) => (
            <li key={c.slug} className="group relative">
              <Link href={`/c/${c.slug}`} className={cn('inline-flex h-11 items-center px-3.5 text-sm font-semibold text-ink-2 hover:text-pine-700', c.dynamic && 'text-saffron-700')}>{c.name}{c.dynamic && <span className="ml-1.5 size-1.5 rounded-full bg-saffron-500" aria-hidden />}</Link>
              {c.children.length > 0 && (
                <div className="invisible absolute left-0 top-full z-50 w-72 translate-y-1 rounded-lg border border-line bg-surface p-2 opacity-0 shadow-pop transition group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100">
                  {c.children.map((ch) => <Link key={ch.slug} href={`/c/${ch.slug}`} className="block rounded-md px-3 py-2 text-sm text-ink-2 hover:bg-sunken hover:text-ink">{ch.name}</Link>)}
                </div>
              )}
            </li>
          ))}
          <li className="ml-auto text-sm text-ink-3"><Link href="/help" className="hover:text-ink">Help</Link> · <Link href="/track" className="hover:text-ink">Track order</Link></li>
        </ul>
      </nav>
      {mobileSearch && (
        <div className="fixed inset-0 z-[70] bg-paper md:hidden" role="dialog" aria-label="Search">
          <div className="flex items-center gap-2 border-b border-line p-3">
            <div className="flex-1"><SearchBar value={q} onChange={setQ} onSubmit={go} suggestions={suggestions} onPick={pick} autoFocus /></div>
            <button onClick={() => setMobileSearch(false)} aria-label="Close search" className="grid size-11 place-items-center rounded-full hover:bg-sunken"><X className="size-5" /></button>
          </div>
          <div className="p-4"><p className="mb-3 text-xs font-bold uppercase tracking-wide text-ink-3">Popular</p><div className="flex flex-wrap gap-2">{['dog toys', 'stem kit', 'cable organizer', 'tote bag', 'night light'].map((t) => <button key={t} onClick={() => go(t)} className="rounded-full border border-line-strong px-4 py-2 text-sm">{t}</button>)}</div></div>
        </div>
      )}
    </header>
  );
}

/* --------------------------------- Mobile tab bar --------------------------------- */
export function MobileTabBar() {
  const path = usePathname();
  const { cart, setCartOpen, user, meta } = useStore();
  const [cats, setCats] = React.useState(false);
  const items = [
    { href: '/', label: 'Home', icon: Home },
    { label: 'Shop', icon: LayoutGrid, onClick: () => setCats(true) },
    { href: '/search', label: 'Search', icon: Search },
    { label: 'Cart', icon: ShoppingBag, badge: cart?.itemCount, onClick: () => setCartOpen(true) },
    { href: user ? '/account' : '/login', label: user ? 'Account' : 'Sign in', icon: UserIcon },
  ];
  return (
    <>
      <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <ul className="grid grid-cols-5">
          {items.map((it) => {
            const active = it.href ? (it.href === '/' ? path === '/' : path.startsWith(it.href)) : false;
            const inner = (<><span className="relative"><it.icon className="size-[22px]" strokeWidth={active ? 2.4 : 1.9} />{it.badge ? <span className="absolute -right-2 -top-1.5 grid min-w-4 place-items-center rounded-full bg-pine-600 px-1 text-[10px] font-bold leading-4 text-white">{it.badge}</span> : null}</span><span className="text-[11px] font-semibold">{it.label}</span></>);
            const cls = cn('flex h-14 w-full flex-col items-center justify-center gap-0.5', active ? 'text-pine-700' : 'text-ink-3');
            return <li key={it.label}>{it.href ? <Link href={it.href} className={cls} aria-current={active ? 'page' : undefined}>{inner}</Link> : <button onClick={it.onClick} className={cls}>{inner}</button>}</li>;
          })}
        </ul>
      </nav>
      <Drawer open={cats} onClose={() => setCats(false)} title="Shop by category" side="bottom">
        <div className="space-y-5 p-5">
          {meta.categories.map((c) => (
            <div key={c.slug}>
              <Link href={`/c/${c.slug}`} onClick={() => setCats(false)} className="text-base font-bold">{c.name} →</Link>
              <div className="mt-2 flex flex-wrap gap-2">{c.children.slice(0, 6).map((ch) => <Link key={ch.slug} href={`/c/${ch.slug}`} onClick={() => setCats(false)} className="rounded-full border border-line-strong px-3.5 py-1.5 text-sm text-ink-2">{ch.name}</Link>)}</div>
            </div>
          ))}
        </div>
      </Drawer>
    </>
  );
}

/* ----------------------------------- Cart drawer ----------------------------------- */
export function CartDrawer() {
  const { cart, cartOpen, setCartOpen, setQty } = useStore();
  const empty = !cart || cart.lines.length === 0;
  return (
    <Drawer open={cartOpen} onClose={() => setCartOpen(false)} title={`Your cart${cart?.itemCount ? ` (${cart.itemCount})` : ''}`}
      footer={!empty && cart ? (
        <div className="space-y-3">
          {cart.freeShippingRemaining !== null && cart.freeShippingRemaining > 0 && <p className="text-center text-sm text-ink-2">Add <b>{money(cart.freeShippingRemaining, cart.currency)}</b> more for free shipping</p>}
          <div className="flex items-center justify-between text-[15px]"><span className="font-semibold">Subtotal</span><PriceDisplay price={cart.subtotal - cart.discount} currency={cart.currency} size="md" /></div>
          <Button block size="lg" href="/checkout" onClick={() => setCartOpen(false)} disabled={cart.checkoutBlocked}>Checkout</Button>
          <Button block variant="secondary" href="/cart" onClick={() => setCartOpen(false)}>View cart</Button>
        </div>
      ) : undefined}>
      {empty ? (
        <div className="flex flex-col items-center px-6 py-16 text-center"><ShoppingBag className="mb-4 size-10 text-ink-3" /><p className="font-bold">Your cart is empty</p><p className="mt-1 text-sm text-ink-3">Find something you’ll love.</p><Button className="mt-5" href="/" onClick={() => setCartOpen(false)}>Start shopping</Button></div>
      ) : (
        <ul className="divide-y divide-line px-5">
          {cart!.lines.map((l) => (
            <li key={l.productId + l.sku} className="flex gap-3.5 py-4">
              <Link href={`/p/${l.slug}`} onClick={() => setCartOpen(false)} className="w-20 shrink-0 overflow-hidden rounded-md"><ProductArt src={l.image} alt={l.title} /></Link>
              <div className="min-w-0 flex-1">
                <Link href={`/p/${l.slug}`} onClick={() => setCartOpen(false)} className="line-clamp-2 text-sm font-semibold leading-snug">{l.title}</Link>
                {l.variantLabel && <p className="text-xs text-ink-3">{l.variantLabel}</p>}
                {l.issue && <p className="mt-0.5 text-xs font-semibold text-coral-500">{l.issue}</p>}
                <div className="mt-2 flex items-center justify-between"><QuantityStepper value={l.quantity} max={Math.max(1, l.maxQty)} onChange={(n) => void setQty(l.productId, l.sku, n)} /><span className="text-sm font-bold tabular-nums">{money(l.lineTotal, cart!.currency)}</span></div>
                <button onClick={() => void setQty(l.productId, l.sku, 0)} className="mt-1.5 text-xs font-semibold text-ink-3 hover:text-coral-500">Remove</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}

/* ----------------------------- AI support assistant ----------------------------- */
interface Msg { from: 'you' | 'bot'; text: string; actions?: { label: string; href?: string; action?: string }[] }
export function ChatWidget() {
  const { user, country } = useStore();
  const [open, setOpen] = React.useState(false);
  const [msgs, setMsgs] = React.useState<Msg[]>([{ from: 'bot', text: 'Hi! I can track an order, start a return, check a refund, or answer questions about shipping and products. How can I help?' }]);
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const ticket = React.useRef<string | undefined>(undefined);
  const lastOrder = React.useRef<string | undefined>(undefined);
  const end = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [msgs, open]);
  const send = async (message: string, confirmCancel = false) => {
    if (!message.trim() || busy) return;
    const orderNo = /ORV-[A-Z0-9]+-[A-F0-9]{6}/i.exec(message)?.[0]?.toUpperCase();
    if (orderNo) lastOrder.current = orderNo;
    setMsgs((m) => [...m, { from: 'you', text: message }]);
    setText('');
    setBusy(true);
    try {
      const r = await api<{ reply: string; ticketId?: string; actions: Msg['actions'] }>('/support/chat', { body: { message, email: user?.email ?? (email || undefined), ticketId: ticket.current, orderNumber: orderNo ?? lastOrder.current, confirmCancel, country } });
      ticket.current = r.ticketId ?? ticket.current;
      setMsgs((m) => [...m, { from: 'bot', text: r.reply, actions: r.actions }]);
    } catch (e) {
      setMsgs((m) => [...m, { from: 'bot', text: `Sorry, I couldn’t reach support just now (${(e as Error).message}). Please try again or email us.` }]);
    } finally { setBusy(false); }
  };
  return (
    <>
      <button onClick={() => setOpen(true)} aria-label="Open support chat" className="fixed bottom-[4.75rem] right-4 z-40 grid size-12 place-items-center rounded-full bg-pine-700 text-white shadow-pop transition hover:scale-105 md:bottom-6 md:right-6"><MessageCircle className="size-5" /></button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Orvia support" width="sm:max-w-md"
        footer={<form onSubmit={(e) => { e.preventDefault(); void send(text); }} className="flex gap-2"><Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type your question…" aria-label="Message" /><Button type="submit" aria-label="Send" loading={busy}><Send className="size-4" /></Button></form>}>
        <div className="flex min-h-full flex-col gap-3 p-4">
          {!user && <div className="rounded-lg bg-sunken p-3 text-xs text-ink-2">To look up an order, enter the email used at checkout:<Input className="mt-2 h-9 text-sm" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" aria-label="Email for order lookup" /></div>}
          {msgs.map((m, i) => (
            <div key={i} className={cn('max-w-[88%] whitespace-pre-line rounded-2xl px-4 py-2.5 text-sm leading-relaxed', m.from === 'you' ? 'ml-auto rounded-br-sm bg-pine-600 text-white' : 'rounded-bl-sm bg-sunken text-ink')}>
              {m.text}
              {m.actions?.length ? <div className="mt-2 flex flex-wrap gap-2">{m.actions.map((a) => a.href ? <Link key={a.label} href={a.href} onClick={() => setOpen(false)} className="rounded-full bg-surface px-3 py-1.5 text-xs font-bold text-pine-700">{a.label}</Link> : <button key={a.label} onClick={() => void send('Yes, cancel my order', true)} className="rounded-full bg-surface px-3 py-1.5 text-xs font-bold text-coral-500">{a.label}</button>)}</div> : null}
            </div>
          ))}
          {busy && <div className="w-16 rounded-2xl rounded-bl-sm bg-sunken px-4 py-3 text-ink-3">···</div>}
          <div ref={end} />
        </div>
      </Drawer>
    </>
  );
}

/* ----------------------------------- Footer ----------------------------------- */
export function TrustStrip() {
  const { meta, country } = useStore();
  const c = meta.countries.find((x) => x.code === country);
  const items = [
    { icon: Truck, t: 'Tracked delivery', d: 'Live tracking from the moment it ships' },
    { icon: RotateCcw, t: `${c?.returnWindowDays ?? 30}-day returns`, d: 'Simple, no-fuss returns' },
    { icon: ShieldCheck, t: 'Secure checkout', d: 'Payments verified server-side' },
    { icon: Headphones, t: 'Real help', d: 'AI assistant plus a human team' },
  ];
  return (
    <section aria-label="Why shop with Orvia" className="border-y border-line bg-surface">
      <ul className="mx-auto grid max-w-7xl grid-cols-2 gap-x-4 gap-y-6 px-4 py-8 lg:grid-cols-4">
        {items.map((i) => (<li key={i.t} className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-full bg-pine-50 text-pine-700"><i.icon className="size-5" /></span><div><p className="text-sm font-bold">{i.t}</p><p className="text-sm text-ink-3">{i.d}</p></div></li>))}
      </ul>
    </section>
  );
}

export function Footer() {
  const { meta, country, setCountry } = useStore();
  const c = meta.countries.find((x) => x.code === country);
  return (
    <footer className="mt-16 border-t border-line bg-sunken pb-24 md:pb-0">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div><Logo /><p className="mt-4 max-w-xs text-sm text-ink-3">Considered goods for pets, kids, style and everyday life — shipped from the warehouse closest to you, with tracking on every order.</p><div className="mt-5"><CountrySelector value={country} countries={meta.countries} onChange={(x) => void setCountry(x)} /></div></div>
        <div><p className="mb-3 text-sm font-bold">Shop</p><ul className="space-y-2 text-sm text-ink-3">{meta.categories.map((x) => <li key={x.slug}><Link href={`/c/${x.slug}`} className="hover:text-ink">{x.name}</Link></li>)}</ul></div>
        <div><p className="mb-3 text-sm font-bold">Help</p><ul className="space-y-2 text-sm text-ink-3"><li><Link href="/help" className="hover:text-ink">Help center</Link></li><li><Link href="/track" className="hover:text-ink">Track an order</Link></li><li><Link href="/legal/returns" className="hover:text-ink">Returns &amp; refunds</Link></li><li><Link href="/legal/shipping" className="hover:text-ink">Shipping &amp; delivery</Link></li></ul></div>
        <div><p className="mb-3 text-sm font-bold">Company</p><ul className="space-y-2 text-sm text-ink-3"><li><Link href="/legal/privacy" className="hover:text-ink">Privacy</Link></li><li><Link href="/legal/terms" className="hover:text-ink">Terms</Link></li><li><Link href="/account" className="hover:text-ink">Your account</Link></li></ul></div>
      </div>
      <div className="border-t border-line"><div className="mx-auto max-w-7xl space-y-2 px-4 py-6 text-xs text-ink-3"><p>{c?.legalNotice}</p><p>© {new Date().getFullYear()} Orvia. Prices shown in {c?.currency}. Delivery estimates depend on the fulfilling warehouse and are confirmed at checkout.</p></div></div>
    </footer>
  );
}
