'use client';
import { Check, ChevronDown, Heart, MapPin, RotateCcw, ShieldCheck, Star, Truck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Badge, Button, Card, Field, Input, Link, PriceDisplay, ProductArt, QuantityStepper, Rating, Textarea, cn, useToast } from '@orvia/ui';
import { api } from '@/lib/api';
import { money } from '@/lib/api';
import { useStore } from './providers';
import type { ProductPage } from '@/lib/types';

export function Gallery({ images, title }: { images: { url: string; alt?: string }[]; title: string }) {
  const [i, setI] = React.useState(0);
  const scroller = React.useRef<HTMLDivElement>(null);
  return (
    <div className="lg:sticky lg:top-32">
      {/* mobile: swipeable */}
      <div ref={scroller} onScroll={(e) => setI(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))} className="no-scrollbar -mx-4 flex snap-x snap-mandatory overflow-x-auto lg:hidden">
        {images.map((im, k) => <div key={k} className="w-full shrink-0 snap-center"><ProductArt src={im.url} alt={im.alt ?? title} priority={k === 0} /></div>)}
      </div>
      <div className="mt-3 flex justify-center gap-1.5 lg:hidden" aria-hidden>{images.map((_, k) => <span key={k} className={cn('h-1.5 rounded-full transition-all', k === i ? 'w-5 bg-pine-600' : 'w-1.5 bg-line-strong')} />)}</div>
      {/* desktop: thumbnails + stage */}
      <div className="hidden gap-4 lg:grid lg:grid-cols-[4.5rem_1fr]">
        <div className="flex flex-col gap-3">{images.map((im, k) => <button key={k} onClick={() => setI(k)} aria-label={`Show image ${k + 1}`} aria-current={k === i} className={cn('overflow-hidden rounded-md border-2', k === i ? 'border-pine-600' : 'border-transparent hover:border-line-strong')}><ProductArt src={im.url} alt="" /></button>)}</div>
        <div className="overflow-hidden rounded-xl border border-line"><ProductArt src={images[i]?.url} alt={images[i]?.alt ?? title} priority /></div>
      </div>
    </div>
  );
}

export function BuyBox({ data }: { data: ProductPage }) {
  const { product: p, variants } = data;
  const router = useRouter();
  const { addToCart, wishlist, toggleWish, country, meta, setCountry } = useStore();
  const [sku, setSku] = React.useState(variants[0]?.sku);
  const [qty, setQty] = React.useState(1);
  const [busy, setBusy] = React.useState<'add' | 'buy' | null>(null);
  const cur = meta.countries.find((c) => c.code === country)!;
  const hasVariants = variants.length > 1;
  const doAdd = async (buy: boolean) => {
    setBusy(buy ? 'buy' : 'add');
    const c = await addToCart(p.id, sku, qty, { silent: buy });
    setBusy(null);
    if (c && buy) router.push('/checkout');
  };
  const other = data.availableIn.filter((c) => c !== country);
  const wished = wishlist.has(p.id);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {p.topCategory && <Badge tone="pine">{p.topCategory}</Badge>}
        {p.available && p.lowStock && <Badge tone="saffron">Only {p.stock} left</Badge>}
        {p.trendScore >= 60 && <Badge tone="saffron">Trending</Badge>}
      </div>
      <h1 className="mt-3 font-display text-[28px] font-semibold leading-tight tracking-tight sm:text-4xl">{p.title}</h1>
      <a href="#reviews" className="mt-2 inline-block"><Rating value={p.rating.avg} count={p.rating.count} size={16} className="text-sm" /></a>
      <div className="mt-5"><PriceDisplay price={p.price} compareAt={p.compareAtPrice} currency={p.currency || cur.currency} size="lg" discountPct={p.discountPct} /></div>
      <p className="mt-1 text-sm text-ink-3">{cur.taxInclusive ? 'Inclusive of all taxes.' : 'Tax calculated at checkout.'}</p>

      {hasVariants && (
        <fieldset className="mt-6">
          <legend className="mb-2.5 text-sm font-bold">Option: <span className="font-semibold text-ink-2">{variants.find((v) => v.sku === sku)?.label}</span></legend>
          <div className="flex flex-wrap gap-2">{variants.map((v) => <button key={v.sku} onClick={() => setSku(v.sku)} aria-pressed={v.sku === sku} className={cn('h-11 min-w-12 rounded-md border px-4 text-sm font-semibold transition-colors', v.sku === sku ? 'border-pine-600 bg-pine-50 text-pine-700 ring-1 ring-pine-600' : 'border-line-strong text-ink-2 hover:border-ink-3')}>{v.label}</button>)}</div>
        </fieldset>
      )}

      <Card className="mt-6 divide-y divide-line">
        <div className="flex gap-3 p-4">
          <Truck className="mt-0.5 size-5 shrink-0 text-pine-600" />
          <div className="text-sm">
            {p.available && data.delivery ? (<><p className="font-bold">Arrives {data.delivery.label}</p><p className="text-ink-3">{p.shipsFrom ? `Ships from our ${p.shipsFrom} partner warehouse. ` : ''}Standard {cur.shippingMethods[0]?.fee === 0 ? 'free' : money(cur.shippingMethods[0]?.fee ?? 0, cur.currency)}{cur.shippingMethods[0]?.freeOver ? `, free over ${money(cur.shippingMethods[0].freeOver, cur.currency)}` : ''}.</p></>) : (<><p className="font-bold">Not available in {cur.name} right now</p>{other.length > 0 && <p className="text-ink-3">Available in {other.map((c) => meta.countries.find((x) => x.code === c)?.name).join(', ')}. <button className="font-semibold text-pine-700 underline" onClick={() => void setCountry(other[0]!)}>Switch country</button></p>}</>)}
          </div>
        </div>
        <div className="flex gap-3 p-4"><RotateCcw className="mt-0.5 size-5 shrink-0 text-pine-600" /><p className="text-sm"><b>{cur.returnWindowDays}-day returns.</b> <span className="text-ink-3">Start a return from your account.</span></p></div>
        <div className="flex gap-3 p-4"><ShieldCheck className="mt-0.5 size-5 shrink-0 text-pine-600" /><p className="text-sm"><b>Secure payment.</b> <span className="text-ink-3">Every payment is verified with the provider before we order.</span></p></div>
      </Card>

      {p.safety && <p className="mt-4 flex items-start gap-2 text-sm text-ink-2"><Check className="mt-0.5 size-4 shrink-0 text-ok-500" /><span>Supplier-declared safety standards: <b>{p.safety.standards.join(', ')}</b>{p.safety.ageRange ? ` · Ages ${p.safety.ageRange}` : ''}</span></p>}

      <div className="mt-6 hidden items-center gap-3 sm:flex">
        <QuantityStepper value={qty} onChange={setQty} max={Math.max(1, Math.min(10, p.stock || 1))} disabled={!p.available} />
        <Button size="lg" className="flex-1" disabled={!p.available} loading={busy === 'add'} onClick={() => void doAdd(false)}>Add to cart</Button>
        <button onClick={() => void toggleWish(p.id)} aria-pressed={wished} aria-label={wished ? 'Remove from wishlist' : 'Add to wishlist'} className="grid size-12 place-items-center rounded-md border border-line-strong hover:bg-sunken"><Heart className={cn('size-5', wished && 'fill-coral-500 text-coral-500')} /></button>
      </div>
      <Button size="lg" variant="accent" block className="mt-3 hidden sm:inline-flex" disabled={!p.available} loading={busy === 'buy'} onClick={() => void doAdd(true)}>Buy now</Button>

      {/* mobile sticky bar sits above the tab bar */}
      <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-line bg-surface/95 p-3 backdrop-blur sm:hidden">
        <div className="flex items-center gap-3">
          <div className="min-w-0"><PriceDisplay price={p.price} currency={p.currency || cur.currency} size="md" /></div>
          <Button className="flex-1" disabled={!p.available} loading={busy === 'add'} onClick={() => void doAdd(false)}>{p.available ? 'Add to cart' : 'Unavailable'}</Button>
          <Button variant="accent" disabled={!p.available} loading={busy === 'buy'} onClick={() => void doAdd(true)}>Buy now</Button>
        </div>
      </div>
      <p className="mt-4 flex items-center gap-1.5 text-xs text-ink-3"><MapPin className="size-3.5" /> Prices and delivery shown for {cur.name}.</p>
    </div>
  );
}

export function Accordion({ items }: { items: { id: string; title: string; body: React.ReactNode }[] }) {
  return (
    <div className="divide-y divide-line rounded-xl border border-line bg-surface">
      {items.map((it, k) => (
        <details key={it.id} open={k === 0} className="group px-5">
          <summary className="flex cursor-pointer list-none items-center justify-between py-4 text-[15px] font-bold [&::-webkit-details-marker]:hidden">{it.title}<ChevronDown className="size-4 text-ink-3 transition-transform group-open:rotate-180" /></summary>
          <div className="pb-5 text-[15px] leading-relaxed text-ink-2">{it.body}</div>
        </details>
      ))}
    </div>
  );
}

export function Reviews({ data }: { data: ProductPage }) {
  const { user } = useStore();
  const toast = useToast();
  const router = useRouter();
  const [list, setList] = React.useState(data.reviews.items);
  const [rating, setRating] = React.useState(5);
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const total = data.reviews.total;
  const dist = data.reviews.distribution;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/products/${data.product.id}/reviews`, { body: { rating, title, body, images: [] } });
      toast.success('Thanks — your review is live.');
      setBody(''); setTitle('');
      router.refresh();
    } catch (er) { toast.error((er as Error).message); } finally { setBusy(false); }
  };
  const helpful = async (id: string) => {
    try { await api(`/reviews/${id}/helpful`, { body: {} }); setList((l) => l.map((r) => (r._id === id ? { ...r, helpfulVotes: r.helpfulVotes + 1 } : r))); } catch (er) { toast.error((er as Error).message.includes('Already') ? 'You already voted' : 'Sign in to vote'); }
  };
  return (
    <section id="reviews" aria-labelledby="rev-h" className="scroll-mt-32">
      <h2 id="rev-h" className="font-display text-2xl font-semibold tracking-tight">Customer reviews</h2>
      <div className="mt-6 grid gap-8 lg:grid-cols-[18rem_1fr]">
        <div>
          <p className="flex items-end gap-2"><span className="text-5xl font-bold tabular-nums">{data.product.rating.count ? data.product.rating.avg.toFixed(1) : '—'}</span><span className="pb-1.5 text-sm text-ink-3">out of 5 · {total} review{total === 1 ? '' : 's'}</span></p>
          <ul className="mt-4 space-y-2">{[5, 4, 3, 2, 1].map((s) => (<li key={s} className="flex items-center gap-2 text-sm"><span className="flex w-8 items-center gap-0.5">{s}<Star className="size-3 fill-saffron-500 text-saffron-500" /></span><div className="h-2 flex-1 rounded-full bg-sunken"><div className="h-full rounded-full bg-saffron-500" style={{ width: `${total ? ((dist[String(s)] ?? 0) / total) * 100 : 0}%` }} /></div><span className="w-6 text-right text-ink-3 tabular-nums">{dist[String(s)] ?? 0}</span></li>))}</ul>
          {user ? (
            <form onSubmit={submit} className="mt-6 space-y-3 rounded-xl border border-line bg-surface p-4">
              <p className="text-sm font-bold">Write a review</p>
              <div role="radiogroup" aria-label="Rating" className="flex gap-1">{[1, 2, 3, 4, 5].map((s) => <button type="button" key={s} role="radio" aria-checked={rating === s} aria-label={`${s} star${s > 1 ? 's' : ''}`} onClick={() => setRating(s)}><Star className={cn('size-7', s <= rating ? 'fill-saffron-500 text-saffron-500' : 'text-line-strong')} /></button>)}</div>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" maxLength={120} aria-label="Review title" />
              <Field><Textarea required minLength={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What did you think?" aria-label="Review" /></Field>
              <Button type="submit" loading={busy} block>Submit review</Button>
            </form>
          ) : <p className="mt-6 text-sm text-ink-3"><Link href="/login" className="font-semibold text-pine-700 underline">Sign in</Link> to write a review.</p>}
        </div>
        <ul className="divide-y divide-line">
          {list.length === 0 && <li className="py-6 text-ink-3">No reviews yet. Be the first to share your experience.</li>}
          {list.map((r) => (
            <li key={r._id} className="py-5 first:pt-0">
              <div className="flex items-center gap-2"><Rating value={r.rating} count={1} size={15} /><span className="text-sm font-bold">{r.title}</span></div>
              <p className="mt-1 text-[15px] leading-relaxed text-ink-2">{r.body}</p>
              <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3"><span>{r.authorName}</span>{r.verifiedPurchase && <Badge tone="ok">Verified purchase</Badge>}<span>{new Date(r.createdAt).toLocaleDateString()}</span><button onClick={() => void helpful(r._id)} className="font-semibold text-pine-700 hover:underline">Helpful ({r.helpfulVotes})</button></p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function FrequentlyBought({ items }: { items: ProductPage['frequentlyBoughtTogether'] }) {
  const { addToCart } = useStore();
  const toast = useToast();
  const [sel, setSel] = React.useState<Set<string>>(new Set(items.slice(0, 2).map((i) => i.id)));
  if (!items.length) return null;
  const chosen = items.filter((i) => sel.has(i.id) && i.available);
  const total = chosen.reduce((a, i) => a + (i.price ?? 0), 0);
  return (
    <Card className="p-5">
      <h3 className="text-lg font-bold">Frequently bought together</h3>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {items.slice(0, 4).map((i) => (
          <li key={i.id}><label className="flex cursor-pointer items-center gap-3 rounded-lg border border-line p-2.5 hover:bg-sunken/60"><input type="checkbox" checked={sel.has(i.id)} disabled={!i.available} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n; })} className="size-4.5 accent-[var(--pine-600)]" /><div className="w-14 shrink-0 overflow-hidden rounded-md"><ProductArt src={i.images[0]?.url} alt="" /></div><div className="min-w-0 text-sm"><p className="line-clamp-2 font-semibold">{i.title}</p><PriceDisplay price={i.price} currency={i.currency} size="sm" /></div></label></li>
        ))}
      </ul>
      <div className="mt-4 flex items-center justify-between"><span className="text-sm text-ink-3">{chosen.length} selected · <b className="text-ink">{chosen[0] ? money(total, chosen[0].currency) : '—'}</b></span><Button variant="secondary" disabled={!chosen.length} onClick={async () => { for (const c of chosen) await addToCart(c.id, undefined, 1, { silent: true }); toast.success(`${chosen.length} item${chosen.length > 1 ? 's' : ''} added to cart`); }}>Add selected</Button></div>
    </Card>
  );
}
