'use client';
import * as React from 'react';
import { LifeBuoy } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Modal, StatusBadge, Tabs, Textarea } from '@orvia/ui';
import { ErrorBox, FilterSelect, Loading, PageHeader, Panel, SearchBox, Toolbar, cur, pctf, useAction, useAdmin, useFetch, usd, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface CaseRow { _id: string; orderNumber: string; kind: string; severity: string; state: string; title?: string; email: string; currency: string; lineValue: number; detectedAt: string; resolvedAt?: string; recommendedId?: string }
interface Option { id: string; kind: string; label: string; staffText: string; feasible: boolean; infeasibleReason?: string; materialChange: boolean; materialReasons: string[]; needsDuplicateAck: boolean; impact: { extraCost: number; refund: number; sunkCost: number; lostMargin: number; contributionDelta: number; exposure: number }; eta: { minDays: number | null; maxDays: number | null; worseningDays: number | null }; auth: { mode: string; reasons: string[]; requiresCustomerConsent: boolean; requiresStaffApproval: boolean; autoEligible: boolean } }
interface Detail {
  case: CaseRow & { evidence: { code: string; detail: string; provenance: string }[]; options: Option[]; recommendationReason?: string; aiExplanation?: { text?: string }; escalationReason?: string; alsoDetected: string[]; round: number };
  timeline: { _id: string; at: string; event: string; actorType: string; actorId: string; summary?: string }[];
  actions: { _id: string; kind: string; state: string; attempts: number; maxAttempts: number; lastError?: string; idempotencyKey: string }[];
  consents: { _id: string; optionId: string; status: string; expiresAt: string }[];
}
interface Kpis { days: number; detected: number; byKind: Record<string, number>; active: number; awaitingCustomer: number; awaitingStaff: number; escalated: number; resolved: number; autoResolved: number; autoResolvedPct: number | null; avgTimeToResolutionHours: number | null; costOfRecoveryUsd: number; costByCurrency: Record<string, { extraCost: number; refund: number }>; consentAcceptRate: number | null; consentSample: number }
interface Policy { enabled: boolean; autoExecuteEnabled: boolean; preApprovedSupplierIds: string[]; maxCostPerCaseUsd: number; maxCostPerDayUsd: number; costTolerancePct: number; maxEtaWorseningDays: number; maxPartialRefundPct: number; defaultPartialRefundPct: number; consentTtlHours: number; maxAttempts: number; maxAutoActionsPerDay: number; scanBatch: number; detection: { acceptanceGraceMinutes: number; delayGraceDays: number; lostAfterIdleDays: number; lostAfterOverdueDays: number; trackingGraceDays: number; fallbackPromiseDays: number } }

const label = (s: string) => s.replace(/_/g, ' ');
const KINDS = ['supplier_cancellation', 'stock_shortage', 'supplier_acceptance_failure', 'failed_delivery', 'suspected_lost', 'carrier_exception', 'invalid_tracking', 'shipment_delay', 'unusual_delivery_pattern'];
const STATES = ['detected', 'planned', 'awaiting_customer', 'awaiting_staff', 'executing', 'monitoring', 'escalated', 'resolved', 'closed'];

export default function RescuePage() {
  const [tab, setTab] = React.useState('cases');
  const [open, setOpen] = React.useState<string | null>(null);
  return (
    <>
      <PageHeader title="Delivery Rescue" subtitle="Detects failing deliveries and recovers them within a policy you control. Anything that changes the product, price or delivery terms needs the customer; money and unclear cases need you." />
      <Tabs tabs={[{ id: 'cases', label: 'Cases' }, { id: 'kpis', label: 'KPIs' }, { id: 'policy', label: 'Policy' }]} value={tab} onChange={setTab} className="mb-4" />
      {tab === 'cases' && <Cases onOpen={setOpen} />}
      {tab === 'kpis' && <KpiView />}
      {tab === 'policy' && <PolicyView />}
      {open && <CaseModal id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Cases({ onOpen }: { onOpen: (id: string) => void }) {
  const [state, setState] = React.useState('');
  const [kind, setKind] = React.useState('');
  const [active, setActive] = React.useState('true');
  const [q, setQ] = React.useState('');
  const [page, setPage] = React.useState(1);
  const qs = `page=${page}&pageSize=25${state ? `&state=${state}` : ''}${kind ? `&kind=${kind}` : ''}${!state && active ? `&active=${active}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const { data, error, loading, reload } = useFetch<{ items: CaseRow[]; total: number }>(`/admin/rescue/cases?${qs}`, 20_000);
  const { can } = useAdmin();
  const { run, busy } = useAction();
  return (
    <>
      <Toolbar>
        <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Order number" />
        <FilterSelect label="State" value={state} onChange={(v) => { setState(v); setPage(1); }} options={[['', 'All states'], ...STATES.map((s): [string, string] => [s, label(s)])]} />
        <FilterSelect label="Failure" value={kind} onChange={(v) => { setKind(v); setPage(1); }} options={[['', 'All failures'], ...KINDS.map((s): [string, string] => [s, label(s)])]} />
        <FilterSelect label="Scope" value={active} onChange={(v) => { setActive(v); setPage(1); }} options={[['true', 'Active'], ['', 'All'], ['false', 'Finished']]} />
        {can('rescue:write') && <Button size="sm" variant="secondary" loading={busy === 'scan'} onClick={() => run('scan', async () => { await api('/admin/rescue/scan', { body: {} }); await reload(); }, 'Scan complete')}>Scan now</Button>}
      </Toolbar>
      {error && !data && <ErrorBox message={error} retry={reload} />}
      {loading && !data && <Loading />}
      {data && data.items.length === 0 && <Card><EmptyState icon={<LifeBuoy className="size-6" />} title="No cases" body="No delivery problems match these filters. The scan runs every 10 minutes." /></Card>}
      <div className="space-y-2">
        {data?.items.map((c) => (
          <Card key={c._id} className="p-4">
            <button className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => onOpen(c._id)}>
              <StatusBadge status={c.severity} /><Badge tone="info">{label(c.kind)}</Badge><Badge>{label(c.state)}</Badge>
              <b className="text-sm">{c.orderNumber}</b><span className="truncate text-sm text-ink-3">{c.title}</span>
              <span className="ml-auto text-xs text-ink-3">{cur(c.lineValue, c.currency)} · {when(c.detectedAt)}</span>
            </button>
          </Card>
        ))}
      </div>
      {data && data.total > 25 && <div className="mt-4 flex items-center gap-2"><Button size="sm" variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button><span className="text-sm text-ink-3">Page {page} of {Math.ceil(data.total / 25)}</span><Button size="sm" variant="secondary" disabled={page * 25 >= data.total} onClick={() => setPage(page + 1)}>Next</Button></div>}
    </>
  );
}

function CaseModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error, loading, reload } = useFetch<Detail>(`/admin/rescue/cases/${id}`, 15_000);
  const { can } = useAdmin();
  const { run, busy } = useAction();
  const [note, setNote] = React.useState('');
  const [ack, setAck] = React.useState(false);
  const c = data?.case;
  const act = (action: string, optionId?: string) => run(action + (optionId ?? ''), async () => {
    await api(`/admin/rescue/cases/${id}/decision`, { body: { action, optionId, note, acknowledgeDuplicateRisk: ack || undefined } });
    setNote(''); await reload();
  }, 'Recorded');
  const active = !!c && !['resolved', 'closed'].includes(c.state);
  return (
    <Modal open onClose={onClose} title={c ? `${c.orderNumber}: ${label(c.kind)}` : 'Case'}>
      {error && !data && <ErrorBox message={error} retry={reload} />}
      {loading && !data && <Loading />}
      {c && data && (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap gap-2"><StatusBadge status={c.severity} /><Badge>{label(c.state)}</Badge><Badge>round {c.round}</Badge>{c.alsoDetected.map((k) => <Badge key={k} tone="info">also {label(k)}</Badge>)}</div>
          {c.escalationReason && <p className="rounded-md bg-warn-50 p-3">Escalated: {c.escalationReason}</p>}
          <Panel title="Evidence" pad>
            <ul className="space-y-1">{c.evidence.map((e, i) => <li key={i}><Badge>{e.provenance.replace(/_/g, ' ')}</Badge> {e.detail}</li>)}</ul>
          </Panel>
          <Panel title="Options" subtitle={c.recommendationReason ? `Recommended (deterministic): ${c.recommendationReason}` : undefined} pad>
            {c.aiExplanation?.text && <p className="mb-3 rounded-md bg-sunken p-3"><Badge>ai suggested</Badge> {c.aiExplanation.text}</p>}
            <div className="space-y-3">
              {c.options.map((o) => (
                <div key={o.id} className={`rounded-lg border p-3 ${o.id === c.recommendedId ? 'border-pine-600' : 'border-line'}`}>
                  <div className="flex flex-wrap items-center gap-2"><b>{o.label}</b>{o.id === c.recommendedId && <Badge tone="ok">recommended</Badge>}<Badge tone={o.auth.mode === 'auto' ? 'ok' : o.auth.mode === 'blocked' ? 'coral' : 'warn'}>{label(o.auth.mode)}</Badge>{o.materialChange && <Badge tone="warn">material change</Badge>}</div>
                  <p className="mt-1 text-ink-2">{o.staffText}</p>
                  {o.feasible ? (
                    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                      <div><dt className="text-xs text-ink-3">Extra cost</dt><dd>{cur(o.impact.extraCost, c.currency)}</dd></div>
                      <div><dt className="text-xs text-ink-3">Refund</dt><dd>{cur(o.impact.refund, c.currency)}</dd></div>
                      <div><dt className="text-xs text-ink-3">Margin impact</dt><dd>{cur(o.impact.contributionDelta, c.currency)}</dd></div>
                      <div><dt className="text-xs text-ink-3">ETA</dt><dd>{o.eta.maxDays === null ? '—' : `${o.eta.minDays}-${o.eta.maxDays}d (+${o.eta.worseningDays}d)`}</dd></div>
                    </dl>
                  ) : <p className="mt-1 text-ink-3">Not feasible: {o.infeasibleReason}</p>}
                  {o.auth.reasons.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-ink-3">{o.auth.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
                  {active && can('rescue:write') && o.feasible && o.kind !== 'escalate_human' && ['planned', 'awaiting_staff', 'awaiting_customer', 'escalated', 'monitoring', 'detected'].includes(c.state) && (
                    <div className="mt-2"><Button size="sm" variant={o.id === c.recommendedId ? 'primary' : 'secondary'} disabled={note.trim().length < 3 || (o.needsDuplicateAck && !ack)} loading={busy === (o.id === c.recommendedId ? 'approve' : 'override') + o.id} onClick={() => act(o.id === c.recommendedId ? 'approve' : 'override', o.id)}>{o.id === c.recommendedId ? 'Approve' : 'Override with this'}{o.auth.requiresCustomerConsent ? ' (asks customer)' : ''}</Button></div>
                  )}
                </div>
              ))}
            </div>
          </Panel>
          {active && can('rescue:write') && (
            <Panel title="Decision" pad>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (required, kept in the audit trail)" rows={2} aria-label="Reason" />
              <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I acknowledge the original parcel may still arrive (needed to reorder over a dispatched shipment)</label>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={note.trim().length < 3} loading={busy === 'escalate'} onClick={() => act('escalate')}>Escalate</Button>
                <Button size="sm" variant="secondary" loading={busy === 'replan'} disabled={note.trim().length < 3} onClick={() => act('replan')}>Re-plan</Button>
                <Button size="sm" variant="ghost" disabled={note.trim().length < 3} loading={busy === 'close'} onClick={() => act('close')}>Close case</Button>
              </div>
            </Panel>
          )}
          {data.actions.length > 0 && <Panel title="Actions" pad><ul className="space-y-1">{data.actions.map((a) => <li key={a._id}><Badge>{a.state}</Badge> {label(a.kind)} · attempts {a.attempts}/{a.maxAttempts}{a.lastError ? ` · ${a.lastError}` : ''}<br /><code className="text-xs text-ink-3">{a.idempotencyKey}</code></li>)}</ul></Panel>}
          {data.consents.length > 0 && <Panel title="Customer consent" pad><ul className="space-y-1">{data.consents.map((k) => <li key={k._id}><Badge>{k.status}</Badge> {k.optionId} · until {when(k.expiresAt)}</li>)}</ul></Panel>}
          <Panel title="Timeline (immutable)" pad>
            <ol className="space-y-1">{data.timeline.map((t) => <li key={t._id}><span className="text-xs text-ink-3">{when(t.at)} · {t.actorType}:{t.actorId}</span><br /><b>{label(t.event)}</b> {t.summary}</li>)}</ol>
          </Panel>
        </div>
      )}
    </Modal>
  );
}

function KpiView() {
  const [days, setDays] = React.useState('30');
  const { data, error, loading, reload } = useFetch<Kpis>(`/admin/rescue/kpis?days=${days}`, 60_000);
  const T = ({ l, v, s }: { l: string; v: string; s?: string }) => <Card className="p-4"><p className="text-xs text-ink-3">{l}</p><p className="text-2xl font-semibold tabular-nums">{v}</p>{s && <p className="text-xs text-ink-3">{s}</p>}</Card>;
  return (
    <>
      <Toolbar><FilterSelect label="Window" value={days} onChange={setDays} options={[['7', '7 days'], ['30', '30 days'], ['90', '90 days']]} /></Toolbar>
      {error && !data && <ErrorBox message={error} retry={reload} />}
      {loading && !data && <Loading />}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <T l="Cases detected" v={String(data.detected)} s={`${data.active} active in window`} />
            <T l="Auto-resolved" v={data.autoResolvedPct === null ? 'No data' : pctf(data.autoResolvedPct, 0)} s={`${data.autoResolved} of ${data.resolved} resolved`} />
            <T l="Avg time to resolution" v={data.avgTimeToResolutionHours === null ? 'No data' : `${data.avgTimeToResolutionHours.toFixed(1)} h`} />
            <T l="Cost of recovery" v={usd(data.costOfRecoveryUsd)} s="extra supplier cost + refunds, USD equiv." />
            <T l="Awaiting customer" v={String(data.awaitingCustomer)} />
            <T l="Awaiting staff" v={String(data.awaitingStaff)} />
            <T l="Escalated" v={String(data.escalated)} />
            <T l="Consent acceptance" v={data.consentAcceptRate === null ? 'No data' : pctf(data.consentAcceptRate, 0)} s={`${data.consentSample} decisions`} />
          </div>
          <Panel title="Detections by failure kind" pad className="mt-4">
            {Object.keys(data.byKind).length === 0 ? <p className="text-sm text-ink-3">None in this window.</p> : <ul className="space-y-1 text-sm">{Object.entries(data.byKind).map(([k, n]) => <li key={k}>{label(k)}: <b>{n}</b></li>)}</ul>}
          </Panel>
        </>
      )}
    </>
  );
}

function PolicyView() {
  const { data, error, loading, reload } = useFetch<Policy>('/admin/rescue/policy');
  const { can } = useAdmin();
  const { run, busy } = useAction();
  const [draft, setDraft] = React.useState<Policy | null>(null);
  const [reason, setReason] = React.useState('');
  React.useEffect(() => { if (data) setDraft(data); }, [data]);
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (loading || !draft) return <Loading />;
  const writable = can('rescue:write');
  const num = (k: keyof Policy, l: string, step = 1) => <label className="block text-sm">{l}<input type="number" step={step} disabled={!writable} className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2" value={draft[k] as number} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} /></label>;
  const det = (k: keyof Policy['detection'], l: string) => <label className="block text-sm">{l}<input type="number" disabled={!writable} className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2" value={draft.detection[k]} onChange={(e) => setDraft({ ...draft, detection: { ...draft.detection, [k]: Number(e.target.value) } })} /></label>;
  return (
    <Panel title="Authorization policy" subtitle="Defaults are conservative: only monitoring runs on its own until you enable automatic execution and pre-approve suppliers. Refunds and replacements are never automatic." pad>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!writable} checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Detection enabled</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!writable} checked={draft.autoExecuteEnabled} onChange={(e) => setDraft({ ...draft, autoExecuteEnabled: e.target.checked })} /> Allow automatic same-product reorder from pre-approved suppliers</label>
        {num('maxCostPerCaseUsd', 'Max cost per case (USD cents)')}
        {num('maxCostPerDayUsd', 'Max automatic cost per day (USD cents)')}
        {num('costTolerancePct', 'Cost tolerance vs original (0.25 = +25%)', 0.05)}
        {num('maxEtaWorseningDays', 'ETA worsening that counts as a material change (days)')}
        {num('defaultPartialRefundPct', 'Default partial refund (fraction of line)', 0.05)}
        {num('maxPartialRefundPct', 'Max partial refund (fraction of line)', 0.05)}
        {num('consentTtlHours', 'Consent link validity (hours)')}
        {num('maxAttempts', 'Attempts before dead-letter')}
        {num('maxAutoActionsPerDay', 'Max automatic actions per day')}
        {num('scanBatch', 'Max new cases per scan')}
        {det('acceptanceGraceMinutes', 'Acceptance grace (minutes)')}
        {det('delayGraceDays', 'Delay grace (days)')}
        {det('lostAfterIdleDays', 'Suspected lost: idle days')}
        {det('lostAfterOverdueDays', 'Suspected lost: days past ETA')}
        {det('trackingGraceDays', 'Missing tracking grace (days)')}
        {det('fallbackPromiseDays', 'Assumed promise when no ETA (days)')}
      </div>
      <label className="mt-4 block text-sm">Pre-approved supplier ids (one per line)
        <Textarea rows={3} disabled={!writable} value={draft.preApprovedSupplierIds.join('\n')} onChange={(e) => setDraft({ ...draft, preApprovedSupplierIds: e.target.value.split(/\s+/).filter(Boolean) })} />
      </label>
      {writable ? (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="grow text-sm">Reason for change (audited)<input className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <Button loading={busy === 'save'} disabled={reason.trim().length < 3} onClick={() => run('save', async () => { await api('/admin/rescue/policy', { method: 'PUT', body: { ...draft, reason } }); setReason(''); await reload(); }, 'Policy saved')}>Save policy</Button>
        </div>
      ) : <p className="mt-4 text-sm text-ink-3">You have read-only access (rescue:write is required to edit).</p>}
    </Panel>
  );
}
