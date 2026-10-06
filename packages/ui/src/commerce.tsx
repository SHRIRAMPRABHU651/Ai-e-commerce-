'use client';
import * as React from 'react';
import { Check, ChevronDown, Circle, Heart, MapPin, Search, Star, Truck, Sparkles, Zap } from 'lucide-react';
import { formatMoney } from '@orvia/types';
import type { Currency } from '@orvia/types';
import { Badge, Button, Link, cn, Card, Switch, Skeleton } from './core';
import type { Tone } from './core';

/* Product art: supplier/licensed image with a graceful fallback block. */
export function ProductArt({ src, alt, className, priority }: { src?: string; alt: string; className?: string; priority?: boolean }) {
  const [failed, setFailed] = React.useState(false);
  return (
    <div className={cn('relative aspect-square overflow-hidden bg-sunken', className)}>
      {src && !failed ? (
        <img src={src} alt={alt} loading={priority ? 'eager' : 'lazy'} decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
      ) : (
        <div className="grid size-full place-items-center text-ink-3" role="img" aria-label={alt}><Sparkles className="size-8 opacity-40" /></div>
      )}
    </div>
  );
}

export function Rating({ value, count, size = 14, className }: { value: number; count?: number; size?: number; className?: string }) {
  if (!count) return <span className={cn('text-xs text-ink-3', className)}>New</span>;
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs text-ink-2', className)} aria-label={`Rated ${value.toFixed(1)} out of 5 from ${count} reviews`}>
      <Star style={{ width: size, height: size }} className="fill-saffron-500 text-saffron-500" aria-hidden />
      <span className="font-bold text-ink">{value.toFixed(1)}</span>
      <span className="text-ink-3">({count})</span>
    </span>
  );
}

export function PriceDisplay({ price, compareAt, currency, size = 'md', discountPct, className }: { price: number | null; compareAt?: number | null; currency: string; size?: 'sm' | 'md' | 'lg'; discountPct?: number; className?: string }) {
  if (price === null || !currency) return <span className="text-sm text-ink-3">Not available here</span>;
  const cur = currency as Currency;
  return (
    <span className={cn('inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5', className)}>
      <span className={cn('font-bold tabular-nums text-ink', size === 'lg' ? 'text-3xl' : size === 'md' ? 'text-lg' : 'text-[15px]')}>{formatMoney(price, cur)}</span>
      {compareAt ? <span className={cn('tabular-nums text-ink-3 line-through', size === 'lg' ? 'text-base' : 'text-sm')}>{formatMoney(compareAt, cur)}</span> : null}
      {discountPct ? <span className="text-xs font-bold text-coral-500">{discountPct}% below typical price</span> : null}
    </span>
  );
}

export interface CardProduct {
  id: string;
  slug: string;
  title: string;
  images: { url: string; alt?: string; card?: string; thumb?: string; zoom?: string }[];
  price: number | null;
  compareAtPrice: number | null;
  currency: string;
  discountPct: number;
  rating: { avg: number; count: number };
  available: boolean;
  lowStock: boolean;
  minDays: number | null;
  maxDays: number | null;
  trendScore: number;
  createdAt: string;
}

export function ProductCard({ p, wished, onWish, onQuickAdd, priority }: { p: CardProduct; wished?: boolean; onWish?: (id: string) => void; onQuickAdd?: (p: CardProduct) => void; priority?: boolean }) {
  const isNew = p.createdAt && Date.now() - new Date(p.createdAt).getTime() < 14 * 86_400_000;
  const badge = !p.available ? { t: 'Unavailable', tone: 'neutral' as Tone } : p.discountPct >= 10 ? { t: `${p.discountPct}% off`, tone: 'coral' as Tone } : p.lowStock ? { t: 'Few left', tone: 'saffron' as Tone } : p.trendScore >= 60 ? { t: 'Trending', tone: 'pine' as Tone } : isNew ? { t: 'New', tone: 'info' as Tone } : null;
  return (
    <article className="group relative flex flex-col">
      <div className="relative overflow-hidden rounded-lg border border-line bg-sunken">
        <Link href={`/p/${p.slug}`} className="block" aria-label={p.title}>
          <ProductArt src={p.images[0]?.card ?? p.images[0]?.url} alt={p.images[0]?.alt ?? p.title} priority={priority} />
        </Link>
        {badge && <Badge tone={badge.tone} className="absolute left-2.5 top-2.5 shadow-sm">{badge.t}</Badge>}
        {onWish && (
          <button onClick={() => onWish(p.id)} aria-pressed={wished} aria-label={wished ? 'Remove from wishlist' : 'Add to wishlist'} className="absolute right-2 top-2 grid size-9 place-items-center rounded-full bg-surface/90 text-ink-2 shadow-sm backdrop-blur transition hover:scale-105">
            <Heart className={cn('size-[18px]', wished && 'fill-coral-500 text-coral-500')} />
          </button>
        )}
        {onQuickAdd && p.available && (
          <div className="absolute inset-x-2.5 bottom-2.5 hidden translate-y-2 opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100 md:block">
            <Button size="sm" variant="accent" block onClick={() => onQuickAdd(p)}>Quick add</Button>
          </div>
        )}
      </div>
      <div className="mt-3 flex flex-1 flex-col gap-1">
        <Link href={`/p/${p.slug}`} className="line-clamp-2 text-[15px] font-semibold leading-snug text-ink hover:text-pine-700">{p.title}</Link>
        <Rating value={p.rating.avg} count={p.rating.count} />
        <PriceDisplay price={p.price} compareAt={p.compareAtPrice} currency={p.currency} size="md" />
        {p.available && p.minDays && p.maxDays ? (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-3"><Truck className="size-3.5" aria-hidden /> Arrives in {p.minDays + 1}–{p.maxDays + 1} days</p>
        ) : null}
      </div>
    </article>
  );
}

export function ProductGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-3 sm:gap-x-4 lg:grid-cols-4 xl:gap-x-5', className)}>{children}</div>;
}
export const ProductGridSkeleton = ({ n = 8 }: { n?: number }) => (
  <ProductGrid>{Array.from({ length: n }, (_, i) => (<div key={i}><Skeleton className="aspect-square" /><Skeleton className="mt-3 h-4 w-4/5" /><Skeleton className="mt-2 h-4 w-1/3" /></div>))}</ProductGrid>
);

/* Section header used on the homepage. */
export const SectionHeader = ({ title, subtitle, href, hrefLabel = 'See all' }: { title: string; subtitle?: string; href?: string; hrefLabel?: string }) => (
  <div className="mb-5 flex items-end justify-between gap-4">
    <div>
      <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-[28px]">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-ink-3">{subtitle}</p>}
    </div>
    {href && <Link href={href} className="shrink-0 text-sm font-semibold text-pine-700 hover:underline">{hrefLabel} →</Link>}
  </div>
);

/* Country selector (header + footer + checkout). */
export function CountrySelector({ value, countries, onChange, compact }: { value: string; countries: { code: string; name: string; currency: string }[]; onChange: (code: string) => void; compact?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const cur = countries.find((c) => c.code === value);
  React.useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const flag = (c: string) => String.fromCodePoint(...[...c].map((ch) => 127397 + ch.charCodeAt(0)));
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} aria-label={`Shipping to ${cur?.name ?? value}. Change country`} className="flex h-11 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-ink-2 hover:bg-sunken">
        <span aria-hidden className="text-base leading-none">{flag(value)}</span>
        {!compact && <span className="hidden sm:inline">{cur?.currency}</span>}
        <ChevronDown className="size-3.5 text-ink-3" aria-hidden />
      </button>
      {open && (
        <ul role="listbox" className="absolute right-0 z-50 mt-2 w-64 rounded-lg border border-line bg-surface p-1.5 shadow-pop">
          <li className="flex items-center gap-1.5 px-3 pb-1.5 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-3"><MapPin className="size-3.5" /> Ship to</li>
          {countries.map((c) => (
            <li key={c.code} role="option" aria-selected={c.code === value}>
              <button onClick={() => { setOpen(false); onChange(c.code); }} className={cn('flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-sunken', c.code === value && 'bg-pine-50 font-semibold text-pine-700')}>
                <span className="text-lg" aria-hidden>{flag(c.code)}</span>
                <span className="flex-1">{c.name}</span>
                <span className="text-xs text-ink-3">{c.currency}</span>
                {c.code === value && <Check className="size-4" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* Search bar with typo-tolerant suggestions supplied by the caller. */
export function SearchBar({ value, onChange, onSubmit, suggestions, onPick, placeholder = 'Search products, categories…', autoFocus, className }: { value: string; onChange: (v: string) => void; onSubmit: (v: string) => void; suggestions?: { label: string; slug?: string }[]; onPick?: (s: { label: string; slug?: string }) => void; placeholder?: string; autoFocus?: boolean; className?: string }) {
  const [focus, setFocus] = React.useState(false);
  const [idx, setIdx] = React.useState(-1);
  const show = focus && value.trim().length > 0 && !!suggestions?.length;
  return (
    <div className={cn('relative', className)}>
      <form role="search" onSubmit={(e) => { e.preventDefault(); setFocus(false); if (idx >= 0 && suggestions?.[idx]) onPick?.(suggestions[idx]!); else onSubmit(value.trim()); }}>
        <Search className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-ink-3" aria-hidden />
        <input
          type="search" inputMode="search" enterKeyHint="search" autoFocus={autoFocus} value={value} placeholder={placeholder} aria-label="Search" aria-autocomplete="list" aria-expanded={show} autoComplete="off"
          onChange={(e) => { onChange(e.target.value); setIdx(-1); }} onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 150)}
          onKeyDown={(e) => { if (!show) return; if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, suggestions!.length - 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, -1)); } }}
          className="h-12 w-full rounded-full border border-line-strong bg-surface pl-11 pr-4 text-[15px] placeholder:text-ink-3 focus:border-pine-500 focus:outline-none focus:ring-2 focus:ring-pine-500/20"
        />
      </form>
      {show && (
        <ul role="listbox" className="absolute inset-x-0 top-full z-50 mt-2 overflow-hidden rounded-lg border border-line bg-surface p-1.5 shadow-pop">
          {suggestions!.map((s, i) => (
            <li key={s.label + i} role="option" aria-selected={i === idx}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { setFocus(false); onPick?.(s); }} className={cn('flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-sunken', i === idx && 'bg-sunken')}>
                <Search className="size-4 text-ink-3" aria-hidden /> <span className="truncate">{s.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* Filter panel (desktop sidebar & mobile sheet content). */
export interface FilterState { category?: string; minPrice?: string; maxPrice?: string; minRating?: string; inStock?: boolean }
export function FilterPanel({ value, onChange, categories, currency }: { value: FilterState; onChange: (f: FilterState) => void; categories: { slug: string; label: string; count?: number }[]; currency: string }) {
  const sym = currency === 'INR' ? '₹' : '$';
  return (
    <div className="space-y-7">
      <fieldset>
        <legend className="mb-3 text-sm font-bold">Category</legend>
        <div className="space-y-1">
          <button onClick={() => onChange({ ...value, category: undefined })} className={cn('block w-full rounded-md px-3 py-2 text-left text-sm', !value.category ? 'bg-pine-50 font-semibold text-pine-700' : 'text-ink-2 hover:bg-sunken')}>All</button>
          {categories.map((c) => (
            <button key={c.slug} onClick={() => onChange({ ...value, category: c.slug })} className={cn('flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm', value.category === c.slug ? 'bg-pine-50 font-semibold text-pine-700' : 'text-ink-2 hover:bg-sunken')}>
              <span>{c.label}</span>{c.count !== undefined && <span className="text-xs text-ink-3">{c.count}</span>}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-3 text-sm font-bold">Price ({currency})</legend>
        <div className="flex items-center gap-2">
          <input aria-label="Minimum price" inputMode="numeric" placeholder={`${sym} Min`} value={value.minPrice ?? ''} onChange={(e) => onChange({ ...value, minPrice: e.target.value.replace(/\D/g, '') || undefined })} className="h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-sm" />
          <span className="text-ink-3">–</span>
          <input aria-label="Maximum price" inputMode="numeric" placeholder={`${sym} Max`} value={value.maxPrice ?? ''} onChange={(e) => onChange({ ...value, maxPrice: e.target.value.replace(/\D/g, '') || undefined })} className="h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-sm" />
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-3 text-sm font-bold">Rating</legend>
        <div className="flex flex-wrap gap-2">
          {['4', '3'].map((r) => (
            <button key={r} aria-pressed={value.minRating === r} onClick={() => onChange({ ...value, minRating: value.minRating === r ? undefined : r })} className={cn('inline-flex h-9 items-center gap-1 rounded-full border px-3.5 text-sm', value.minRating === r ? 'border-pine-600 bg-pine-50 font-semibold text-pine-700' : 'border-line-strong text-ink-2')}>{r}<Star className="size-3.5 fill-current" /> & up</button>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold">In stock only</span>
        <Switch checked={!!value.inStock} onChange={(v) => onChange({ ...value, inStock: v || undefined })} label="In stock only" />
      </div>
    </div>
  );
}

/* Order timeline: derived from real status, shipment events, and the order's own timeline. */
const STEPS = [
  { key: 'PAID', label: 'Order placed', desc: 'Payment confirmed' },
  { key: 'SUPPLIER_PROCESSING', label: 'Preparing', desc: 'Sent to our fulfilment partner' },
  { key: 'SHIPPED', label: 'Shipped', desc: 'On its way to the carrier' },
  { key: 'IN_TRANSIT', label: 'In transit', desc: 'Travelling to you' },
  { key: 'DELIVERED', label: 'Delivered', desc: 'Enjoy!' },
];
const ORDER = ['PENDING_PAYMENT', 'PAID', 'SUPPLIER_PROCESSING', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED'];
export function OrderTimeline({ status, timestamps }: { status: string; timestamps?: Record<string, string | undefined> }) {
  if (['CANCELLED', 'REFUNDED'].includes(status)) return <div className="rounded-lg bg-sunken p-4 text-sm text-ink-2">This order was {status.toLowerCase()}.</div>;
  const cur = Math.max(ORDER.indexOf(status === 'EXCEPTION' || status === 'REFUND_REQUESTED' ? 'SUPPLIER_PROCESSING' : status), 0);
  return (
    <ol className="relative space-y-5" aria-label="Order progress">
      {STEPS.map((s) => {
        const i = ORDER.indexOf(s.key);
        const done = i <= cur && status !== 'PENDING_PAYMENT';
        const active = i === cur;
        return (
          <li key={s.key} className="relative flex gap-3.5">
            <span className={cn('relative z-10 mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border-2', done ? 'border-pine-600 bg-pine-600 text-white' : 'border-line-strong bg-surface text-transparent')}>{done ? <Check className="size-3.5" strokeWidth={3} /> : <Circle className="size-2" />}</span>
            <div className="min-w-0 pb-1">
              <p className={cn('text-sm font-bold', done ? 'text-ink' : 'text-ink-3')}>{s.label}{active && done && status !== 'DELIVERED' && <span className="ml-2 rounded-full bg-pine-50 px-2 py-0.5 text-xs text-pine-700">Current</span>}</p>
              <p className="text-sm text-ink-3">{timestamps?.[s.key] ? new Date(timestamps[s.key]!).toLocaleString() : s.desc}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ----------------------------- Admin building blocks ----------------------------- */
export function MetricCard({ label, value, delta, deltaGoodWhen = 'up', hint, spark, tone }: { label: string; value: string; delta?: number | null; deltaGoodWhen?: 'up' | 'down'; hint?: string; spark?: number[]; tone?: 'default' | 'warn' }) {
  const good = delta === undefined || delta === null ? undefined : deltaGoodWhen === 'up' ? delta >= 0 : delta <= 0;
  return (
    <Card className="p-4 sm:p-5">
      <p className="text-[13px] font-semibold text-ink-3">{label}</p>
      <div className="mt-1.5 flex items-end justify-between gap-2">
        <p className={cn('text-2xl font-bold tabular-nums tracking-tight sm:text-[28px]', tone === 'warn' && 'text-coral-500')}>{value}</p>
        {spark && spark.length > 1 && <Sparkline data={spark} className="mb-1 h-8 w-20" />}
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-xs">
        {delta !== undefined && delta !== null && (
          <span className={cn('inline-flex items-center gap-0.5 font-bold', good ? 'text-ok-500' : 'text-coral-500')}>{delta >= 0 ? '▲' : '▼'} {Math.abs(delta * 100).toFixed(1)}%</span>
        )}
        {hint && <span className="text-ink-3">{hint}</span>}
      </div>
    </Card>
  );
}

export function Sparkline({ data, className, color = 'var(--series-1)' }: { data: number[]; className?: string; color?: string }) {
  const w = 100, h = 32;
  const min = Math.min(...data), max = Math.max(...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 3 - ((v - min) / (max - min || 1)) * (h - 6)}`).join(' ');
  return <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={className} aria-hidden><polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" /></svg>;
}

export function AIInsightCard({ severity, title, detail, action, onAction }: { severity: 'info' | 'positive' | 'warning' | 'critical'; title: string; detail: string; action?: { label: string; href?: string }; onAction?: () => void }) {
  const tone = { info: 'bg-info-50 text-info-500', positive: 'bg-ok-50 text-ok-500', warning: 'bg-warn-50 text-warn-500', critical: 'bg-coral-50 text-coral-500' }[severity];
  const Icon = severity === 'positive' ? Zap : Sparkles;
  return (
    <div className="flex gap-3 rounded-lg border border-line bg-surface p-4">
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-full', tone)}><Icon className="size-4.5" aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold leading-snug">{title}</p>
        <p className="mt-0.5 text-sm text-ink-3">{detail}</p>
        {action && (action.href ? <Link href={action.href} className="mt-2 inline-block text-sm font-semibold text-pine-700 hover:underline">{action.label} →</Link> : <button onClick={onAction} className="mt-2 text-sm font-semibold text-pine-700 hover:underline">{action.label} →</button>)}
      </div>
    </div>
  );
}

const RISK: Record<string, Tone> = { low: 'ok', medium: 'warn', high: 'coral' };
export function AutomationCard({ a, onMode, canEdit }: { a: { key: string; name: string; description: string; mode: string; risk: string; schedule: { name: string; everyMs: number; enabled: boolean }[]; lastRun: string | null; nextRun: string | null; successRate: number | null }; onMode: (mode: string) => void; canEdit: boolean }) {
  const every = (ms: number) => (ms >= 86_400_000 ? `${ms / 86_400_000}d` : ms >= 3_600_000 ? `${ms / 3_600_000}h` : `${ms / 60_000}m`);
  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div><h3 className="text-[15px] font-bold">{a.name}</h3><p className="mt-0.5 text-sm text-ink-3">{a.description}</p></div>
        <Badge tone={RISK[a.risk] ?? 'neutral'}>{a.risk} risk</Badge>
      </div>
      <div role="radiogroup" aria-label={`${a.name} mode`} className="mt-4 grid grid-cols-3 gap-1 rounded-md bg-sunken p-1">
        {['OFF', 'ASSISTED', 'AUTOMATIC'].map((m) => (
          <button key={m} role="radio" aria-checked={a.mode === m} disabled={!canEdit} onClick={() => a.mode !== m && onMode(m)} className={cn('h-9 rounded-md text-xs font-bold transition-colors disabled:cursor-not-allowed', a.mode === m ? (m === 'AUTOMATIC' ? 'bg-pine-600 text-white shadow-sm' : m === 'ASSISTED' ? 'bg-surface text-saffron-700 shadow-sm' : 'bg-surface text-ink shadow-sm') : 'text-ink-3 hover:text-ink')}>{m[0] + m.slice(1).toLowerCase()}</button>
        ))}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div><dt className="text-ink-3">Schedule</dt><dd className="font-semibold">{a.schedule.length ? a.schedule.map((s) => `${s.name.replace(/_/g, ' ')} · ${every(s.everyMs)}${s.enabled ? '' : ' (off)'}`).join(', ') : 'Event-driven'}</dd></div>
        <div><dt className="text-ink-3">Success rate (7d)</dt><dd className="font-semibold">{a.successRate === null ? '—' : `${Math.round(a.successRate * 100)}%`}</dd></div>
        <div><dt className="text-ink-3">Last run</dt><dd className="font-semibold">{a.lastRun ? new Date(a.lastRun).toLocaleString() : '—'}</dd></div>
        <div><dt className="text-ink-3">Next run</dt><dd className="font-semibold">{a.nextRun ? new Date(a.nextRun).toLocaleTimeString() : '—'}</dd></div>
      </dl>
    </Card>
  );
}

