'use client';
import * as React from 'react';
import { Badge, Button, DataTable, Modal, Select, Textarea } from '@orvia/ui';
import type { Column, Tone } from '@orvia/ui';
import { ErrorBox, FilterSelect, Loading, PageHeader, Panel, Toolbar, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface Tool { name: string; sideEffect: string; audience: string[]; permission: string | null; requiresConfirmation: boolean; description: string }
interface Agent {
  id: string; name: string; purpose: string; audience: 'customer_facing' | 'staff'; enabled: boolean; disabledReason: string | null; disabledBy: string | null; disabledAt: string | null;
  status: 'ready' | 'needs_api_key' | 'killed'; needsApiKey: boolean; mode: string; modelChain: string[]; tools: Tool[];
  limits: { timeoutMs: number; maxSteps: number; maxToolCalls: number; retryLimit: number; minConfidence: number; budget: { perCallTokens: number; perDayTokens: number; perDayCostMicros: number } };
  usageToday: { runs: number; modelCalls: number; cacheHits: number; tokens: number; costMicros: number; budgetStops: number; tokenPct: number; costPct: number };
}
interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
interface RunRow { _id: string; agentId: string; actorType: string; outcome: string; source: string; models: string[]; tokens: number; costMicros: number; modelCalls: number; cacheHits: number; flags: string[]; createdAt: string; durationMs: number; confidence?: number; escalationId?: string }
interface RunDetail extends RunRow { inputRedacted: string; outputRedacted: string; inputHash: string; notes: string[]; steps: number; toolCalls: { tool: string; sideEffect: string; argsSummary: string; outcome: string; reason?: string; ms: number; outputBytes: number }[]; requestId?: string }
interface Escalation { _id: string; agentId: string; reason: string; status: string; summary: string; orderNumber?: string; createdAt: string; resolvedBy?: string; resolutionNote?: string; context?: Record<string, unknown> }
interface Replacement { _id: string; orderNumber: string; sku: string; quantity: number; reason: string; details: string; state: string; createdAt: string; decisionNote?: string }
interface Usage { items: { agentId: string; day: string; runs: number; modelCalls: number; cacheHits: number; tokens: number; costMicros: number; budgetStops: number }[]; note: string }
type Metric = { status: 'ok'; value: number; n: number } | { status: 'insufficient_data'; n: number; needed: number };
interface Metrics { minSample: number; cases: number; resolved: number; satisfaction: Metric; firstContactResolution: Metric; refundAccuracy: { kindMatch: Metric; exactAmount: Metric }; retention: Metric; definitions: Record<string, string> }
interface StaffOut { summary: string; findings: { title: string; detail: string; severity: string; evidence: string[] }[]; recommendations: { action: string; rationale: string }[]; confidence: number; dataGaps: string[] }
interface RunResult { runId: string | null; outcome: string; output: StaffOut | null; source: string; aiUsed: boolean; notes: string[]; escalated: boolean; usage: { tokens: number; costMicros: number; modelCalls: number; cacheHits: number }; toolCalls: { tool: string; outcome: string; reason: string | null }[] }

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;
const pc = (x: number) => `${Math.round(x * 100)}%`;
const outcomeTone = (o: string): Tone => (o === 'success' ? 'ok' : o === 'fallback' || o === 'awaiting_confirmation' ? 'info' : o === 'escalated' || o === 'budget_stopped' ? 'warn' : o === 'error' || o === 'killed' || o === 'refused' ? 'coral' : 'neutral');
const statusTone = (s: Agent['status']): Tone => (s === 'ready' ? 'ok' : s === 'needs_api_key' ? 'warn' : 'coral');
const effectTone = (e: string): Tone => (e === 'read' ? 'neutral' : e === 'propose' ? 'info' : 'warn');
const sevTone = (s: string): Tone => (s === 'attention' ? 'coral' : s === 'watch' ? 'warn' : 'neutral');
const label = (s: string) => s.replace(/_/g, ' ');
const OUTCOMES: [string, string][] = [['', 'All outcomes'], ['success', 'Success'], ['fallback', 'Fallback'], ['escalated', 'Escalated'], ['awaiting_confirmation', 'Awaiting confirmation'], ['budget_stopped', 'Budget stopped'], ['refused', 'Refused'], ['killed', 'Killed'], ['error', 'Error']];
const ACTORS: [string, string][] = [['', 'All actors'], ['guest', 'Guests'], ['customer', 'Customers'], ['staff', 'Staff'], ['system', 'System']];

function Bar({ pct, warn }: { pct: number; warn?: boolean }) {
  return <div className="h-2 w-full rounded bg-sunken" role="progressbar" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}><div className={`h-2 rounded ${warn || pct >= 0.9 ? 'bg-coral-500' : 'bg-pine-600'}`} style={{ width: `${Math.max(2, Math.round(pct * 100))}%` }} /></div>;
}

function RunModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { run, busy } = useAction();
  const [focus, setFocus] = React.useState('');
  const [days, setDays] = React.useState('30');
  const [res, setRes] = React.useState<RunResult | null>(null);
  const go = () => run('run', async () => { setRes(await api<RunResult>(`/admin/agents/${agent.id}/run`, { body: { ...(focus.trim() ? { focus: focus.trim() } : {}), days: Number(days) } })); });
  return (
    <Modal open onClose={onClose} title={`Run: ${agent.name}`} size="lg" footer={<Button onClick={go} loading={busy === 'run'}>Run now</Button>}>
      <p className="mb-3 text-sm text-ink-3">Read-only. The agent reads existing services with your permissions and returns a structured summary. It cannot change anything; every recommendation needs your approval. The run is audited.</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <label className="text-sm font-bold">Focus (optional, treated as data)<Textarea value={focus} onChange={(e) => setFocus(e.target.value)} maxLength={500} className="mt-1 min-h-16 font-normal" placeholder="e.g. why did refunds go up last week?" /></label>
        <label className="text-sm font-bold">Days<Select value={days} onChange={(e) => setDays(e.target.value)} className="mt-1 font-normal">{['7', '14', '30', '90'].map((d) => <option key={d} value={d}>{d}</option>)}</Select></label>
      </div>
      {res && (
        <div className="mt-4 space-y-3" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2 text-xs"><Badge tone={outcomeTone(res.outcome)}>{label(res.outcome)}</Badge><Badge tone={res.aiUsed ? 'pine' : 'neutral'}>{res.aiUsed ? 'AI-worded' : 'deterministic'}</Badge>{res.output && <span className="text-ink-3">confidence {pc(res.output.confidence)}</span>}<span className="text-ink-3">{res.usage.tokens} tokens est., {usd(res.usage.costMicros)}</span>{res.escalated && <Badge tone="warn">escalated to queue</Badge>}</div>
          {res.output ? (
            <>
              <p className="text-sm">{res.output.summary}</p>
              {res.output.findings.map((f, i) => <div key={i} className="rounded-lg border border-line p-3"><p className="text-sm font-bold">{f.title} <Badge tone={sevTone(f.severity)}>{f.severity}</Badge></p><p className="mt-1 text-sm text-ink-2">{f.detail}</p>{f.evidence.length > 0 && <p className="mt-1 text-xs text-ink-3">Evidence: {f.evidence.join(', ')}</p>}</div>)}
              {res.output.recommendations.length > 0 && <div><h4 className="text-sm font-bold">Recommendations (need human approval)</h4><ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{res.output.recommendations.map((r, i) => <li key={i}><b>{r.action}</b> <span className="text-ink-3">{r.rationale}</span></li>)}</ul></div>}
              {res.output.dataGaps.length > 0 && <div><h4 className="text-sm font-bold">Data gaps</h4><ul className="mt-1 list-disc pl-5 text-xs text-ink-3">{res.output.dataGaps.map((g, i) => <li key={i}>{g}</li>)}</ul></div>}
            </>
          ) : <p className="text-sm text-ink-3">No output. {res.notes.join(' ')}</p>}
          {res.notes.length > 0 && res.output && <p className="text-xs text-ink-3">Notes: {res.notes.join(' · ')}</p>}
        </div>
      )}
    </Modal>
  );
}

function KillModal({ agent, onClose, onDone }: { agent: Agent; onClose: () => void; onDone: () => void }) {
  const { run, busy } = useAction();
  const [reason, setReason] = React.useState('');
  const enabling = !agent.enabled;
  const go = () => run('kill', async () => { await api(`/admin/agents/${agent.id}/kill`, { body: { enabled: enabling, reason: reason.trim() } }); onDone(); onClose(); }, enabling ? 'Agent switched on' : 'Agent switched off');
  return (
    <Modal open onClose={onClose} title={`${enabling ? 'Switch on' : 'Switch off'}: ${agent.name}`} footer={<Button variant={enabling ? 'primary' : 'danger'} loading={busy === 'kill'} disabled={reason.trim().length < 3} onClick={go}>{enabling ? 'Switch on' : 'Switch off'}</Button>}>
      <p className="mb-2 text-sm text-ink-3">{enabling ? 'The agent will accept runs again.' : agent.audience === 'customer_facing' ? 'Customers will see that the assistant is switched off and are pointed to support.' : 'Admin runs of this agent will be refused.'} The change is recorded in the audit log with your reason.</p>
      <label className="text-sm font-bold">Reason<Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="mt-1 min-h-16 font-normal" /></label>
    </Modal>
  );
}

function AgentCard({ a, canWrite, onRun, onKill }: { a: Agent; canWrite: boolean; onRun: () => void; onKill: () => void }) {
  return (
    <Panel title={a.name} subtitle={a.audience === 'customer_facing' ? 'Customer-facing' : 'Staff-facing'} action={<Badge tone={statusTone(a.status)}>{a.status === 'needs_api_key' ? 'needs API key' : a.status}</Badge>}>
      <p className="text-sm text-ink-2">{a.purpose}</p>
      <p className="mt-2 text-xs text-ink-3">{a.mode}. Model chain: {a.needsApiKey ? <span>{a.modelChain.join(' → ')} (inactive; templates only)</span> : a.modelChain.join(' → ')} → deterministic template.</p>
      {!a.enabled && <p className="mt-2 rounded bg-coral-50 p-2 text-xs text-coral-700">Switched off{a.disabledBy ? ` by ${a.disabledBy}` : ''}{a.disabledAt ? ` on ${when(a.disabledAt)}` : ''}: {a.disabledReason}</p>}
      <details className="mt-3"><summary className="cursor-pointer text-sm font-bold">Tools ({a.tools.length}) and limits</summary>
        <ul className="mt-2 space-y-1 text-xs">{a.tools.map((t) => <li key={t.name}><code>{t.name}</code> <Badge tone={effectTone(t.sideEffect)}>{label(t.sideEffect)}</Badge>{t.requiresConfirmation && <Badge tone="warn">customer confirms</Badge>}{t.permission && <span className="text-ink-3"> needs {t.permission}</span>}<span className="block text-ink-3">{t.description}</span></li>)}</ul>
        <p className="mt-2 text-xs text-ink-3">Timeout {a.limits.timeoutMs / 1000}s · max {a.limits.maxSteps} steps · {a.limits.maxToolCalls} tool calls · {a.limits.retryLimit} retry · escalate below {pc(a.limits.minConfidence)} confidence · {a.limits.budget.perCallTokens} tokens/call · {a.limits.budget.perDayTokens} tokens/day · {usd(a.limits.budget.perDayCostMicros)}/day</p>
      </details>
      <div className="mt-3 space-y-1 text-xs text-ink-3">
        <div className="flex justify-between"><span>Tokens today (est.)</span><span>{a.usageToday.tokens} / {a.limits.budget.perDayTokens}</span></div><Bar pct={a.usageToday.tokenPct} />
        <div className="flex justify-between"><span>Cost today (est.)</span><span>{usd(a.usageToday.costMicros)} / {usd(a.limits.budget.perDayCostMicros)}</span></div><Bar pct={a.usageToday.costPct} />
        <p>{a.usageToday.runs} run(s), {a.usageToday.modelCalls} model call(s), {a.usageToday.cacheHits} cache hit(s){a.usageToday.budgetStops ? `, ${a.usageToday.budgetStops} budget stop(s)` : ''}</p>
      </div>
      {canWrite && <div className="mt-3 flex flex-wrap gap-2">{a.audience === 'staff' && a.enabled && <Button size="sm" onClick={onRun}>Run</Button>}<Button size="sm" variant={a.enabled ? 'danger' : 'primary'} onClick={onKill}>{a.enabled ? 'Kill switch' : 'Switch on'}</Button></div>}
    </Panel>
  );
}

function RunDetailView({ id }: { id: string }) {
  const { data, error, loading } = useFetch<RunDetail>(`/admin/agents/runs/${id}`);
  if (loading) return <Loading rows={2} />;
  if (error || !data) return <ErrorBox message={error ?? 'Not found'} />;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-2"><Badge tone={outcomeTone(data.outcome)}>{label(data.outcome)}</Badge><Badge>{data.agentId}</Badge><Badge>{data.actorType}</Badge><Badge>{data.source}</Badge>{data.models.map((m) => <Badge key={m} tone="pine">{m}</Badge>)}</div>
      <p className="text-xs text-ink-3">{when(data.createdAt)} · {data.durationMs} ms · {data.steps} step(s) · {data.tokens} tokens est. · {usd(data.costMicros)} · {data.modelCalls} model call(s) · {data.cacheHits} cache hit(s){data.confidence != null ? ` · confidence ${pc(data.confidence)}` : ''}</p>
      <div><h4 className="font-bold">Input (redacted)</h4><p className="rounded bg-sunken p-2 text-xs">{data.inputRedacted || '—'}</p><p className="mt-1 text-xs text-ink-3">hash {data.inputHash.slice(0, 16)}…</p></div>
      <div><h4 className="font-bold">Tool calls ({data.toolCalls.length})</h4>
        {data.toolCalls.length === 0 ? <p className="text-xs text-ink-3">No tools were called.</p> : <ul className="space-y-1 text-xs">{data.toolCalls.map((c, i) => <li key={i} className="rounded border border-line p-2"><code>{c.tool}</code> <Badge tone={effectTone(c.sideEffect)}>{label(c.sideEffect)}</Badge> <Badge tone={c.outcome === 'ok' ? 'ok' : c.outcome === 'refused' ? 'coral' : 'info'}>{label(c.outcome)}</Badge> <span className="text-ink-3">{c.ms} ms, {c.outputBytes} B</span><br /><span className="text-ink-3">args: {c.argsSummary}</span>{c.reason && <span className="block text-coral-700">{c.reason}</span>}</li>)}</ul>}
      </div>
      <div><h4 className="font-bold">Output (redacted)</h4><pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-sunken p-2 text-xs">{data.outputRedacted || '—'}</pre></div>
      {(data.flags.length > 0 || data.notes.length > 0) && <div><h4 className="font-bold">Flags and notes</h4><div className="flex flex-wrap gap-1">{data.flags.map((f) => <Badge key={f} tone="warn">{f}</Badge>)}</div><ul className="mt-1 list-disc pl-5 text-xs text-ink-3">{data.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></div>}
    </div>
  );
}

function RunsTab({ agents }: { agents: Agent[] }) {
  const [agentId, setAgentId] = React.useState('');
  const [outcome, setOutcome] = React.useState('');
  const [actor, setActor] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [sel, setSel] = React.useState<RunRow | null>(null);
  const qs = `page=${page}&pageSize=25${agentId ? `&agentId=${agentId}` : ''}${outcome ? `&outcome=${outcome}` : ''}${actor ? `&actorType=${actor}` : ''}`;
  const { data, error, loading, reload } = useFetch<Page<RunRow>>(`/admin/agents/runs?${qs}`);
  const cols: Column<RunRow>[] = [
    { key: 'at', header: 'When', render: (r) => when(r.createdAt) },
    { key: 'a', header: 'Agent', render: (r) => <b>{agents.find((a) => a.id === r.agentId)?.name ?? r.agentId}</b> },
    { key: 'who', header: 'Actor', hideBelow: 'md', render: (r) => r.actorType },
    { key: 'o', header: 'Outcome', render: (r) => <Badge tone={outcomeTone(r.outcome)}>{label(r.outcome)}</Badge> },
    { key: 's', header: 'Source', hideBelow: 'md', render: (r) => r.source },
    { key: 't', header: 'Tokens / cost', hideBelow: 'lg', align: 'right', render: (r) => `${r.tokens} · ${usd(r.costMicros)}` },
    { key: 'f', header: 'Flags', hideBelow: 'lg', render: (r) => (r.flags.length ? <span className="text-xs text-warn-500">{r.flags.slice(0, 2).join(', ')}</span> : '') },
  ];
  return (
    <>
      <Toolbar>
        <FilterSelect label="Agent" value={agentId} onChange={(v) => { setAgentId(v); setPage(1); }} options={[['', 'All agents'], ...agents.map((a): [string, string] => [a.id, a.name])]} />
        <FilterSelect label="Outcome" value={outcome} onChange={(v) => { setOutcome(v); setPage(1); }} options={OUTCOMES} />
        <FilterSelect label="Actor" value={actor} onChange={(v) => { setActor(v); setPage(1); }} options={ACTORS} />
      </Toolbar>
      {error && <ErrorBox message={error} retry={() => void reload()} />}
      <Panel pad={false}><DataTable<RunRow> columns={cols} rows={data?.items} rowKey={(r) => r._id} loading={loading} onRowClick={setSel} page={page} pageSize={25} total={data?.total} onPage={setPage} empty={{ title: 'No runs yet', body: 'Runs appear here as customers use the assistant and staff run agents.' }} /></Panel>
      <Modal open={!!sel} onClose={() => setSel(null)} title="Run detail" size="lg">{sel && <RunDetailView id={sel._id} />}</Modal>
    </>
  );
}

function BudgetsTab({ agents }: { agents: Agent[] }) {
  const [days, setDays] = React.useState('14');
  const { data, error, loading, reload } = useFetch<Usage>(`/admin/agents/usage?days=${days}`);
  const [sel, setSel] = React.useState('');
  const totals = agents.map((a) => {
    const rows = data?.items.filter((i) => i.agentId === a.id) ?? [];
    const sum = (k: 'runs' | 'modelCalls' | 'cacheHits' | 'tokens' | 'costMicros' | 'budgetStops') => rows.reduce((s, r) => s + r[k], 0);
    return { a, runs: sum('runs'), modelCalls: sum('modelCalls'), cacheHits: sum('cacheHits'), tokens: sum('tokens'), costMicros: sum('costMicros'), stops: sum('budgetStops') };
  });
  const daily = data?.items.filter((i) => i.agentId === sel) ?? [];
  return (
    <>
      <Toolbar><FilterSelect label="Period" value={days} onChange={setDays} options={[['7', '7 days'], ['14', '14 days'], ['30', '30 days']]} /></Toolbar>
      {error && <ErrorBox message={error} retry={() => void reload()} />}
      {loading ? <Loading /> : (
        <Panel title="Usage per agent" subtitle={data?.note} pad={false}>
          <DataTable<(typeof totals)[number]> columns={[
            { key: 'n', header: 'Agent', render: (r) => <b>{r.a.name}</b> },
            { key: 'r', header: 'Runs', align: 'right', render: (r) => r.runs },
            { key: 'm', header: 'Model calls', hideBelow: 'md', align: 'right', render: (r) => `${r.modelCalls} (${r.cacheHits} cached)` },
            { key: 't', header: 'Tokens (est.)', align: 'right', render: (r) => r.tokens },
            { key: 'c', header: 'Cost (est.)', align: 'right', render: (r) => usd(r.costMicros) },
            { key: 'b', header: 'Today vs daily budget', hideBelow: 'md', render: (r) => <div className="w-32"><Bar pct={r.a.usageToday.costPct} /><span className="text-xs text-ink-3">{pc(r.a.usageToday.costPct)} cost · {pc(r.a.usageToday.tokenPct)} tokens</span></div> },
            { key: 's', header: 'Budget stops', hideBelow: 'lg', align: 'right', render: (r) => (r.stops ? <Badge tone="warn">{r.stops}</Badge> : 0) },
          ]} rows={totals} rowKey={(r) => r.a.id} onRowClick={(r) => setSel(r.a.id)} empty={{ title: 'No usage', body: 'No agent has run in this period.' }} />
        </Panel>
      )}
      {sel && <Panel title={`Daily usage: ${agents.find((a) => a.id === sel)?.name}`} className="mt-4">{daily.length === 0 ? <p className="text-sm text-ink-3">No runs in this period.</p> : <table className="w-full text-left text-sm"><thead><tr className="text-xs text-ink-3"><th>Day</th><th>Runs</th><th>Model calls</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>{daily.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.runs}</td><td>{d.modelCalls}</td><td>{d.tokens}</td><td>{usd(d.costMicros)}</td></tr>)}</tbody></table>}</Panel>}
    </>
  );
}

function EscalationsTab({ agents, canWrite, onChange }: { agents: Agent[]; canWrite: boolean; onChange: () => void }) {
  const { run, busy } = useAction();
  const [status, setStatus] = React.useState('open');
  const [page, setPage] = React.useState(1);
  const [sel, setSel] = React.useState<Escalation | null>(null);
  const [note, setNote] = React.useState('');
  const { data, error, loading, reload } = useFetch<Page<Escalation> & { open: number }>(`/admin/agents/escalations?page=${page}&pageSize=25${status ? `&status=${status}` : ''}`);
  const rep = useFetch<Page<Replacement>>('/admin/agents/replacement-requests?status=pending&pageSize=25');
  const [repSel, setRepSel] = React.useState<{ r: Replacement; decision: 'approved' | 'rejected' } | null>(null);
  const resolve = () => run('res', async () => { await api(`/admin/agents/escalations/${sel!._id}/resolve`, { body: { note: note.trim() } }); setSel(null); setNote(''); await reload(); onChange(); }, 'Escalation resolved');
  const decide = () => run('rep', async () => { await api(`/admin/agents/replacement-requests/${repSel!.r._id}/decide`, { body: { decision: repSel!.decision, note: note.trim() } }); setRepSel(null); setNote(''); await Promise.all([rep.reload(), reload()]); onChange(); }, 'Decision recorded');
  const cols: Column<Escalation>[] = [
    { key: 'at', header: 'When', render: (r) => when(r.createdAt) },
    { key: 'a', header: 'Agent', render: (r) => agents.find((a) => a.id === r.agentId)?.name ?? r.agentId },
    { key: 'r', header: 'Reason', render: (r) => <Badge tone={r.reason === 'sensitive' || r.reason === 'tool_refused' ? 'coral' : 'warn'}>{label(r.reason)}</Badge> },
    { key: 's', header: 'Summary', hideBelow: 'md', render: (r) => <span className="text-sm">{r.summary}{r.orderNumber ? ` · ${r.orderNumber}` : ''}</span> },
    { key: 'st', header: 'Status', render: (r) => <Badge tone={r.status === 'open' ? 'warn' : 'ok'}>{r.status}</Badge> },
  ];
  return (
    <>
      <Toolbar><FilterSelect label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[['open', `Open${data ? ` (${data.open})` : ''}`], ['resolved', 'Resolved'], ['', 'All']]} /></Toolbar>
      {error && <ErrorBox message={error} retry={() => void reload()} />}
      <Panel pad={false}><DataTable<Escalation> columns={cols} rows={data?.items} rowKey={(r) => r._id} loading={loading} onRowClick={setSel} page={page} pageSize={25} total={data?.total} onPage={setPage} empty={{ title: 'Nothing waiting for a person', body: 'Low-confidence, sensitive, limit-hit, refused or budget-stopped cases will appear here.' }} /></Panel>
      <Panel title="Replacement requests awaiting staff" subtitle="Raised by the assistant after the customer confirmed. Approving records your decision; fulfil it in the Returns console." className="mt-4" pad={false}>
        {rep.error ? <div className="p-4"><ErrorBox message={rep.error} retry={() => void rep.reload()} /></div> : (
          <DataTable<Replacement> columns={[
            { key: 'o', header: 'Order', render: (r) => <b>{r.orderNumber}</b> },
            { key: 'sku', header: 'Item', render: (r) => `${r.quantity} x ${r.sku}` },
            { key: 're', header: 'Reason', render: (r) => label(r.reason) },
            { key: 'd', header: 'Customer details', hideBelow: 'md', render: (r) => <span className="text-xs">{r.details || '—'}</span> },
            { key: 'act', header: '', render: (r) => canWrite ? <div className="flex gap-1"><Button size="sm" onClick={(e) => { e.stopPropagation(); setNote(''); setRepSel({ r, decision: 'approved' }); }}>Approve</Button><Button size="sm" variant="danger" onClick={(e) => { e.stopPropagation(); setNote(''); setRepSel({ r, decision: 'rejected' }); }}>Reject</Button></div> : null },
          ]} rows={rep.data?.items} rowKey={(r) => r._id} loading={rep.loading} empty={{ title: 'No pending requests', body: 'Replacement requests from the assistant appear here.' }} />
        )}
      </Panel>
      <Modal open={!!sel} onClose={() => setSel(null)} title="Escalation" footer={sel?.status === 'open' && canWrite ? <Button loading={busy === 'res'} disabled={note.trim().length < 3} onClick={resolve}>Resolve</Button> : undefined}>
        {sel && <div className="space-y-2 text-sm"><p><Badge tone="warn">{label(sel.reason)}</Badge> {sel.summary}</p>{sel.orderNumber && <p className="text-xs text-ink-3">Order {sel.orderNumber}</p>}<pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-sunken p-2 text-xs">{JSON.stringify(sel.context ?? {}, null, 2)}</pre>
          {sel.status === 'open' ? (canWrite ? <label className="block font-bold">Resolution note<Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className="mt-1 min-h-16 font-normal" /></label> : <p className="text-xs text-ink-3">You can view but not resolve escalations.</p>) : <p className="text-xs text-ink-3">Resolved by {sel.resolvedBy} — {sel.resolutionNote}</p>}</div>}
      </Modal>
      <Modal open={!!repSel} onClose={() => setRepSel(null)} title={repSel ? `${repSel.decision === 'approved' ? 'Approve' : 'Reject'} replacement for ${repSel.r.orderNumber}` : ''} footer={<Button loading={busy === 'rep'} disabled={note.trim().length < 3} onClick={decide}>Record decision</Button>}>
        <label className="block text-sm font-bold">Note (kept in the audit log)<Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="mt-1 min-h-16 font-normal" /></label>
      </Modal>
    </>
  );
}

function MetricCard({ title, m, fmt, hint }: { title: string; m: Metric; fmt: (v: number) => string; hint: string }) {
  return (
    <div className="rounded-lg border border-line p-4">
      <p className="text-xs font-bold uppercase tracking-wide text-ink-3">{title}</p>
      {m.status === 'ok' ? <p className="mt-1 text-2xl font-extrabold">{fmt(m.value)}</p> : <p className="mt-1 text-lg font-bold text-ink-3">Insufficient data</p>}
      <p className="mt-1 text-xs text-ink-3">{m.status === 'ok' ? `n = ${m.n}` : `${m.n} of ${m.needed} cases needed`} · {hint}</p>
    </div>
  );
}
function OutcomesTab() {
  const { data, error, loading, reload } = useFetch<Metrics>('/admin/agents/metrics/advocate');
  if (loading) return <Loading rows={2} />;
  if (error || !data) return <ErrorBox message={error ?? 'No data'} retry={() => void reload()} />;
  return (
    <Panel title="Customer Advocate outcomes" subtitle={`Computed from stored records (${data.cases} advocate case(s), ${data.resolved} resolved by the engines or staff). Shown only with at least ${data.minSample} observations.`}>
      {data.cases === 0 && <p className="mb-3 text-sm text-ink-3">No customer has used the Customer Advocate yet.</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard title="Customer satisfaction" m={data.satisfaction} fmt={(v) => `${v.toFixed(2)} / 5`} hint="mean post-resolution rating" />
        <MetricCard title="First-contact resolution" m={data.firstContactResolution} fmt={(v) => pc(v)} hint="single run, no escalation" />
        <MetricCard title="Refund accuracy: right kind" m={data.refundAccuracy.kindMatch} fmt={(v) => pc(v)} hint="recommendation vs final outcome" />
        <MetricCard title="Refund accuracy: exact amount" m={data.refundAccuracy.exactAmount} fmt={(v) => pc(v)} hint="refund recommendations that ended in a refund" />
        <MetricCard title="Retention (90 days)" m={data.retention} fmt={(v) => pc(v)} hint="repeat purchase after resolution" />
      </div>
      <details className="mt-4"><summary className="cursor-pointer text-sm font-bold">How these are computed</summary><dl className="mt-2 space-y-1 text-xs text-ink-3">{Object.entries(data.definitions).map(([k, v]) => <div key={k}><dt className="inline font-bold">{label(k)}: </dt><dd className="inline">{v}</dd></div>)}</dl></details>
    </Panel>
  );
}

const TABS = [['agents', 'Agents'], ['runs', 'Run log'], ['budgets', 'Budgets'], ['escalations', 'Escalations'], ['outcomes', 'Advocate outcomes']] as const;

export default function AiAgentsPage() {
  const { can } = useAdmin();
  const canWrite = can('ai:write');
  const [tab, setTab] = React.useState<(typeof TABS)[number][0]>('agents');
  const { data, error, loading, reload } = useFetch<{ items: Agent[] }>('/admin/agents');
  const [runFor, setRunFor] = React.useState<Agent | null>(null);
  const [killFor, setKillFor] = React.useState<Agent | null>(null);
  const agents = data?.items ?? [];
  return (
    <>
      <PageHeader title="AI agents" subtitle="Governed agents: an explicit tool allowlist, deterministic engines that decide money and eligibility, full audit, budgets and a human escalation queue. Models only word what deterministic tools returned." />
      <div role="tablist" aria-label="AI agents sections" className="mb-4 inline-flex flex-wrap rounded-md bg-sunken p-1">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`h-8 rounded px-3 text-xs font-bold ${tab === k ? 'bg-surface shadow-sm' : 'text-ink-3'}`}>{l}</button>)}
      </div>
      {error && <ErrorBox message={error} retry={() => void reload()} />}
      {tab === 'agents' && (loading ? <Loading /> : agents.length === 0 ? !error && <p className="text-sm text-ink-3">No agents are registered.</p> : (
        <>
          {agents.some((a) => a.needsApiKey) && <p className="mb-3 rounded-lg bg-warn-50 p-3 text-sm text-warn-500">No model API key (GEMINI_API_KEY) is configured, so every agent runs deterministic tools and templates only. Nothing is faked: outputs are built from the tool results and labelled “deterministic”.</p>}
          <div className="grid gap-4 lg:grid-cols-2">{agents.map((a) => <AgentCard key={a.id} a={a} canWrite={canWrite} onRun={() => setRunFor(a)} onKill={() => setKillFor(a)} />)}</div>
        </>
      ))}
      {tab === 'runs' && <RunsTab agents={agents} />}
      {tab === 'budgets' && <BudgetsTab agents={agents} />}
      {tab === 'escalations' && <EscalationsTab agents={agents} canWrite={canWrite} onChange={() => void reload()} />}
      {tab === 'outcomes' && <OutcomesTab />}
      {runFor && <RunModal agent={runFor} onClose={() => { setRunFor(null); void reload(); }} />}
      {killFor && <KillModal agent={killFor} onClose={() => setKillFor(null)} onDone={() => void reload()} />}
    </>
  );
}
