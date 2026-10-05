'use client';
import * as React from 'react';
import { Badge, Button, Card, DataTable, Drawer, StatusBadge, Textarea } from '@orvia/ui';
import type { Column } from '@orvia/ui';
import { ErrorBox, FilterSelect, Loading, PageHeader, Toolbar, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface T { _id: string; email?: string; subject?: string; status: string; priority: string; updatedAt: string; messages: { from: string; text: string; at: string }[] }
export default function SupportPage() {
  const { can } = useAdmin();
  const [status, setStatus] = React.useState('escalated');
  const [page, setPage] = React.useState(1);
  const [sel, setSel] = React.useState<string | null>(null);
  const [text, setText] = React.useState('');
  const { data, error, loading, reload } = useFetch<{ items: T[]; total: number }>(`/admin/support/tickets?page=${page}&pageSize=20${status ? `&status=${status}` : ''}`, 60_000);
  const det = useFetch<{ ticket: T; order: { orderNumber: string; status: string } | null }>(sel ? `/admin/support/tickets/${sel}` : null);
  const { run, busy } = useAction();
  const cols: Column<T>[] = [
    { key: 's', header: 'Subject', render: (r) => <div><b className="block max-w-72 truncate">{r.subject}</b><p className="text-xs text-ink-3">{r.email ?? 'anonymous'}</p></div> },
    { key: 'p', header: 'Priority', hideBelow: 'md', render: (r) => <StatusBadge status={r.priority === 'normal' ? 'low' : r.priority} label={r.priority} /> },
    { key: 'st', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'm', header: 'Messages', hideBelow: 'md', align: 'right', render: (r) => r.messages.length },
    { key: 'u', header: 'Updated', hideBelow: 'lg', render: (r) => when(r.updatedAt) },
  ];
  return (
    <>
      <PageHeader title="Support" subtitle="The AI assistant answers from orders, shipments and products. Anything it can’t resolve is escalated here." />
      <Toolbar><FilterSelect label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[['', 'All'], ['escalated', 'Escalated'], ['open', 'Open'], ['pending', 'Awaiting customer'], ['resolved', 'Resolved']]} /></Toolbar>
      {error && !data && <ErrorBox message={error} retry={reload} />}
      <Card><DataTable columns={cols} rows={data?.items} loading={loading} rowKey={(r) => r._id} onRowClick={(r) => setSel(r._id)} page={page} pageSize={20} total={data?.total} onPage={setPage} empty={{ title: 'No tickets' }} /></Card>
      <Drawer open={!!sel} onClose={() => setSel(null)} title={det.data?.ticket.subject ?? 'Ticket'} width="sm:max-w-xl" footer={can('support:write') && det.data ? <div className="space-y-2"><Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply to the customer (sent by email)" aria-label="Reply" /><div className="flex gap-2"><Button loading={busy === 'r'} disabled={text.length < 2 || !det.data.ticket.email} onClick={() => void run('r', async () => { await api(`/admin/support/tickets/${sel}/reply`, { body: { text, resolve: false } }); setText(''); await det.reload(); await reload(); }, 'Reply sent')}>Send</Button><Button variant="secondary" loading={busy === 'x'} disabled={text.length < 2 || !det.data.ticket.email} onClick={() => void run('x', async () => { await api(`/admin/support/tickets/${sel}/reply`, { body: { text, resolve: true } }); setText(''); setSel(null); await reload(); }, 'Sent and resolved')}>Send & resolve</Button></div></div> : undefined}>
        {!det.data ? <div className="p-5"><Loading /></div> : <div className="space-y-3 p-5">{det.data.order && <p className="text-sm"><Badge>{det.data.order.orderNumber}</Badge> <StatusBadge status={det.data.order.status} /></p>}{det.data.ticket.messages.map((m, i) => <div key={i} className={`max-w-[90%] rounded-2xl px-4 py-2.5 text-sm ${m.from === 'customer' ? 'bg-sunken' : m.from === 'ai' ? 'ml-auto bg-info-50' : 'ml-auto bg-pine-50'}`}><p className="mb-0.5 text-[11px] font-bold uppercase text-ink-3">{m.from}</p><p className="whitespace-pre-line">{m.text}</p></div>)}</div>}
      </Drawer>
    </>
  );
}
