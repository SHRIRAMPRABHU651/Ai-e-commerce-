'use client';
import * as React from 'react';
import { Badge, Card, DataTable, Drawer, StatusBadge } from '@orvia/ui';
import type { Column } from '@orvia/ui';
import { ErrorBox, Loading, PageHeader, SearchBox, Toolbar, usd, useFetch, when, cur } from '@/components/admin/kit';

interface C { _id: string; email: string; name?: string; country?: string; ordersCount: number; lifetimeValue: number; lastOrderAt?: string; marketingConsent: boolean }

export default function CustomersPage() {
  const [page, setPage] = React.useState(1);
  const [q, setQ] = React.useState('');
  const [sel, setSel] = React.useState<string | null>(null);
  const { data, error, loading, reload } = useFetch<{ items: C[]; total: number }>(`/admin/customers?page=${page}&pageSize=25${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const det = useFetch<{ customer: C; orders: { _id: string; orderNumber: string; status: string; amounts: { total: number }; currency: string; createdAt: string }[] }>(sel ? `/admin/customers/${sel}` : null);
  const cols: Column<C>[] = [
    { key: 'n', header: 'Customer', render: (r) => <div><b>{r.name ?? '—'}</b><p className="text-xs text-ink-3">{r.email}</p></div> },
    { key: 'c', header: 'Country', hideBelow: 'md', render: (r) => r.country ?? '—' },
    { key: 'o', header: 'Orders', align: 'right', render: (r) => r.ordersCount },
    { key: 'l', header: 'Lifetime value', align: 'right', render: (r) => <b>{usd(r.lifetimeValue)}</b> },
    { key: 'm', header: 'Marketing', hideBelow: 'lg', render: (r) => (r.marketingConsent ? <Badge tone="ok">Opted in</Badge> : <Badge>No consent</Badge>) },
    { key: 'd', header: 'Last order', hideBelow: 'md', render: (r) => when(r.lastOrderAt) },
  ];
  return (
    <>
      <PageHeader title="Customers" subtitle="Lifetime value is shown in each order’s own currency summed as stored — use Analytics for converted USD figures." />
      <Toolbar><SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Name or email" /></Toolbar>
      {error && !data && <ErrorBox message={error} retry={reload} />}
      <Card><DataTable columns={cols} rows={data?.items} loading={loading} rowKey={(r) => r._id} onRowClick={(r) => setSel(r._id)} page={page} pageSize={25} total={data?.total} onPage={setPage} /></Card>
      <Drawer open={!!sel} onClose={() => setSel(null)} title="Customer">
        {!det.data ? <div className="p-5"><Loading /></div> : <div className="space-y-4 p-5"><div><p className="text-lg font-bold">{det.data.customer.name}</p><p className="text-sm text-ink-3">{det.data.customer.email}</p></div><h3 className="text-sm font-bold">Orders</h3><ul className="divide-y divide-line">{det.data.orders.map((o) => <li key={o._id} className="flex items-center justify-between py-2.5 text-sm"><span><b>{o.orderNumber}</b> <span className="text-ink-3">{when(o.createdAt)}</span></span><span className="flex items-center gap-2"><b className="tabular-nums">{cur(o.amounts.total, o.currency)}</b><StatusBadge status={o.status} /></span></li>)}</ul></div>}
      </Drawer>
      <span className="hidden">{String(!!reload)}</span>
    </>
  );
}
