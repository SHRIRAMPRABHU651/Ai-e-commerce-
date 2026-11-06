'use client';
import { GitCompare } from 'lucide-react';
import * as React from 'react';
import { Badge, Button, Card, EmptyState, Link, ProductArt, Skeleton } from '@orvia/ui';
import type { CompareResponse } from '@orvia/types';
import { api } from '@/lib/api';
import { useCompareIds } from './findShared';
import { TrackPriceButton } from './findPriceGuard';

/** /compare?ids=a,b,c (falls back to the browser's compare tray when no ids are in the URL). */
export function ComparePage({ idsParam }: { idsParam?: string }) {
  const tray = useCompareIds();
  const fromUrl = React.useMemo(() => (idsParam ?? '').split(',').map((s) => s.trim()).filter((s) => /^[a-f\d]{24}$/i.test(s)).slice(0, 4), [idsParam]);
  const ids = fromUrl.length ? fromUrl : tray.ids;
  const [data, setData] = React.useState<CompareResponse | null>(null);
  const [state, setState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = React.useState('');
  const key = ids.join(',');
  React.useEffect(() => {
    if (ids.length < 2) { setState('ready'); setData(null); return; }
    let live = true;
    setState('loading');
    api<CompareResponse>('/compare', { body: { ids } }).then((r) => { if (live) { setData(r); setState('ready'); } }).catch((e: Error) => { if (live) { setErr(e.message); setState('error'); } });
    return () => { live = false; };
  }, [key]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-10">
      <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">Compare products</h1>
      <p className="mt-2 text-ink-3">Side by side, using only the details we hold for each product.</p>
      <div className="mt-6" aria-live="polite">
        {state === 'loading' && <Skeleton className="h-80" />}
        {state === 'error' && <div role="alert" className="rounded-xl border border-coral-200 bg-coral-50 p-4 text-sm text-coral-900"><p className="font-semibold">We could not build this comparison</p><p className="mt-1">{err}</p><Button href="/find" variant="secondary" size="sm" className="mt-3">Back to Find</Button></div>}
        {state === 'ready' && !data && <EmptyState icon={<GitCompare className="size-6" />} title="Pick 2 to 4 products to compare" body="Tick “Compare” on products in Find, then open the compare tray." action={<Button href="/find">Open Find</Button>} />}
        {state === 'ready' && data && (
          <>
            {data.bestFor.length > 0 && (
              <ul className="mb-5 grid gap-3 sm:grid-cols-3" aria-label="Best for">
                {data.bestFor.map((b) => { const p = data.products.find((x) => x.id === b.productId)!; return <li key={b.label}><Card className="p-4"><Badge tone="pine">{b.label}</Badge><p className="mt-2 font-semibold">{p.title}</p><p className="text-sm text-ink-3">{b.detail}</p></Card></li>; })}
              </ul>
            )}
            {data.keyDifferences.length > 0 && <section className="mb-5 rounded-xl border border-line bg-surface p-4"><h2 className="text-sm font-bold">Key differences</h2><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">{data.keyDifferences.map((d) => <li key={d}>{d}</li>)}</ul></section>}
            <div className="overflow-x-auto rounded-xl border border-line bg-surface">
              <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
                <caption className="sr-only">Product comparison</caption>
                <thead>
                  <tr><th scope="col" className="w-40 p-3" />
                    {data.products.map((p) => (
                      <th key={p.id} scope="col" className="min-w-40 p-3 align-top">
                        <div className="w-24"><ProductArt src={p.image ?? undefined} alt={p.title} /></div>
                        <Link href={`/p/${p.slug}`} className="mt-2 block font-semibold hover:underline">{p.title}</Link>
                        <div className="mt-2 flex flex-wrap gap-2"><TrackPriceButton productId={p.id} price={p.price} currency={data.currency} /></div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.key} className={r.differs ? 'bg-pine-50/50' : undefined}>
                      <th scope="row" className="p-3 align-top font-semibold text-ink-2">{r.label}{r.differs && <span className="sr-only"> (differs)</span>}</th>
                      {r.values.map((v, i) => <td key={i} className="p-3 align-top">{v ?? <span className="text-ink-3">Not listed</span>}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-ink-3">{data.note} All prices are in {data.currency}.</p>
          </>
        )}
      </div>
    </div>
  );
}
