'use client';
import { ArrowDown, ArrowUp, Copy, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Badge, Button, Card, EmptyState, Field, Input, Select, Skeleton, Tabs, Textarea, useToast } from '@orvia/ui';
import { api } from '@/lib/api';
import { useApi } from './account';
import { CreatorStatusBadge } from './creators';

const money = (minor: number, c: string) => new Intl.NumberFormat(c === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: c }).format(minor / 100);
const day = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '—');

interface Me { creator: null | { id: string; handle: string; displayName: string; bio: string; avatarUrl: string | null; socialLinks: { platform: string; url: string }[]; status: string; reviewNote: string | null; payout: { kycStatus: string; taxInfoCollected: boolean; method: string | null; held: boolean }; profileUrl: string } }
type Cur = 'USD' | 'CAD' | 'INR';
const PLATFORMS = ['instagram', 'youtube', 'tiktok', 'x', 'facebook', 'pinterest', 'website', 'blog'];

export function CreatorPortal() {
  const { data, loading, reload } = useApi<Me>('/creator/me');
  if (loading) return <div className="space-y-3"><Skeleton className="h-10 w-1/3" /><Skeleton className="h-48 w-full" /></div>;
  if (!data) return <p className="text-ink-3">The creator programme is unavailable right now. Please try again shortly.</p>;
  if (!data.creator) return <Apply onDone={reload} />;
  const c = data.creator;
  if (c.status !== 'approved') {
    return (
      <div className="max-w-xl space-y-3">
        <h1 className="font-display text-3xl font-semibold">Creator application</h1>
        <p className="flex items-center gap-2">Status: <CreatorStatusBadge status={c.status} /></p>
        {c.status === 'pending' && <p className="text-ink-3">We’re reviewing your application. You’ll be able to build collections and get links once it’s approved.</p>}
        {c.status === 'rejected' && <p className="text-ink-3">Your application wasn’t approved{c.reviewNote ? `: ${c.reviewNote}` : '.'}</p>}
        {c.status === 'suspended' && <p className="text-ink-3">Your creator account is suspended. Contact support for details.</p>}
      </div>
    );
  }
  return <Portal me={c} onChange={reload} />;
}

function Apply({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = React.useState({ handle: '', displayName: '', bio: '', audience: '', platform: 'instagram', url: '', terms: false });
  const [busy, setBusy] = React.useState(false);
  const [errs, setErrs] = React.useState<Record<string, string>>({});
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErrs({});
    try {
      await api('/creator/apply', { body: { handle: f.handle, displayName: f.displayName, bio: f.bio, audience: f.audience, socialLinks: f.url ? [{ platform: f.platform, url: f.url }] : [], acceptTerms: f.terms } });
      toast.success('Application sent'); onDone();
    } catch (er) {
      const d = (er as { details?: { path: string; message: string }[] }).details;
      if (Array.isArray(d)) setErrs(Object.fromEntries(d.map((x) => [x.path.split('.')[0]!, x.message])));
      toast.error((er as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="max-w-xl space-y-4">
      <div><h1 className="font-display text-3xl font-semibold">Become an Orvia creator</h1>
        <p className="mt-1 text-ink-3">Recommend products you believe in and earn a commission when people buy through your page. Commission is a percentage of the net order value (after discounts, tax, shipping and refunds), and is paid only after the return window. Every page you publish carries a clear paid-partnership disclosure.</p></div>
      <Field label="Handle" error={errs.handle} hint="Your page will be /creators/handle"><Input value={f.handle} maxLength={30} onChange={(e) => setF({ ...f, handle: e.target.value })} required /></Field>
      <Field label="Display name" error={errs.displayName}><Input value={f.displayName} maxLength={60} onChange={(e) => setF({ ...f, displayName: e.target.value })} required /></Field>
      <Field label="Short bio" error={errs.bio}><Textarea rows={3} maxLength={500} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} /></Field>
      <Field label="Where is your audience?" error={errs.audience}><Input value={f.audience} maxLength={300} onChange={(e) => setF({ ...f, audience: e.target.value })} /></Field>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Field label="Platform"><Select value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value })}>{PLATFORMS.map((p) => <option key={p}>{p}</option>)}</Select></Field>
        <Field label="Profile link (https)" error={errs.socialLinks}><Input type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
      </div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={f.terms} onChange={(e) => setF({ ...f, terms: e.target.checked })} className="mt-1" /><span>I will clearly disclose that I earn commission, will not buy through my own links, and understand that fraudulent or self-referred orders are reversed.</span></label>
      <Button type="submit" loading={busy} disabled={!f.terms || busy}>Submit application</Button>
    </form>
  );
}

function Portal({ me, onChange }: { me: NonNullable<Me['creator']>; onChange: () => void }) {
  const [tab, setTab] = React.useState('dashboard');
  return (
    <div className="space-y-5">
      <div><h1 className="font-display text-3xl font-semibold">Creator portal</h1><p className="text-ink-3">@{me.handle} · <a className="underline" href={me.profileUrl}>view public page</a></p></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'dashboard', label: 'Dashboard' }, { id: 'collections', label: 'Collections' }, { id: 'links', label: 'Links' }, { id: 'commissions', label: 'Commissions' }, { id: 'payouts', label: 'Payouts' }, { id: 'profile', label: 'Profile' }]} />
      {tab === 'dashboard' && <Dashboard />}
      {tab === 'collections' && <Collections />}
      {tab === 'links' && <Links />}
      {tab === 'commissions' && <Commissions />}
      {tab === 'payouts' && <Payouts me={me} />}
      {tab === 'profile' && <Profile me={me} onChange={onChange} />}
    </div>
  );
}

interface Perf { windowDays: number; clicks: number; orders: number; refundRate: number | null; netSales: Record<string, number>; commission: Record<string, { accrued: number; payable: number; paid: number }>; balances: Record<string, { accrued: number; payable: number; inPayout: number; paid: number }>; totalClicks: number; attributionDays: number; topLinks: { label: string; clicks: number }[] }
function Dashboard() {
  const { data, loading } = useApi<Perf>('/creator/performance');
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (!data) return <p className="text-ink-3">Performance data is unavailable right now.</p>;
  const cur = Object.keys(data.balances);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label={`Clicks (${data.windowDays}d)`} value={String(data.clicks)} />
        <Stat label={`Orders (${data.windowDays}d)`} value={String(data.orders)} />
        <Stat label="Refund rate" value={data.refundRate === null ? 'No orders yet' : `${(data.refundRate * 100).toFixed(1)}%`} />
        <Stat label="All-time clicks" value={String(data.totalClicks)} />
      </div>
      <Card className="p-5">
        <h2 className="font-semibold">Balances</h2>
        {cur.length === 0 ? <p className="mt-2 text-sm text-ink-3">No commissions yet. Commission accrues when an order placed through your link is delivered, and becomes payable after the return window.</p> : (
          <div className="mt-3 grid gap-3 sm:grid-cols-4">{cur.flatMap((c) => [
            <Stat key={`${c}a`} label={`Pending (${c})`} value={money(data.balances[c]!.accrued, c)} />, <Stat key={`${c}p`} label={`Payable (${c})`} value={money(data.balances[c]!.payable, c)} />,
            <Stat key={`${c}i`} label={`In payout (${c})`} value={money(data.balances[c]!.inPayout, c)} />, <Stat key={`${c}d`} label={`Paid (${c})`} value={money(data.balances[c]!.paid, c)} />])}</div>
        )}
        <p className="mt-3 text-xs text-ink-3">Attribution is last-touch within {data.attributionDays} days. Your own purchases and orders using a friend-referral code are not commissionable.</p>
      </Card>
      {data.topLinks.length > 0 && <Card className="p-5"><h2 className="font-semibold">Top links</h2><ul className="mt-2 text-sm">{data.topLinks.map((l) => <li key={l.label} className="flex justify-between border-b border-line/60 py-1.5"><span>{l.label}</span><span>{l.clicks} clicks</span></li>)}</ul></Card>}
    </div>
  );
}
const Stat = ({ label, value }: { label: string; value: string }) => <Card className="p-4"><p className="text-xs text-ink-3">{label}</p><p className="mt-1 font-display text-2xl font-semibold">{value}</p></Card>;

interface Col { id: string; slug: string; title: string; description: string; published: boolean; items: { productId: string; title: string; note: string }[] }
interface Prod { id: string; title: string; slug: string }
function Collections() {
  const { data, loading, reload } = useApi<{ items: Col[] }>('/creator/collections');
  const [editing, setEditing] = React.useState<Col | 'new' | null>(null);
  if (editing) return <CollectionEditor initial={editing === 'new' ? null : editing} onClose={(changed) => { setEditing(null); if (changed) void reload(); }} />;
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Button onClick={() => setEditing('new')}>New collection</Button></div>
      {loading ? <Skeleton className="h-32 w-full" /> : !data || data.items.length === 0 ? <EmptyState title="No collections yet" body="Create a collection of products you recommend, then publish it to get a shareable page." /> : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {data.items.map((c) => <li key={c.id} className="flex items-center justify-between gap-3 p-4"><div className="min-w-0"><p className="truncate font-semibold">{c.title}</p><p className="text-xs text-ink-3">{c.items.length} products · /{c.slug}</p></div><div className="flex shrink-0 items-center gap-2"><Badge tone={c.published ? 'pine' : 'neutral'}>{c.published ? 'Published' : 'Draft'}</Badge><Button size="sm" variant="secondary" onClick={() => setEditing(c)}>Edit</Button></div></li>)}
        </ul>
      )}
    </div>
  );
}

function CollectionEditor({ initial, onClose }: { initial: Col | null; onClose: (changed: boolean) => void }) {
  const toast = useToast();
  const [title, setTitle] = React.useState(initial?.title ?? '');
  const [description, setDescription] = React.useState(initial?.description ?? '');
  const [items, setItems] = React.useState<{ productId: string; title: string; note: string }[]>(initial?.items.map((i) => ({ productId: i.productId, title: i.title, note: i.note })) ?? []);
  const [published, setPublished] = React.useState(initial?.published ?? false);
  const [q, setQ] = React.useState('');
  const [results, setResults] = React.useState<Prod[]>([]);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(() => void api<{ items: Prod[] }>(`/products?pageSize=8&q=${encodeURIComponent(q)}`).then((r) => setResults(r.items)).catch(() => setResults([])), 300);
    return () => clearTimeout(t);
  }, [q]);
  const move = (i: number, d: number) => setItems((a) => { const b = [...a]; const j = i + d; if (j < 0 || j >= b.length) return a; [b[i], b[j]] = [b[j]!, b[i]!]; return b; });
  const save = async () => {
    setBusy(true);
    try {
      const body = { title, description, productIds: items.map((i) => i.productId), notes: Object.fromEntries(items.filter((i) => i.note).map((i) => [i.productId, i.note])), published };
      if (initial) await api(`/creator/collections/${initial.id}`, { method: 'PATCH', body }); else await api('/creator/collections', { body });
      toast.success('Saved'); onClose(true);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => { if (!initial || !window.confirm('Delete this collection?')) return; try { await api(`/creator/collections/${initial.id}`, { method: 'DELETE' }); onClose(true); } catch (e) { toast.error((e as Error).message); } };
  return (
    <div className="max-w-2xl space-y-4">
      <Field label="Title"><Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Description"><Textarea rows={3} maxLength={600} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label="Add products" hint="Only products that are currently sellable can be recommended."><Input type="search" placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
      {results.length > 0 && <ul className="rounded-lg border border-line">{results.map((p) => <li key={p.id} className="flex items-center justify-between gap-2 p-2 text-sm"><span className="truncate">{p.title}</span><Button size="sm" variant="secondary" disabled={items.some((i) => i.productId === p.id) || items.length >= 40} onClick={() => setItems([...items, { productId: p.id, title: p.title, note: '' }])}>Add</Button></li>)}</ul>}
      <ol className="space-y-2">
        {items.map((it, i) => (
          <li key={it.productId} className="flex items-start gap-2 rounded-lg border border-line p-3">
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{i + 1}. {it.title}</p><Input aria-label="Your note" placeholder="Why you recommend it (optional)" maxLength={240} value={it.note} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} className="mt-2" /></div>
            <div className="flex shrink-0 flex-col gap-1"><button aria-label="Move up" onClick={() => move(i, -1)}><ArrowUp className="size-4" /></button><button aria-label="Move down" onClick={() => move(i, 1)}><ArrowDown className="size-4" /></button><button aria-label="Remove" onClick={() => setItems(items.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button></div>
          </li>
        ))}
      </ol>
      {items.length === 0 && <p className="text-sm text-ink-3">Search above to add at least one product.</p>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} /> Published (visible on your public page)</label>
      <div className="flex flex-wrap gap-2"><Button loading={busy} disabled={busy || title.trim().length < 3} onClick={() => void save()}>Save</Button><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button>{initial && <Button variant="secondary" onClick={() => void remove()}>Delete</Button>}</div>
    </div>
  );
}

interface LinkRow { id: string; code: string; label: string; url: string; clicks: number }
function Links() {
  const toast = useToast();
  const { data, loading, reload } = useApi<{ items: LinkRow[] }>('/creator/links');
  const cols = useApi<{ items: Col[] }>('/creator/collections');
  const [label, setLabel] = React.useState('');
  const [target, setTarget] = React.useState('');
  const products = [...new Map((cols.data?.items ?? []).flatMap((c) => c.items).map((i) => [i.productId, i])).values()];
  const create = async () => {
    try {
      const body: Record<string, string> = { label };
      if (target.startsWith('c:')) body.collectionId = target.slice(2);
      if (target.startsWith('p:')) body.productId = target.slice(2);
      await api('/creator/links', { body }); setLabel(''); void reload(); toast.success('Link created');
    } catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">New share link</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Label"><Input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} /></Field>
          <Field label="Points to"><Select value={target} onChange={(e) => setTarget(e.target.value)}><option value="">My page</option>{cols.data?.items.filter((c) => c.published).map((c) => <option key={c.id} value={`c:${c.id}`}>{c.title}</option>)}{products.map((p) => <option key={p.productId} value={`p:${p.productId}`}>{p.title}</option>)}</Select></Field>
        </div>
        <Button disabled={!label.trim()} onClick={() => void create()}>Create link</Button>
      </Card>
      {loading ? <Skeleton className="h-24 w-full" /> : !data || data.items.length === 0 ? <EmptyState title="No links yet" body="Links track clicks and attribute orders to you for 30 days." /> : (
        <ul className="divide-y divide-line rounded-lg border border-line">{data.items.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"><div className="min-w-0"><p className="font-semibold">{l.label}</p><p className="truncate font-mono text-xs text-ink-3">{l.url}</p></div>
            <div className="flex items-center gap-2"><span className="text-ink-3">{l.clicks} clicks</span><Button size="sm" variant="secondary" onClick={() => void navigator.clipboard.writeText(l.url).then(() => toast.success('Copied'), () => toast.error('Could not copy'))}><Copy className="size-4" /></Button><Button size="sm" variant="secondary" onClick={() => void api(`/creator/links/${l.id}`, { method: 'DELETE' }).then(reload)}><Trash2 className="size-4" /></Button></div></li>))}</ul>
      )}
    </div>
  );
}

interface CommissionRow { id: string; kind: string; status: string; amount: number; currency: string; orderRef: string | null; netBase: number | null; rate: number | null; holdUntil: string | null; note: string | null; createdAt: string }
function Commissions() {
  const [page, setPage] = React.useState(1);
  const { data, loading } = useApi<{ items: CommissionRow[]; total: number; pageSize: number }>(`/creator/commissions?page=${page}&pageSize=20`);
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (!data || data.items.length === 0) return <EmptyState title="No commissions yet" body="Entries appear here when an attributed order is delivered." />;
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-line"><table className="w-full min-w-[40rem] text-left text-sm"><thead className="bg-sunken text-xs uppercase text-ink-3"><tr><th className="p-3">Order</th><th>Type</th><th>Status</th><th>Net base</th><th>Rate</th><th>Held until</th><th className="pr-3 text-right">Amount</th></tr></thead>
        <tbody>{data.items.map((r) => <tr key={r.id} className="border-t border-line/60"><td className="p-3">{r.orderRef ?? '—'}</td><td>{r.kind}</td><td><Badge tone={r.status === 'paid' ? 'pine' : r.status === 'payable' ? 'info' : 'neutral'}>{r.status}</Badge></td><td>{r.netBase === null ? '' : money(r.netBase, r.currency)}</td><td>{r.rate === null ? '' : `${(r.rate * 100).toFixed(1)}%`}</td><td>{day(r.holdUntil)}</td><td className="pr-3 text-right tabular-nums">{money(r.amount, r.currency)}</td></tr>)}</tbody></table></div>
      <div className="flex justify-between text-sm"><Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><span className="text-ink-3">Page {page}</span><Button size="sm" variant="secondary" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>Next</Button></div>
    </div>
  );
}

interface PayoutRow { id: string; currency: string; amount: number; status: string; requestedAt: string | null; paidAt: string | null; method: string | null; externalReference: string | null; rejectedReason: string | null }
function Payouts({ me }: { me: NonNullable<Me['creator']> }) {
  const toast = useToast();
  const { data, loading, reload } = useApi<{ items: PayoutRow[] }>('/creator/payouts');
  const perf = useApi<Perf & { payoutThreshold: Record<string, number> }>('/creator/performance');
  const [busy, setBusy] = React.useState('');
  const request = async (currency: Cur) => { setBusy(currency); try { await api('/creator/payouts', { body: { currency } }); toast.success('Payout requested'); void reload(); void perf.reload(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(''); } };
  return (
    <div className="space-y-4">
      <Card className="p-4 text-sm"><h2 className="font-semibold">Payout checklist</h2>
        <ul className="mt-2 space-y-1"><li>Identity verified: <Badge tone={me.payout.kycStatus === 'verified' ? 'pine' : 'saffron'}>{me.payout.kycStatus.replace('_', ' ')}</Badge></li><li>Tax information collected: <Badge tone={me.payout.taxInfoCollected ? 'pine' : 'saffron'}>{me.payout.taxInfoCollected ? 'yes' : 'no'}</Badge></li>{me.payout.held && <li><Badge tone="coral">Payouts on hold</Badge></li>}</ul>
        <p className="mt-2 text-xs text-ink-3">Orvia never asks for ID or bank numbers in this portal. Support collects them through a secure channel and records only that they were collected. Payouts are transferred manually by our team after approval.</p></Card>
      {perf.data && Object.entries(perf.data.balances).map(([c, b]) => (
        <Card key={c} className="flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="text-sm text-ink-3">Payable ({c})</p><p className="font-display text-2xl font-semibold">{money(b.payable, c)}</p><p className="text-xs text-ink-3">Minimum {money(perf.data!.payoutThreshold[c] ?? 0, c)}</p></div><Button loading={busy === c} disabled={!!busy || b.payable < (perf.data!.payoutThreshold[c] ?? 0)} onClick={() => void request(c as Cur)}>Request payout</Button></Card>
      ))}
      {loading ? <Skeleton className="h-24 w-full" /> : !data || data.items.length === 0 ? <EmptyState title="No payouts yet" /> : (
        <ul className="divide-y divide-line rounded-lg border border-line">{data.items.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"><div><p className="font-semibold">{money(p.amount, p.currency)} <Badge tone={p.status === 'paid' ? 'pine' : p.status === 'rejected' ? 'coral' : 'info'}>{p.status}</Badge></p><p className="text-xs text-ink-3">Requested {day(p.requestedAt)}{p.paidAt ? ` · paid ${day(p.paidAt)} (${p.method}, ref ${p.externalReference})` : ''}{p.rejectedReason ? ` · ${p.rejectedReason}` : ''}</p></div>
            <div className="flex gap-2"><a className="underline" href={`/api/v1/creator/payouts/${p.id}/statement?format=html`} target="_blank" rel="noreferrer">Print statement</a><a className="underline" href={`/api/v1/creator/payouts/${p.id}/statement?format=csv`}>CSV</a></div></li>))}</ul>
      )}
    </div>
  );
}

function Profile({ me, onChange }: { me: NonNullable<Me['creator']>; onChange: () => void }) {
  const toast = useToast();
  const [displayName, setName] = React.useState(me.displayName);
  const [bio, setBio] = React.useState(me.bio);
  const [links, setLinks] = React.useState(me.socialLinks);
  const [busy, setBusy] = React.useState(false);
  const save = async () => { setBusy(true); try { await api('/creator/profile', { method: 'PATCH', body: { displayName, bio, socialLinks: links } }); toast.success('Profile saved'); onChange(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  const upload = async (f: File) => {
    const fd = new FormData(); fd.append('file', f);
    const res = await fetch('/api/v1/creator/avatar', { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'x-requested-with': 'orvia' } });
    if (res.ok) { toast.success('Avatar updated'); onChange(); } else toast.error(((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? 'Upload failed');
  };
  return (
    <div className="max-w-xl space-y-4">
      <div className="flex items-center gap-4">{me.avatarUrl ? <img src={me.avatarUrl} alt="" className="size-16 rounded-full object-cover" width={64} height={64} /> : <div aria-hidden className="grid size-16 place-items-center rounded-full bg-sunken font-bold">{me.displayName[0]}</div>}
        <label className="text-sm"><span className="font-semibold">Avatar</span><input type="file" accept="image/jpeg,image/png,image/webp,image/avif" className="mt-1 block" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} /><span className="text-xs text-ink-3">JPEG, PNG, WebP or AVIF, at least 500px on the short side.</span></label></div>
      <Field label="Display name"><Input value={displayName} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Bio"><Textarea rows={3} maxLength={500} value={bio} onChange={(e) => setBio(e.target.value)} /></Field>
      <div className="space-y-2"><p className="text-sm font-semibold">Social links (https only)</p>
        {links.map((l, i) => <div key={i} className="flex gap-2"><Select aria-label="Platform" value={l.platform} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, platform: e.target.value } : x)))} className="w-32">{PLATFORMS.map((p) => <option key={p}>{p}</option>)}</Select><Input aria-label="URL" type="url" value={l.url} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} /><Button variant="secondary" size="sm" onClick={() => setLinks(links.filter((_, j) => j !== i))}>Remove</Button></div>)}
        {links.length < 6 && <Button variant="secondary" size="sm" onClick={() => setLinks([...links, { platform: 'instagram', url: '' }])}>Add link</Button>}</div>
      <Button loading={busy} disabled={busy} onClick={() => void save()}>Save profile</Button>
    </div>
  );
}
