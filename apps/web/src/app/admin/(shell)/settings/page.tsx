'use client';
import * as React from 'react';
import { Badge, Button, Card, Field, Input, Select } from '@orvia/ui';
import { ErrorBox, Loading, PageHeader, Panel, useAction, useAdmin, useFetch, usd } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface S { pricing: { minMarginPct: number; maxDiscountPct: number; minSellingPrice: Record<string, number>; targetProfitPerOrder: Record<string, number>; targetRoas: number; defaultStrategy: string; targetMarginPct: number; baseRefundRate: number; assumedAdCostPct: number; minPriceChangePct: number }; ops: { lowStockThreshold: number; supplierPriceSpikePct: number; fraudHighScore: number; fraudMediumScore: number; highValueOrderUsd: number; fulfillmentMaxAttempts: number }; automation: { autoRefundLimitUsd: number }; integrations: Record<string, { configured: boolean; mode: string }>; environment: string; modes: Record<string, string> }
const INTEG: Record<string, [string, string]> = { gemini: ['Gemini AI', 'GEMINI_API_KEY'], stripe: ['Stripe', 'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET'], razorpay: ['Razorpay', 'RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET'], cj_dropshipping: ['CJ Dropshipping', 'CJ_API_KEY'], meta_ads: ['Meta Ads', 'META_ACCESS_TOKEN, META_AD_ACCOUNT_ID, META_PAGE_ID'], tiktok_ads: ['TikTok Ads', 'TIKTOK_ACCESS_TOKEN, TIKTOK_ADVERTISER_ID'], google_ads: ['Google Ads', 'GOOGLE_ADS_*'], email: ['Email (Resend)', 'EMAIL_PROVIDER_KEY'], sms: ['SMS / WhatsApp (Twilio)', 'TWILIO_*'], s3: ['AWS S3', 'S3_BUCKET, AWS_*'], redis: ['Redis', 'REDIS_URL'] };

export default function SettingsPage() {
  const { can } = useAdmin();
  const { data, error, reload } = useFetch<S>('/admin/settings');
  const { run, busy } = useAction();
  const [p, setP] = React.useState<Record<string, string>>({});
  const [o, setO] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (!data) return;
    setP({ minMarginPct: String(data.pricing.minMarginPct * 100), maxDiscountPct: String(data.pricing.maxDiscountPct * 100), targetMarginPct: String(data.pricing.targetMarginPct * 100), targetRoas: String(data.pricing.targetRoas), minUSD: String(data.pricing.minSellingPrice['USD']! / 100), profitUSD: String(data.pricing.targetProfitPerOrder['USD']! / 100), strategy: data.pricing.defaultStrategy });
    setO({ lowStockThreshold: String(data.ops.lowStockThreshold), supplierPriceSpikePct: String(data.ops.supplierPriceSpikePct * 100), fraudHighScore: String(data.ops.fraudHighScore), highValueOrderUsd: String(data.ops.highValueOrderUsd / 100), fulfillmentMaxAttempts: String(data.ops.fulfillmentMaxAttempts) });
  }, [data]);
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading />;
  const w = can('settings:write');
  const savePricing = () => run('p', async () => {
    const rate = (c: string) => ({ USD: 1, CAD: 1.37, INR: 84 })[c]!;
    await api('/admin/settings/pricing', { method: 'PUT', body: { minMarginPct: Number(p['minMarginPct']) / 100, maxDiscountPct: Number(p['maxDiscountPct']) / 100, targetMarginPct: Number(p['targetMarginPct']) / 100, targetRoas: Number(p['targetRoas']), defaultStrategy: p['strategy'],
      minSellingPrice: { USD: Math.round(Number(p['minUSD']) * 100), CAD: Math.round(Number(p['minUSD']) * 100 * rate('CAD')), INR: Math.round(Number(p['minUSD']) * 100 * rate('INR')) },
      targetProfitPerOrder: { USD: Math.round(Number(p['profitUSD']) * 100), CAD: Math.round(Number(p['profitUSD']) * 100 * rate('CAD')), INR: Math.round(Number(p['profitUSD']) * 100 * rate('INR')) } } });
    await reload();
  }, 'Pricing guardrails saved');
  const saveOps = () => run('o', async () => { await api('/admin/settings/ops', { method: 'PUT', body: { lowStockThreshold: Number(o['lowStockThreshold']), supplierPriceSpikePct: Number(o['supplierPriceSpikePct']) / 100, fraudHighScore: Number(o['fraudHighScore']), highValueOrderUsd: Math.round(Number(o['highValueOrderUsd']) * 100), fulfillmentMaxAttempts: Number(o['fulfillmentMaxAttempts']) } }); await reload(); }, 'Operational thresholds saved');
  const F = (k: string, label: string, hint?: string, st = p, set = setP) => <Field label={label} hint={hint}><Input inputMode="decimal" disabled={!w} value={st[k] ?? ''} onChange={(e) => set({ ...st, [k]: e.target.value })} /></Field>;
  return (
    <>
      <PageHeader title="Settings" subtitle="Pricing guardrails, operational thresholds and integration status. Secrets are never shown here." actions={<><Badge>{data.environment}</Badge></>} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Pricing guardrails" subtitle="No automated price can violate these">
          <div className="grid gap-4 sm:grid-cols-2">{F('minMarginPct', 'Minimum margin %', 'Contribution margin floor')}{F('maxDiscountPct', 'Maximum discount %', 'Largest single price drop')}{F('targetMarginPct', 'Default target margin %')}{F('targetRoas', 'Target ROAS')}{F('minUSD', 'Minimum selling price (USD)', 'CAD/INR converted at the configured FX')}{F('profitUSD', 'Target profit / order (USD)')}
            <Field label="Default strategy"><Select disabled={!w} value={p['strategy'] ?? ''} onChange={(e) => setP({ ...p, strategy: e.target.value })}>{['cost_plus', 'target_margin', 'competitor_based', 'dynamic_demand', 'ai_optimized'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</Select></Field></div>
          {w && <Button className="mt-5" loading={busy === 'p'} onClick={() => void savePricing()}>Save pricing</Button>}
        </Panel>
        <Panel title="Operations" subtitle="Fraud, inventory and fulfilment thresholds">
          <div className="grid gap-4 sm:grid-cols-2">{F('lowStockThreshold', 'Low-stock threshold (units)', undefined, o, setO)}{F('supplierPriceSpikePct', 'Supplier price-spike alert %', undefined, o, setO)}{F('fraudHighScore', 'High fraud risk score (0–100)', 'Orders at/above are held for review', o, setO)}{F('highValueOrderUsd', 'High-value order (USD)', undefined, o, setO)}{F('fulfillmentMaxAttempts', 'Fulfilment retry attempts', 'Then it becomes an exception', o, setO)}<Field label="Auto-approve refunds up to (USD)" hint="Higher refunds by non-admins need approval"><Input disabled value={usd(data.automation.autoRefundLimitUsd)} /></Field></div>
          {w && <Button className="mt-5" loading={busy === 'o'} onClick={() => void saveOps()}>Save thresholds</Button>}
        </Panel>
      </div>
      <Panel className="mt-4" title="Provider modes" subtitle="Mock providers are refused in production">
        <div className="flex flex-wrap gap-2">{Object.entries(data.modes).map(([k, v]) => <Badge key={k} tone={v === 'mock' || v === 'log' ? 'warn' : 'ok'}>{k}: {v}</Badge>)}</div>
      </Panel>
      <Panel className="mt-4" title="Integrations" subtitle="Add credentials as environment variables / AWS Secrets Manager entries, then redeploy.">
        <ul className="divide-y divide-line">{Object.entries(data.integrations).map(([k, v]) => <li key={k} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0"><div><p className="text-sm font-bold">{INTEG[k]?.[0] ?? k}</p><p className="text-xs text-ink-3"><code>{INTEG[k]?.[1]}</code></p></div><Badge tone={v.configured ? 'ok' : 'neutral'}>{v.configured ? `Configured · ${v.mode}` : 'Not configured'}</Badge></li>)}</ul>
      </Panel>
      <Card className="mt-4 p-4 text-sm text-ink-3">Automation modes are managed in <a className="font-bold text-pine-700" href="/admin/automation">Automation</a>; ad budget rules in <a className="font-bold text-pine-700" href="/admin/ads">Ads</a>; country tax and shipping in <a className="font-bold text-pine-700" href="/admin/countries">Countries</a>.</Card>
    </>
  );
}
