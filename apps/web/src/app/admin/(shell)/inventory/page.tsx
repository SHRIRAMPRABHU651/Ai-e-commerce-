'use client';
import * as React from 'react';
import { Button, Card, DataTable, StatusBadge } from '@orvia/ui';
import type { Column } from '@orvia/ui';
import { ErrorBox, FilterSelect, PageHeader, Toolbar, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface R { _id: string; productTitle?: string; productState?: string; country: string; available: number; status: string; bestSupplier?: string | null; syncedAt?: string }

export default function InventoryPage() {
  const { can } = useAdmin();
  const [page, setPage] = React.useState(1);
  const [status, setStatus] = React.useState('');
  const [country, setCountry] = React.useState('');
  const { data, error, loading, reload } = useFetch<{ items: R[]; total: number; counts: Record<string, number> }>(`/admin/inventory?page=${page}&pageSize=25${status ? `&status=${status}` : ''}${country ? `&country=${country}` : ''}`, 60_000);
  const { run, busy } = useAction();
  const cols: Column<R>[] = [
    { key: 'p', header: 'Product', render: (r) => <span className="block max-w-72 truncate font-semibold">{r.productTitle}</span> },
    { key: 's', header: 'Listing', hideBelow: 'md', render: (r) => (r.productState ? <StatusBadge status={r.productState} /> : '—') },
    { key: 'c', header: 'Country', render: (r) => r.country },
    { key: 'st', header: 'Stock status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'a', header: 'Available', align: 'right', render: (r) => <b>{r.available}</b> },
    { key: 'b', header: 'Best supplier', hideBelow: 'lg', render: (r) => r.bestSupplier ?? '—' },
    { key: 'y', header: 'Synced', hideBelow: 'lg', render: (r) => when(r.syncedAt) },
  ];
  return (
    <>
      <PageHeader title="Inventory" subtitle="Live supplier stock per country. Unavailable products are hidden automatically and restored when stock returns." actions={can('inventory:write') && <Button loading={busy === 's'} onClick={() => void run('s', async () => { await api('/admin/inventory/sync', { body: {} }); await reload(); }, 'Inventory sync finished')}>Sync now</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">{['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'SUPPLIER_UNAVAILABLE', 'PRICE_CHANGED'].map((k) => <button key={k} onClick={() => { setStatus(status === k ? '' : k); setPage(1); }} className={`rounded-lg border p-4 text-left ${status === k ? 'border-pine-600 bg-pine-50' : 'border-line bg-surface'}`}><StatusBadge status={k} /><p className="mt-2 text-2xl font-bold tabular-nums">{data?.counts[k] ?? 0}</p></button>)}</div>
      <Toolbar><FilterSelect label="Country" value={country} onChange={(v) => { setCountry(v); setPage(1); }} options={[['', 'All countries'], ['US', 'USA'], ['CA', 'Canada'], ['IN', 'India']]} /></Toolbar>
      {error && !data && <ErrorBox message={error} retry={reload} />}
      <Card><DataTable columns={cols} rows={data?.items} loading={loading} rowKey={(r) => r._id} page={page} pageSize={25} total={data?.total} onPage={setPage} /></Card>
    </>
  );
}
