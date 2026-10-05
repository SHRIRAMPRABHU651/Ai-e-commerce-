'use client';
import * as React from 'react';
import { Badge, Button, Card, DataTable, Field, Input, Modal, Select, StatusBadge } from '@orvia/ui';
import type { Column } from '@orvia/ui';
import { ErrorBox, PageHeader, Panel, pctf, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface S { id: string; code: string; name: string; provider: string; country: string | null; rating: number; reliability: number; returnPolicyDays: number; active: boolean; apiStatus: string; apiStatusMessage: string | null; lastSyncAt: string | null; ordersTotal: number; failRate: number; lateRate: number; offers: number; offersAvailable: number }

export default function SuppliersPage() {
  const { can } = useAdmin();
  const { data, error, loading, reload } = useFetch<{ items: S[]; adapters: { provider: string; label: string; requiresCredentials: string[]; configured: boolean; usable: boolean; note: string }[] }>('/admin/suppliers', 60_000);
  const { run, busy } = useAction();
  const [add, setAdd] = React.useState(false);
  const [f, setF] = React.useState({ code: '', name: '', provider: 'cj', country: '', returnPolicyDays: 14 });
  const cols: Column<S>[] = [
    { key: 'n', header: 'Supplier', render: (r) => <div><b>{r.name}</b><p className="text-xs text-ink-3">{r.code} · {r.provider}</p></div> },
    { key: 'c', header: 'Warehouse', hideBelow: 'md', render: (r) => r.country ?? 'varies' },
    { key: 'api', header: 'API', render: (r) => <div><StatusBadge status={r.apiStatus} />{r.apiStatusMessage && <p className="mt-1 max-w-48 truncate text-xs text-ink-3" title={r.apiStatusMessage}>{r.apiStatusMessage}</p>}</div> },
    { key: 'o', header: 'Offers', hideBelow: 'md', align: 'right', render: (r) => `${r.offersAvailable}/${r.offers}` },
    { key: 'rel', header: 'Reliability', align: 'right', render: (r) => <b>{r.reliability}</b> },
    { key: 'rt', header: 'Rating', hideBelow: 'lg', align: 'right', render: (r) => r.rating.toFixed(1) },
    { key: 'f', header: 'Fail / late', hideBelow: 'lg', align: 'right', render: (r) => `${pctf(r.failRate, 0)} / ${pctf(r.lateRate, 0)}` },
    { key: 'rp', header: 'Returns', hideBelow: 'lg', align: 'right', render: (r) => `${r.returnPolicyDays}d` },
    { key: 'ls', header: 'Last sync', hideBelow: 'lg', render: (r) => when(r.lastSyncAt) },
    { key: 'a', header: '', align: 'right', render: (r) => <div className="flex justify-end gap-1.5">{can('suppliers:write') && <Button size="sm" variant="secondary" loading={busy === r.id} onClick={(e) => { e.stopPropagation(); void run(r.id, async () => { await api(`/admin/suppliers/${r.id}/check`, { body: {} }); await reload(); }, 'Health check complete'); }}>Check</Button>}{can('suppliers:write') && <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void run(r.id + 'a', async () => { await api(`/admin/suppliers/${r.id}`, { method: 'PATCH', body: { active: !r.active } }); await reload(); }); }}>{r.active ? 'Disable' : 'Enable'}</Button>}</div> },
  ];
  return (
    <>
      <PageHeader title="Suppliers" subtitle="API health, reliability measured from real shipments, and the adapters you can connect." actions={can('suppliers:write') ? <Button onClick={() => setAdd(true)}>Add supplier</Button> : undefined} />
      {error && !data && <ErrorBox message={error} retry={reload} />}
      <Card><DataTable columns={cols} rows={data?.items} loading={loading} rowKey={(r) => r.id} /></Card>
      <h2 className="mb-3 mt-8 text-lg font-bold">Supplier adapters</h2>
      <div className="grid gap-3 md:grid-cols-2">{data?.adapters.map((a) => (
        <Panel key={a.provider} title={a.label} action={<Badge tone={a.usable ? 'ok' : 'neutral'}>{a.usable ? 'Ready' : 'Needs credentials'}</Badge>}><p className="text-sm text-ink-2">{a.note}</p>{a.requiresCredentials.length > 0 && <p className="mt-2 text-xs text-ink-3">Environment: {a.requiresCredentials.map((c) => <code key={c} className="mr-1 rounded bg-sunken px-1.5 py-0.5">{c}</code>)}</p>}</Panel>
      ))}</div>
      <Modal open={add} onClose={() => setAdd(false)} title="Add supplier" size="sm" footer={<><Button variant="secondary" onClick={() => setAdd(false)}>Cancel</Button><Button loading={busy === 'add'} disabled={!f.code || !f.name} onClick={() => void run('add', async () => { await api('/admin/suppliers', { body: { ...f, country: f.country || undefined } }); setAdd(false); await reload(); }, 'Supplier added — run a health check')}>Add</Button></>}>
        <div className="space-y-3">
          <Field label="Code" hint="lowercase letters, digits, dashes"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Adapter"><Select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>{data?.adapters.map((a) => <option key={a.provider} value={a.provider}>{a.label}</option>)}</Select></Field>
          <Field label="Primary warehouse country"><Select value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}><option value="">Varies / other</option><option value="US">USA</option><option value="CA">Canada</option><option value="IN">India</option></Select></Field>
        </div>
      </Modal>
    </>
  );
}
