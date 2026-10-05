'use client';
import * as React from 'react';
import { Badge, Button, Card, DataTable, StatusBadge } from '@orvia/ui';
import type { Column } from '@orvia/ui';
import { ErrorBox, FilterSelect, PageHeader, Panel, Toolbar, cur, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface P { _id: string; orderNumber?: string; email?: string; provider: string; intentId: string; amount: number; currency: string; status: string; failureReason?: string; createdAt: string }
export default function PaymentsPage() {
  const { can } = useAdmin();
  const [page, setPage] = React.useState(1);
  const [status, setStatus] = React.useState('');
  const { data, error, loading, reload } = useFetch<{ items: P[]; total: number; mode: string; providers: Record<string, { configured: boolean }>; pendingRefunds: { _id: string; amount: number; currency: string; reason: string; status: string }[] }>(`/admin/payments?page=${page}&pageSize=25${status ? `&status=${status}` : ''}`);
  const { run, busy } = useAction();
  const cols: Column<P>[] = [
    { key: 'o', header: 'Order', render: (r) => <div><b>{r.orderNumber}</b><p className="text-xs text-ink-3">{r.email}</p></div> },
    { key: 'p', header: 'Provider', hideBelow: 'md', render: (r) => <Badge>{r.provider}</Badge> },
    { key: 'i', header: 'Intent', hideBelow: 'lg', render: (r) => <code className="text-xs">{r.intentId.slice(0, 22)}</code> },
    { key: 'a', header: 'Amount', align: 'right', render: (r) => <b>{cur(r.amount, r.currency)}</b> },
    { key: 's', header: 'Status', render: (r) => <div><StatusBadge status={r.status} />{r.failureReason && <p className="text-xs text-coral-500">{r.failureReason}</p>}</div> },
    { key: 'd', header: 'Created', hideBelow: 'md', render: (r) => when(r.createdAt) },
  ];
  return (
    <>
      <PageHeader title="Payments" subtitle="Payment state comes only from provider-verified webhooks — never from the browser." actions={<Badge tone={data?.mode === 'mock' ? 'warn' : 'ok'}>{data?.mode === 'mock' ? 'Mock provider (dev only)' : 'Live'}</Badge>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2">{data && Object.entries(data.providers).map(([k, v]) => <Card key={k} className="flex items-center justify-between p-4"><span className="font-semibold capitalize">{k}</span><Badge tone={v.configured ? 'ok' : 'neutral'}>{v.configured ? 'Credentials set' : 'Not configured'}</Badge></Card>)}</div>
      {data && data.pendingRefunds.length > 0 && <Panel className="mb-4" title="Refunds needing attention"><ul className="divide-y divide-line text-sm">{data.pendingRefunds.map((r) => <li key={r._id} className="flex items-center justify-between gap-3 py-2.5"><span><b>{cur(r.amount, r.currency)}</b> · {r.reason} <StatusBadge status={r.status} /></span>{r.status === 'pending_approval' && can('refunds:approve') && <Button size="sm" loading={busy === r._id} onClick={() => void run(r._id, async () => { await api(`/admin/refunds/${r._id}/approve`, { body: {} }); await reload(); }, 'Refund approved')}>Approve</Button>}</li>)}</ul></Panel>}
      <Toolbar><FilterSelect label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[['', 'All statuses'], ['succeeded', 'Succeeded'], ['pending', 'Pending'], ['failed', 'Failed'], ['refunded', 'Refunded'], ['partially_refunded', 'Partially refunded']]} /></Toolbar>
      {error && !data && <ErrorBox message={error} retry={reload} />}
      <Card><DataTable columns={cols} rows={data?.items} loading={loading} rowKey={(r) => r._id} page={page} pageSize={25} total={data?.total} onPage={setPage} /></Card>
    </>
  );
}
