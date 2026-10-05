'use client';
import * as React from 'react';
import { Badge, Button, Card, Checkbox, DataTable, Field, Input, Modal, Select, StatusBadge } from '@orvia/ui';
import type { Column } from '@orvia/ui';
import { ErrorBox, PageHeader, Panel, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface P { _id: string; name: string; type: string; code?: string; countries: string[]; percent: number; active: boolean; usedCount: number; usageLimit: number; endsAt?: string }
interface Rec { _id: string; summary: string; payload: { country: string; percent: number } }
const TYPES = ['percentage', 'fixed', 'free_shipping', 'bxgy', 'first_order', 'cart', 'flash_sale', 'seasonal'];

export default function PromotionsPage() {
  const { can } = useAdmin();
  const { data, error, reload } = useFetch<{ items: P[]; recommendations: Rec[] }>('/admin/promotions');
  const { run, busy } = useAction();
  const [open, setOpen] = React.useState(false);
  const [f, setF] = React.useState({ name: '', type: 'percentage', code: '', percent: '10', country: '', minSubtotal: '', buy: '2', get: '1' });
  const cols: Column<P>[] = [
    { key: 'n', header: 'Promotion', render: (r) => <div><b>{r.name}</b><p className="text-xs text-ink-3">{r.type.replace(/_/g, ' ')}{r.code ? ` · code ${r.code}` : ' · automatic'}</p></div> },
    { key: 'c', header: 'Countries', hideBelow: 'md', render: (r) => (r.countries.length ? r.countries.join(', ') : 'All') },
    { key: 'p', header: 'Value', render: (r) => (r.percent ? `${Math.round(r.percent * 100)}%` : '—') },
    { key: 'u', header: 'Used', hideBelow: 'md', align: 'right', render: (r) => `${r.usedCount}${r.usageLimit ? ` / ${r.usageLimit}` : ''}` },
    { key: 'e', header: 'Ends', hideBelow: 'lg', render: (r) => (r.endsAt ? when(r.endsAt) : '—') },
    { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.active ? 'active' : 'paused'} /> },
    { key: 'a', header: '', align: 'right', render: (r) => can('promotions:write') && <Button size="sm" variant="ghost" onClick={() => void run(r._id, async () => { await api(`/admin/promotions/${r._id}`, { method: 'PATCH', body: { active: !r.active } }); await reload(); })}>{r.active ? 'Disable' : 'Enable'}</Button> },
  ];
  const create = () => run('c', async () => {
    const body: Record<string, unknown> = { name: f.name, type: f.type, percent: ['percentage', 'first_order', 'cart', 'flash_sale', 'seasonal'].includes(f.type) ? Number(f.percent) / 100 : 0, countries: f.country ? [f.country] : [] };
    if (f.code) body['code'] = f.code;
    if (f.type === 'bxgy') body['bxgy'] = { buy: Number(f.buy), get: Number(f.get) };
    if (f.minSubtotal) body['minSubtotal'] = Object.fromEntries((f.country ? [f.country] : ['US', 'CA', 'IN']).map((c) => [c, Math.round(Number(f.minSubtotal) * 100)]));
    if (f.type === 'free_shipping' && !f.minSubtotal) body['minSubtotal'] = {};
    await api('/admin/promotions', { body }); setOpen(false); await reload();
  }, 'Promotion created');
  return (
    <>
      <PageHeader title="Promotions" subtitle="Discounts are clamped so an order can never fall below landed cost." actions={can('promotions:write') && <Button onClick={() => setOpen(true)}>New promotion</Button>} />
      {error && !data && <ErrorBox message={error} retry={reload} />}
      {data && data.recommendations.length > 0 && (
        <Panel className="mb-4" title="AI recommendations" subtitle="Awaiting your approval">
          <ul className="space-y-3">{data.recommendations.map((r) => <li key={r._id} className="flex flex-col gap-3 rounded-lg bg-saffron-50 p-4 sm:flex-row sm:items-center sm:justify-between"><p className="text-sm text-ink">{r.summary}</p><div className="flex shrink-0 gap-2"><Button size="sm" loading={busy === r._id} onClick={() => void run(r._id, async () => { await api(`/admin/automation/decisions/${r._id}/approve`, { body: {} }); await reload(); }, 'Promotion created')}>Approve</Button><Button size="sm" variant="ghost" onClick={() => void run(r._id + 'r', async () => { await api(`/admin/automation/decisions/${r._id}/reject`, { body: { reason: 'declined' } }); await reload(); })}>Decline</Button></div></li>)}</ul>
        </Panel>
      )}
      <Card><DataTable columns={cols} rows={data?.items} rowKey={(r) => r._id} empty={{ title: 'No promotions yet' }} /></Card>
      <Modal open={open} onClose={() => setOpen(false)} title="New promotion" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={busy === 'c'} disabled={!f.name} onClick={() => void create()}>Create</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</Select></Field>
          <Field label="Country"><Select value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}><option value="">All</option><option value="US">USA</option><option value="CA">Canada</option><option value="IN">India</option></Select></Field>
          {['percentage', 'first_order', 'cart', 'flash_sale', 'seasonal'].includes(f.type) && <Field label="Discount %" hint="max 50"><Input inputMode="numeric" value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} /></Field>}
          {f.type === 'bxgy' && <><Field label="Buy"><Input value={f.buy} onChange={(e) => setF({ ...f, buy: e.target.value })} /></Field><Field label="Get free"><Input value={f.get} onChange={(e) => setF({ ...f, get: e.target.value })} /></Field></>}
          <Field label="Code (blank = automatic)"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Minimum subtotal (optional)"><Input inputMode="decimal" value={f.minSubtotal} onChange={(e) => setF({ ...f, minSubtotal: e.target.value })} /></Field>
        </div>
        <Checkbox className="mt-3" checked disabled label="Discounts are capped at 50% and never below landed cost" readOnly />
      </Modal>
      <span className="hidden"><Badge>{''}</Badge></span>
    </>
  );
}
