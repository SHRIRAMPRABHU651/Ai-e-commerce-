'use client';
import { Check, GitCompare } from 'lucide-react';
import * as React from 'react';
import { Link, ProductArt, Rating, cn } from '@orvia/ui';
import type { FindItem } from '@orvia/types';
import { money } from '@/lib/api';

/* ------------------------------ compare tray (per-browser convenience, localStorage) ------------------------------ */
const KEY = 'orvia_compare_ids';
const MAX = 4;
const EVT = 'orvia:compare';
const read = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && /^[a-f\d]{24}$/i.test(x)).slice(0, MAX) : [];
  } catch { return []; }
};
const write = (ids: string[]) => { try { localStorage.setItem(KEY, JSON.stringify(ids)); } catch { /* storage unavailable: tray is session-less */ } window.dispatchEvent(new Event(EVT)); };

export function useCompareIds() {
  const [ids, setIds] = React.useState<string[]>([]);
  React.useEffect(() => {
    const sync = () => setIds(read());
    sync();
    window.addEventListener(EVT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(EVT, sync); window.removeEventListener('storage', sync); };
  }, []);
  const toggle = React.useCallback((id: string) => { const cur = read(); write(cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= MAX ? cur : [...cur, id]); }, []);
  const clear = React.useCallback(() => write([]), []);
  return { ids, toggle, clear, full: ids.length >= MAX };
}

/** Drop-in "Compare" checkbox for any product card or product page: `<CompareToggle productId={p.id} />`. */
export function CompareToggle({ productId, className }: { productId: string; className?: string }) {
  const { ids, toggle, full } = useCompareIds();
  const on = ids.includes(productId);
  return (
    <button type="button" onClick={() => toggle(productId)} aria-pressed={on} disabled={!on && full} title={!on && full ? `You can compare up to ${MAX} products` : undefined}
      className={cn('inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors disabled:opacity-50', on ? 'border-pine-600 bg-pine-50 text-pine-800' : 'border-line-strong text-ink-2 hover:bg-sunken', className)}>
      {on ? <Check className="size-3.5" aria-hidden /> : <GitCompare className="size-3.5" aria-hidden />}{on ? 'In compare' : 'Compare'}
    </button>
  );
}

/** Sticky bar listing how many products are selected, linking to /compare?ids=. Mount once on pages that show CompareToggle. */
export function CompareTray() {
  const { ids, clear } = useCompareIds();
  if (!ids.length) return null;
  return (
    <div role="region" aria-label="Compare tray" className="fixed inset-x-0 bottom-16 z-30 px-4 md:bottom-4">
      <div className="mx-auto flex max-w-xl items-center justify-between gap-3 rounded-full border border-line-strong bg-surface px-4 py-2.5 shadow-pop">
        <span className="text-sm font-semibold">{ids.length} selected <span className="font-normal text-ink-3">(2 to 4)</span></span>
        <span className="flex items-center gap-2">
          <button type="button" onClick={clear} className="text-sm text-ink-3 underline">Clear</button>
          {ids.length >= 2 ? <Link href={`/compare?ids=${ids.join(',')}`} className="inline-flex h-9 items-center rounded-full bg-pine-700 px-4 text-sm font-semibold text-on-fill">Compare</Link> : <span className="text-xs text-ink-3">Pick one more</span>}
        </span>
      </div>
    </div>
  );
}

export const deliveryText = (i: Pick<FindItem, 'minDays' | 'maxDays'>): string | null =>
  i.minDays == null && i.maxDays == null ? null : i.minDays === i.maxDays || i.minDays == null || i.maxDays == null ? `${i.maxDays ?? i.minDays} days` : `${i.minDays}-${i.maxDays} days`;

export function ResultCard({ item, children }: { item: FindItem; children?: React.ReactNode }) {
  const d = deliveryText(item);
  return (
    <li className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface">
      <Link href={`/p/${item.slug}`} className="group block"><ProductArt src={item.image ?? undefined} alt={item.title} /></Link>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <Link href={`/p/${item.slug}`} className="line-clamp-2 text-sm font-semibold hover:underline">{item.title}</Link>
        <div className="flex items-baseline gap-2"><span className="text-base font-bold">{money(item.price, item.currency)}</span><span className="text-xs text-ink-3">≈ {money(item.deliveredEstimate, item.currency)} delivered, before tax</span></div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3"><Rating value={item.rating.avg} count={item.rating.count} />{d && <span>Delivery est. {d}</span>}</div>
        {item.deliveryFit === 'may_not_arrive' && <p className="rounded-md bg-saffron-50 px-2 py-1 text-xs font-semibold text-saffron-800" role="status">May not arrive in time</p>}
        {item.deliveryFit === 'unknown' && <p className="rounded-md bg-sunken px-2 py-1 text-xs text-ink-2" role="status">Delivery time not available</p>}
        <details className="text-xs text-ink-2">
          <summary className="cursor-pointer font-semibold text-pine-700">Why this matched</summary>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">{item.whyMatched.map((w, i) => <li key={i}>{w.text}</li>)}</ul>
        </details>
        <div className="mt-auto flex flex-wrap gap-2 pt-1"><CompareToggle productId={item.id} />{children}</div>
      </div>
    </li>
  );
}
