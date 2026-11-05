'use client';
import { Bookmark, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Badge, Button, Card, EmptyState, Link, Skeleton, Switch, useToast } from '@orvia/ui';
import { api } from '@/lib/api';
import { useApi } from './account';

interface Saved { id: string; name: string; query: string; country: string; budgetMax: number | null; deliverBy: string | null; alertNewMatches: boolean; lastNotifiedAt: string | null }

export const savedSearchHref = (s: Pick<Saved, 'query' | 'budgetMax' | 'deliverBy'>): string => {
  const p = new URLSearchParams({ q: s.query });
  if (s.budgetMax) p.set('budget', String(s.budgetMax));
  if (s.deliverBy) p.set('by', s.deliverBy);
  return `/find?${p.toString()}`;
};

/** /account/saved-searches */
export function SavedSearchesPanel() {
  const { data, loading, reload } = useApi<{ items: Saved[] }>('/account/saved-searches');
  const toast = useToast();
  const act = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast.success(ok); await reload(); } catch (e) { toast.error((e as Error).message); } };
  if (loading) return <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>;
  if (!data?.items.length) return <EmptyState icon={<Bookmark className="size-6" />} title="No saved searches yet" body="Run a search in Find and choose “Save this search” to come back to it, or get an email when new products match." action={<Button href="/find">Open Find</Button>} />;
  return (
    <ul className="space-y-3">
      {data.items.map((s) => (
        <li key={s.id}><Card className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Link href={savedSearchHref(s)} className="font-semibold hover:underline">{s.name}</Link>
              <p className="mt-0.5 break-words text-sm text-ink-3">“{s.query}”</p>
              <div className="mt-1 flex flex-wrap gap-1.5">{s.budgetMax && <Badge>Budget {s.budgetMax}</Badge>}{s.deliverBy && <Badge>By {s.deliverBy}</Badge>}<Badge>{s.country}</Badge></div>
            </div>
            <button type="button" aria-label={`Delete saved search ${s.name}`} onClick={() => void act(() => api(`/account/saved-searches/${s.id}`, { method: 'DELETE' }), 'Deleted')} className="grid size-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-sunken"><Trash2 className="size-4" /></button>
          </div>
          <div className="mt-3"><Switch label="Email me when new products match (at most once a day)" checked={s.alertNewMatches} onChange={(v) => void act(() => api(`/account/saved-searches/${s.id}`, { method: 'PATCH', body: { alertNewMatches: v } }))} /></div>
        </Card></li>
      ))}
    </ul>
  );
}
