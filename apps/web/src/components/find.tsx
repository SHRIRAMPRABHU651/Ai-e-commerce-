'use client';
import { Bookmark, ImageIcon, Search, Sparkles } from 'lucide-react';
import * as React from 'react';
import { Badge, Button, EmptyState, Input, Link, Skeleton, useToast } from '@orvia/ui';
import type { FindResponse } from '@orvia/types';
import { ApiError, api, money } from '@/lib/api';
import { CompareTray, ResultCard } from './findShared';
import { TrackPriceButton } from './findPriceGuard';
import { useStore } from './providers';

const EXAMPLES = ['Best value gift for my dog under $40', 'Screen-free toys for a 5 year old before Friday', 'Cheapest desk organizer', 'Top rated travel gadgets'];
interface Preset { id: string; group: string; title: string; query: string; count: number }
const GROUPS: Record<string, string> = { gift: 'Gifts', budget: 'By budget', need: 'By need', quick: 'Quick picks' };

export function FindPage({ initialQuery = '', initialBudget, initialBy }: { initialQuery?: string; initialBudget?: number; initialBy?: string }) {
  const { country, user } = useStore();
  const toast = useToast();
  const [q, setQ] = React.useState(initialQuery);
  const [res, setRes] = React.useState<FindResponse | null>(null);
  const [state, setState] = React.useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = React.useState<{ message: string; code?: string } | null>(null);
  const [presets, setPresets] = React.useState<Preset[]>([]);
  const [imageNote, setImageNote] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const extra = React.useRef<{ budgetMax?: number; deliverBy?: string }>({ budgetMax: initialBudget, deliverBy: initialBy });
  const live = React.useRef(0);

  React.useEffect(() => { api<{ items: Preset[] }>('/find/presets').then((r) => setPresets(r.items)).catch(() => setPresets([])); }, [country]);

  const run = React.useCallback(async (query: string, keep = false) => {
    const text = query.trim();
    if (!text) return;
    if (!keep) extra.current = {};
    const id = ++live.current;
    setState('loading'); setError(null); setImageNote(null);
    window.history.replaceState(null, '', `/find?q=${encodeURIComponent(text)}`);
    try {
      const r = await api<FindResponse>('/find', { body: { query: text, country, ...extra.current } });
      if (id === live.current) { setRes(r); setState('idle'); }
    } catch (e) {
      if (id !== live.current) return;
      setState('error');
      setError({ message: e instanceof ApiError && e.status === 429 ? 'You are searching very quickly. Please wait a moment and try again.' : (e as Error).message, code: (e as ApiError).code });
    }
  }, [country]);

  React.useEffect(() => { if (initialQuery) void run(initialQuery, true); }, []);

  const onImage = async (file: File | undefined) => {
    if (!file) return;
    setState('loading'); setError(null); setRes(null);
    const id = ++live.current;
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (q.trim()) fd.append('query', q.trim());
      const r = await fetch(`/api/v1/find/image?country=${country}`, { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'x-requested-with': 'orvia' } });
      const j = (await r.json().catch(() => ({}))) as FindResponse & { error?: { message?: string; code?: string } };
      if (id !== live.current) return;
      if (!r.ok) {
        if (j.error?.code === 'not_configured') setImageNote('Photo search is not available on this store yet because it needs an AI vision service that has not been set up. You can still describe what you are looking for in words.');
        else setError({ message: j.error?.message ?? 'Image search failed', code: j.error?.code });
        setState(j.error?.code === 'not_configured' ? 'idle' : 'error');
        return;
      }
      setRes(j); setState('idle');
    } catch (e) { if (id === live.current) { setState('error'); setError({ message: (e as Error).message }); } }
  };

  const save = async () => {
    if (!res) return;
    const name = window.prompt('Name this search', q.trim().slice(0, 60));
    if (!name) return;
    setSaving(true);
    const remember = window.confirm('Also remember this search in your Orvia memory? You can switch memory off or delete items any time in your account.');
    try { const r = await api<{ memory: { saved: boolean; reason?: string } | null }>('/account/saved-searches', { body: { name, query: q.trim(), country, remember, ...extra.current } }); toast.success(r.memory && !r.memory.saved ? 'Search saved (memory is off or full, so it was not added to memory)' : 'Search saved'); } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  };

  const u = res?.understood;
  const chips: string[] = [];
  if (u) {
    u.needs.forEach((n) => chips.push(`Need: ${n.name}`));
    u.categories.forEach((c) => chips.push(`Category: ${c.name}`));
    if (u.gift) chips.push(`Gift${u.gift.recipient ? ` for ${u.gift.recipient}` : ''}${u.gift.occasion ? ` (${u.gift.occasion})` : ''}`);
    if (u.budget) chips.push(`Budget: ${u.budget.min ? `${money(u.budget.min * 100, u.budget.currency)} to ` : 'up to '}${u.budget.max ? money(u.budget.max * 100, u.budget.currency) : '…'}${u.budget.converted ? ' (converted)' : ''}`);
    if (u.deadline) chips.push(`Arrive by ${u.deadline.date}`);
    u.attributes.forEach((a) => chips.push(`${a.kind[0]!.toUpperCase()}${a.kind.slice(1)}: ${a.value}`));
    if (u.sort !== 'relevance') chips.push(`Sort: ${u.sort.replace('_', ' ')}`);
  }
  const grouped = presets.reduce<Record<string, Preset[]>>((m, p) => ((m[p.group] ??= []).push(p), m), {});

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-10">
      <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">Find what you need</h1>
      <p className="mt-2 max-w-2xl text-ink-3">Describe it in your own words: what it is for, your budget, and when you need it. We search only products available in your country and show why each one matched.</p>
      <form role="search" className="mt-5 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); void run(q); }}>
        <label htmlFor="find-q" className="sr-only">Describe what you are looking for</label>
        <Input id="find-q" value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} placeholder="e.g. gift for my dog under $40 before Friday" className="flex-1" autoComplete="off" />
        <div className="flex gap-2">
          <Button type="submit" loading={state === 'loading'} className="flex-1 sm:flex-none"><Search className="mr-1.5 size-4" aria-hidden />Find</Button>
          <label className="inline-flex h-11 cursor-pointer items-center gap-1.5 rounded-md border border-line-strong px-3 text-sm font-semibold text-ink-2 hover:bg-sunken focus-within:ring-2">
            <ImageIcon className="size-4" aria-hidden /><span className="hidden sm:inline">Search by photo</span><span className="sm:hidden">Photo</span>
            <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => { void onImage(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        </div>
      </form>
      <div className="mt-3 flex flex-wrap gap-2" aria-label="Examples">{EXAMPLES.map((x) => <button key={x} type="button" onClick={() => { setQ(x); void run(x); }} className="rounded-full border border-line-strong px-3.5 py-1.5 text-sm text-ink-2 hover:bg-sunken">{x}</button>)}</div>

      {imageNote && <p role="status" className="mt-4 rounded-lg bg-sunken p-3 text-sm text-ink-2">{imageNote}</p>}

      <div className="mt-6" aria-live="polite">
        {state === 'loading' && <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4" aria-label="Loading results">{Array.from({ length: 8 }).map((_, i) => <li key={i}><Skeleton className="h-64" /></li>)}</ul>}
        {state === 'error' && <div role="alert" className="rounded-xl border border-coral-200 bg-coral-50 p-4 text-sm text-coral-900"><p className="font-semibold">We could not complete that search</p><p className="mt-1">{error?.message}</p><Button variant="secondary" size="sm" className="mt-3" onClick={() => void run(q, true)}>Try again</Button></div>}
        {state === 'idle' && res && u && (
          <>
            <section aria-label="How we understood your search" className="rounded-xl border border-line bg-surface p-4">
              <p className="flex items-center gap-1.5 text-sm font-bold"><Sparkles className="size-4 text-pine-600" aria-hidden />How we understood your search</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {chips.map((c) => <Badge key={c} tone="pine">{c}</Badge>)}
                {u.keywords.map((k) => <Badge key={k}>“{k}”</Badge>)}
                {!chips.length && !u.keywords.length && <span className="text-sm text-ink-3">No specific filters detected.</span>}
              </div>
              {u.notes.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-ink-3">{u.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
              <p className="mt-2 text-xs text-ink-3">Matching: keywords and synonyms{res.engine.semantic !== 'none' ? ` plus ${res.engine.semantic}` : ''}. {res.engine.ai === 'refined' ? 'AI suggested related terms (it never chooses products).' : res.engine.ai === 'unavailable_fallback' ? 'AI refinement was unavailable, so only our rules were used.' : 'No AI was used for this search.'}</p>
              {u.compare && <p className="mt-2 text-sm text-pine-800">Looks like you want to compare: tick “Compare” on 2 to 4 results below.</p>}
            </section>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-ink-3"><b className="text-ink">{res.total}</b> result{res.total === 1 ? '' : 's'}{res.excluded.tooLate ? ` · ${res.excluded.tooLate} hidden because they cannot arrive in time` : ''}{res.excluded.overBudget ? ` · ${res.excluded.overBudget} over budget` : ''}</p>
              {user ? <Button variant="secondary" size="sm" onClick={() => void save()} loading={saving}><Bookmark className="mr-1.5 size-4" aria-hidden />Save this search</Button> : <Link href="/login?next=/find" className="text-sm font-semibold text-pine-700 underline">Sign in to save searches</Link>}
            </div>
            {res.items.length === 0
              ? <div className="mt-4"><EmptyState icon={<Search className="size-6" />} title="Nothing matched that" body="Try fewer details, a higher budget or a later date. We only show real products in your country, so we will not guess." /></div>
              : <ul className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">{res.items.map((i) => <ResultCard key={i.id} item={i}><TrackPriceButton productId={i.id} price={i.price} currency={i.currency} /></ResultCard>)}</ul>}
            <p className="mt-6 text-xs text-ink-3">{res.disclaimer}</p>
          </>
        )}
        {state === 'idle' && !res && Object.keys(grouped).length > 0 && (
          <div className="space-y-5">
            {Object.entries(grouped).map(([g, list]) => (
              <section key={g} aria-label={GROUPS[g] ?? g}>
                <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-3">{GROUPS[g] ?? g}</h2>
                <div className="flex flex-wrap gap-2">{list.map((p) => <button key={p.id} type="button" onClick={() => { setQ(p.query); void run(p.query); }} className="rounded-full border border-line-strong px-3.5 py-1.5 text-sm text-ink-2 hover:bg-sunken">{p.title} <span className="text-ink-3">({p.count})</span></button>)}</div>
              </section>
            ))}
          </div>
        )}
      </div>
      <CompareTray />
    </div>
  );
}
