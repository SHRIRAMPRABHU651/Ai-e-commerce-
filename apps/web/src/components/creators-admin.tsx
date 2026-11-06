'use client';
import * as React from 'react';
import { Badge, Button, DataTable, Field, Input, Tabs, Textarea } from '@orvia/ui';
import { api } from '@/lib/api';
import { ErrorBox, Loading, Panel, Toolbar, FilterSelect, useAction, useAdmin, useFetch, when } from './admin/kit';

const money = (minor: number, c: string) => new Intl.NumberFormat(c === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: c }).format(minor / 100);
interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
interface CreatorRow { id: string; handle: string; displayName: string; email: string; status: string; appliedAt: string; audience: string; bio: string; socialLinks: { platform: string; url: string }[]; rateOverride: number | null; payoutsHeld: boolean; payout: { kycStatus: string; taxInfoCollected: boolean }; performance: { clicks: number; orders: number; refundRate: number | null; netSales: Record<string, number>; commission: Record<string, { accrued: number; payable: number; paid: number }> } }

/** Staff review UI for creators, commissions, payouts, fraud, referrals, loyalty and comments. Every action is permission-gated server-side and audited. */
export function CreatorsAdmin() {
  const { can } = useAdmin();
  const [tab, setTab] = React.useState('applications');
  const overview = useFetch<{ pendingApplications: number; approvedCreators: number; openFlags: number; openPayouts: number; pendingComments: number; referralCodes: number }>('/admin/creators/overview');
  const o = overview.data;
  return (
    <div className="space-y-4">
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'applications', label: 'Applications', count: o?.pendingApplications }, { id: 'creators', label: 'Creators', count: o?.approvedCreators }, { id: 'rules', label: 'Commission rules' },
        { id: 'payouts', label: 'Payouts', count: o?.openPayouts }, { id: 'fraud', label: 'Fraud review', count: o?.openFlags }, { id: 'referrals', label: 'Referrals' }, { id: 'loyalty', label: 'Loyalty' }, { id: 'comments', label: 'Comments', count: o?.pendingComments },
      ]} />
      {overview.error && <ErrorBox message={overview.error} retry={overview.reload} />}
      {tab === 'applications' && <Creators status="pending" onChange={overview.reload} canWrite={can('creators:write')} />}
      {tab === 'creators' && <Creators status="" onChange={overview.reload} canWrite={can('creators:write')} />}
      {tab === 'rules' && <Rules canWrite={can('creators:write')} />}
      {tab === 'payouts' && <Payouts canWrite={can('creators:write')} onChange={overview.reload} />}
      {tab === 'fraud' && <Flags canWrite={can('creators:write')} onChange={overview.reload} />}
      {tab === 'referrals' && <Referrals />}
      {tab === 'loyalty' && (can('loyalty:read') ? <LoyaltyAdmin canWrite={can('loyalty:write')} /> : <p className="text-sm text-ink-3">You don’t have access to loyalty.</p>)}
      {tab === 'comments' && <Comments canWrite={can('creators:write')} onChange={overview.reload} />}
    </div>
  );
}

function Creators({ status, onChange, canWrite }: { status: string; onChange: () => void; canWrite: boolean }) {
  const [page, setPage] = React.useState(1);
  const [filter, setFilter] = React.useState(status);
  const [q, setQ] = React.useState('');
  const { data, error, loading, reload } = useFetch<Page<CreatorRow>>(`/admin/creators?page=${page}&pageSize=20${filter ? `&status=${filter}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const { run, busy } = useAction();
  const [open, setOpen] = React.useState<CreatorRow | null>(null);
  const [note, setNote] = React.useState('');
  const act = (key: string, fn: () => Promise<unknown>, ok: string) => run(key, fn, ok).then(() => { setOpen(null); setNote(''); reload(); onChange(); });
  return (
    <div className="space-y-3">
      <Toolbar>
        {status === '' && <FilterSelect label="Status" value={filter} onChange={(v) => { setFilter(v); setPage(1); }} options={[['', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['suspended', 'Suspended']]} />}
        <Input aria-label="Search handle" placeholder="Handle prefix" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="w-48" />
      </Toolbar>
      {error && <ErrorBox message={error} retry={reload} />}
      <DataTable<CreatorRow> rows={data?.items} loading={loading} rowKey={(r) => r.id} page={page} pageSize={20} total={data?.total} onPage={setPage} onRowClick={setOpen}
        empty={{ title: status === 'pending' ? 'No applications waiting' : 'No creators yet' }}
        columns={[
          { key: 'h', header: 'Creator', render: (r) => <span><strong>@{r.handle}</strong><span className="block text-xs text-ink-3">{r.email}</span></span> },
          { key: 's', header: 'Status', render: (r) => <Badge tone={r.status === 'approved' ? 'pine' : r.status === 'pending' ? 'saffron' : 'coral'}>{r.status}</Badge> },
          { key: 'c', header: 'Clicks 90d', align: 'right', hideBelow: 'md', render: (r) => r.performance.clicks },
          { key: 'o', header: 'Orders 90d', align: 'right', hideBelow: 'md', render: (r) => r.performance.orders },
          { key: 'n', header: 'Net sales', align: 'right', hideBelow: 'lg', render: (r) => Object.entries(r.performance.netSales).map(([c, v]) => money(v, c)).join(' · ') || '—' },
          { key: 'ca', header: 'Commission accrued / paid', align: 'right', hideBelow: 'lg', render: (r) => Object.entries(r.performance.commission).map(([c, v]) => `${money(v.accrued + v.payable, c)} / ${money(v.paid, c)}`).join(' · ') || '—' },
          { key: 'rr', header: 'Refund rate', align: 'right', hideBelow: 'lg', render: (r) => (r.performance.refundRate === null ? 'n/a' : `${(r.performance.refundRate * 100).toFixed(0)}%`) },
        ]} />
      {open && (
        <Panel title={`@${open.handle}`} subtitle={`${open.displayName} · applied ${when(open.appliedAt)}`} action={<Button size="sm" variant="secondary" onClick={() => setOpen(null)}>Close</Button>}>
          <p className="whitespace-pre-wrap text-sm">{open.bio || 'No bio'}</p>
          {open.audience && <p className="mt-2 text-sm text-ink-3">Audience: {open.audience}</p>}
          <ul className="mt-2 text-sm">{open.socialLinks.map((l) => <li key={l.url}>{l.platform}: <a className="underline" href={l.url} rel="nofollow noopener noreferrer" target="_blank">{l.url}</a></li>)}</ul>
          <p className="mt-2 text-sm">KYC: <Badge>{open.payout.kycStatus}</Badge> · Tax info collected: <Badge>{open.payout.taxInfoCollected ? 'yes' : 'no'}</Badge> · Rate override: {open.rateOverride === null ? 'none' : `${(open.rateOverride * 100).toFixed(2)}%`} {open.payoutsHeld && <Badge tone="coral">payouts held</Badge>}</p>
          {canWrite && (
            <div className="mt-4 space-y-3">
              <Field label="Note (shown to the creator on rejection)"><Textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <div className="flex flex-wrap gap-2">
                {open.status === 'pending' && <><Button loading={busy === 'ap'} onClick={() => void act('ap', () => api(`/admin/creators/${open.id}/review`, { body: { decision: 'approve', note } }), 'Approved')}>Approve</Button>
                  <Button variant="secondary" loading={busy === 'rj'} onClick={() => void act('rj', () => api(`/admin/creators/${open.id}/review`, { body: { decision: 'reject', note } }), 'Rejected')}>Reject</Button></>}
                {open.status === 'approved' && <Button variant="secondary" onClick={() => void act('su', () => api(`/admin/creators/${open.id}/status`, { body: { status: 'suspended', reason: note } }), 'Suspended')}>Suspend</Button>}
                {open.status === 'suspended' && <Button variant="secondary" onClick={() => void act('re', () => api(`/admin/creators/${open.id}/status`, { body: { status: 'approved' } }), 'Reinstated')}>Reinstate</Button>}
                {open.status === 'approved' && <>
                  <Button variant="secondary" onClick={() => void act('kyc', () => api(`/admin/creators/${open.id}/terms`, { method: 'PATCH', body: { kycStatus: 'verified', taxInfoCollected: true, ...(note ? { kycReference: note.slice(0, 80) } : {}) } }), 'Payout checklist marked complete')}>Mark KYC + tax collected</Button>
                  <Button variant="secondary" onClick={() => void act('hold', () => api(`/admin/creators/${open.id}/hold`, { body: { held: !open.payoutsHeld, reason: note } }), open.payoutsHeld ? 'Payouts released' : 'Payouts held')}>{open.payoutsHeld ? 'Release payout hold' : 'Hold payouts'}</Button></>}
              </div>
              <p className="text-xs text-ink-3">Only the fact that identity/tax information was collected, plus an opaque reference, is stored. Never type ID numbers or bank details here.</p>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

function Rules({ canWrite }: { canWrite: boolean }) {
  const { data, error, loading, reload } = useFetch<{ rules: Record<string, unknown> }>('/admin/creators/rules');
  const { run, busy } = useAction();
  const [text, setText] = React.useState('');
  React.useEffect(() => { if (data) setText(JSON.stringify(data.rules, null, 2)); }, [data]);
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? 'Unavailable'} retry={reload} />;
  return (
    <Panel title="Commission rules" subtitle="Percent of the NET base (after discounts, ex tax and shipping, after refunds). Amounts are minor units (cents/paise).">
      <Textarea aria-label="Rules JSON" rows={22} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} disabled={!canWrite} />
      {canWrite && <div className="mt-3 flex gap-2"><Button loading={busy === 'save'} onClick={() => { let parsed: unknown; try { parsed = JSON.parse(text); } catch { void run('x', () => Promise.reject(new Error('Invalid JSON'))); return; } void run('save', () => api('/admin/creators/rules', { method: 'PUT', body: parsed }), 'Rules saved (audited)').then(reload); }}>Save rules</Button></div>}
      <p className="mt-3 text-xs text-ink-3">Fields: defaultRate, categoryRates, minOrderNet, maxPerOrder, maxShareOfContribution, tiers, holdBufferDays, escalatedHoldDays, refundRateHold, attributionDays, payoutThreshold, velocity limits. Invalid values are rejected with field errors. Changes apply to future accruals only.</p>
    </Panel>
  );
}

interface PayoutRow { id: string; handle: string; currency: string; amount: number; status: string; requestedAt: string; entryCount: number; checklist: Record<string, boolean> | null }
function Payouts({ canWrite, onChange }: { canWrite: boolean; onChange: () => void }) {
  const [status, setStatus] = React.useState('requested');
  const [page, setPage] = React.useState(1);
  const { data, error, loading, reload } = useFetch<Page<PayoutRow>>(`/admin/creators/payouts?status=${status}&page=${page}&pageSize=20`);
  const { run, busy } = useAction();
  const [ref, setRef] = React.useState('');
  const after = () => { reload(); onChange(); };
  return (
    <div className="space-y-3">
      <Toolbar><FilterSelect label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[['requested', 'Requested'], ['approved', 'Approved (awaiting transfer)'], ['paid', 'Paid'], ['rejected', 'Rejected'], ['all', 'All']]} /></Toolbar>
      <p className="text-xs text-ink-3">Transfers are made manually in your bank/PSP console. Record the method and external reference after you have sent the money; nothing here moves funds.</p>
      {error && <ErrorBox message={error} retry={reload} />}
      <DataTable<PayoutRow> rows={data?.items} loading={loading} rowKey={(r) => r.id} page={page} pageSize={20} total={data?.total} onPage={setPage} empty={{ title: 'No payouts in this state' }}
        columns={[
          { key: 'h', header: 'Creator', render: (r) => `@${r.handle}` }, { key: 'a', header: 'Amount', align: 'right', render: (r) => money(r.amount, r.currency) },
          { key: 'e', header: 'Entries', align: 'right', hideBelow: 'md', render: (r) => r.entryCount }, { key: 'd', header: 'Requested', hideBelow: 'md', render: (r) => when(r.requestedAt) },
          { key: 'c', header: 'Checklist', hideBelow: 'lg', render: (r) => (r.checklist ? Object.entries(r.checklist).map(([k, v]) => <Badge key={k} tone={v ? 'pine' : 'coral'} className="mr-1">{k.replace('Ok', '').replace('noOpenFlags', 'no flags')}</Badge>) : '—') },
          { key: 's', header: 'Status', render: (r) => <Badge>{r.status}</Badge> },
          { key: 'x', header: '', render: (r) => canWrite && (
            <span className="flex flex-wrap gap-1">
              {r.status === 'requested' && <><Button size="sm" loading={busy === `a${r.id}`} onClick={() => void run(`a${r.id}`, () => api(`/admin/creators/payouts/${r.id}/approve`, { body: {} }), 'Approved').then(after)}>Approve</Button>
                <Button size="sm" variant="secondary" onClick={() => { const reason = window.prompt('Reason for rejection'); if (reason) void run(`r${r.id}`, () => api(`/admin/creators/payouts/${r.id}/reject`, { body: { reason } }), 'Rejected').then(after); }}>Reject</Button></>}
              {r.status === 'approved' && <><Input aria-label="External transfer reference" placeholder="Transfer reference" value={ref} onChange={(e) => setRef(e.target.value)} className="h-8 w-40" />
                <Button size="sm" disabled={ref.trim().length < 3} loading={busy === `p${r.id}`} onClick={() => void run(`p${r.id}`, () => api(`/admin/creators/payouts/${r.id}/paid`, { body: { method: 'bank_transfer', externalReference: ref.trim() } }), 'Recorded as paid').then(() => { setRef(''); after(); })}>Mark paid</Button></>}
            </span>) },
        ]} />
    </div>
  );
}

interface FlagRow { id: string; handle: string; orderId: string | null; kind: string; severity: string; detail: string; status: string; resolution: string | null }
function Flags({ canWrite, onChange }: { canWrite: boolean; onChange: () => void }) {
  const [status, setStatus] = React.useState('open');
  const [page, setPage] = React.useState(1);
  const { data, error, loading, reload } = useFetch<Page<FlagRow>>(`/admin/creators/flags?status=${status}&page=${page}&pageSize=20`);
  const { run } = useAction();
  const resolve = (f: FlagRow, resolution: 'cleared' | 'confirmed') => {
    const note = window.prompt(resolution === 'confirmed' ? 'Confirm fraud: the commission for this order is reversed. Add a note' : 'Why is this a false positive?');
    if (note && note.trim().length >= 3) void run(`f${f.id}`, () => api(`/admin/creators/flags/${f.id}/resolve`, { body: { resolution, note } }), resolution === 'confirmed' ? 'Confirmed, commission reversed' : 'Cleared').then(() => { reload(); onChange(); });
  };
  return (
    <div className="space-y-3">
      <Toolbar><FilterSelect label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[['open', 'Open'], ['confirmed', 'Confirmed'], ['cleared', 'Cleared'], ['all', 'All']]} /></Toolbar>
      {error && <ErrorBox message={error} retry={reload} />}
      <DataTable<FlagRow> rows={data?.items} loading={loading} rowKey={(r) => r.id} page={page} pageSize={20} total={data?.total} onPage={setPage} empty={{ title: 'Nothing to review', body: 'Flags appear when attribution looks suspicious. Commissions with an open flag are not released.' }}
        columns={[
          { key: 'h', header: 'Creator', render: (r) => `@${r.handle}` }, { key: 'k', header: 'Signal', render: (r) => r.kind.replace(/_/g, ' ') },
          { key: 'sv', header: 'Severity', render: (r) => <Badge tone={r.severity === 'high' ? 'coral' : 'saffron'}>{r.severity}</Badge> }, { key: 'd', header: 'Detail', hideBelow: 'md', render: (r) => r.detail },
          { key: 's', header: 'Status', render: (r) => r.status },
          { key: 'x', header: '', render: (r) => canWrite && r.status === 'open' && <span className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => resolve(r, 'cleared')}>Clear</Button><Button size="sm" onClick={() => resolve(r, 'confirmed')}>Confirm fraud</Button></span> },
        ]} />
    </div>
  );
}

interface RefRow { id: string; referrerEmail: string; refereeEmail: string; code: string; status: string; reason: string | null; rewardCode: string | null; at: string }
function Referrals() {
  const [status, setStatus] = React.useState('');
  const [page, setPage] = React.useState(1);
  const { data, error, loading, reload } = useFetch<Page<RefRow> & { totals: { codes: number; rewarded: number; rejected: number }; rejectionReasons: { reason: string; count: number }[] }>(`/admin/creators/referrals?page=${page}&pageSize=20${status ? `&status=${status}` : ''}`);
  return (
    <div className="space-y-3">
      {data && <div className="flex flex-wrap gap-2 text-sm"><Badge>{data.totals.codes} codes</Badge><Badge tone="pine">{data.totals.rewarded} rewarded</Badge><Badge tone="coral">{data.totals.rejected} rejected</Badge>{data.rejectionReasons.map((r) => <Badge key={r.reason} tone="saffron">{r.reason.replace(/_/g, ' ')}: {r.count}</Badge>)}</div>}
      <Toolbar><FilterSelect label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[['', 'All'], ['rewarded', 'Rewarded'], ['rejected', 'Rejected']]} /></Toolbar>
      {error && <ErrorBox message={error} retry={reload} />}
      <DataTable<RefRow> rows={data?.items} loading={loading} rowKey={(r) => r.id} page={page} pageSize={20} total={data?.total} onPage={setPage} empty={{ title: 'No referrals settled yet' }}
        columns={[{ key: 'r', header: 'Referrer', render: (r) => r.referrerEmail }, { key: 'f', header: 'Friend', hideBelow: 'md', render: (r) => r.refereeEmail }, { key: 's', header: 'Outcome', render: (r) => <Badge tone={r.status === 'rewarded' ? 'pine' : 'coral'}>{r.status}</Badge> }, { key: 'w', header: 'Reason / reward', render: (r) => (r.reason ?? r.rewardCode ?? '').replace(/_/g, ' ') }, { key: 't', header: 'When', hideBelow: 'lg', render: (r) => when(r.at) }]} />
    </div>
  );
}

interface LoyRow { userId: string; email: string; name: string; points: number; lastActivity: string }
function LoyaltyAdmin({ canWrite }: { canWrite: boolean }) {
  const [q, setQ] = React.useState('');
  const [page, setPage] = React.useState(1);
  const { data, error, loading, reload } = useFetch<Page<LoyRow>>(`/admin/loyalty/accounts?page=${page}&pageSize=20${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const { run } = useAction();
  const adjust = (r: LoyRow) => {
    const pts = Number(window.prompt(`Adjust points for ${r.email} (use a negative number to deduct)`));
    if (!Number.isInteger(pts) || pts === 0) return;
    const reason = window.prompt('Reason (recorded in the audit log)');
    if (reason && reason.trim().length >= 5) void run(`l${r.userId}`, () => api('/admin/loyalty/adjust', { body: { userId: r.userId, points: pts, reason } }), 'Adjusted').then(reload);
  };
  return (
    <div className="space-y-3">
      <Toolbar><Input aria-label="Search by email prefix" placeholder="Email prefix" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="w-56" /></Toolbar>
      {error && <ErrorBox message={error} retry={reload} />}
      <DataTable<LoyRow> rows={data?.items} loading={loading} rowKey={(r) => r.userId} page={page} pageSize={20} total={data?.total} onPage={setPage} empty={{ title: 'No loyalty activity yet' }}
        columns={[{ key: 'e', header: 'Customer', render: (r) => <span>{r.name}<span className="block text-xs text-ink-3">{r.email}</span></span> }, { key: 'p', header: 'Points', align: 'right', render: (r) => r.points }, { key: 'l', header: 'Last activity', hideBelow: 'md', render: (r) => when(r.lastActivity) }, { key: 'x', header: '', render: (r) => canWrite && <Button size="sm" variant="secondary" onClick={() => adjust(r)}>Adjust</Button> }]} />
    </div>
  );
}

interface CommentRow { id: string; displayName: string; body: string; status: string; reportCount: number; reasons: string[] }
function Comments({ canWrite, onChange }: { canWrite: boolean; onChange: () => void }) {
  const [status, setStatus] = React.useState('pending');
  const [page, setPage] = React.useState(1);
  const { data, error, loading, reload } = useFetch<Page<CommentRow>>(`/admin/creators/comments?status=${status}&page=${page}&pageSize=20`);
  const { run } = useAction();
  const mod = (id: string, decision: string) => void run(`c${id}`, () => api(`/admin/creators/comments/${id}/moderate`, { body: { decision } }), 'Done').then(() => { reload(); onChange(); });
  return (
    <div className="space-y-3">
      <Toolbar><FilterSelect label="Queue" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[['pending', 'Awaiting review'], ['reported', 'Reported'], ['published', 'Published'], ['rejected', 'Rejected']]} /></Toolbar>
      {error && <ErrorBox message={error} retry={reload} />}
      <DataTable<CommentRow> rows={data?.items} loading={loading} rowKey={(r) => r.id} page={page} pageSize={20} total={data?.total} onPage={setPage} empty={{ title: 'Queue is empty' }}
        columns={[{ key: 'n', header: 'Author', render: (r) => r.displayName }, { key: 'b', header: 'Comment', render: (r) => <span className="block max-w-md whitespace-pre-wrap break-words">{r.body}</span> }, { key: 'r', header: 'Reports', align: 'right', render: (r) => (r.reportCount ? `${r.reportCount} (${r.reasons.join(', ')})` : '0') },
          { key: 'x', header: '', render: (r) => canWrite && <span className="flex gap-1">{r.status !== 'published' && <Button size="sm" onClick={() => mod(r.id, 'published')}>Publish</Button>}<Button size="sm" variant="secondary" onClick={() => mod(r.id, r.status === 'published' ? 'removed' : 'rejected')}>{r.status === 'published' ? 'Remove' : 'Reject'}</Button></span> }]} />
    </div>
  );
}
