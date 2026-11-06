'use client';
import { Copy, Gift } from 'lucide-react';
import * as React from 'react';
import { Badge, Button, Card, EmptyState, Input, Skeleton, useToast } from '@orvia/ui';
import { api } from '@/lib/api';
import { useApi } from './account';

interface Loyalty {
  status: { enrolled: boolean; points: number; tier: string | null; lifetimePoints: number; trailingSpendUsd: number; nextTier: { name: string; spendRemainingUsd: number } | null; expiringSoon: { points: number; at: string } | null };
  rules: { pointsPerUsd: number; pointsPerUsdValue: number; minRedeemPoints: number; maxRedeemPoints: number; redemptionValidDays: number; pointsExpireDays: number; tiers: { name: string; minSpendUsd: number; multiplier: number }[] };
  activity: { items: { id: string; kind: string; points: number; note: string | null; expiresAt: string | null; at: string }[]; redemptions: { code: string; points: number; valueUsd: number; status: string; expiresAt: string }[] };
}
const usd = (m: number) => `$${(m / 100).toFixed(m % 100 ? 2 : 0)}`;

/** `/account/loyalty`: points balance, tier, activity and redemption. All figures come from the points ledger. */
export function LoyaltyPanel() {
  const { data, loading, reload } = useApi<Loyalty>('/account/loyalty?pageSize=20');
  const toast = useToast();
  const [points, setPoints] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  if (loading) return <Skeleton className="h-64 w-full" />;
  if (!data) return <p className="text-ink-3">Loyalty is unavailable right now. Please try again shortly.</p>;
  const { status: s, rules: r, activity } = data;
  const redeem = async () => {
    setBusy(true);
    try {
      const out = await api<{ code: string; valueUsd: number }>('/account/loyalty/redeem', { body: { points: Number(points) } });
      toast.success(`Your ${usd(out.valueUsd)} code is ${out.code}`); setPoints(''); void reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-6">
      <div><h2 className="font-display text-2xl font-semibold">Loyalty</h2>
        <p className="mt-1 max-w-xl text-ink-3">Earn {r.pointsPerUsd} point per $1 of delivered, net order value (after discounts, refunds, tax and shipping). {r.pointsPerUsdValue} points = $1. Points expire {r.pointsExpireDays} days after they are earned.</p></div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-5"><p className="text-sm text-ink-3">Points</p><p className="mt-1 font-display text-3xl font-semibold" data-testid="loyalty-points">{s.points}</p>{s.expiringSoon && <p className="mt-1 text-xs text-ink-3">{s.expiringSoon.points} expire {new Date(s.expiringSoon.at).toLocaleDateString()}</p>}</Card>
        <Card className="p-5"><p className="text-sm text-ink-3">Tier</p><p className="mt-1 font-display text-3xl font-semibold">{s.tier ?? 'Not started'}</p>{s.nextTier && <p className="mt-1 text-xs text-ink-3">{usd(s.nextTier.spendRemainingUsd)} more spend to {s.nextTier.name}</p>}</Card>
        <Card className="p-5"><p className="text-sm text-ink-3">Spend, last 12 months</p><p className="mt-1 font-display text-3xl font-semibold">{usd(s.trailingSpendUsd)}</p></Card>
      </div>
      <Card className="space-y-3 p-5">
        <h3 className="flex items-center gap-2 font-semibold"><Gift className="size-4" /> Redeem points</h3>
        <p className="text-sm text-ink-3">Get a single-use discount code ({r.minRedeemPoints}–{r.maxRedeemPoints} points, in multiples of 10) valid for {r.redemptionValidDays} days. The code applies to baskets of at least 3× its value, and may be reduced at checkout so an order is never sold below cost. Unused expired codes return your points.</p>
        <div className="flex flex-wrap gap-2"><Input aria-label="Points to redeem" inputMode="numeric" className="w-40" placeholder={`${r.minRedeemPoints}`} value={points} onChange={(e) => setPoints(e.target.value.replace(/\D/g, ''))} /><Button loading={busy} disabled={busy || !points || s.points < r.minRedeemPoints} onClick={() => void redeem()}>Redeem</Button></div>
        {s.points < r.minRedeemPoints && <p className="text-xs text-ink-3">You need at least {r.minRedeemPoints} points to redeem.</p>}
      </Card>
      {activity.redemptions.length > 0 && (
        <div><h3 className="mb-2 font-semibold">Your codes</h3><ul className="divide-y divide-line rounded-lg border border-line">{activity.redemptions.map((c) => (
          <li key={c.code} className="flex items-center justify-between gap-3 px-4 py-3 text-sm"><span className="font-mono font-bold">{c.code}</span><span className="flex items-center gap-2 text-ink-3">{usd(c.valueUsd)} · {c.status === 'active' ? `expires ${new Date(c.expiresAt).toLocaleDateString()}` : ''}<Badge tone={c.status === 'active' ? 'pine' : 'neutral'}>{c.status}</Badge>{c.status === 'active' && <button aria-label="Copy code" onClick={() => void navigator.clipboard.writeText(c.code).then(() => toast.success('Copied'), () => undefined)}><Copy className="size-4" /></button>}</span></li>))}</ul></div>
      )}
      <div><h3 className="mb-2 font-semibold">Activity</h3>
        {activity.items.length === 0 ? <EmptyState title="No activity yet" body="Points appear after an order is delivered and the return window has passed." /> : (
          <ul className="divide-y divide-line rounded-lg border border-line">{activity.items.map((a) => <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm"><span><span className="font-semibold capitalize">{a.kind}</span>{a.note ? ` · ${a.note}` : ''}<span className="block text-xs text-ink-3">{new Date(a.at).toLocaleDateString()}</span></span><span className={a.points < 0 ? 'text-coral-700' : 'text-pine-700'}>{a.points > 0 ? '+' : ''}{a.points}</span></li>)}</ul>
        )}</div>
      <details className="text-sm text-ink-3"><summary className="cursor-pointer font-semibold">Tiers</summary><ul className="mt-2 space-y-1">{r.tiers.map((t) => <li key={t.name}>{t.name}: {usd(t.minSpendUsd)}+ spend per year, {t.multiplier}× points</li>)}</ul></details>
    </div>
  );
}
