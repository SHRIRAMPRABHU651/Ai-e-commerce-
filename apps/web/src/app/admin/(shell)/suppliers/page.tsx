'use client';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import * as React from 'react';
import { Badge, Button, Card, Checkbox, DataTable, Field, Input, Modal, Select, StatusBadge, Textarea } from '@orvia/ui';
import type { Column } from '@orvia/ui';
import { ErrorBox, PageHeader, Panel, pctf, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface S {
  id: string; code: string; name: string; provider: string; country: string | null; rating: number; reliability: number; returnPolicyDays: number; active: boolean; apiStatus: string;
  apiStatusMessage: string | null; lastSyncAt: string | null; ordersTotal: number; failRate: number; lateRate: number; offers: number; offersAvailable: number;
  servesCountries: string[]; priority: number; credentialsSet: boolean; mappingSet: boolean;
}
interface Data {
  items: S[];
  adapters: { provider: string; label: string; requiresCredentials: string[]; configured: boolean; usable: boolean; note: string }[];
  coverage: { country: string; name: string; suppliers: string[] }[];
}
const COUNTRIES = [['US', 'USA'], ['CA', 'Canada'], ['IN', 'India']] as const;
const REST_TEMPLATE = JSON.stringify({
  baseUrl: 'https://api.your-supplier.com/v1', auth: { type: 'bearer' }, currency: 'USD', warehouseCountry: 'US',
  endpoints: {
    search: { path: '/products', query: { q: '{query}', page: '{page}' } },
    product: { path: '/products/{id}', data: 'data' },
    quote: { path: '/products/{id}/quote', query: { country: '{country}', qty: '{qty}' }, data: 'data' },
    createOrder: { method: 'POST', path: '/orders', data: 'data', body: { reference: '{idempotencyKey}', sku: '{sku}', quantity: '{qty}', ship_to: { name: '{address.fullName}', line1: '{address.line1}', city: '{address.city}', postal_code: '{address.postalCode}', country: '{address.country}' } } },
    order: { path: '/orders/{id}', data: 'data' },
  },
  fields: { list: 'data.items', id: 'id', title: 'name', description: 'description', images: ['images'], price: 'price', quoteShipping: 'shipping.cost', quoteMinDays: 'shipping.min_days', quoteMaxDays: 'shipping.max_days', stock: 'stock', trackingNumber: 'tracking.number', carrier: 'tracking.carrier' },
}, null, 2);

const blank = { id: '', code: '', name: '', provider: 'rest', country: '', servesCountries: [] as string[], priority: 100, returnPolicyDays: 14, apiKey: '', apiSecret: '', config: '' };

export default function SuppliersPage() {
  const { can } = useAdmin();
  const { data, error, loading, reload } = useFetch<Data>('/admin/suppliers', 60_000);
  const { run, busy } = useAction();
  const [form, setForm] = React.useState<typeof blank | null>(null);
  const editing = !!form?.id;
  const toggleCountry = (c: string) => form && setForm({ ...form, servesCountries: form.servesCountries.includes(c) ? form.servesCountries.filter((x) => x !== c) : [...form.servesCountries, c] });

  const save = () => run('save', async () => {
    if (!form) return;
    let config: unknown;
    if (form.config.trim()) {
      try { config = JSON.parse(form.config); } catch { throw new Error('The API mapping is not valid JSON'); }
    }
    const credentials = form.apiKey ? { apiKey: form.apiKey, ...(form.apiSecret ? { apiSecret: form.apiSecret } : {}) } : undefined;
    if (editing) {
      await api(`/admin/suppliers/${form.id}`, { method: 'PATCH', body: { name: form.name, servesCountries: form.servesCountries, priority: Number(form.priority), returnPolicyDays: Number(form.returnPolicyDays), ...(credentials ? { credentials } : {}), ...(config ? { config } : {}) } });
    } else {
      await api('/admin/suppliers', { body: { code: form.code, name: form.name, provider: form.provider, country: form.country || undefined, servesCountries: form.servesCountries, priority: Number(form.priority), returnPolicyDays: Number(form.returnPolicyDays), ...(credentials ? { credentials } : {}), ...(config ? { config } : {}) } });
    }
    setForm(null);
    await reload();
  }, editing ? 'Supplier updated' : 'Supplier added');

  const cols: Column<S>[] = [
    { key: 'n', header: 'Supplier', render: (r) => <div><b>{r.name}</b><p className="text-xs text-ink-3">{r.code} · {r.provider}{r.credentialsSet ? ' · key set' : r.provider !== 'mock' ? ' · no key' : ''}</p></div> },
    { key: 'sv', header: 'Serves', render: (r) => <div className="flex flex-wrap gap-1">{r.servesCountries.length ? r.servesCountries.map((c) => <Badge key={c}>{c}</Badge>) : <span className="text-xs text-ink-3">everywhere</span>}</div> },
    { key: 'api', header: 'API', render: (r) => <div><StatusBadge status={r.apiStatus} />{r.apiStatusMessage && <p className="mt-1 max-w-48 truncate text-xs text-ink-3" title={r.apiStatusMessage}>{r.apiStatusMessage}</p>}</div> },
    { key: 'o', header: 'Offers', hideBelow: 'md', align: 'right', render: (r) => `${r.offersAvailable}/${r.offers}` },
    { key: 'rel', header: 'Reliability', hideBelow: 'md', align: 'right', render: (r) => <b>{r.reliability}</b> },
    { key: 'f', header: 'Fail / late', hideBelow: 'lg', align: 'right', render: (r) => `${pctf(r.failRate, 0)} / ${pctf(r.lateRate, 0)}` },
    { key: 'ls', header: 'Last sync', hideBelow: 'lg', render: (r) => when(r.lastSyncAt) },
    { key: 'a', header: '', align: 'right', render: (r) => can('suppliers:write') && (
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="secondary" loading={busy === r.id} onClick={(e) => { e.stopPropagation(); void run(r.id, async () => { await api(`/admin/suppliers/${r.id}/check`, { body: {} }); await reload(); }, 'Health check complete'); }}>Check</Button>
        <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setForm({ ...blank, id: r.id, code: r.code, name: r.name, provider: r.provider, country: r.country ?? '', servesCountries: r.servesCountries, priority: r.priority, returnPolicyDays: r.returnPolicyDays }); }}>Edit</Button>
        <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void run(r.id + 'a', async () => { await api(`/admin/suppliers/${r.id}`, { method: 'PATCH', body: { active: !r.active } }); await reload(); }); }}>{r.active ? 'Disable' : 'Enable'}</Button>
      </div>
    ) },
  ];

  return (
    <>
      <PageHeader title="Suppliers" subtitle="Connect a different supplier for each country. Every supplier has its own API key, countries served and photos; orders go to the best supplier that serves the destination." actions={can('suppliers:write') ? <Button onClick={() => setForm({ ...blank })}>Add supplier</Button> : undefined} />
      {error && !data && <ErrorBox message={error} retry={reload} />}
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {data?.coverage.map((c) => (
          <Card key={c.country} className={`p-4 ${c.suppliers.length ? '' : 'border-coral-500/50 bg-coral-50'}`}>
            <p className="flex items-center gap-2 font-bold">{c.suppliers.length ? <CheckCircle2 className="size-4 text-ok-500" aria-hidden /> : <AlertTriangle className="size-4 text-coral-500" aria-hidden />}{c.name}</p>
            {c.suppliers.length ? <p className="mt-1 text-sm text-ink-2">{c.suppliers.join(' → ')}</p> : <p className="mt-1 text-sm text-coral-600">No supplier serves {c.name} — nothing can be sold there until you add one.</p>}
          </Card>
        ))}
      </div>
      <Card><DataTable columns={cols} rows={data?.items} loading={loading} rowKey={(r) => r.id} /></Card>
      <h2 className="mb-3 mt-8 text-lg font-bold">Supplier adapters</h2>
      <div className="grid gap-3 md:grid-cols-3">{data?.adapters.map((a) => (
        <Panel key={a.provider} title={a.label} action={<Badge tone={a.usable ? 'ok' : 'neutral'}>{a.usable ? 'Ready' : 'Needs credentials'}</Badge>}><p className="text-sm text-ink-2">{a.note}</p></Panel>
      ))}</div>
      <Modal open={!!form} onClose={() => setForm(null)} title={editing ? `Edit ${form?.name}` : 'Add supplier'} size="lg" footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button loading={busy === 'save'} disabled={!form || !form.name || (!editing && !form.code) || (form.provider !== 'mock' && form.servesCountries.length === 0)} onClick={() => void save()}>{editing ? 'Save' : 'Add supplier'}</Button></>}>
        {form && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Code" hint="lowercase letters, digits, dashes"><Input value={form.code} disabled={editing} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
              <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Adapter"><Select value={form.provider} disabled={editing} onChange={(e) => setForm({ ...form, provider: e.target.value, config: e.target.value === 'rest' && !form.config ? REST_TEMPLATE : form.config })}>{data?.adapters.map((a) => <option key={a.provider} value={a.provider}>{a.label}</option>)}</Select></Field>
              <Field label="Priority" hint="Lower = preferred when value is similar"><Input inputMode="numeric" value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) || 100 })} /></Field>
            </div>
            <fieldset>
              <legend className="mb-2 text-sm font-semibold">Countries this supplier ships to</legend>
              <div className="flex flex-wrap gap-4">{COUNTRIES.map(([c, n]) => <Checkbox key={c} checked={form.servesCountries.includes(c)} onChange={() => toggleCountry(c)} label={n} />)}</div>
              <p className="mt-1 text-xs text-ink-3">Orders and prices for a country only ever use suppliers that serve it.</p>
            </fieldset>
            {form.provider !== 'mock' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="API key" hint={editing ? 'Leave blank to keep the stored key' : 'Stored encrypted; never shown again'}><Input type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></Field>
                <Field label="API secret (optional)"><Input type="password" autoComplete="off" value={form.apiSecret} onChange={(e) => setForm({ ...form, apiSecret: e.target.value })} /></Field>
              </div>
            )}
            {form.provider === 'rest' && (
              <Field label="API mapping (JSON)" hint="Describes this supplier's endpoints and field names — see docs/SUPPLIERS.md. Leave blank when editing to keep the current mapping."><Textarea className="min-h-56 font-mono text-xs" value={form.config} onChange={(e) => setForm({ ...form, config: e.target.value })} spellCheck={false} /></Field>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
