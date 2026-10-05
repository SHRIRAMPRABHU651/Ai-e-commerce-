'use client';
import * as React from 'react';
import { BarList, FunnelChart, LineChart, MetricCard } from '@orvia/ui';
import { ErrorBox, Loading, PageHeader, Panel, RangeSelect, pctf, rangeQs, usd, useFetch } from '@/components/admin/kit';

interface Fin { grossRevenue: number; discounts: number; refunds: number; supplierCost: number; shippingCost: number; duties: number; paymentFees: number; adSpend: number; netRevenue: number; grossProfit: number; contributionProfit: number; netProfitEstimate: number; roas: number; orders: number; customers: number; aov: number; conversionRate: number; sessions: number; refundRate: number; note: string; pendingCostOrders: number }
interface D { financials: Fin; series: { date: string; revenue: number; profit: number; orders: number; adSpend: number }[]; countries: { country: string; name: string; revenue: number; orders: number; profit: number; adSpend: number; roas: number; conversionRate: number; avgDeliveryDays: number | null }[]; countryRecommendation: string; products: { winners: { title: string; profit: number; units: number }[]; losers: { title: string; profit: number; units: number }[] }; funnel: { step: string; count: number }[]; categories: { category: string; revenue: number; units: number }[]; advertising: { spend: number; revenue: number; clicks: number; impressions: number; purchases: number } }

export default function AnalyticsPage() {
  const [preset, setPreset] = React.useState('30d');
  const [from, setFrom] = React.useState(''); const [to, setTo] = React.useState('');
  const { data: d, error, reload } = useFetch<D>(`/admin/analytics?${rangeQs(preset, from, to)}`);
  if (error && !d) return <ErrorBox message={error} retry={reload} />;
  if (!d) return <Loading rows={6} />;
  const f = d.financials;
  const row = (label: string, v: number, strong = false, neg = false) => <tr key={label} className={strong ? 'border-t-2 border-line-strong' : 'border-t border-line'}><td className={`py-2.5 ${strong ? 'font-bold' : 'text-ink-2'}`}>{label}</td><td className={`py-2.5 text-right tabular-nums ${strong ? 'font-bold' : ''} ${v < 0 || neg ? 'text-coral-500' : ''}`}>{neg ? '−' : ''}{usd(Math.abs(v))}</td></tr>;
  return (
    <>
      <PageHeader title="Analytics" subtitle="Revenue, profit tiers, traffic, countries and product performance (USD)." actions={<RangeSelect value={preset} onChange={setPreset} from={from} to={to} onDates={(a, b) => { setFrom(a); setTo(b); }} />} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <MetricCard label="Net revenue" value={usd(f.netRevenue)} /><MetricCard label="Orders" value={String(f.orders)} hint={`${f.customers} customers`} /><MetricCard label="AOV" value={usd(f.aov)} /><MetricCard label="Conversion" value={pctf(f.conversionRate, 2)} hint={`${f.sessions} sessions`} /><MetricCard label="Refund rate" value={pctf(f.refundRate)} deltaGoodWhen="down" /><MetricCard label="ROAS" value={f.roas ? f.roas.toFixed(2) + '×' : '—'} />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_24rem]">
        <Panel title="Revenue and profit" subtitle="Daily"><LineChart title="Daily revenue, contribution profit and ad spend" labels={d.series.map((s) => s.date)} format={(n) => usd(Math.round(n), { compact: true })} series={[{ id: 'r', label: 'Net revenue', color: 'var(--series-1)', data: d.series.map((s) => s.revenue), area: true }, { id: 'p', label: 'Contribution profit', color: 'var(--series-2)', data: d.series.map((s) => s.profit) }]} /></Panel>
        <Panel title="Financial summary" subtitle="Revenue is never called profit">
          <table className="w-full text-sm"><tbody>{row('Gross revenue', f.grossRevenue)}{row('Discounts', f.discounts, false, true)}{row('Refunds', f.refunds, false, true)}{row('Net revenue', f.netRevenue, true)}{row('Supplier cost', f.supplierCost, false, true)}{row('Shipping cost', f.shippingCost, false, true)}{row('Duties', f.duties, false, true)}{row('Gross profit', f.grossProfit, true)}{row('Payment fees', f.paymentFees, false, true)}{row('Advertising', f.adSpend, false, true)}{row('Contribution profit', f.contributionProfit, true)}{row('Estimated net profit', f.netProfitEstimate, true)}</tbody></table>
          <p className="mt-3 text-xs text-ink-3">{f.note}</p>
        </Panel>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Conversion funnel" subtitle="Unique sessions"><FunnelChart steps={d.funnel} /></Panel>
        <Panel title="Revenue by category"><BarList rows={d.categories.map((c) => ({ label: c.category, value: c.revenue, sub: `${c.units} units` }))} format={(n) => usd(n)} /></Panel>
        <Panel title="Country performance" subtitle={d.countryRecommendation}><div className="overflow-x-auto"><table className="w-full min-w-96 text-sm"><thead><tr className="text-left text-xs text-ink-3"><th className="pb-2">Country</th><th className="pb-2 text-right">Revenue</th><th className="pb-2 text-right">Orders</th><th className="pb-2 text-right">Profit</th><th className="pb-2 text-right">ROAS</th><th className="pb-2 text-right">Conv.</th></tr></thead><tbody>{d.countries.map((c) => <tr key={c.country} className="border-t border-line"><td className="py-2.5 font-semibold">{c.name}</td><td className="py-2.5 text-right tabular-nums">{usd(c.revenue)}</td><td className="py-2.5 text-right tabular-nums">{c.orders}</td><td className={`py-2.5 text-right tabular-nums ${c.profit < 0 ? 'text-coral-500' : ''}`}>{usd(c.profit)}</td><td className="py-2.5 text-right tabular-nums">{c.roas ? c.roas.toFixed(2) : '—'}</td><td className="py-2.5 text-right tabular-nums">{pctf(c.conversionRate, 2)}</td></tr>)}</tbody></table></div></Panel>
        <Panel title="Advertising"><dl className="grid grid-cols-2 gap-4 text-sm">{[['Spend', usd(d.advertising.spend)], ['Attributed revenue', usd(d.advertising.revenue)], ['Clicks', d.advertising.clicks.toLocaleString()], ['Impressions', d.advertising.impressions.toLocaleString()], ['Purchases', String(d.advertising.purchases)], ['CTR', pctf(d.advertising.impressions ? d.advertising.clicks / d.advertising.impressions : 0, 2)]].map(([k, v]) => <div key={k}><dt className="text-ink-3">{k}</dt><dd className="text-lg font-bold tabular-nums">{v}</dd></div>)}</dl></Panel>
        <Panel title="Best products" subtitle="Contribution after ad spend"><BarList rows={d.products.winners.map((w) => ({ label: w.title, value: w.profit, sub: `${w.units} sold` }))} format={(n) => usd(n)} color="var(--series-3)" /></Panel>
        <Panel title="Worst products"><BarList rows={d.products.losers.map((w) => ({ label: w.title, value: w.profit, sub: `${w.units} sold` }))} format={(n) => usd(n)} /></Panel>
      </div>
    </>
  );
}
