import type { Metadata } from 'next';
import { ArrowRight, Sparkles } from 'lucide-react';
import { Button, Link, SectionHeader, Rating, ProductArt, PriceDisplay, Badge } from '@orvia/ui';
import { RecentlyViewed, ProductShelf, TrackPage } from '@/components/shelf';
import { TrustStrip } from '@/components/chrome';
import { resolveCountry, sget } from '@/lib/server';
import type { HomeData, Meta } from '@/lib/types';

export const metadata: Metadata = { title: { absolute: 'Orvia — considered goods for pets, kids, style & everyday life' }, alternates: { canonical: '/' } };

const TILE_STYLE: Record<string, string> = { pet: 'bg-[#f3e6d3] text-[#5d3a17]', kids: 'bg-[#e1ecfa] text-[#1f4f94]', fashion: 'bg-[#ece3f2] text-[#4e3774]', gadgets: 'bg-[#dcebe7] text-[#1c4439]' };
const TILE_COPY: Record<string, string> = { pet: 'Toys, feeders and travel gear for happy pets', kids: 'Play that teaches, calms and creates', fashion: 'Pieces with character, built to be worn', gadgets: 'Small upgrades for desks, bags and cars' };

export default async function Home() {
  const country = await resolveCountry();
  const [home, meta] = await Promise.all([sget<HomeData>('/home', { country }), sget<Meta>('/meta', { country })]);
  if (!home || !meta) return null;
  const hero = home.trending.filter((p) => p.available).slice(0, 3);
  const welcome = home.promotions.find((p) => p.code);
  const flash = home.promotions.find((p) => !p.code && p.percent > 0);
  return (
    <>
      <TrackPage />
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-line bg-gradient-to-b from-pine-50 to-paper">
        <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 py-10 sm:py-14 lg:grid-cols-[1.05fr_1fr] lg:py-20">
          <div>
            <Badge tone="saffron" className="mb-5"><Sparkles className="size-3.5" /> {flash ? `${Math.round(flash.percent * 100)}% off today — applied automatically` : 'New this week'}</Badge>
            <h1 className="font-display text-[40px] font-semibold leading-[1.05] tracking-tight text-pine-900 sm:text-6xl">Everyday things,<br />made a little better.</h1>
            <p className="mt-5 max-w-lg text-base text-ink-2 sm:text-lg">Hand-picked goods for pets, kids, style and your desk — shipped from the warehouse closest to you, with tracking on every order and {meta.countries.find((c) => c.code === country)?.returnWindowDays}-day returns.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" href="/c/trending">Shop trending <ArrowRight className="size-4" /></Button>
              <Button size="lg" variant="secondary" href="/search?sort=newest">New arrivals</Button>
            </div>
            {welcome && <p className="mt-6 text-sm text-ink-2">New here? Use code <span className="rounded-md bg-surface px-2 py-1 font-mono text-[13px] font-bold text-pine-700 ring-1 ring-line-strong">{welcome.code}</span> for {Math.round(welcome.percent * 100)}% off your first order.</p>}
          </div>
          <div className="relative mx-auto grid w-full max-w-lg grid-cols-6 grid-rows-6 gap-3 sm:gap-4" style={{ aspectRatio: '1 / 0.92' }}>
            {hero.map((p, i) => (
              <Link key={p.id} href={`/p/${p.slug}`} className={['col-span-4 row-span-4 col-start-1 row-start-1', 'col-span-3 row-span-3 col-start-4 row-start-3', 'col-span-3 row-span-2 col-start-1 row-start-5'][i]! + ' group relative overflow-hidden rounded-xl border border-line bg-surface shadow-card'}>
                <ProductArt src={p.images[0]?.url} alt={p.title} priority className="absolute inset-0 !aspect-auto size-full" />
                <span className="absolute inset-x-2 top-2 flex items-center justify-between gap-2 rounded-lg bg-surface/95 px-2.5 py-1.5 text-xs shadow backdrop-blur"><span className="truncate font-semibold">{p.title}</span><PriceDisplay price={p.price} currency={p.currency} size="sm" /></span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Category discovery */}
      <section className="mx-auto max-w-7xl px-4 pt-12" aria-labelledby="cats">
        <SectionHeader title="Shop by category" />
        <h2 id="cats" className="sr-only">Categories</h2>
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {home.categories.map((c) => (
            <Link key={c.slug} href={`/c/${c.slug}`} className={`group relative flex min-h-36 flex-col justify-between overflow-hidden rounded-xl p-4 transition-transform hover:-translate-y-0.5 sm:min-h-44 sm:p-5 ${TILE_STYLE[c.slug] ?? 'bg-sunken'}`}>
              <span className="font-display text-2xl font-semibold sm:text-3xl">{c.name}</span>
              <span className="text-[13px] leading-snug opacity-80 sm:text-sm">{TILE_COPY[c.slug]}<span className="mt-2 flex items-center gap-1 font-bold">{c.count} items <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-1" /></span></span>
            </Link>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 pt-14"><SectionHeader title="Trending now" subtitle={`What shoppers in ${meta.countries.find((c) => c.code === country)?.name} are adding to cart`} href="/c/trending" /><ProductShelf products={home.trending} /></section>

      {(flash || welcome) && (
        <section className="mx-auto max-w-7xl px-4 pt-14" aria-label="Offers">
          <div className="grid gap-3 sm:grid-cols-2">
            {flash && <div className="rounded-xl bg-pine-900 p-6 text-pine-100"><p className="text-xs font-bold uppercase tracking-widest text-saffron-500">Limited time</p><p className="mt-2 font-display text-3xl font-semibold text-white">{flash.name}</p><p className="mt-1 text-sm">{Math.round(flash.percent * 100)}% off sitewide, applied at checkout — no code needed.</p></div>}
            {welcome && <div className="rounded-xl bg-saffron-50 p-6 text-saffron-700"><p className="text-xs font-bold uppercase tracking-widest">First order</p><p className="mt-2 font-display text-3xl font-semibold text-ink">Take {Math.round(welcome.percent * 100)}% off</p><p className="mt-1 text-sm">Use code <b className="font-mono">{welcome.code}</b> at checkout.</p></div>}
          </div>
        </section>
      )}

      {home.recommended.length > 0 && <section className="mx-auto max-w-7xl px-4 pt-14"><SectionHeader title="Recommended for you" subtitle="Based on what you’ve viewed" /><ProductShelf products={home.recommended} /></section>}
      {home.deals.length > 0 && <section className="mx-auto max-w-7xl px-4 pt-14"><SectionHeader title="Today’s deals" subtitle="Priced below what similar items typically sell for" href="/search?sort=price_asc" /><ProductShelf products={home.deals} /></section>}
      <section className="mx-auto max-w-7xl px-4 pt-14"><SectionHeader title="New arrivals" href="/search?sort=newest" /><ProductShelf products={home.newArrivals} /></section>
      <section className="mx-auto max-w-7xl px-4 pt-14"><SectionHeader title="Best sellers" href="/search?sort=bestselling" /><ProductShelf products={home.bestSellers} /></section>
      {home.countryTrending.length > 0 && <section className="mx-auto max-w-7xl px-4 pt-14"><SectionHeader title={`Popular in ${meta.countries.find((c) => c.code === country)?.name}`} /><ProductShelf products={home.countryTrending} /></section>}

      {home.testimonials.length > 0 && (
        <section className="mx-auto max-w-7xl px-4 pt-16" aria-labelledby="proof">
          <h2 id="proof" className="font-display text-2xl font-semibold tracking-tight sm:text-[28px]">Loved by verified buyers</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {home.testimonials.map((t, i) => (
              <figure key={i} className="rounded-xl border border-line bg-surface p-6 shadow-card">
                <Rating value={t.rating} count={1} />
                <blockquote className="mt-3 text-[15px] leading-relaxed text-ink">“{t.body}”</blockquote>
                <figcaption className="mt-4 text-sm text-ink-3"><b className="text-ink">{t.authorName}</b> · verified purchase<br />on {t.product}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}
      <div className="mt-16"><TrustStrip /></div>
      <RecentlyViewed />
    </>
  );
}
