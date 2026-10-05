'use client';
import * as React from 'react';
import { Badge, Button, Card, Field, Input, Switch, Textarea } from '@orvia/ui';
import { ErrorBox, Loading, PageHeader, Panel, cur, pctf, useAction, useAdmin, useFetch, usd } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface Cfg { code: string; name: string; currency: string; enabled: boolean; taxInclusive: boolean; defaultTaxRate: number; regionTaxRates: Record<string, number>; paymentProviders: string[]; paymentMethods: string[]; returnWindowDays: number; legalNotice: string; fxPerUsd: number; duty: { deMinimis: number; rate: number }; shippingMethods: { code: string; label: string; fee: number; freeOver: number | null; minDays: number; maxDays: number }[] }
interface D { configs: Cfg[]; analytics: { countries: { country: string; revenue: number; orders: number; profit: number; adSpend: number; roas: number; conversionRate: number; avgDeliveryDays: number | null; profitPerOrder: number }[]; recommendation: string } }

export default function CountriesPage() {
  const { can } = useAdmin();
  const { data, error, reload } = useFetch<D>('/admin/countries');
  const { run, busy } = useAction();
  const [edit, setEdit] = React.useState<Record<string, { legalNotice: string; returnWindowDays: string; defaultTaxRate: string }>>({});
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading rows={4} />;
  return (
    <>
      <PageHeader title="Countries" subtitle="Per-market currency, tax, duties, shipping, payment methods and performance. Add more markets by extending the country config." />
      <Panel className="mb-4" title="Where to expand" subtitle="30 days, computed from your orders and ad data"><p className="text-sm text-ink-2">{data.analytics.recommendation}</p></Panel>
      <div className="grid gap-4 xl:grid-cols-3">
        {data.configs.map((c) => {
          const a = data.analytics.countries.find((x) => x.country === c.code);
          const e = edit[c.code] ?? { legalNotice: c.legalNotice, returnWindowDays: String(c.returnWindowDays), defaultTaxRate: String(c.defaultTaxRate * 100) };
          return (
            <Card key={c.code} className="flex flex-col p-5">
              <div className="flex items-center justify-between"><div><h2 className="text-lg font-bold">{c.name}</h2><p className="text-sm text-ink-3">{c.currency} · FX {c.fxPerUsd}/USD · payments: {c.paymentProviders.join(', ')}</p></div><Switch checked={c.enabled} disabled={!can('countries:write')} label={`${c.name} enabled`} onChange={(v) => void run(c.code, async () => { await api(`/admin/countries/${c.code}`, { method: 'PUT', body: { enabled: v } }); await reload(); })} /></div>
              <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">{[['Revenue', usd(a?.revenue ?? 0, { compact: true })], ['Orders', String(a?.orders ?? 0)], ['Profit', usd(a?.profit ?? 0, { compact: true })], ['ROAS', a?.roas ? a.roas.toFixed(2) : '—'], ['Conversion', pctf(a?.conversionRate, 2)], ['Avg delivery', a?.avgDeliveryDays ? `${a.avgDeliveryDays}d` : '—']].map(([k, v]) => <div key={k}><dt className="text-xs text-ink-3">{k}</dt><dd className="font-bold tabular-nums">{v}</dd></div>)}</dl>
              <div className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm"><p><b>Tax:</b> {c.taxInclusive ? 'inclusive' : 'added at checkout'} · default {pctf(c.defaultTaxRate)}{Object.keys(c.regionTaxRates).length ? ` · ${Object.keys(c.regionTaxRates).length} regional rates` : ''}</p><p><b>Duties (est.):</b> {pctf(c.duty.rate, 0)} above {cur(c.duty.deMinimis, c.currency)} on cross-border shipments</p>{c.shippingMethods.map((m) => <p key={m.code}><b>{m.label}:</b> {cur(m.fee, c.currency)}{m.freeOver ? `, free over ${cur(m.freeOver, c.currency)}` : ''} · {m.minDays}–{m.maxDays} days</p>)}<p className="flex flex-wrap gap-1.5 pt-1">{c.paymentMethods.map((m) => <Badge key={m}>{m.replace(/_/g, ' ')}</Badge>)}</p></div>
              {can('countries:write') && (
                <div className="mt-4 space-y-3 border-t border-line pt-4">
                  <div className="grid grid-cols-2 gap-3"><Field label="Return window (days)"><Input value={e.returnWindowDays} onChange={(x) => setEdit({ ...edit, [c.code]: { ...e, returnWindowDays: x.target.value } })} /></Field><Field label="Default tax %"><Input value={e.defaultTaxRate} onChange={(x) => setEdit({ ...edit, [c.code]: { ...e, defaultTaxRate: x.target.value } })} /></Field></div>
                  <Field label="Legal notice shown to customers"><Textarea value={e.legalNotice} onChange={(x) => setEdit({ ...edit, [c.code]: { ...e, legalNotice: x.target.value } })} /></Field>
                  <Button size="sm" loading={busy === c.code + 's'} onClick={() => void run(c.code + 's', async () => { await api(`/admin/countries/${c.code}`, { method: 'PUT', body: { legalNotice: e.legalNotice, returnWindowDays: Number(e.returnWindowDays), defaultTaxRate: Number(e.defaultTaxRate) / 100 } }); await reload(); }, 'Saved')}>Save</Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-ink-3">Tax tables and duty rules are estimates for display and margin planning — use a tax service (Stripe Tax, TaxJar) and your customs broker for filings.</p>
    </>
  );
}
