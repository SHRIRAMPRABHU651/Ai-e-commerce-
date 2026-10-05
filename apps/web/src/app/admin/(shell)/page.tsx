'use client';
import * as React from 'react';
import { AIInsightCard, BarList, Badge, Button, LineChart, Link, MetricCard, StatusBadge } from '@orvia/ui';
import { ErrorBox, Loading, PageHeader, Panel, RangeSelect, delta, pctf, rangeQs, usd, useFetch, when } from '@/components/admin/kit';

interface Fin { grossRevenue: number; netRevenue: number; grossProfit: number; contributionProfit: number; netProfitEstimate: number; adSpend: number; roas: number; conversionRate: number; aov: number; orders: number; customers: number; refundRate: number; note: string; pendingCostOrders: number }
interface Overview {
  current: Fin; previous: Fin; live: Record<string, number>;
  insights: { id: string; severity: 'info' | 'positive' | 'warning' | 'critical'; title: string; detail: string; action?: { label: string; href: string } }[];
  winners: { productId: string; title: string; profit: number; units: number }[]; losers: { productId: string; title: string; profit: number; units: number }[];
  countries: { country: string; name: string; revenue: number; orders: number; profit: number; roas: number; conversionRate: number; avgDeliveryDays: number | null }[]; countryRecommendation: string;
  suppliers: { id: string; name: string; apiStatus: string; reliability: number; failRate: number; ordersTotal: number; lastSyncAt: string | null }[];
  series: { date: string; revenue: number; profit: number; orders: number; adSpend: number }[];
  exceptions: { _id: string; kind: string; priority: string; issue: string; createdAt: string }[]; pendingDecisions: number;
  automations: { key: string; name: string; mode: string; successRate: number | null }[];
}
interface Brief { items: { date: string; narrative: string; data: { recommendedActions: string[] } }[] }

export default function OverviewPage() {
  const [preset, setPreset] = React.useState('7d');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const { data: d, error, loading, reload } = useFetch<Overview>(`/admin/overview?${rangeQs(preset, from, to)}`, 60_000);
  const brief = useFetch<Brief>('/admin/brief');
  if (error && !d) return <ErrorBox message={error} retry={reload} />;
  if (!d) return <Loading rows={6} />;
  const c = d.current, p = d.previous;
  const sp = (k: 'revenue' | 'profit' | 'orders' | 'adSpend') => d.series.map((s) => s[k]);
  const live = d.live;
  return (
    <>
      <PageHeader title="Overview" subtitle="Revenue, profit and what needs attention — at a glance." actions={<RangeSelect value={preset} onChange={setPreset} from={from} to={to} onDates={(f, t) => { setFrom(f); setTo(t); }} />} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <MetricCard label="Net revenue" value={usd(c.netRevenue, { compact: true })} delta={delta(c.netRevenue, p.netRevenue)} hint="vs prev." spark={sp('revenue')} />
        <MetricCard label="Contribution profit" value={usd(c.contributionProfit, { compact: true })} delta={delta(c.contributionProfit, p.contributionProfit)} hint="after ads" spark={sp('profit')} tone={c.contributionProfit < 0 ? 'warn' : 'default'} />
        <MetricCard label="Orders" value={String(c.orders)} delta={delta(c.orders, p.orders)} hint={`${c.customers} customers`} spark={sp('orders')} />
        <MetricCard label="Ad spend" value={usd(c.adSpend, { compact: true })} delta={delta(c.adSpend, p.adSpend)} deltaGoodWhen="down" spark={sp('adSpend')} />
        <MetricCard label="ROAS" value={c.roas ? c.roas.toFixed(2) + '×' : '—'} delta={c.roas && p.roas ? delta(c.roas, p.roas) : null} hint="net rev ÷ ads" />
        <MetricCard label="Conversion" value={pctf(c.conversionRate, 2)} delta={delta(c.conversionRate, p.conversionRate)} />
        <MetricCard label="Avg. order value" value={usd(c.aov)} delta={delta(c.aov, p.aov)} hint={`refund ${pctf(c.refundRate)}`} />
      </div>
      <p className="mt-2 text-xs text-ink-3">Revenue is never profit: gross profit ({usd(c.grossProfit)}) and contribution profit ({usd(c.contributionProfit)}) subtract supplier cost, shipping, fees, refunds and ad spend. {c.note}</p>

      <div className="mt-5 grid gap-4 xl:grid-cols-[1fr_20rem]">
        <Panel title="Revenue vs. contribution profit" subtitle="Daily, USD"><LineChart title="Revenue and contribution profit by day" labels={d.series.map((s) => s.date)} format={(n) => usd(Math.round(n), { compact: true })} series={[{ id: 'rev', label: 'Net revenue', color: 'var(--series-1)', data: d.series.map((s) => s.revenue), area: true }, { id: 'pro', label: 'Contribution profit', color: 'var(--series-2)', data: d.series.map((s) => s.profit) }]} /></Panel>
        <Panel title="Live" subtitle="Right now">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            {[['Active visitors', live['activeVisitors']], ['Orders awaiting payment', live['currentOrders']], ['Pending supplier orders', live['pendingSupplierOrders']], ['Shipping issues', live['shippingIssues']], ['Low / out of stock', live['lowStockProducts']], ['Failed payments (24h)', live['failedPayments']], ['Failed supplier orders', live['failedSupplierOrders']], ['Ad alerts', live['adAlerts']]].map(([k, v]) => (
              <div key={k as string}><dt className="text-ink-3">{k}</dt><dd className={`text-xl font-bold tabular-nums ${Number(v) > 0 && !String(k).startsWith('Active') && !String(k).startsWith('Orders') ? 'text-coral-500' : ''}`}>{v ?? 0}</dd></div>
            ))}
          </dl>
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Panel title="Winning products" subtitle="30-day contribution"><BarList rows={d.winners.map((w) => ({ label: w.title, value: w.profit, sub: `${w.units} sold` }))} format={(n) => usd(n)} color="var(--series-3)" /></Panel>
        <Panel title="Losing products" subtitle="30-day contribution"><BarList rows={d.losers.map((w) => ({ label: w.title, value: w.profit, sub: `${w.units} sold` }))} format={(n) => usd(n)} /></Panel>
        <Panel title="Country performance" subtitle="30 days" action={<Link href="/admin/countries" className="text-xs font-bold text-pine-700">Details →</Link>}>
          <ul className="space-y-3">{d.countries.map((k) => <li key={k.country} className="flex items-center justify-between gap-3 text-sm"><span className="font-semibold">{k.name}</span><span className="text-right tabular-nums"><b>{usd(k.revenue, { compact: true })}</b> <span className="text-ink-3">· {k.orders} orders · profit <span className={k.profit < 0 ? 'text-coral-500' : ''}>{usd(k.profit, { compact: true })}</span></span></span></li>)}</ul>
          <p className="mt-4 rounded-md bg-sunken p-3 text-xs text-ink-2">{d.countryRecommendation}</p>
        </Panel>
        <Panel title="Supplier health" action={<Link href="/admin/suppliers" className="text-xs font-bold text-pine-700">Manage →</Link>}>
          <ul className="space-y-3">{d.suppliers.map((s) => <li key={s.id} className="flex items-center justify-between gap-2 text-sm"><span className="min-w-0 truncate font-semibold">{s.name}</span><span className="flex shrink-0 items-center gap-2"><span className="text-xs text-ink-3">rel. {s.reliability}</span><StatusBadge status={s.apiStatus} /></span></li>)}</ul>
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Panel title="AI recommendations" subtitle="Computed from your data" action={d.pendingDecisions > 0 ? <Link href="/admin/automation" className="text-xs font-bold text-saffron-700">{d.pendingDecisions} awaiting approval →</Link> : undefined}>
          <div className="space-y-3">{d.insights.map((i) => <AIInsightCard key={i.id} severity={i.severity} title={i.title} detail={i.detail} action={i.action} />)}</div>
        </Panel>
        <Panel title="Exceptions" subtitle="Zero-touch by default, human when needed" action={<Link href="/admin/exceptions" className="text-xs font-bold text-pine-700">All →</Link>}>
          {d.exceptions.length === 0 ? <p className="py-6 text-center text-sm text-ink-3">Nothing needs attention 🎉</p> : <ul className="divide-y divide-line">{d.exceptions.map((e) => <li key={e._id} className="py-3 first:pt-0"><div className="flex items-center gap-2"><StatusBadge status={e.priority} /><Badge>{e.kind.replace(/_/g, ' ').toLowerCase()}</Badge></div><p className="mt-1.5 text-sm">{e.issue}</p><p className="text-xs text-ink-3">{when(e.createdAt)}</p></li>)}</ul>}
        </Panel>
        <Panel title="Automation status" action={<Link href="/admin/automation" className="text-xs font-bold text-pine-700">Control →</Link>}>
          <ul className="divide-y divide-line">{d.automations.map((a) => <li key={a.key} className="flex items-center justify-between gap-3 py-2.5 text-sm first:pt-0"><span className="font-semibold">{a.name}</span><span className="flex items-center gap-2"><span className="text-xs text-ink-3">{a.successRate === null ? '' : `${Math.round(a.successRate * 100)}%`}</span><StatusBadge status={a.mode} /></span></li>)}</ul>
        </Panel>
      </div>

      <Panel className="mt-4" title="Daily brief" subtitle="Generated from database figures" action={<Button size="sm" variant="secondary" onClick={async () => { await fetch('/api/v1/admin/brief/generate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'orvia' }, body: '{}' }); void brief.reload(); }}>Regenerate</Button>}>
        {brief.data?.items[0] ? <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-2">{brief.data.items[0].narrative}</pre> : <p className="text-sm text-ink-3">No brief yet. It is generated every morning by the AI Reports automation.</p>}
      </Panel>
    </>
  );
}
