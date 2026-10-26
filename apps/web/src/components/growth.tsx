'use client';
import { Copy, Gift, Share2 } from 'lucide-react';
import * as React from 'react';
import { Badge, Button, Card, Skeleton, useToast } from '@orvia/ui';
import { api } from '@/lib/api';
import { useApi } from './account';
import { useStore } from './providers';

interface ReferralSummary {
  code: string; link: string; friendPercent: number; rewardPercent: number; friendsOrdered: number; rewardsEarned: number; notRewarded: number;
  rewards: { code: string; status: 'available' | 'used' | 'expired'; expiresAt?: string }[];
}

async function share(url: string, title: string, text: string): Promise<'shared' | 'copied' | 'failed'> {
  try {
    if (typeof navigator.share === 'function') { await navigator.share({ url, title, text }); return 'shared'; }
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch (e) {
    return (e as Error).name === 'AbortError' ? 'shared' : 'failed'; // closing the share sheet is not an error
  }
}

/** Landing from a friend's link (?ref=CODE): attach their discount to the cart, tell the shopper, and clean the URL. */
export function ReferralCapture() {
  const toast = useToast();
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const ref = url.searchParams.get('ref');
    if (!ref) return;
    url.searchParams.delete('ref');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    api<{ valid: boolean; applied: boolean; percent?: number }>('/referrals/claim', { body: { code: ref } })
      .then((r) => { if (r.valid && r.applied) toast.success(`A friend sent you ${Math.round((r.percent ?? 0) * 100)}% off your first order. It’s applied at checkout.`); })
      .catch(() => undefined); // a bad link must never get in the way of shopping
  }, [toast]);
  return null;
}

/** Share a product. Signed-in shoppers share with their referral code so a friend’s first order earns them a thank-you. */
export function ShareButton({ path, title }: { path: string; title: string }) {
  const toast = useToast();
  const { user } = useStore();
  const onClick = async () => {
    let url = `${window.location.origin}${path}`;
    if (user) {
      const r = await api<ReferralSummary>('/account/referrals').catch(() => null);
      if (r) url += `?ref=${encodeURIComponent(r.code)}`;
    }
    const out = await share(url, title, `${title} on Orvia`);
    if (out === 'copied') toast.success('Link copied');
    else if (out === 'failed') toast.error('Could not share. Copy the link from your address bar instead.');
  };
  return <button onClick={() => void onClick()} aria-label={`Share ${title}`} className="grid size-12 place-items-center rounded-md border border-line-strong hover:bg-sunken"><Share2 className="size-5" /></button>;
}

export function ReferralPanel() {
  const { data, loading } = useApi<ReferralSummary>('/account/referrals');
  const toast = useToast();
  if (loading) return <Skeleton className="h-64 w-full" />;
  if (!data) return <p className="text-ink-3">Referrals are unavailable right now.</p>;
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-2xl font-semibold">Invite a friend</h2>
        <p className="mt-1 max-w-xl text-ink-3">Your friend gets {pct(data.friendPercent)} off their first order. Once it has been delivered and not refunded, you get a one-time {pct(data.rewardPercent)} code. One reward per friend, and only for new customers.</p>
      </div>
      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-3">Your link</p>
          <p className="mt-1 truncate font-mono text-sm" data-testid="referral-link">{data.link}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" onClick={async () => { const o = await share(data.link, 'Orvia', `Get ${pct(data.friendPercent)} off your first Orvia order`); if (o === 'copied') toast.success('Link copied'); }}><Share2 className="size-4" /> Share</Button>
          <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(data.link).then(() => toast.success('Link copied'), () => toast.error('Could not copy'))}><Copy className="size-4" /> Copy</Button>
        </div>
      </Card>
      <div className="grid gap-3 sm:grid-cols-2">
        <Card className="p-5"><p className="text-sm text-ink-3">Friends who ordered</p><p className="mt-1 font-display text-3xl font-semibold">{data.friendsOrdered}</p></Card>
        <Card className="p-5"><p className="text-sm text-ink-3">Rewards earned</p><p className="mt-1 font-display text-3xl font-semibold">{data.rewardsEarned}</p></Card>
      </div>
      <div>
        <h3 className="mb-2 flex items-center gap-2 font-semibold"><Gift className="size-4" /> Your reward codes</h3>
        {data.rewards.length === 0 ? <p className="text-sm text-ink-3">No rewards yet. They appear after a friend’s order is delivered.</p> : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {data.rewards.map((r) => (
              <li key={r.code} className="flex items-center justify-between gap-3 px-4 py-3 text-sm"><span className="font-mono font-bold">{r.code}</span><span className="flex items-center gap-2 text-ink-3">{r.expiresAt && r.status === 'available' && `expires ${new Date(r.expiresAt).toLocaleDateString()}`}<Badge tone={r.status === 'available' ? 'pine' : 'neutral'}>{r.status}</Badge></span></li>
            ))}
          </ul>
        )}
        {data.notRewarded > 0 && <p className="mt-2 text-xs text-ink-3">{data.notRewarded} invited order{data.notRewarded === 1 ? '' : 's'} did not qualify (for example, your own orders or orders under review).</p>}
      </div>
    </div>
  );
}
