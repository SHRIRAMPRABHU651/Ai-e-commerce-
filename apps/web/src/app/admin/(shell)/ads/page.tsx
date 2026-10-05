'use client';
import * as React from 'react';
import { Badge, Button, Card, Field, Input, Switch } from '@orvia/ui';
import { ErrorBox, Loading, PageHeader, Panel, useAction, useAdmin, useFetch, usd } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface Rules { safeMode: boolean; minImpressions: number; minClicks: number; pauseNoPurchaseSpend: number; targetCpa: number; cpaReduceFactor: number; targetRoas: number; scaleStep: number; maxDailyBudget: number; minDailyBudget: number; maxRefundRate: number; negativeProfitMinSpend: number; dailyLimit: number; monthlyLimit: number }
interface S { ads: Rules; modes: { ads: string }; integrations: Record<string, { configured: boolean; mode: string }> }
const MONEY: (keyof Rules)[] = ['pauseNoPurchaseSpend', 'targetCpa', 'maxDailyBudget', 'minDailyBudget', 'negativeProfitMinSpend', 'dailyLimit', 'monthlyLimit'];
const FIELDS: { k: keyof Rules; label: string; hint: string }[] = [
  { k: 'dailyLimit', label: 'Global daily spend limit', hint: 'Sum of all active campaign daily budgets can never exceed this' },
  { k: 'monthlyLimit', label: 'Monthly spend limit', hint: 'Campaigns pause when this month’s spend reaches it' },
  { k: 'maxDailyBudget', label: 'Max daily budget per campaign', hint: 'Scaling never goes above this' },
  { k: 'minDailyBudget', label: 'Min daily budget', hint: 'Reductions never go below this' },
  { k: 'pauseNoPurchaseSpend', label: 'Pause if spend ≥ and 0 purchases', hint: 'Requires the minimum click sample too' },
  { k: 'targetCpa', label: 'Target CPA', hint: 'Above this for the window → reduce budget' },
  { k: 'targetRoas', label: 'Target ROAS', hint: 'At/above (and profitable) → scale within caps' },
  { k: 'scaleStep', label: 'Scale step', hint: 'Fraction; safe mode caps it at 0.2 (+20%/run)' },
  { k: 'cpaReduceFactor', label: 'Reduce factor', hint: 'Budget multiplier when reducing (0.7 = −30%)' },
  { k: 'maxRefundRate', label: 'Max refund rate', hint: 'Above → reduce; above 2× → pause' },
  { k: 'negativeProfitMinSpend', label: 'Negative-profit pause after spend of', hint: 'Avoids pausing on tiny samples' },
  { k: 'minImpressions', label: 'Min impressions for a decision', hint: 'Below this the engine only observes' },
  { k: 'minClicks', label: 'Min clicks for a decision', hint: 'Prevents killing on insufficient data' },
];

export default function AdsPage() {
  const { can } = useAdmin();
  const { data, error, reload } = useFetch<S>('/admin/settings');
  const [v, setV] = React.useState<Record<string, string>>({});
  const { run, busy } = useAction();
  React.useEffect(() => {
    if (!data) return;
    setV(Object.fromEntries(FIELDS.map((f) => [f.k, String(MONEY.includes(f.k) ? (data.ads[f.k] as number) / 100 : data.ads[f.k])])));
  }, [data]);
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading />;
  const save = () => run('save', async () => {
    const body: Record<string, number | boolean> = {};
    for (const f of FIELDS) { const n = Number(v[f.k]); body[f.k] = MONEY.includes(f.k) ? Math.round(n * 100) : n; }
    await api('/admin/settings/ads', { method: 'PUT', body }); await reload();
  }, 'Ad rules saved');
  const platforms = [['meta', 'Meta Ads', 'META_ACCESS_TOKEN, META_AD_ACCOUNT_ID, META_PAGE_ID'], ['tiktok', 'TikTok Ads', 'TIKTOK_ACCESS_TOKEN, TIKTOK_ADVERTISER_ID'], ['google', 'Google Ads', 'GOOGLE_ADS_CLIENT_ID, _CLIENT_SECRET, _REFRESH_TOKEN, _DEVELOPER_TOKEN, _CUSTOMER_ID']];
  const live = (k: string) => data.integrations[k === 'meta' ? 'meta_ads' : k === 'tiktok' ? 'tiktok_ads' : 'google_ads']!;
  return (
    <>
      <PageHeader title="Ads" subtitle="Ad accounts and budget guard-rails. Safe mode is on by default: no campaign can exceed these limits." />
      <div className="grid gap-4 md:grid-cols-3">{platforms.map(([k, name, env]) => { const i = live(k!); return <Panel key={k} title={name} action={<Badge tone={i.configured ? 'ok' : 'neutral'}>{i.configured ? (i.mode === 'mock' ? 'Mock (dev)' : 'Connected') : 'Not connected'}</Badge>}><p className="text-sm text-ink-3">{i.configured ? `Mode: ${i.mode}` : 'Add credentials to connect.'}</p><p className="mt-2 text-xs text-ink-3"><code className="rounded bg-sunken px-1.5 py-0.5">{env}</code></p></Panel>; })}</div>
      <Panel className="mt-4" title="Budget rules" subtitle="Evaluated hourly. In ASSISTED mode changes wait for your approval (Automation → Ad optimization).">
        <div className="mb-5 flex items-center justify-between rounded-lg bg-pine-50 p-4"><div><p className="font-bold text-pine-700">Safe mode</p><p className="text-sm text-ink-2">Stepwise scaling (max +20%) and hard spend caps.</p></div><Switch checked={data.ads.safeMode} disabled={!can('settings:write')} label="Safe mode" onChange={(x) => void run('sm', async () => { await api('/admin/settings/ads', { method: 'PUT', body: { safeMode: x } }); await reload(); })} /></div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{FIELDS.map((f) => <Field key={f.k} label={`${f.label}${MONEY.includes(f.k) ? ' (USD)' : ''}`} hint={f.hint}><Input inputMode="decimal" value={v[f.k] ?? ''} disabled={!can('settings:write')} onChange={(e) => setV({ ...v, [f.k]: e.target.value })} /></Field>)}</div>
        {can('settings:write') && <Button className="mt-5" loading={busy === 'save'} onClick={() => void save()}>Save rules</Button>}
        <p className="mt-3 text-xs text-ink-3">Current exposure: daily limit {usd(data.ads.dailyLimit)}, monthly {usd(data.ads.monthlyLimit)}.</p>
      </Panel>
      <Card className="mt-4 p-5 text-sm text-ink-2"><b>How decisions work:</b> pause on spend with zero purchases or negative contribution profit · reduce when CPA stays above target or refunds rise · scale (≤20%) only when ROAS beats target and the campaign is profitable · never judge samples below the minimums.</Card>
    </>
  );
}
