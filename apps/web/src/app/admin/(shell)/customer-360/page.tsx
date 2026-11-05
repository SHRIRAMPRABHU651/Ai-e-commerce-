'use client';
import * as React from 'react';
import { Badge, Input } from '@orvia/ui';
import { api } from '@/lib/api';
import { Button, EmptyState, ErrorBox, FilterSelect, Loading, PageHeader, Panel, SearchBox, Toolbar, cur, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';

interface SearchRes { total: number; items: { userId: string; email: string; name: string; country: string | null; ordersCount: number; lastOrderAt: string | null; deleted: boolean }[] }
interface Profile {
  identity: { userId: string; email: string; name: string; country: string | null; emailVerified: boolean; createdAt: string; lastLoginAt: string | null; disabled: boolean; deleted: boolean };
  preferences: { lifegraphEnabled: boolean; memoryEnabled: boolean; replenishmentOptIn: boolean };
  shoppingInterests: { kind: string; value: string; source: string }[];
  purchaseHistory: { ordersCount: number; lifetimeValue: number; lastOrderAt: string | null; recent: { orderNumber: string; status: string; total: number; currency: string; createdAt: string; itemCount: number }[] };
  wishlistCount: number; savedCollections: string[];
  productInteractions: { type: string; count: number }[];
  supportHistory: { id: string; subject: string; status: string }[];
  deliveryHistory: { orderNumber: string; status: string; carrier?: string }[];
  returns: { id: string; status: string; reason: string; orderNumber?: string }[];
  loyalty: { tier?: string; points?: number } | null;
  referrals: { code: string | null; rewardsEarned: number };
  consents: { kind: string; granted: boolean; at: string | null }[];
  riskFlags: string[];
  staffNotes: { id: string; body: string; authorName?: string; createdAt: string }[];
  deletionRequests: { id: string; status: string; coolingOffUntil: string }[];
  timeline: { at: string; type: string; summary: string }[];
}
interface Deletions { total: number; items: { id: string; userId: string; email: string; status: string; reason: string | null; requestedAt: string; coolingOffUntil: string; coolingOffElapsed: boolean; staffNote: string | null }[] }

function Detail({ userId, onClose }: { userId: string; onClose: () => void }) {
  const { can } = useAdmin();
  const [reveal, setReveal] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState('');
  const path = `/admin/customer-360/${userId}${reveal ? `?reveal=email&reason=${encodeURIComponent(reveal)}` : ''}`;
  const { data, error, loading, reload } = useFetch<Profile>(path);
  const { run, busy } = useAction();
  const [note, setNote] = React.useState('');
  if (loading) return <Loading rows={4} />;
  if (error || !data) return <ErrorBox message={error ?? 'Not found'} retry={() => void reload()} />;
  const write = can('customer360:write');
  return (
    <div className="space-y-4">
      <Toolbar><Button variant="secondary" size="sm" onClick={onClose}>Back to search</Button><span className="text-xs text-ink-3">Opening this profile was recorded in the audit log.</span></Toolbar>
      <Panel title={data.identity.name} subtitle={data.identity.email} action={write && !reveal ? <div className="flex gap-2"><Input aria-label="Reason to reveal contact details" placeholder="Reason to reveal email/name" value={reason} onChange={(e) => setReason(e.target.value)} className="h-9 w-56 text-sm" /><Button size="sm" variant="secondary" disabled={reason.trim().length < 5} onClick={() => setReveal(reason.trim())}>Reveal</Button></div> : undefined}>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3"><div><dt className="text-ink-3">Country</dt><dd>{data.identity.country ?? '—'}</dd></div><div><dt className="text-ink-3">Joined</dt><dd>{when(data.identity.createdAt)}</dd></div><div><dt className="text-ink-3">Last login</dt><dd>{when(data.identity.lastLoginAt)}</dd></div>
          <div><dt className="text-ink-3">Orders</dt><dd>{data.purchaseHistory.ordersCount}</dd></div><div><dt className="text-ink-3">Lifetime value (as recorded)</dt><dd>{cur(data.purchaseHistory.lifetimeValue, 'USD')}</dd></div><div><dt className="text-ink-3">Loyalty</dt><dd>{data.loyalty ? `${data.loyalty.tier ?? ''} ${data.loyalty.points ?? ''}`.trim() || 'Member' : 'Not available'}</dd></div></dl>
        <div className="mt-3 flex flex-wrap gap-1.5">{data.identity.deleted && <Badge tone="coral">Anonymized</Badge>}{data.identity.disabled && <Badge tone="coral">Disabled</Badge>}{data.riskFlags.map((f) => <Badge key={f} tone="saffron">{f}</Badge>)}{!data.riskFlags.length && <span className="text-xs text-ink-3">No risk flags</span>}</div>
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Consents">{data.consents.map((c) => <div key={c.kind} className="flex items-center justify-between gap-2 py-1 text-sm"><span>{c.kind.replace('_', ' ')}{c.at && <span className="text-ink-3"> · {when(c.at)}</span>}</span><span className="flex items-center gap-2"><Badge tone={c.granted ? 'pine' : 'neutral'}>{c.granted ? 'granted' : 'off'}</Badge>{write && c.granted && <button className="text-xs font-bold text-coral-500" disabled={busy === c.kind} onClick={() => { const r = window.prompt('Reason for withdrawing this consent on the customer’s behalf (min 5 chars)'); if (r && r.length >= 5) void run(c.kind, () => api(`/admin/customer-360/${userId}/consents/withdraw`, { body: { kind: c.kind, reason: r } }).then(reload), 'Withdrawn'); }}>Withdraw</button>}</span></div>)}</Panel>
        <Panel title="Preferences and interests"><p className="text-sm text-ink-3">LifeGraph {data.preferences.lifegraphEnabled ? 'on' : 'off'} · Memory {data.preferences.memoryEnabled ? 'on' : 'off'} · Reorder suggestions {data.preferences.replenishmentOptIn ? 'on' : 'off'}</p><ul className="mt-2 flex flex-wrap gap-1.5">{data.shoppingInterests.map((i) => <li key={i.kind + i.value}><Badge>{i.kind.replace('_', ' ')}: {i.value}</Badge></li>)}</ul>{!data.shoppingInterests.length && <p className="mt-2 text-sm text-ink-3">None shared.</p>}<p className="mt-2 text-sm text-ink-3">Wishlist {data.wishlistCount} · saved collections {data.savedCollections.length}</p></Panel>
        <Panel title="Recent orders">{data.purchaseHistory.recent.length ? <ul className="divide-y divide-line text-sm">{data.purchaseHistory.recent.map((o) => <li key={o.orderNumber} className="flex justify-between py-1.5"><span>{o.orderNumber} · {o.status}</span><span>{cur(o.total, o.currency)}</span></li>)}</ul> : <p className="text-sm text-ink-3">No orders.</p>}</Panel>
        <Panel title="Support, returns, deliveries"><ul className="space-y-1 text-sm">{data.supportHistory.map((t) => <li key={t.id}>Ticket: {t.subject} ({t.status})</li>)}{data.returns.map((r) => <li key={r.id}>Return {r.orderNumber}: {r.status}</li>)}{data.deliveryHistory.slice(0, 8).map((s, i) => <li key={i}>Delivery {s.orderNumber}: {s.status}</li>)}</ul>{!data.supportHistory.length && !data.returns.length && !data.deliveryHistory.length && <p className="text-sm text-ink-3">Nothing on record.</p>}<p className="mt-2 text-xs text-ink-3">Interactions (90d): {data.productInteractions.map((i) => `${i.type} ${i.count}`).join(', ') || 'none'}</p></Panel>
      </div>
      <Panel title="Staff notes">
        {write && <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void run('note', () => api(`/admin/customer-360/${userId}/notes`, { body: { body: note } }).then(() => { setNote(''); return reload(); }), 'Note added'); }}><Input aria-label="Note" placeholder="Factual notes only; the customer can request them" required maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} /><Button type="submit" disabled={busy === 'note'}>Add</Button></form>}
        {data.staffNotes.length ? <ul className="divide-y divide-line text-sm">{data.staffNotes.map((n) => <li key={n.id} className="py-2"><p>{n.body}</p><p className="text-xs text-ink-3">{n.authorName} · {when(n.createdAt)}</p></li>)}</ul> : <p className="text-sm text-ink-3">No notes.</p>}
      </Panel>
      <Panel title="Timeline">{data.timeline.length ? <ul className="divide-y divide-line text-sm">{data.timeline.map((t, i) => <li key={i} className="flex justify-between gap-3 py-1.5"><span>{t.summary}</span><span className="shrink-0 text-ink-3">{when(t.at)}</span></li>)}</ul> : <p className="text-sm text-ink-3">No activity.</p>}</Panel>
    </div>
  );
}

function DeletionQueue() {
  const { can } = useAdmin();
  const [status, setStatus] = React.useState('');
  const { data, error, loading, reload } = useFetch<Deletions>(`/admin/customer-360/deletion-requests${status ? `?status=${status}` : ''}`);
  const { run, busy } = useAction();
  const act = (id: string, action: string, confirmMsg?: string) => { if (confirmMsg && !window.confirm(confirmMsg)) return; const note = window.prompt('Note for the audit log (min 3 chars)'); if (note && note.length >= 3) void run(id, () => api(`/admin/customer-360/deletion-requests/${id}/process`, { body: { action, note } }).then(reload), 'Done'); };
  return (
    <Panel title="Deletion requests" subtitle="Execute only after the cooling-off period. Anonymization is irreversible; order and payment records are retained without personal details." action={<FilterSelect label="Status" value={status} onChange={setStatus} options={[['', 'All'], ['requested', 'Requested'], ['ready', 'Ready'], ['on_hold', 'On hold'], ['completed', 'Completed'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled']]} />}>
      {loading ? <Loading /> : error ? <ErrorBox message={error} retry={() => void reload()} /> : !data?.items.length ? <EmptyState title="No deletion requests" /> : (
        <ul className="divide-y divide-line text-sm">{data.items.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><div><p className="font-semibold">{d.email} <Badge>{d.status.replace('_', ' ')}</Badge></p><p className="text-xs text-ink-3">Requested {when(d.requestedAt)} · cooling-off until {when(d.coolingOffUntil)}{d.staffNote && ` · ${d.staffNote}`}</p></div>
            {can('customer360:write') && ['requested', 'ready', 'on_hold'].includes(d.status) && <div className="flex gap-2">
              {d.status !== 'on_hold' && <Button size="sm" disabled={!d.coolingOffElapsed || busy === d.id} onClick={() => act(d.id, 'execute', 'Permanently anonymize this account?')}>Execute</Button>}
              {d.status === 'on_hold' ? <Button size="sm" variant="secondary" onClick={() => act(d.id, 'release')}>Release hold</Button> : <Button size="sm" variant="secondary" onClick={() => act(d.id, 'hold')}>Legal hold</Button>}
              <Button size="sm" variant="secondary" onClick={() => act(d.id, 'reject')}>Reject</Button></div>}</li>
        ))}</ul>
      )}
    </Panel>
  );
}

export default function Page() {
  const [q, setQ] = React.useState('');
  const [selected, setSelected] = React.useState<string | null>(null);
  const { data, error, loading, reload } = useFetch<SearchRes>(q.trim().length >= 2 ? `/admin/customer-360?q=${encodeURIComponent(q.trim())}` : null);
  return (
    <div>
      <PageHeader title="Customer 360" subtitle="Unified customer view. Contact details are masked; every profile view, reveal and change is audited." />
      {selected ? <Detail userId={selected} onClose={() => setSelected(null)} /> : (
        <div className="space-y-6">
          <Panel title="Find a customer">
            <Toolbar><SearchBox value={q} onChange={setQ} placeholder="Email or name (min 2 characters)" /></Toolbar>
            {q.trim().length < 2 ? <p className="text-sm text-ink-3">Search by email prefix or name.</p> : loading ? <Loading /> : error ? <ErrorBox message={error} retry={() => void reload()} /> : !data?.items.length ? <EmptyState title="No customers found" /> : (
              <ul className="divide-y divide-line text-sm">{data.items.map((u) => <li key={u.userId}><button className="flex w-full items-center justify-between gap-3 py-2.5 text-left hover:bg-sunken" onClick={() => setSelected(u.userId)}><span><span className="font-semibold">{u.name}</span> <span className="text-ink-3">{u.email}</span>{u.deleted && <Badge tone="coral" className="ml-2">anonymized</Badge>}</span><span className="text-ink-3">{u.ordersCount} orders{u.lastOrderAt && ` · last ${when(u.lastOrderAt)}`}</span></button></li>)}</ul>
            )}
          </Panel>
          <DeletionQueue />
        </div>
      )}
    </div>
  );
}
