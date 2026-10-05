'use client';
import * as React from 'react';
import { Button, Card, DataTable, StatusBadge } from '@orvia/ui';
import type { Column } from '@orvia/ui';
import { ErrorBox, FilterSelect, PageHeader, Toolbar, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface S { _id: string; orderNumber?: string; country?: string; customer?: string; supplierName?: string; supplierOrderId?: string; status: string; carrier?: string; trackingNumber?: string; estimatedDelivery?: string; lastError?: string; updatedAt: string }
export default function ShippingPage() {
  const { can } = useAdmin();
  const [page, setPage] = React.useState(1);
  const [status, setStatus] = React.useState('');
  const { data, error, loading, reload } = useFetch<{ items: S[]; total: number }>(`/admin/shipping?page=${page}&pageSize=25${status ? `&status=${status}` : ''}`, 60_000);
  const { run, busy } = useAction();
  const cols: Column<S>[] = [
    { key: 'o', header: 'Order', render: (r) => <div><b>{r.orderNumber}</b><p className="text-xs text-ink-3">{r.customer} · {r.country}</p></div> },
    { key: 's', header: 'Supplier', hideBelow: 'md', render: (r) => <div>{r.supplierName}<p className="text-xs text-ink-3">{r.supplierOrderId}</p></div> },
    { key: 'st', header: 'Status', render: (r) => <div><StatusBadge status={r.status} />{r.lastError && <p className="mt-1 max-w-48 truncate text-xs text-coral-500" title={r.lastError}>{r.lastError}</p>}</div> },
    { key: 't', header: 'Tracking', render: (r) => (r.trackingNumber ? <div><code className="text-xs">{r.trackingNumber}</code><p className="text-xs text-ink-3">{r.carrier}</p></div> : <span className="text-ink-3">not issued yet</span>) },
    { key: 'e', header: 'ETA', hideBelow: 'lg', render: (r) => (r.estimatedDelivery ? new Date(r.estimatedDelivery).toLocaleDateString() : '—') },
    { key: 'u', header: 'Updated', hideBelow: 'lg', render: (r) => when(r.updatedAt) },
  ];
  return (
    <>
      <PageHeader title="Shipping" subtitle="Supplier shipments and tracking sync. We only ever show tracking the supplier has actually issued." actions={can('orders:write') && <Button loading={busy === 's'} onClick={() => void run('s', async () => { await api('/admin/shipping/sync', { body: {} }); await reload(); }, 'Tracking synced')}>Sync tracking now</Button>} />
      <Toolbar><FilterSelect label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[['', 'All'], ['CREATED', 'Created'], ['SHIPPED', 'Shipped'], ['IN_TRANSIT', 'In transit'], ['OUT_FOR_DELIVERY', 'Out for delivery'], ['DELIVERED', 'Delivered'], ['FAILED', 'Failed'], ['CANCELLED', 'Cancelled']]} /></Toolbar>
      {error && !data && <ErrorBox message={error} retry={reload} />}
      <Card><DataTable columns={cols} rows={data?.items} loading={loading} rowKey={(r) => r._id} page={page} pageSize={25} total={data?.total} onPage={setPage} /></Card>
    </>
  );
}
