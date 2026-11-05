'use client';
import * as React from 'react';
import { Badge, Button, Card, DataTable, EmptyState, Field, Input, Select, Tabs, BarList, LineChart } from '@orvia/ui';
import type { Column, Tone } from '@orvia/ui';
import { ErrorBox, Loading, Panel, RangeSelect, cur, pctf, rangeQs, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

type Prov = 'actual' | 'mixed' | 'estimated' | 'unavailable';
interface Kpi { value: number | null; provenance: Prov; note?: string }
const PROV: Record<Prov, { tone: Tone; label: string }> = { actual: { tone: 'ok', label: 'actual' }, mixed: { tone: 'warn', label: 'mixed' }, estimated: { tone: 'warn', label: 'ESTIMATE' }, unavailable: { tone: 'neutral', label: 'unavailable' } };
const ProvBadge = ({ p }: { p: Prov }) => <Badge tone={PROV[p].tone}>{PROV[p].label}</Badge>;
const num = (n: number | null | undefined, d = 0) => (n === null || n === undefined ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: d }));
const inr = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);
const crore = (n: number) => `₹${(n / 1e7).toFixed(2)} crore`;

function Tile({ label, k, fmt, hint }: { label: string; k: Kpi | undefined; fmt: (n: number) => string; hint?: string }) {
  return (
    <Card className="p-4" data-testid={`kpi-${label}`}>
      <div className="flex items-start justify-between gap-2"><p className="text-xs font-semibold uppercase tracking-wide text-ink-3">{label}</p>{k && <ProvBadge p={k.provenance} />}</div>
      <p className="mt-1 text-2xl font-extrabold tabular-nums">{k && k.value !== null ? fmt(k.value) : '—'}</p>
      {(k?.note || hint) && <p className="mt-1 text-xs text-ink-3">{k?.value === null && k?.provenance === 'unavailable' ? (k.note ?? hint) : (hint ?? k?.note)}</p>}
    </Card>
  );
}

const TABS = [
  { id: 'overview', label: 'Overview' }, { id: 'pnl', label: 'P&L' }, { id: 'ledger', label: 'Ledger' }, { id: 'recon', label: 'Reconciliation' }, { id: 'fx', label: 'FX' },
  { id: 'cash', label: 'Cash flow' }, { id: 'cohorts', label: 'Cohorts / LTV' }, { id: 'pricing', label: 'Costs & price books' }, { id: 'model', label: '₹38 crore model' },
];

export function FinanceConsole() {
  const [tab, setTab] = React.useState('overview');
  return (
    <div>
      <Tabs tabs={TABS} value={tab} onChange={setTab} className="mb-4 overflow-x-auto" />
      {tab === 'overview' && <OverviewTab />}
      {tab === 'pnl' && <PnlTab />}
      {tab === 'ledger' && <LedgerTab />}
      {tab === 'recon' && <ReconTab />}
      {tab === 'fx' && <FxTab />}
      {tab === 'cash' && <CashTab />}
      {tab === 'cohorts' && <CohortsTab />}
      {tab === 'pricing' && <PricingTab />}
      {tab === 'model' && <ModelTab />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
interface OverviewRes {
  currency: string; truncated: boolean; definitions: Record<string, string>;
  fx: { source: string; asOf: string; staleness: string; stale: boolean };
  kpis: unknown;
  pnl: { key: string; label: string; amount: number | null; provenance: Prov; note?: string }[];
}
type KpiBag = Record<string, Kpi>;
const asKpis = (o: OverviewRes) => o.kpis as KpiBag & { orders: number; costKnownOrders: number; costCoverage: number | null; customers: number; newCustomers: number } & { caveats: string[] };

function FxBanner({ fx }: { fx: OverviewRes['fx'] }) {
  return <p className="mb-3 text-xs text-ink-3" role="status">Converted at {fx.source} rates as of {when(fx.asOf)} {fx.stale && <Badge tone="warn">rates {fx.staleness}</Badge>}</p>;
}

function OverviewTab() {
  const [preset, setPreset] = React.useState('30d');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const { data, error, loading, reload } = useFetch<OverviewRes>(`/admin/finance/overview?${rangeQs(preset, from, to)}`);
  const prod = useFetch<{ rows: { key: string; label: string; contributionBeforeAds: number; orders: number }[]; currency: string }>(`/admin/finance/profitability?by=product&${rangeQs(preset, from, to)}`);
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading />;
  const k = asKpis(data);
  const c = data.currency;
  const m = (n: number) => cur(n, c);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3"><RangeSelect value={preset} onChange={setPreset} from={from} to={to} onDates={(f, t) => { setFrom(f); setTo(t); }} />{loading && <span className="text-xs text-ink-3">Refreshing…</span>}</div>
      <FxBanner fx={data.fx} />
      {k.orders === 0 ? <EmptyState title="No paid orders yet" body="Figures appear here once real orders are paid. Nothing on this page is estimated from imaginary sales." /> : (
        <>
          <Card className="p-4 text-sm" role="note"><p className="font-semibold">GMV, net sales, contribution and profit are four different numbers.</p>
            <ul className="mt-1 list-disc pl-5 text-ink-2">{Object.entries(data.definitions).map(([key, v]) => <li key={key}><strong>{key}</strong>: {v}</li>)}</ul></Card>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="GMV" k={k['gmv']} fmt={m} /><Tile label="Net sales" k={k['netSales']} fmt={m} /><Tile label="Gross profit" k={k['grossProfit']} fmt={m} /><Tile label="Contribution" k={k['contribution']} fmt={m} />
            <Tile label="Contribution margin" k={k['contributionMargin']} fmt={(n) => pctf(n)} /><Tile label="Net profit (estimate)" k={k['netProfitEstimate']} fmt={m} /><Tile label="Refund-adjusted revenue" k={k['refundAdjustedRevenue']} fmt={m} /><Tile label="Advertising contribution" k={k['advertisingContribution']} fmt={m} />
            <Tile label="CAC" k={k['cac']} fmt={m} /><Tile label="AOV" k={k['aov']} fmt={m} /><Tile label="Repeat-purchase rate" k={k['repeatPurchaseRate']} fmt={(n) => pctf(n)} /><Tile label="Customer lifetime value" k={k['customerLifetimeValue']} fmt={m} />
            <Tile label="Refund rate" k={k['refundRate']} fmt={(n) => pctf(n)} /><Tile label="Chargeback rate" k={k['chargebackRate']} fmt={(n) => pctf(n, 2)} /><Tile label="Delivery success" k={k['deliverySuccess']} fmt={(n) => pctf(n)} /><Tile label="ROAS" k={k['roas']} fmt={(n) => n.toFixed(2)} />
          </div>
          <p className="text-sm text-ink-2">{num(k.orders)} paid orders · {num(k.customers)} customers ({num(k.newCustomers)} new) · cost known for {num(k.costKnownOrders)} orders ({pctf(k.costCoverage)}).{data.truncated && ' Showing the most recent 5,000 orders only.'}</p>
          {k.caveats.length > 0 && <Card className="p-4 text-sm" role="note"><p className="font-semibold">Read with care</p><ul className="list-disc pl-5 text-ink-2">{k.caveats.map((x) => <li key={x}>{x}</li>)}</ul></Card>}
          <Panel title="Most profitable products" subtitle="Contribution before advertising, cost-known orders only">
            {prod.data ? <BarList rows={prod.data.rows.slice(0, 8).map((r) => ({ label: r.label, value: r.contributionBeforeAds, sub: `${r.orders} orders` }))} format={m} /> : <Loading rows={2} />}
          </Panel>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
interface SettingsRes { settings: Record<string, number | string | null | Record<string, number>> }
const SET_FIELDS: { key: string; label: string; money?: boolean; pct?: boolean; hint?: string }[] = [
  { key: 'monthlyOpex', label: 'Operating expenses per month', money: true, hint: 'ASSUMPTION used for the net profit estimate' },
  { key: 'csCostPerOrder', label: 'Customer-service cost per order', money: true, hint: 'assumption' },
  { key: 'otherVariablePerOrder', label: 'Other variable cost per order', money: true, hint: 'assumption' },
  { key: 'openingCash', label: 'Opening cash (as entered, not from a bank)', money: true },
  { key: 'pspSettlementDaysDefault', label: 'PSP settlement delay (days, default)' },
  { key: 'supplierPaymentTermsDays', label: 'Supplier payment terms (days after order)' },
  { key: 'pspRollingReservePct', label: 'PSP rolling reserve (%)', pct: true },
  { key: 'assumedRefundRate', label: 'Assumed refund rate (%)', pct: true, hint: 'used until measured' },
  { key: 'assumedChargebackRate', label: 'Assumed chargeback rate (%)', pct: true },
  { key: 'costChangeAlertPct', label: 'Cost-change alert threshold (%)', pct: true },
  { key: 'minOrdersForMeasured', label: 'Orders needed before measured data replaces placeholders' },
];

function SettingsForm({ currency }: { currency: string }) {
  const { can } = useAdmin();
  const { data, error, reload } = useFetch<SettingsRes>('/admin/finance/settings');
  const [form, setForm] = React.useState<Record<string, string>>({});
  const { run, busy } = useAction();
  React.useEffect(() => {
    if (!data) return;
    setForm(Object.fromEntries(SET_FIELDS.map((f) => { const v = data.settings[f.key] as number | null; return [f.key, v === null || v === undefined ? '' : String(f.money ? v / 100 : f.pct ? +(v * 100).toFixed(3) : v)]; })));
  }, [data]);
  if (error) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading rows={2} />;
  const writable = can('finance:write');
  const save = () => run('settings', async () => {
    const body: Record<string, number | null> = {};
    for (const f of SET_FIELDS) {
      const raw = form[f.key] ?? '';
      if (raw === '') { if (f.key === 'openingCash') body[f.key] = null; continue; }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${f.label}: enter a non-negative number`);
      body[f.key] = f.money ? Math.round(n * 100) : f.pct ? n / 100 : n;
    }
    await api('/admin/finance/settings', { method: 'PUT', body });
    await reload();
  }, 'Assumptions saved');
  return (
    <Panel title="Finance assumptions" subtitle={`Set by an admin, never measured. Money in ${currency}. Every change is audited.`}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SET_FIELDS.map((f) => <Field key={f.key} label={f.label} hint={f.hint} htmlFor={`s-${f.key}`}><Input id={`s-${f.key}`} inputMode="decimal" value={form[f.key] ?? ''} disabled={!writable} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} /></Field>)}
      </div>
      {writable ? <Button className="mt-3" loading={busy === 'settings'} onClick={() => void save()}>Save assumptions</Button> : <p className="mt-3 text-xs text-ink-3">Read-only: you need finance:write to edit.</p>}
    </Panel>
  );
}

function PnlTab() {
  const [preset, setPreset] = React.useState('30d');
  const [by, setBy] = React.useState('product');
  const { data, error, reload } = useFetch<OverviewRes>(`/admin/finance/overview?preset=${preset}`);
  const prof = useFetch<{ rows: { key: string; label: string; orders: number; netRevenue: number; cost: number; contributionBeforeAds: number; margin: number | null }[]; currency: string; note: string }>(`/admin/finance/profitability?by=${by}&preset=${preset}`);
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading />;
  const c = data.currency;
  const rows = data.pnl;
  const cols: Column<(typeof rows)[number]>[] = [
    { key: 'l', header: 'Line', render: (r) => <span className={['netSales', 'contribution', 'netProfit', 'grossProfit'].includes(r.key) ? 'font-bold' : ''}>{r.label}</span> },
    { key: 'a', header: `Amount (${c})`, align: 'right', render: (r) => (r.amount === null ? '—' : cur(r.amount, c)) },
    { key: 'p', header: 'Basis', render: (r) => <ProvBadge p={r.provenance} /> },
    { key: 'n', header: 'Note', hideBelow: 'md', render: (r) => <span className="text-xs text-ink-3">{r.note ?? ''}</span> },
  ];
  const pcols: Column<NonNullable<typeof prof.data>['rows'][number]>[] = [
    { key: 'k', header: by === 'order' ? 'Order' : by[0]!.toUpperCase() + by.slice(1), render: (r) => r.label },
    { key: 'o', header: 'Orders', align: 'right', render: (r) => r.orders },
    { key: 'r', header: 'Net revenue', align: 'right', render: (r) => cur(r.netRevenue, c) },
    { key: 'c', header: 'Costs', align: 'right', render: (r) => cur(r.cost, c) },
    { key: 'p', header: 'Contribution before ads', align: 'right', render: (r) => cur(r.contributionBeforeAds, c) },
    { key: 'm', header: 'Margin', align: 'right', render: (r) => pctf(r.margin) },
  ];
  return (
    <div className="space-y-4">
      <RangeSelect value={preset} onChange={setPreset} />
      <FxBanner fx={data.fx} />
      <Panel title="Profit and loss" subtitle="From GMV down to an ESTIMATED net profit. Operating expenses are an assumption you set below." pad={false}>
        <DataTable columns={cols} rows={rows} rowKey={(r) => r.key} empty={{ title: 'No paid orders yet' }} />
      </Panel>
      <Panel title="Profitability" subtitle={prof.data?.note} action={<Select aria-label="Group by" value={by} onChange={(e) => setBy(e.target.value)}>{['product', 'supplier', 'country', 'order'].map((v) => <option key={v} value={v}>{v}</option>)}</Select>} pad={false}>
        {prof.error ? <ErrorBox message={prof.error} retry={prof.reload} /> : <DataTable columns={pcols} rows={prof.data?.rows} rowKey={(r) => r.key} loading={prof.loading} empty={{ title: 'No cost-known orders yet', body: 'Profitability needs orders whose supplier order has been placed.' }} dense />}
      </Panel>
      <SettingsForm currency={c} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
interface Entry { _id: string; idempotencyKey: string; kind: string; currency: string; postedAt: string; memo?: string; lines: { account: string; side: 'debit' | 'credit'; amount: number }[]; refs?: { orderId?: string } }
const KINDS = ['order_paid', 'supplier_cost', 'supplier_cost_reversal', 'refund', 'chargeback', 'payment_fee', 'psp_settlement', 'supplier_settlement', 'ad_spend', 'reserve_hold', 'reserve_release', 'adjustment'];
const ACCOUNTS = ['cash', 'psp_receivable', 'psp_reserve', 'revenue_product', 'revenue_shipping', 'discounts', 'refunds', 'chargebacks', 'tax_payable', 'cogs_product', 'shipping_cost', 'duties_cost', 'payment_fees', 'supplier_payable', 'ad_spend', 'other_variable'];

function LedgerTab() {
  const { can } = useAdmin();
  const [page, setPage] = React.useState(1);
  const [kind, setKind] = React.useState('');
  const [account, setAccount] = React.useState('');
  const [orderId, setOrderId] = React.useState('');
  const qs = `page=${page}&pageSize=25${kind ? `&kind=${kind}` : ''}${account ? `&account=${account}` : ''}${/^[a-f0-9]{24}$/i.test(orderId) ? `&orderId=${orderId}` : ''}`;
  const { data, error, loading, reload } = useFetch<{ items: Entry[]; total: number; page: number; pageSize: number }>(`/admin/finance/ledger?${qs}`);
  const bal = useFetch<{ totals: Record<string, Record<string, number>> }>('/admin/finance/ledger/balances');
  const { run, busy } = useAction();
  const exportCsv = () => run('csv', async () => {
    const r = await api<{ filename: string; csv: string }>(`/admin/finance/ledger/export?${qs.replace(/page=\d+&pageSize=\d+&?/, '')}`);
    const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = r.filename; a.click(); URL.revokeObjectURL(url);
  });
  const cols: Column<Entry>[] = [
    { key: 'd', header: 'Posted', render: (e) => when(e.postedAt) },
    { key: 'k', header: 'Kind', render: (e) => <Badge>{e.kind}</Badge> },
    { key: 'l', header: 'Lines', render: (e) => <span className="text-xs">{e.lines.map((l) => `${l.side === 'debit' ? 'Dr' : 'Cr'} ${l.account} ${cur(l.amount, e.currency)}`).join(' · ')}</span> },
    { key: 'm', header: 'Memo', hideBelow: 'lg', render: (e) => <span className="text-xs text-ink-3" title={e.idempotencyKey}>{e.memo}</span> },
  ];
  return (
    <div className="space-y-4">
      <Card className="p-4 text-sm">Append-only double-entry journal. Every entry balances (debits = credits) and carries an idempotency key, so reposting is safe. Corrections are reversal entries, never edits.</Card>
      {bal.data && Object.keys(bal.data.totals).length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Object.entries(bal.data.totals).map(([c, t]) => (
          <Card key={c} className="p-4 text-sm"><p className="text-xs font-semibold uppercase text-ink-3">Ledger totals · {c}</p>
            <dl className="mt-1 grid grid-cols-2 gap-x-2"><dt>Gross sales (ex-tax)</dt><dd className="text-right tabular-nums">{cur(t['grossSales']!, c)}</dd><dt>Net sales</dt><dd className="text-right tabular-nums">{cur(t['netSales']!, c)}</dd><dt>Contribution before ads</dt><dd className="text-right tabular-nums">{cur(t['contributionBeforeAds']!, c)}</dd><dt>Ad spend</dt><dd className="text-right tabular-nums">{cur(t['adSpend']!, c)}</dd></dl></Card>))}</div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Kind" htmlFor="lk"><Select id="lk" value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }}><option value="">All</option>{KINDS.map((k) => <option key={k}>{k}</option>)}</Select></Field>
        <Field label="Account" htmlFor="la"><Select id="la" value={account} onChange={(e) => { setAccount(e.target.value); setPage(1); }}><option value="">All</option>{ACCOUNTS.map((k) => <option key={k}>{k}</option>)}</Select></Field>
        <Field label="Order id" htmlFor="lo"><Input id="lo" value={orderId} placeholder="24-char id" onChange={(e) => { setOrderId(e.target.value.trim()); setPage(1); }} /></Field>
        <Button variant="secondary" loading={busy === 'csv'} onClick={() => void exportCsv()}>Export CSV</Button>
        {can('finance:write') && <>
          <Button variant="secondary" loading={busy === 'sync'} onClick={() => void run('sync', async () => { await api('/admin/finance/ledger/sync', { method: 'POST', body: {} }); await reload(); await bal.reload(); }, 'Ledger synced')}>Sync now</Button>
          <Button variant="secondary" loading={busy === 'bf'} onClick={() => void run('bf', () => api('/admin/finance/ledger/backfill', { method: 'POST', body: {} }), 'Backfill queued (idempotent)')}>Backfill</Button>
        </>}
      </div>
      {error ? <ErrorBox message={error} retry={reload} /> : (
        <Card className="p-0"><DataTable columns={cols} rows={data?.items} rowKey={(e) => e._id} loading={loading} empty={{ title: 'The ledger is empty', body: 'Entries are posted automatically for paid orders, supplier orders, refunds and ad spend. An admin can run Sync now.' }} page={page} pageSize={25} total={data?.total ?? 0} onPage={setPage} dense /></Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
function ReconTab() {
  const { data, error, loading, reload } = useFetch<{ checked: Record<string, number>; matchedOrders: number; findings: { kind: string; orderId?: string; detail: string; severity: string }[]; ranAt: string; note: string }>('/admin/finance/reconciliation');
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading />;
  const cols: Column<(typeof data.findings)[number]>[] = [
    { key: 's', header: 'Severity', render: (f) => <Badge tone={f.severity === 'critical' ? 'coral' : f.severity === 'high' ? 'warn' : 'neutral'}>{f.severity}</Badge> },
    { key: 'k', header: 'Check', render: (f) => f.kind },
    { key: 'd', header: 'Detail', render: (f) => f.detail },
  ];
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">{data.note} Checked {Object.entries(data.checked).map(([k, v]) => `${v} ${k}`).join(', ')}; {data.matchedOrders} order(s) match the ledger exactly. <Button size="sm" variant="secondary" loading={loading} onClick={() => void reload()}>Re-run</Button></p>
      <Card className="p-0"><DataTable columns={cols} rows={data.findings} rowKey={(f) => f.kind + (f.orderId ?? f.detail)} empty={{ title: 'No discrepancies found', body: 'The ledger agrees with orders, refunds and supplier orders in this window.' }} dense /></Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
interface FxRes { provider: string; snapshot: { rates: Record<string, number>; source: string; fetchedAt: string; providerDate: string | null }; ageHours: number; staleness: string; policy: { warnHours: number; hardLimitHours: number; enforceHardLimit: boolean; adminOverride: boolean }; productionSafe: boolean; history: { rates: Record<string, number>; source: string; fetchedAt: string }[] }
function FxTab() {
  const { can } = useAdmin();
  const { data, error, reload } = useFetch<FxRes>('/admin/finance/fx');
  const { run, busy } = useAction();
  const [reason, setReason] = React.useState('');
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading />;
  const tone: Tone = data.staleness === 'fresh' ? 'ok' : data.staleness === 'warn' ? 'warn' : 'coral';
  const w = can('finance:write');
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3"><Badge tone={tone}>{data.staleness}</Badge><span className="text-sm">Provider <strong>{data.provider}</strong> · source <strong>{data.snapshot.source}</strong> · fetched {when(data.snapshot.fetchedAt)} ({data.ageHours}h ago){data.snapshot.providerDate ? ` · provider date ${data.snapshot.providerDate}` : ''}</span></div>
        <p className="mt-2 text-sm text-ink-2">Rates per 1 USD: {Object.entries(data.snapshot.rates).map(([c, r]) => `${c} ${r}`).join(' · ')}</p>
        <p className="mt-1 text-xs text-ink-3">Warn after {data.policy.warnHours}h. {data.policy.enforceHardLimit ? `Production refuses to price new orders from rates older than ${data.policy.hardLimitHours}h${data.policy.adminOverride ? ' (admin override active)' : ''}.` : `Hard limit (${data.policy.hardLimitHours}h) is only enforced in production.`}</p>
        {!data.productionSafe && <p className="mt-2 text-sm text-warn-600" role="alert">These are the static dev/test rates. Production configuration refuses them: set FX_PROVIDER=frankfurter (no key) or exchangerate_api.</p>}
        {w && <div className="mt-3 flex flex-wrap items-end gap-3">
          <Button loading={busy === 'fx'} onClick={() => void run('fx', async () => { await api('/admin/finance/fx/refresh', { method: 'POST', body: { acceptLargeMove: false } }); await reload(); }, 'FX rates refreshed')}>Refresh now</Button>
          <Field label="Override reason (≥10 chars)" htmlFor="fxr"><Input id="fxr" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Button variant="secondary" disabled={reason.trim().length < 10} loading={busy === 'ov'} onClick={() => void run('ov', async () => { await api('/admin/finance/fx/override', { method: 'POST', body: { hours: 6, reason } }); await reload(); }, 'Override granted for 6h')}>Allow expired rates for 6h</Button>
        </div>}
      </Card>
      <Panel title="History" subtitle="Most recent stored rate fetches" pad={false}>
        <DataTable rows={data.history} rowKey={(h) => h.fetchedAt} columns={[{ key: 'a', header: 'Fetched', render: (h) => when(h.fetchedAt) }, { key: 's', header: 'Source', render: (h) => h.source }, { key: 'r', header: 'Rates per USD', render: (h) => Object.entries(h.rates).map(([c, r]) => `${c} ${r}`).join(' · ') }]} empty={{ title: 'No stored rates', body: 'Rates are stored on the first refresh (static dev rates are not stored).' }} dense />
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
interface CashRes {
  currency: string;
  forecast: { weeks: { weekStart: string; inflows: number; supplierPayments: number; refundAndChargebackReserve: number; reserveHeld: number; adSpend: number; opex: number; net: number; closing: number | null }[]; totals: { inflows: number; outflows: number; net: number }; openingCash: number | null; lowestClosing: number | null; basis: string[] };
  position: { ledgerCash: number | null; pspReceivable: number | null; supplierPayable: number | null; openingCash: number | null; note: string };
  assumptions: Record<string, unknown>;
}
function CashTab() {
  const { data, error, reload } = useFetch<CashRes>('/admin/finance/cashflow');
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading />;
  const c = data.currency;
  const f = data.forecast;
  const cols: Column<(typeof f.weeks)[number]>[] = [
    { key: 'w', header: 'Week of', render: (w) => w.weekStart },
    { key: 'i', header: 'PSP settlements in', align: 'right', render: (w) => cur(w.inflows, c) },
    { key: 's', header: 'Supplier payments', align: 'right', render: (w) => cur(-w.supplierPayments, c) },
    { key: 'r', header: 'Refund / chargeback reserve', align: 'right', render: (w) => cur(-w.refundAndChargebackReserve, c) },
    { key: 'a', header: 'Ad spend', align: 'right', render: (w) => cur(-w.adSpend, c) },
    { key: 'o', header: 'Opex (assumed)', align: 'right', render: (w) => cur(-w.opex, c) },
    { key: 'n', header: 'Net', align: 'right', render: (w) => cur(w.net, c) },
    { key: 'c', header: 'Closing', align: 'right', render: (w) => (w.closing === null ? '—' : cur(w.closing, c)) },
  ];
  const withClosing = f.weeks.every((w) => w.closing !== null);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Ledger cash" k={{ value: data.position.ledgerCash, provenance: data.position.ledgerCash === null ? 'unavailable' : 'actual', note: 'No ledger entries yet' }} fmt={(n) => cur(n, c)} />
        <Tile label="PSP receivable" k={{ value: data.position.pspReceivable, provenance: data.position.pspReceivable === null ? 'unavailable' : 'actual', note: 'No ledger entries yet' }} fmt={(n) => cur(n, c)} />
        <Tile label="Supplier payable" k={{ value: data.position.supplierPayable, provenance: data.position.supplierPayable === null ? 'unavailable' : 'actual', note: 'No ledger entries yet' }} fmt={(n) => cur(n, c)} />
        <Tile label="Opening cash (entered)" k={{ value: data.position.openingCash, provenance: data.position.openingCash === null ? 'unavailable' : 'estimated', note: 'Set it in P&L → assumptions' }} fmt={(n) => cur(n, c)} />
      </div>
      <p className="text-xs text-ink-3">{data.position.note}</p>
      {withClosing && f.weeks.length > 1 && <Card className="p-4"><LineChart title="Projected closing cash" labels={f.weeks.map((w) => w.weekStart)} series={[{ id: 'c', label: 'Closing cash', color: 'var(--series-1)', data: f.weeks.map((w) => (w.closing ?? 0) / 100) }]} format={(n) => cur(n * 100, c)} /></Card>}
      <Panel title="8-week forecast" subtitle={f.lowestClosing !== null ? `Lowest projected balance ${cur(f.lowestClosing, c)}` : 'Running balance needs opening cash'} pad={false}><DataTable columns={cols} rows={f.weeks} rowKey={(w) => w.weekStart} dense /></Panel>
      <Card className="p-4 text-sm"><p className="font-semibold">What this is and is not</p><ul className="list-disc pl-5 text-ink-2">{f.basis.map((b) => <li key={b}>{b}</li>)}</ul></Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
interface CohortRes { currency: string; cohorts: { cohort: string; customers: number; retention: number[]; cumulativeNetRevenuePerCustomer: number[]; cumulativeContributionPerCustomer: number[]; cac: number | null; contributionAfterCac: number | null; costCoverage: number }[]; ltv3: { value: number | null; customers: number }; ltv6: { value: number | null; customers: number }; note: string }
function CohortsTab() {
  const { data, error, reload } = useFetch<CohortRes>('/admin/finance/cohorts?months=12');
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading />;
  const c = data.currency;
  const cols: Column<CohortRes['cohorts'][number]>[] = [
    { key: 'c', header: 'Cohort', render: (r) => r.cohort },
    { key: 'n', header: 'Customers', align: 'right', render: (r) => r.customers },
    { key: 'ret', header: 'Active by month', render: (r) => <span className="text-xs tabular-nums">{r.retention.join(' · ')}</span> },
    { key: 'rev', header: 'Net revenue / customer', align: 'right', render: (r) => cur(r.cumulativeNetRevenuePerCustomer.at(-1) ?? 0, c) },
    { key: 'con', header: 'Contribution / customer', align: 'right', render: (r) => cur(r.cumulativeContributionPerCustomer.at(-1) ?? 0, c) },
    { key: 'cac', header: 'CAC', align: 'right', render: (r) => (r.cac === null ? 'unavailable' : cur(r.cac, c)) },
    { key: 'after', header: 'After CAC', align: 'right', render: (r) => (r.contributionAfterCac === null ? '—' : cur(r.contributionAfterCac, c)) },
    { key: 'cov', header: 'Cost coverage', align: 'right', render: (r) => pctf(r.costCoverage, 0) },
  ];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Tile label="Observed LTV, 3 months" k={{ value: data.ltv3.value, provenance: data.ltv3.value === null ? 'unavailable' : 'actual', note: 'Needs enough customers in cohorts at least 3 months old' }} fmt={(n) => cur(n, c)} />
        <Tile label="Observed LTV, 6 months" k={{ value: data.ltv6.value, provenance: data.ltv6.value === null ? 'unavailable' : 'actual', note: 'Needs enough customers in cohorts at least 6 months old' }} fmt={(n) => cur(n, c)} />
      </div>
      <p className="text-xs text-ink-3">{data.note}</p>
      <Card className="p-0"><DataTable columns={cols} rows={data.cohorts} rowKey={(r) => r.cohort} empty={{ title: 'No cohorts yet', body: 'Cohorts appear once customers have paid orders. Low cost coverage means contribution is understated.' }} /></Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
function PricingTab() {
  const [page, setPage] = React.useState(1);
  const [country, setCountry] = React.useState('');
  const alerts = useFetch<{ thresholdPct: number; checked: number; alerts: { key: string; label: string; orderNumber?: string; quoted: number; actual: number; changePct: number; extraCost: number; severity: string }[]; note: string }>('/admin/finance/cost-alerts');
  const books = useFetch<{ rows: { productId: string; title: string; country: string; currency: string | null; enabled: boolean; price: number; landedCost: number | null; expectedMargin: number | null; basis: string }[]; total: number; pageSize: number; note: string }>(`/admin/finance/price-books?page=${page}${country ? `&country=${country}` : ''}`);
  return (
    <div className="space-y-4">
      <Panel title="Supplier cost changes" subtitle={alerts.data ? `Actual landed cost per unit vs the cost the price was based on; alert above ${pctf(alerts.data.thresholdPct, 0)}. ${alerts.data.checked} supplier orders checked.` : undefined} pad={false}>
        {alerts.error ? <ErrorBox message={alerts.error} retry={alerts.reload} /> : <DataTable rows={alerts.data?.alerts} loading={alerts.loading} rowKey={(a) => a.key} empty={{ title: 'No cost increases above the threshold' }} dense columns={[
          { key: 'p', header: 'Product', render: (a) => a.label }, { key: 'o', header: 'Order', hideBelow: 'md', render: (a) => a.orderNumber ?? '' },
          { key: 'q', header: 'Quoted / unit', align: 'right', render: (a) => num(a.quoted / 100, 2) }, { key: 'a', header: 'Actual / unit', align: 'right', render: (a) => num(a.actual / 100, 2) },
          { key: 'c', header: 'Change', align: 'right', render: (a) => <Badge tone={a.severity === 'critical' ? 'coral' : 'warn'}>+{(a.changePct * 100).toFixed(0)}%</Badge> }, { key: 'e', header: 'Extra cost', align: 'right', render: (a) => num(a.extraCost / 100, 2) },
        ]} />}
      </Panel>
      <Panel title="Country price books" subtitle={books.data?.note} action={<Select aria-label="Country" value={country} onChange={(e) => { setCountry(e.target.value); setPage(1); }}><option value="">All countries</option><option>US</option><option>CA</option><option>IN</option></Select>} pad={false}>
        {books.error ? <ErrorBox message={books.error} retry={books.reload} /> : <DataTable rows={books.data?.rows} loading={books.loading} rowKey={(r) => r.productId + r.country} empty={{ title: 'No priced products yet' }} page={page} pageSize={books.data?.pageSize ?? 20} total={books.data?.total ?? 0} onPage={setPage} dense columns={[
          { key: 't', header: 'Product', render: (r) => r.title }, { key: 'c', header: 'Market', render: (r) => <>{r.country}{!r.enabled && <Badge className="ml-1">off</Badge>}</> },
          { key: 'p', header: 'Price', align: 'right', render: (r) => cur(r.price, r.currency ?? 'USD') }, { key: 'l', header: 'Landed cost', align: 'right', render: (r) => (r.landedCost ? cur(r.landedCost, r.currency ?? 'USD') : '—') },
          { key: 'm', header: 'Margin', align: 'right', render: (r) => pctf(r.expectedMargin) }, { key: 'b', header: 'Basis', render: (r) => <Badge tone={r.basis === 'measured' ? 'ok' : 'warn'}>{r.basis}</Badge> },
        ]} />}
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
type Names = 'conservative' | 'base' | 'aggressive';
type A = Record<string, number | string | null>;
interface ScenarioRes {
  verdict: string; reachable: boolean; messages: string[]; ordersRequired: number; ordersPerDay: number; sessionsPerDay: number; gmv: number; netSales: number; contribution: number; adSpendTotal: number; opexTotal: number; netProfit: number; breakEvenOrdersPerMonth: number | null;
  unit: { contributionPerOrder: number; contributionMargin: number | null; breakEvenCac: number | null; netSalesPerOrder: number }; workingCapital: { total: number; supplierFunding: number; adFunding: number; reserveHeld: number; refundBuffer: number };
}
interface ModelRes {
  saved: boolean; measuredApplied: boolean; provenanceNote: string; minOrdersForMeasured: number;
  measured: { orders: number } | null;
  sets: Record<Names, { assumptions: A; provenance: Record<string, string> }>; results: Record<Names, ScenarioRes>;
  sensitivity: Record<'cac' | 'conversion' | 'refundRate', { label: string; contributionPerOrder: number; ordersPerDay: number; netProfit: number; verdict: string }[]>;
}
const FIELDS: { key: string; label: string; pct?: boolean; hint?: string }[] = [
  { key: 'targetAmountInr', label: 'Target (₹)' }, { key: 'horizonMonths', label: 'Horizon (months)' }, { key: 'aov', label: 'AOV charged, incl. tax (₹)' }, { key: 'taxRate', label: 'Tax embedded in AOV (%)', pct: true },
  { key: 'discountRate', label: 'Discounts vs list (%)', pct: true }, { key: 'landedCostPct', label: 'Supplier + shipping + duties, % of net price', pct: true }, { key: 'paymentFeePct', label: 'Payment fee (%)', pct: true }, { key: 'paymentFeeFixed', label: 'Payment fee fixed (₹)' },
  { key: 'refundRate', label: 'Refund rate (%)', pct: true }, { key: 'refundCostRecoveryPct', label: 'Supplier cost recovered on refunds (%)', pct: true }, { key: 'chargebackRate', label: 'Chargeback rate (%)', pct: true },
  { key: 'cac', label: 'CAC per new customer (₹)' }, { key: 'repeatOrderShare', label: 'Orders from repeat customers (%)', pct: true }, { key: 'conversionRate', label: 'Conversion rate (%)', pct: true },
  { key: 'csCostPerOrder', label: 'Customer-service cost / order (₹)' }, { key: 'otherVariablePerOrder', label: 'Other variable / order (₹)' }, { key: 'opexPerMonth', label: 'Operating expenses / month (₹)' },
  { key: 'pspSettlementDays', label: 'PSP settlement delay (days)' }, { key: 'supplierPaymentLeadDays', label: 'Supplier paid N days after order' }, { key: 'adSpendLeadDays', label: 'Ad spend precedes orders by (days)' },
  { key: 'rollingReservePct', label: 'PSP rolling reserve (%)', pct: true }, { key: 'rollingReserveHoldDays', label: 'Reserve hold (days)' },
  { key: 'availableWorkingCapital', label: 'Available working capital (₹, optional)' }, { key: 'maxOrdersPerDay', label: 'Max orders/day capacity (optional)' }, { key: 'maxMonthlyAdSpend', label: 'Max monthly ad spend (₹, optional)' },
];
const VERDICT: Record<string, { tone: Tone; text: string }> = {
  consistent: { tone: 'ok', text: 'Reachable IF these assumptions hold' }, needs_funding: { tone: 'warn', text: 'Needs more working capital' }, exceeds_capacity: { tone: 'warn', text: 'Exceeds stated capacity' },
  loss_making: { tone: 'coral', text: 'Reachable but loss-making' }, not_reachable: { tone: 'coral', text: 'Not reachable: loses money per order' },
};
const disp = (f: (typeof FIELDS)[number], v: number | string | null) => (v === null || v === undefined ? '' : String(f.pct ? +(Number(v) * 100).toFixed(3) : v));

function ModelTab() {
  const { can } = useAdmin();
  const { data, error, reload } = useFetch<ModelRes>('/admin/finance/model');
  const [edit, setEdit] = React.useState<Record<Names, Record<string, string>> | null>(null);
  const { run, busy } = useAction();
  React.useEffect(() => {
    if (!data) return;
    setEdit(Object.fromEntries((['conservative', 'base', 'aggressive'] as Names[]).map((n) => [n, Object.fromEntries(FIELDS.map((f) => [f.key, disp(f, data.sets[n].assumptions[f.key] ?? null)]))])) as Record<Names, Record<string, string>>);
  }, [data]);
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data || !edit) return <Loading />;
  const names: Names[] = ['conservative', 'base', 'aggressive'];
  const writable = can('finance:write');
  const save = () => run('model', async () => {
    const body: Record<string, { assumptions: Record<string, number | string | null> }> = {};
    for (const n of names) {
      const a: Record<string, number | string | null> = {};
      for (const f of FIELDS) {
        const raw = edit[n][f.key] ?? '';
        if (raw === '') { if (['availableWorkingCapital', 'maxOrdersPerDay', 'maxMonthlyAdSpend'].includes(f.key)) { a[f.key] = null; continue; } throw new Error(`${n}: ${f.label} is required`); }
        const v = Number(raw);
        if (!Number.isFinite(v)) throw new Error(`${n}: ${f.label} must be a number`);
        a[f.key] = f.pct ? v / 100 : v;
      }
      a['targetBasis'] = data.sets[n].assumptions['targetBasis'] ?? 'net_sales';
      body[n] = { assumptions: a };
    }
    await api('/admin/finance/model', { method: 'PUT', body });
    await reload();
  }, 'Assumptions saved');
  const prov = (n: Names, k: string) => data.sets[n].provenance[k] ?? 'placeholder';
  return (
    <div className="space-y-4">
      <Card className="p-4 text-sm" role="note">
        <p className="font-semibold">How to read this model</p>
        <p className="text-ink-2">The ₹38 crore target is an input, not a prediction. The model shows what the target would require <em>if</em> the assumptions held and whether that would make money. Values marked <strong>placeholder</strong> are documented starting points, not measurements: replace them with measured data. {data.provenanceNote}</p>
      </Card>
      <div className="grid gap-3 lg:grid-cols-3">
        {names.map((n) => { const r = data.results[n]; const v = VERDICT[r.verdict]!; return (
          <Card key={n} className="p-4" data-testid={`scenario-${n}`}>
            <div className="flex items-center justify-between"><h3 className="font-bold capitalize">{n}</h3><Badge tone={v.tone}>{v.text}</Badge></div>
            <dl className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1 text-sm">
              <dt>Orders required</dt><dd className="text-right tabular-nums">{num(r.ordersRequired)}</dd><dt>Orders / day</dt><dd className="text-right tabular-nums">{num(r.ordersPerDay)}</dd><dt>Sessions / day</dt><dd className="text-right tabular-nums">{num(r.sessionsPerDay)}</dd>
              <dt>GMV (charged)</dt><dd className="text-right tabular-nums">{crore(r.gmv)}</dd><dt>Net sales</dt><dd className="text-right tabular-nums">{crore(r.netSales)}</dd>
              <dt>Contribution / order</dt><dd className="text-right tabular-nums">{inr(r.unit.contributionPerOrder)}</dd><dt>Contribution margin</dt><dd className="text-right tabular-nums">{pctf(r.unit.contributionMargin)}</dd>
              <dt>Break-even CAC</dt><dd className="text-right tabular-nums">{r.unit.breakEvenCac === null ? 'none' : inr(r.unit.breakEvenCac)}</dd>
              <dt>Ad spend (total)</dt><dd className="text-right tabular-nums">{crore(r.adSpendTotal)}</dd><dt>Operating expenses</dt><dd className="text-right tabular-nums">{crore(r.opexTotal)}</dd>
              <dt className="font-semibold">Net profit</dt><dd className="text-right font-semibold tabular-nums">{crore(r.netProfit)}</dd>
              <dt>Break-even orders / month</dt><dd className="text-right tabular-nums">{r.breakEvenOrdersPerMonth === null ? 'never' : num(r.breakEvenOrdersPerMonth)}</dd>
              <dt>Working capital needed</dt><dd className="text-right tabular-nums">{crore(r.workingCapital.total)}</dd>
            </dl>
            <ul className="mt-3 list-disc pl-5 text-xs text-ink-2">{r.messages.map((m) => <li key={m}>{m}</li>)}</ul>
          </Card>); })}
      </div>
      <Panel title="Sensitivity (base case)" subtitle="One input changed at a time" pad={false}>
        <div className="grid gap-0 md:grid-cols-3">{(['cac', 'conversion', 'refundRate'] as const).map((g) => (
          <div key={g} className="overflow-x-auto p-3"><table className="w-full text-sm"><caption className="mb-1 text-left text-xs font-bold uppercase text-ink-3">{g}</caption><tbody>{data.sensitivity[g].map((p) => <tr key={p.label}><td>{p.label}</td><td className="text-right tabular-nums">{inr(p.contributionPerOrder)}/order</td><td className="text-right tabular-nums">{crore(p.netProfit)}</td></tr>)}</tbody></table></div>))}</div>
      </Panel>
      <Panel title="Assumptions" subtitle={data.measured ? `${data.measured.orders} paid orders in the last 90 days (measured values are used from ${data.minOrdersForMeasured}).` : 'No paid orders yet: nothing is measured.'} action={writable ? <Button loading={busy === 'model'} onClick={() => void save()}>Save assumptions</Button> : undefined} pad={false}>
        <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
          <thead className="bg-sunken text-left text-xs text-ink-3"><tr><th className="px-3 py-2">Assumption</th>{names.map((n) => <th key={n} className="px-3 py-2 capitalize">{n}</th>)}</tr></thead>
          <tbody>{FIELDS.map((f) => (
            <tr key={f.key} className="border-t border-line/70"><th scope="row" className="px-3 py-1 text-left font-medium">{f.label}</th>
              {names.map((n) => <td key={n} className="px-3 py-1"><div className="flex items-center gap-2"><Input aria-label={`${f.label} ${n}`} className="h-9 w-28" inputMode="decimal" disabled={!writable} value={edit[n][f.key] ?? ''} onChange={(e) => setEdit({ ...edit, [n]: { ...edit[n], [f.key]: e.target.value } })} />
                <Badge tone={prov(n, f.key) === 'measured' ? 'ok' : prov(n, f.key) === 'admin' ? 'info' : 'warn'}>{prov(n, f.key) === 'placeholder' ? 'placeholder: replace with measured data' : prov(n, f.key)}</Badge></div></td>)}
            </tr>))}</tbody>
        </table></div>
        {!writable && <p className="p-3 text-xs text-ink-3">Read-only: you need finance:write to edit assumptions.</p>}
      </Panel>
    </div>
  );
}
