'use client';
import { Download, Package, Shield } from 'lucide-react';
import * as React from 'react';
import { Badge, Button, Card, EmptyState, Field, Input, Link, Select, Skeleton, StatusBadge, useToast } from '@orvia/ui';
import { api, money } from '@/lib/api';

/** Data hook with error + reload (account pages need an error state; `useApi` in account.tsx has none). */
function useData<T>(path: string) {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const reload = React.useCallback(async () => {
    try { setData(await api<T>(path)); setError(null); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [path]);
  React.useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload };
}

function Frame({ loading, error, retry, children }: { loading: boolean; error: string | null; retry: () => void; children: React.ReactNode }) {
  if (loading) return <Skeleton className="h-64" />;
  if (error) return <Card className="p-5 text-sm" role="alert"><p className="font-semibold text-coral-500">Something went wrong</p><p className="mt-1 text-ink-3">{error}</p><Button className="mt-3" variant="secondary" size="sm" onClick={retry}>Try again</Button></Card>;
  return <>{children}</>;
}

const when = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '');
const Toggle = ({ id, label, checked, onChange, hint, disabled }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string; disabled?: boolean }) => (
  <label htmlFor={id} className="flex items-start gap-3 py-2 text-sm"><input id={id} type="checkbox" className="mt-1 size-4" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><span><span className="font-semibold">{label}</span>{hint && <span className="block text-ink-3">{hint}</span>}</span></label>
);

function useRun() {
  const toast = useToast();
  return async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast.success(ok); return true; } catch (e) { toast.error((e as Error).message); return false; } };
}

/* ------------------------------ privacy ------------------------------ */
interface Privacy {
  consents: { kind: string; granted: boolean; at: string | null; policyVersion: string | null; currentPolicyVersion: string }[];
  history: { id: string; kind: string; granted: boolean; at: string; source: string; byStaff: boolean }[];
  deletion: { id: string; status: string; requestedAt: string; coolingOffUntil: string } | null;
}
const CONSENT_COPY: Record<string, [string, string]> = {
  marketing_email: ['Marketing email', 'Offers and news by email. Order and security emails are always sent.'],
  personalization: ['Personalization', 'Use what you tell us (LifeGraph) and your activity to tailor suggestions.'],
  analytics: ['Analytics', 'Help us understand how the store is used.'],
  data_processing: ['Data processing', 'Process your account data to run your orders and support.'],
};

export function PrivacyPanel() {
  const { data, error, loading, reload } = useData<Privacy>('/account/privacy');
  const run = useRun();
  const [confirm, setConfirm] = React.useState(false);
  const [reason, setReason] = React.useState('');
  return (
    <Frame loading={loading} error={error} retry={() => void reload()}>
      {data && (
        <div className="space-y-6">
          <Card className="p-5 sm:p-6">
            <h2 className="flex items-center gap-2 text-lg font-bold"><Shield className="size-5 text-pine-600" /> Your consents</h2>
            <p className="mt-1 text-sm text-ink-3">Everything is off until you say yes. You can change your mind at any time; each change is recorded with the policy version you saw.</p>
            <div className="mt-3 divide-y divide-line">
              {data.consents.map((c) => (
                <div key={c.kind}>
                  <Toggle id={`c-${c.kind}`} label={CONSENT_COPY[c.kind]?.[0] ?? c.kind} hint={`${CONSENT_COPY[c.kind]?.[1] ?? ''}${c.at ? ` Last changed ${when(c.at)} (policy ${c.policyVersion}).` : ''}`} checked={c.granted}
                    onChange={async (v) => { if (await run(() => api(`/account/privacy/consents/${c.kind}`, { method: 'PUT', body: { granted: v } }), v ? 'Saved' : 'Withdrawn')) await reload(); }} />
                </div>
              ))}
            </div>
          </Card>
          <Card className="p-5 sm:p-6">
            <h2 className="text-lg font-bold">Your data</h2>
            <p className="mt-1 text-sm text-ink-3">Download everything we hold about you as a JSON file. Card numbers are never stored by us.</p>
            <div className="mt-3 flex flex-wrap gap-2"><a href="/api/v1/account/privacy/export" download className="inline-flex h-10 items-center gap-2 rounded-md border border-line px-4 text-sm font-semibold hover:bg-sunken"><Download className="size-4" /> Download my data</a></div>
          </Card>
          <Card className="p-5 sm:p-6">
            <h2 className="text-lg font-bold">Delete my account</h2>
            {data.deletion ? (
              <div className="mt-2 space-y-3 text-sm">
                <p>Deletion requested on {when(data.deletion.requestedAt)} (status: <strong>{data.deletion.status.replace('_', ' ')}</strong>). Your data is kept until the cooling-off period ends on <strong>{when(data.deletion.coolingOffUntil)}</strong>, then our team processes the request.</p>
                {data.deletion.status !== 'on_hold' && <Button variant="secondary" onClick={async () => { if (await run(() => api('/account/privacy/deletion', { method: 'DELETE' }), 'Request cancelled')) await reload(); }}>Cancel the request</Button>}
              </div>
            ) : (
              <div className="mt-2 space-y-3 text-sm text-ink-3">
                <p>After a 14-day cooling-off period we remove your name, email, addresses, wishlist, preferences and memory. We keep a minimal order and payment record without personal details, as the law requires. This cannot be undone.</p>
                <Field label="Reason (optional)" htmlFor="del-reason"><Input id="del-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                <Toggle id="del-confirm" label="I understand this will permanently remove my account" checked={confirm} onChange={setConfirm} />
                <Button disabled={!confirm} onClick={async () => { if (await run(() => api('/account/privacy/deletion', { body: { confirm: true, reason: reason || undefined } }), 'Deletion requested')) await reload(); }}>Request deletion</Button>
              </div>
            )}
          </Card>
          <Card className="p-5 sm:p-6">
            <h2 className="text-lg font-bold">Consent history</h2>
            {data.history.length ? <ul className="mt-3 divide-y divide-line text-sm">{data.history.map((h) => <li key={h.id} className="flex justify-between gap-3 py-2"><span>{h.granted ? 'Granted' : 'Withdrew'} {CONSENT_COPY[h.kind]?.[0] ?? h.kind}{h.byStaff && ' (by our team at your request)'}</span><span className="text-ink-3">{when(h.at)}</span></li>)}</ul> : <p className="mt-2 text-sm text-ink-3">No changes yet.</p>}
          </Card>
        </div>
      )}
    </Frame>
  );
}

/* ------------------------------ preferences + LifeGraph ------------------------------ */
const TOPICS: { id: string; label: string; transactional?: boolean }[] = [
  { id: 'order_updates', label: 'Order and delivery updates', transactional: true }, { id: 'security', label: 'Account security', transactional: true }, { id: 'support', label: 'Support replies', transactional: true },
  { id: 'promotions', label: 'Offers and promotions' }, { id: 'newsletter', label: 'Newsletter' }, { id: 'back_in_stock', label: 'Back-in-stock alerts you asked for' },
  { id: 'price_drops', label: 'Price-drop alerts you asked for' }, { id: 'recommendations', label: 'Product suggestions' }, { id: 'replenishment', label: 'Reorder reminders' },
];
const CHANNELS = ['email', 'sms', 'push'] as const;

export function PreferencesPanel() {
  const { data, error, loading, reload } = useData<{ topics: Record<string, Record<string, boolean>>; replenishmentOptIn: boolean; consents: { kind: string; granted: boolean }[] }>('/account/preferences');
  const run = useRun();
  const marketing = data?.consents.find((c) => c.kind === 'marketing_email')?.granted;
  return (
    <div className="space-y-6">
      <Frame loading={loading} error={error} retry={() => void reload()}>
        {data && (
          <Card className="p-5 sm:p-6">
            <h2 className="text-lg font-bold">How we contact you</h2>
            <p className="mt-1 text-sm text-ink-3">Service emails (orders, security, support) always arrive by email. Everything else is off until you switch it on{!marketing && ' and also needs Marketing email consent on the Privacy page'}.</p>
            <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[28rem] text-sm"><thead><tr className="text-left text-ink-3"><th className="py-2 font-semibold">Topic</th>{CHANNELS.map((c) => <th key={c} className="px-2 py-2 font-semibold capitalize">{c}</th>)}</tr></thead><tbody className="divide-y divide-line">
              {TOPICS.map((t) => (
                <tr key={t.id}><td className="py-2 pr-2">{t.label}{t.transactional && <span className="ml-2 text-xs text-ink-3">(service)</span>}</td>
                  {CHANNELS.map((c) => { const on = t.transactional && c === 'email' ? true : !!data.topics[t.id]?.[c]; return <td key={c} className="px-2 py-2"><input type="checkbox" className="size-4" aria-label={`${t.label} by ${c}`} checked={on} disabled={t.transactional && c === 'email'} onChange={async (e) => { if (await run(() => api('/account/preferences', { method: 'PUT', body: { topics: { [t.id]: { [c]: e.target.checked } } } }))) await reload(); }} /></td>; })}</tr>
              ))}
            </tbody></table></div>
            <div className="mt-3 border-t border-line pt-3"><Toggle id="repl" label="Reorder suggestions for consumables" hint="Only for products marked as consumable; no timing is guessed." checked={data.replenishmentOptIn} onChange={async (v) => { if (await run(() => api('/account/preferences', { method: 'PUT', body: { topics: {}, replenishmentOptIn: v } }), 'Saved')) await reload(); }} /></div>
          </Card>
        )}
      </Frame>
      <LifeGraphPanel />
    </div>
  );
}

interface LG { enabled: boolean; personalizationConsent: boolean; nodes: { id: string; kind: string; label: string; value: string; source: string; parentId: string | null }[]; kinds: { kind: string; label: string; values: string[] | null; parentKind: string | null }[] }
interface Recs { personalized: boolean; note: string | null; items: { product: { id: string; slug: string; title: string; price: number | null; currency: string }; reasons: string[] }[] }

export function LifeGraphPanel() {
  const { data, error, loading, reload } = useData<LG>('/account/lifegraph');
  const recs = useData<Recs>('/account/recommendations?limit=6');
  const run = useRun();
  const [kind, setKind] = React.useState('');
  const [value, setValue] = React.useState('');
  const [parent, setParent] = React.useState('');
  const spec = data?.kinds.find((k) => k.kind === kind);
  const parents = data?.nodes.filter((n) => n.kind === spec?.parentKind) ?? [];
  const refresh = async () => { await reload(); await recs.reload(); };
  return (
    <Frame loading={loading} error={error} retry={() => void reload()}>
      {data && (
        <Card className="p-5 sm:p-6">
          <h2 className="text-lg font-bold">LifeGraph: tell us what matters</h2>
          <p className="mt-1 text-sm text-ink-3">Optional. You choose what to share, from a fixed list of shopping topics. We never ask about health, religion, ethnicity, sexuality, politics, exact location or children’s exact ages, and we never infer them. You can see, edit, download and delete everything here.</p>
          <Toggle id="lg-on" label="Use LifeGraph to personalize my suggestions" checked={data.enabled} hint={!data.personalizationConsent ? 'Also needs “Personalization” consent on the Privacy page; until then nothing is used.' : undefined}
            onChange={async (v) => { if (await run(() => api('/account/lifegraph/settings', { method: 'PUT', body: { enabled: v } }))) await refresh(); }} />
          {data.enabled && (
            <>
              <form className="mt-3 grid gap-3 sm:grid-cols-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api('/account/lifegraph/nodes', { body: { kind, value, parentId: parent || undefined } }), 'Added')) { setValue(''); await refresh(); } }}>
                <Select aria-label="What to add" required value={kind} onChange={(e) => { setKind(e.target.value); setValue(''); setParent(''); }}><option value="">Add…</option>{data.kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</Select>
                {spec?.values ? <Select aria-label="Value" required value={value} onChange={(e) => setValue(e.target.value)}><option value="">Choose…</option>{spec.values.map((v) => <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>)}</Select> : <Input aria-label="Category slug" placeholder="e.g. dog-toys" required value={value} onChange={(e) => setValue(e.target.value.toLowerCase())} disabled={!kind} />}
                {spec?.parentKind ? <Select aria-label="Attach to" required value={parent} onChange={(e) => setParent(e.target.value)}><option value="">For…</option>{parents.map((p) => <option key={p.id} value={p.id}>{p.value}</option>)}</Select> : <span />}
                <Button type="submit" disabled={!kind || !value}>Add</Button>
              </form>
              {data.nodes.length ? (
                <ul className="mt-4 divide-y divide-line text-sm">{data.nodes.map((n) => (
                  <li key={n.id} className="flex items-center justify-between gap-3 py-2"><span><strong>{n.label}:</strong> {n.value.replace(/_/g, ' ')} {n.source === 'derived_from_purchases' ? <Badge tone="saffron">From your purchases</Badge> : <Badge tone="pine">You told us</Badge>}</span>
                    <button className="font-semibold text-ink-3 hover:text-coral-500" onClick={async () => { if (await run(() => api(`/account/lifegraph/nodes/${n.id}`, { method: 'DELETE' }))) await refresh(); }}>Delete</button></li>
                ))}</ul>
              ) : <p className="mt-4 text-sm text-ink-3">Nothing added yet.</p>}
            </>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {data.enabled && data.personalizationConsent && <Button variant="secondary" size="sm" onClick={async () => { if (await run(() => api('/account/lifegraph/derive', { method: 'POST', body: {} }), 'Updated')) await refresh(); }}>Suggest from my purchases</Button>}
            <a href="/api/v1/account/lifegraph/export" download className="inline-flex h-9 items-center gap-2 rounded-md border border-line px-3 text-sm font-semibold hover:bg-sunken"><Download className="size-4" /> Download</a>
            <Button variant="secondary" size="sm" onClick={async () => { if (window.confirm('Erase your whole LifeGraph?') && await run(() => api('/account/lifegraph', { method: 'DELETE' }), 'Erased')) await refresh(); }}>Erase everything</Button>
          </div>
          {recs.data && recs.data.personalized && recs.data.items.length > 0 && (
            <div className="mt-5 border-t border-line pt-4"><h3 className="font-semibold">Suggestions for you</h3>
              <ul className="mt-2 space-y-2 text-sm">{recs.data.items.map((r) => <li key={r.product.id}><Link href={`/p/${r.product.slug}`} className="font-semibold hover:underline">{r.product.title}</Link>{r.product.price !== null && <span className="text-ink-3"> · {money(r.product.price, r.product.currency)}</span>}{r.reasons[0] && <p className="text-ink-3">{r.reasons[0]}</p>}</li>)}</ul></div>
          )}
        </Card>
      )}
    </Frame>
  );
}

/* ------------------------------ memory ------------------------------ */
interface Mem { settings: { enabled: boolean; retentionDays: number }; items: { id: string; kind: string; title: string; payload: Record<string, unknown>; enabled: boolean; origin: string; expiresAt: string | null; createdAt: string }[]; total: number }
const KIND_LABEL: Record<string, string> = { requirement: 'Requirement', comparison: 'Comparison', product_question: 'Product question', favourite_collection: 'Favourite collection', note: 'Note' };

export function MemoryPanel() {
  const { data, error, loading, reload } = useData<Mem>('/account/memory?page=1&pageSize=50');
  const run = useRun();
  const [title, setTitle] = React.useState('');
  const [text, setText] = React.useState('');
  const [kind, setKind] = React.useState('note');
  return (
    <Frame loading={loading} error={error} retry={() => void reload()}>
      {data && (
        <div className="space-y-6">
          <Card className="p-5 sm:p-6">
            <h2 className="text-lg font-bold">Commerce Memory</h2>
            <p className="mt-1 text-sm text-ink-3">Things you chose to save: requirements, comparisons, questions and favourite collections. Nothing is saved unless you ask. You control it all.</p>
            <Toggle id="mem-on" label="Allow saving to memory" checked={data.settings.enabled} onChange={async (v) => { if (await run(() => api('/account/memory/settings', { method: 'PUT', body: { enabled: v } }))) await reload(); }} />
            <Field label="Keep items for" htmlFor="mem-ret"><Select id="mem-ret" value={String(data.settings.retentionDays)} onChange={async (e) => { if (await run(() => api('/account/memory/settings', { method: 'PUT', body: { retentionDays: Number(e.target.value) } }), 'Retention updated')) await reload(); }}>{[30, 90, 180, 365, 0].map((d) => <option key={d} value={d}>{d === 0 ? 'Until I delete them' : `${d} days`}</option>)}</Select></Field>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href="/api/v1/account/memory/export" download className="inline-flex h-9 items-center gap-2 rounded-md border border-line px-3 text-sm font-semibold hover:bg-sunken"><Download className="size-4" /> Download</a>
              <Button variant="secondary" size="sm" disabled={!data.total} onClick={async () => { if (window.confirm('Delete all memory items?') && await run(() => api('/account/memory', { method: 'DELETE' }), 'Deleted')) await reload(); }}>Delete all</Button>
            </div>
          </Card>
          {data.settings.enabled && (
            <Card className="p-5 sm:p-6">
              <form className="grid gap-3 sm:grid-cols-3" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api('/account/memory', { body: { kind, title, payload: text ? { text } : {} } }), 'Saved')) { setTitle(''); setText(''); await reload(); } }}>
                <Select aria-label="Type" value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
                <Input aria-label="Title" placeholder="Title" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className="sm:col-span-2" />
                <Input aria-label="Details" placeholder="Details (optional)" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} className="sm:col-span-2" />
                <Button type="submit">Save</Button>
              </form>
            </Card>
          )}
          {data.items.length ? (
            <ul className="space-y-3">{data.items.map((m) => (
              <li key={m.id}><Card className="flex items-start justify-between gap-3 p-4 text-sm"><div className={m.enabled ? '' : 'opacity-60'}><p className="font-semibold">{m.title} <Badge>{KIND_LABEL[m.kind] ?? m.kind}</Badge></p>{typeof m.payload.text === 'string' && <p className="text-ink-3">{m.payload.text}</p>}<p className="text-xs text-ink-3">Saved {when(m.createdAt)}{m.expiresAt && ` · removed ${when(m.expiresAt)}`}</p></div>
                <div className="flex shrink-0 flex-col items-end gap-1"><button className="font-semibold text-ink-3 hover:text-pine-700" onClick={async () => { if (await run(() => api(`/account/memory/${m.id}`, { method: 'PATCH', body: { enabled: !m.enabled } }))) await reload(); }}>{m.enabled ? 'Switch off' : 'Switch on'}</button>
                  <button className="font-semibold text-ink-3 hover:text-coral-500" onClick={async () => { if (await run(() => api(`/account/memory/${m.id}`, { method: 'DELETE' }))) await reload(); }}>Delete</button></div></Card></li>
            ))}</ul>
          ) : <EmptyState icon={<Package className="size-6" />} title="Nothing saved" body="Items you save from the store or here will appear in this list." />}
        </div>
      )}
    </Frame>
  );
}

/* ------------------------------ products + companion ------------------------------ */
export function ProductsPanel() {
  const { data, error, loading, reload } = useData<{ items: { orderItemId: string; orderNumber: string; title: string; image: string | null; deliveredAt: string; consumable: boolean }[] }>('/account/products');
  return (
    <Frame loading={loading} error={error} retry={() => void reload()}>
      {data && (data.items.length ? (
        <ul className="space-y-3">{data.items.map((p) => <li key={p.orderItemId}><Link href={`/account/products/${p.orderItemId}`} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4 shadow-card hover:border-line-strong"><div className="min-w-0"><p className="truncate font-semibold">{p.title}</p><p className="text-sm text-ink-3">{p.orderNumber} · delivered {when(p.deliveredAt)}</p></div>{p.consumable && <Badge>Consumable</Badge>}</Link></li>)}</ul>
      ) : <EmptyState icon={<Package className="size-6" />} title="No delivered products yet" body="Care, usage and support information for your products appears here once they are delivered." action={<Button href="/account/orders" variant="secondary">View orders</Button>} />)}
    </Frame>
  );
}

type Sec = { status: 'provided'; provenance: string; text?: string; field?: string; description?: string; bullets?: string[]; items?: { name: string; value: string }[]; standards?: string[]; ageRange?: string } | { status: 'not_provided'; message: string };
interface Companion {
  orderNumber: string;
  product: { slug: string; title: string; brand: string };
  companion: { overview: Sec; usage: Sec; care: Sec; specs: Sec; safety: Sec; warranty: Sec; verifiedClaims: { claim: string; type: string; note?: string }[]; compatibility: { explicit: string[] } };
  related: { label: string; note: string; items: { id: string; slug: string; title: string; price: number | null; currency: string }[] };
  replenishment: { eligible: boolean; message: string };
  returns: { href: string; note: string };
}

function Section({ title, sec, children }: { title: string; sec: Sec; children?: React.ReactNode }) {
  return (
    <Card className="p-5"><h3 className="font-bold">{title}</h3>
      {sec.status === 'provided' ? <div className="mt-2 text-sm">{children}<p className="mt-2 text-xs text-ink-3">Source: {sec.provenance.replace('_', ' ')}</p></div> : <p className="mt-2 text-sm text-ink-3">{sec.message}</p>}
    </Card>
  );
}

export function CompanionPanel({ orderItemId }: { orderItemId: string }) {
  const { data, error, loading, reload } = useData<Companion>(`/account/products/${orderItemId}`);
  return (
    <Frame loading={loading} error={error} retry={() => void reload()}>
      {data && (
        <div className="space-y-4">
          <div><Link href="/account/products" className="text-sm font-semibold text-pine-700">All my products</Link><h2 className="mt-1 text-xl font-bold">{data.product.title}</h2><p className="text-sm text-ink-3">{data.product.brand} · order {data.orderNumber}</p></div>
          <Section title="About this product" sec={data.companion.overview}>{data.companion.overview.status === 'provided' && <><p>{data.companion.overview.description}</p>{!!data.companion.overview.bullets?.length && <ul className="mt-2 list-disc pl-5">{data.companion.overview.bullets.map((b) => <li key={b}>{b}</li>)}</ul>}</>}</Section>
          <Section title="How to use" sec={data.companion.usage}>{data.companion.usage.status === 'provided' && <p>{data.companion.usage.text}</p>}</Section>
          <Section title="Care" sec={data.companion.care}>{data.companion.care.status === 'provided' && <p>{data.companion.care.text}</p>}</Section>
          <Section title="Safety information" sec={data.companion.safety}>{data.companion.safety.status === 'provided' && <p>{data.companion.safety.standards?.length ? `Standards: ${data.companion.safety.standards.join(', ')}. ` : ''}{data.companion.safety.ageRange ? `Age range: ${data.companion.safety.ageRange}.` : ''}</p>}</Section>
          <Section title="Warranty" sec={data.companion.warranty}>{data.companion.warranty.status === 'provided' && <p>{data.companion.warranty.text}</p>}</Section>
          <Section title="Specifications" sec={data.companion.specs}>{data.companion.specs.status === 'provided' && <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">{data.companion.specs.items?.map((i) => <React.Fragment key={i.name}><dt className="font-semibold">{i.name}</dt><dd>{i.value}</dd></React.Fragment>)}</dl>}</Section>
          {data.companion.verifiedClaims.length > 0 && <Card className="p-5"><h3 className="font-bold">Verified claims</h3><ul className="mt-2 text-sm">{data.companion.verifiedClaims.map((c) => <li key={c.claim}><Badge tone="pine">Verified</Badge> {c.claim.replace('_', ' ')} ({c.type.replace('_', ' ')}){c.note && ` · ${c.note}`}</li>)}</ul></Card>}
          {data.companion.compatibility.explicit.length > 0 && <Card className="p-5"><h3 className="font-bold">Compatible with (as stated by the supplier)</h3><p className="mt-2 text-sm">{data.companion.compatibility.explicit.join(', ')}</p></Card>}
          <Card className="p-5"><h3 className="font-bold">Need help?</h3>
            <div className="mt-2 flex flex-wrap gap-2"><Button href="/help" variant="secondary" size="sm">Contact support</Button><Button href={data.returns.href} variant="secondary" size="sm">Return or exchange</Button></div><p className="mt-2 text-xs text-ink-3">{data.returns.note}</p></Card>
          {data.replenishment.eligible && <Card className="p-5"><h3 className="font-bold">Running low?</h3><p className="mt-2 text-sm text-ink-3">{data.replenishment.message}</p><Button href={`/p/${data.product.slug}`} size="sm" className="mt-2">Buy again</Button></Card>}
          {data.related.items.length > 0 && <Card className="p-5"><h3 className="font-bold">{data.related.label}</h3><p className="text-xs text-ink-3">{data.related.note}</p><ul className="mt-2 space-y-1 text-sm">{data.related.items.map((r) => <li key={r.id}><Link href={`/p/${r.slug}`} className="font-semibold hover:underline">{r.title}</Link>{r.price !== null && <span className="text-ink-3"> · {money(r.price, r.currency)}</span>}</li>)}</ul></Card>}
        </div>
      )}
    </Frame>
  );
}

/* ------------------------------ aftercare ------------------------------ */
interface Aftercare {
  returns: { id: string; status: string; reason: string; orderNumber: string | null; createdAt: string }[];
  refunds: { id: string; orderNumber: string | null; amount: number; currency: string; status: string }[];
  tickets: { id: string; subject: string; status: string; updatedAt: string }[];
  deliveryIssues: { orderNumber: string; status: string; carrier: string | null; estimatedDelivery: string | null; late: boolean }[];
  rescueCases: { id: string; status: string; kind?: string; orderNumber: string | null }[];
}
export function AftercarePanel() {
  const { data, error, loading, reload } = useData<Aftercare>('/account/aftercare');
  const empty = data && !data.returns.length && !data.refunds.length && !data.tickets.length && !data.deliveryIssues.length && !data.rescueCases.length;
  return (
    <Frame loading={loading} error={error} retry={() => void reload()}>
      {data && (empty ? <EmptyState icon={<Shield className="size-6" />} title="Nothing needs your attention" body="Open returns, refunds, support tickets and delivery problems will show up here." action={<Button href="/help" variant="secondary">Contact support</Button>} /> : (
        <div className="space-y-5">
          {data.deliveryIssues.length > 0 && <Card className="p-5"><h3 className="font-bold">Delivery issues</h3><ul className="mt-2 divide-y divide-line text-sm">{data.deliveryIssues.map((d) => <li key={d.orderNumber + d.status} className="flex justify-between py-2"><Link href={`/orders/${d.orderNumber}`} className="font-semibold">{d.orderNumber}</Link><span>{d.late ? `Past estimated date (${when(d.estimatedDelivery)})` : d.status.toLowerCase()}</span></li>)}</ul></Card>}
          {data.returns.length > 0 && <Card className="p-5"><h3 className="font-bold">Open returns</h3><ul className="mt-2 divide-y divide-line text-sm">{data.returns.map((r) => <li key={r.id} className="flex items-center justify-between py-2"><span>{r.orderNumber} · {r.reason.replace(/_/g, ' ')}</span><StatusBadge status={r.status} /></li>)}</ul></Card>}
          {data.refunds.length > 0 && <Card className="p-5"><h3 className="font-bold">Refunds in progress</h3><ul className="mt-2 divide-y divide-line text-sm">{data.refunds.map((r) => <li key={r.id} className="flex items-center justify-between py-2"><span>{r.orderNumber} · {money(r.amount, r.currency)}</span><StatusBadge status={r.status} /></li>)}</ul></Card>}
          {data.tickets.length > 0 && <Card className="p-5"><h3 className="font-bold">Support tickets</h3><ul className="mt-2 divide-y divide-line text-sm">{data.tickets.map((t) => <li key={t.id} className="flex items-center justify-between py-2"><span>{t.subject}</span><StatusBadge status={t.status} /></li>)}</ul></Card>}
          {data.rescueCases.length > 0 && <Card className="p-5"><h3 className="font-bold">Order rescue</h3><ul className="mt-2 divide-y divide-line text-sm">{data.rescueCases.map((r) => <li key={r.id} className="flex items-center justify-between py-2"><span>{r.orderNumber ?? 'Order'} · {r.kind?.replace(/_/g, ' ') ?? 'case'}</span><StatusBadge status={r.status} /></li>)}</ul></Card>}
        </div>
      ))}
    </Frame>
  );
}
