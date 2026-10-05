'use client';
import * as React from 'react';
import { Badge, Card, DataTable } from '@orvia/ui';
import type { Column } from '@orvia/ui';
import { ErrorBox, FilterSelect, PageHeader, SearchBox, Toolbar, useFetch, when } from '@/components/admin/kit';

interface L { _id: string; timestamp: string; actor: string; actorType: string; action: string; resource?: string; resourceId?: string; previousValue?: unknown; newValue?: unknown; reason?: string; aiSummary?: string; provider?: string; requestId?: string }
const j = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

export default function AuditPage() {
  const [page, setPage] = React.useState(1);
  const [action, setAction] = React.useState('');
  const [type, setType] = React.useState('');
  const { data, error, loading, reload } = useFetch<{ items: L[]; total: number }>(`/admin/audit?page=${page}&pageSize=30${action ? `&action=${encodeURIComponent(action)}` : ''}${type ? `&actorType=${type}` : ''}`);
  const [open, setOpen] = React.useState<string | null>(null);
  const cols: Column<L>[] = [
    { key: 't', header: 'When', render: (r) => <span className="whitespace-nowrap text-xs">{when(r.timestamp)}</span> },
    { key: 'a', header: 'Actor', render: (r) => <div><b className="text-sm">{r.actor}</b><p><Badge tone={r.actorType === 'ai' ? 'info' : r.actorType === 'user' ? 'pine' : 'neutral'}>{r.actorType}</Badge></p></div> },
    { key: 'ac', header: 'Action', render: (r) => <code className="text-xs">{r.action}</code> },
    { key: 'r', header: 'Resource', hideBelow: 'md', render: (r) => <span className="text-xs text-ink-3">{r.resource}{r.resourceId ? ` · ${r.resourceId.slice(-8)}` : ''}</span> },
    { key: 'd', header: 'Detail', render: (r) => <div className="max-w-md text-xs"><p className="text-ink-2">{r.aiSummary ?? r.reason}</p>{open === r._id && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-sunken p-2">{[r.previousValue !== undefined && `before: ${j(r.previousValue)}`, r.newValue !== undefined && `after: ${j(r.newValue)}`, r.provider && `provider: ${r.provider}`, r.requestId && `request: ${r.requestId}`].filter(Boolean).join('\n')}</pre>}</div> },
  ];
  return (
    <>
      <PageHeader title="Audit logs" subtitle="Append-only record of every important manual and automated action: actor, before/after, reason, AI summary, provider and request id." />
      <Toolbar><SearchBox value={action} onChange={(v) => { setAction(v); setPage(1); }} placeholder="Action prefix, e.g. order." /><FilterSelect label="Actor type" value={type} onChange={(v) => { setType(v); setPage(1); }} options={[['', 'All actors'], ['user', 'Staff'], ['ai', 'AI agents'], ['system', 'System'], ['webhook', 'Webhooks']]} /></Toolbar>
      {error && !data && <ErrorBox message={error} retry={reload} />}
      <Card><DataTable columns={cols} rows={data?.items} loading={loading} rowKey={(r) => r._id} onRowClick={(r) => setOpen(open === r._id ? null : r._id)} page={page} pageSize={30} total={data?.total} onPage={setPage} /></Card>
    </>
  );
}
