'use client';
import { Flag, Megaphone } from 'lucide-react';
import * as React from 'react';
import { Badge, Button, Card, Skeleton, Textarea, useToast } from '@orvia/ui';
import { api } from '@/lib/api';
import { useStore } from './providers';

/**
 * Landing capture for creator links: `?cr=<handle>` or `?cl=<link code>`.
 * Mount once in the store layout next to <ReferralCapture />. Records a click and attaches first-party, last-touch attribution to the cart.
 * Silent by design: a bad or unknown link must never get in the way of shopping.
 */
export function CreatorCapture() {
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const cr = url.searchParams.get('cr');
    const cl = url.searchParams.get('cl');
    if (!cr && !cl) return;
    url.searchParams.delete('cr');
    url.searchParams.delete('cl');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    const body = cl && /^[A-Za-z0-9]{6,20}$/.test(cl) ? { link: cl, landing: url.pathname } : cr ? { handle: cr.slice(0, 31), landing: url.pathname } : null;
    if (body) void api('/creators/attribution', { body }).catch(() => undefined);
  }, []);
  return null;
}

/** Clear affiliate relationship disclosure (shown above the fold on every creator page). */
export function AffiliateBanner({ text, name }: { text: string; name: string }) {
  return (
    <aside role="note" aria-label="Affiliate disclosure" className="flex items-start gap-3 rounded-lg border border-saffron-500/40 bg-saffron-50 p-4 text-sm text-ink">
      <Megaphone className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p><strong>Paid partnership with {name}. </strong>{text}</p>
    </aside>
  );
}

interface Comment { id: string; displayName: string; body: string; at?: string }

/** Moderated discussion: logged-in customers post under a first-name display name; comments appear after review. */
export function CollectionDiscussion({ collectionId, initial, total }: { collectionId: string; initial: Comment[]; total: number }) {
  const { user } = useStore();
  const toast = useToast();
  const [body, setBody] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ message: string }>(`/creators/collections/${collectionId}/comments`, { body: { body } });
      toast.success(r.message);
      setBody('');
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const report = async (id: string) => {
    try { await api(`/creators/comments/${id}/report`, { body: { reason: 'abuse' } }); toast.success('Thanks, we will review this comment'); } catch (e) { toast.error((e as Error).message); }
  };
  return (
    <section aria-labelledby="disc-h" className="mt-12">
      <h2 id="disc-h" className="font-display text-xl font-semibold">Discussion <span className="text-ink-3">({total})</span></h2>
      <p className="mt-1 text-sm text-ink-3">Comments are reviewed before they appear. Please don’t share personal details or links.</p>
      {initial.length === 0 ? <p className="mt-4 text-sm text-ink-3">No comments yet.</p> : (
        <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
          {initial.map((c) => (
            <li key={c.id} className="flex items-start justify-between gap-3 p-4">
              <div className="min-w-0"><p className="text-sm font-semibold">{c.displayName}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{c.body}</p></div>
              {user && <button onClick={() => void report(c.id)} aria-label={`Report comment by ${c.displayName}`} className="shrink-0 text-ink-3 hover:text-ink"><Flag className="size-4" /></button>}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-5">
        {user ? (
          <div className="space-y-2">
            <Textarea aria-label="Your comment" value={body} maxLength={500} rows={3} onChange={(e) => setBody(e.target.value)} placeholder="Share a thought about these picks" />
            <div className="flex items-center justify-between"><span className="text-xs text-ink-3">{body.length}/500 · posted as {user.name.split(' ')[0]}</span><Button disabled={busy || body.trim().length < 2} loading={busy} onClick={() => void submit()}>Post comment</Button></div>
          </div>
        ) : <p className="text-sm text-ink-3"><a className="font-semibold underline" href="/login?next=/creators">Sign in</a> to join the discussion.</p>}
      </div>
    </section>
  );
}

export function CreatorStatusBadge({ status }: { status: string }) {
  const tone = status === 'approved' ? 'pine' : status === 'pending' ? 'saffron' : status === 'suspended' || status === 'rejected' ? 'coral' : 'neutral';
  return <Badge tone={tone}>{status}</Badge>;
}

export const CardSkeleton = () => <Card className="p-5"><Skeleton className="h-6 w-1/3" /><Skeleton className="mt-3 h-20 w-full" /></Card>;
