'use client';
import * as React from 'react';
import { Button, Card, DataTable, StatusBadge } from '@orvia/ui';
import type { Column } from '@orvia/ui';
import { ErrorBox, FilterSelect, PageHeader, Toolbar, cur, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface R { _id: string; orderNumber?: string; email?: string; reason: string; details?: string; status: string; total?: number; currency?: string; createdAt: string }
export default function ReturnsPage() {
  const { can } = useAdmin();
  const [status, setStatus] = React.useState('requested');
  const [page, setPage] = React.useState(1);
  const { data, error, loading, reload } = useFetch<{ items: R[]; total: number }>(`/admin/returns?page=${page}&pageSize=25${status ? `&status=${status}` : ''}`);
  const { run, busy } = useAction();
  const decide = (id: string, decision: string, ok: string) => run(id + decision, async () => { await api(`/admin/returns/${id}/decision`, { body: { decision, note: decision } }); await reload(); }, ok);
  const cols: Column<R>[] = [
    { key: 'o', header: 'Order', render: (r) => <div><b>{r.orderNumber}</b><p className="text-xs text-ink-3">{r.email}</p></div> },
    { key: 'r', header: 'Reason', render: (r) => <div><span className="capitalize">{r.reason.replace(/_/g, ' ')}</span>{r.details && <p className="max-w-56 truncate text-xs text-ink-3" title={r.details}>{r.details}</p>}</div> },
    { key: 't', header: 'Order total', hideBelow: 'md', align: 'right', render: (r) => cur(r.total, r.currency ?? 'USD') },
    { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'd', header: 'Requested', hideBelow: 'md', render: (r) => when(r.createdAt) },
    { key: 'a', header: '', align: 'right', render: (r) => can('returns:write') && ['requested', 'approved'].includes(r.status) && <div className="flex justify-end gap-1.5">{r.status === 'requested' && <Button size="sm" variant="secondary" loading={busy === r._id + 'approve'} onClick={() => void decide(r._id, 'approve', 'Return approved')}>Approve</Button>}<Button size="sm" loading={busy === r._id + 'refund'} onClick={() => void decide(r._id, 'refund', 'Refund issued')}>Refund</Button>{r.status === 'requested' && <Button size="sm" variant="ghost" loading={busy === r._id + 'reject'} onClick={() => void decide(r._id, 'reject', 'Return rejected')}>Reject</Button>}</div> },
  ];
  return (
    <>
      <PageHeader title="Returns" subtitle="Return requests and refunds. High-value refunds by non-admin staff need approval." />
      <Toolbar><FilterSelect label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[['', 'All'], ['requested', 'Requested'], ['approved', 'Approved'], ['refunded', 'Refunded'], ['rejected', 'Rejected']]} /></Toolbar>
      {error && !data && <ErrorBox message={error} retry={reload} />}
      <Card><DataTable columns={cols} rows={data?.items} loading={loading} rowKey={(r) => r._id} page={page} pageSize={25} total={data?.total} onPage={setPage} empty={{ title: 'No returns' }} /></Card>
    </>
  );
}
