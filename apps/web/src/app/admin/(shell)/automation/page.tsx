'use client';
import * as React from 'react';
import { AutomationCard, Badge, Button, Card, Switch, StatusBadge, Tabs } from '@orvia/ui';
import { ErrorBox, Loading, PageHeader, Panel, pctf, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface A { key: string; name: string; description: string; mode: string; risk: string; schedule: { name: string; everyMs: number; enabled: boolean }[]; lastRun: string | null; nextRun: string | null; successRate: number | null }
interface D { automations: A[]; agents: { name: string; description: string; tools: string[]; permissions: string[]; timeoutMs: number; retries: number }[]; schedules: { name: string; everyMs: number; enabled: boolean; description: string; risk: string }[]; queue: Record<string, number>; integrations: Record<string, { configured: boolean; mode: string }>; environment: string; llm: string }
interface Dec { _id: string; agent: string; kind: string; summary: string; status: string; confidence?: number; createdAt: string; error?: string; mode?: string }
const every = (ms: number) => (ms >= 86_400_000 ? `${ms / 86_400_000}d` : ms >= 3_600_000 ? `${ms / 3_600_000}h` : `${ms / 60_000}m`);

export default function AutomationPage() {
  const { can } = useAdmin();
  const [tab, setTab] = React.useState('control');
  const [dstatus, setDstatus] = React.useState('proposed');
  const { data: d, error, reload } = useFetch<D>('/admin/automation', 30_000);
  const dec = useFetch<{ items: Dec[]; total: number }>(`/admin/automation/decisions?status=${dstatus}&pageSize=30`, 20_000);
  const tasks = useFetch<{ items: { _id: string; agent: string; status: string; summary?: string; confidence?: number; durationMs?: number; createdAt: string; error?: string }[] }>(tab === 'agents' ? '/admin/automation/ai-tasks?pageSize=15' : null);
  const { run, busy } = useAction();
  if (error && !d) return <ErrorBox message={error} retry={reload} />;
  if (!d) return <Loading rows={5} />;
  const pending = dec.data?.items.length ?? 0;
  return (
    <>
      <PageHeader title="Automation Center" subtitle="Zero-touch by default, exception-driven when necessary. Sensitive operations start in ASSISTED mode." actions={<><Badge tone={d.llm === 'gemini' ? 'ok' : 'warn'}>{d.llm === 'gemini' ? 'Gemini connected' : 'AI: deterministic fallback (no GEMINI_API_KEY)'}</Badge><Badge>{d.environment}</Badge></>} />
      <Tabs tabs={[{ id: 'control', label: 'Controls' }, { id: 'queue', label: 'Approvals', count: dstatus === 'proposed' ? pending : undefined }, { id: 'schedules', label: 'Schedules' }, { id: 'agents', label: 'Agents' }]} value={tab} onChange={setTab} className="mb-5" />
      {tab === 'control' && (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{d.automations.map((a) => <AutomationCard key={a.key} a={a} canEdit={can('automation:write')} onMode={(mode) => void run(a.key, async () => { await api(`/admin/automation/${a.key}`, { method: 'PUT', body: { mode } }); await reload(); }, `${a.name}: ${mode.toLowerCase()}`)} />)}</div>
          <Card className="mt-4 p-5 text-sm text-ink-2"><b>OFF</b> — nothing runs. <b>ASSISTED</b> — the agent proposes; you approve each change in <i>Approvals</i>. <b>AUTOMATIC</b> — executes immediately within guard-rails (margin floor, spend limits, compliance gates) and is recorded in the audit log. Switch to AUTOMATIC only after you have watched ASSISTED proposals for a while.</Card>
        </>
      )}
      {tab === 'queue' && (
        <Panel title="AI decisions" action={<div className="flex gap-1">{['proposed', 'executed', 'auto_executed', 'rejected', 'failed'].map((s) => <button key={s} onClick={() => setDstatus(s)} aria-pressed={dstatus === s} className={`rounded-full px-3 py-1 text-xs font-bold ${dstatus === s ? 'bg-pine-600 text-white' : 'bg-sunken text-ink-3'}`}>{s.replace('_', ' ')}</button>)}</div>}>
          {dec.data?.items.length === 0 && <p className="py-8 text-center text-sm text-ink-3">Nothing {dstatus.replace('_', ' ')}.</p>}
          <ul className="divide-y divide-line">{dec.data?.items.map((x) => (
            <li key={x._id} className="flex flex-col gap-3 py-4 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge tone="info">{x.agent}</Badge><Badge>{x.kind.replace(/_/g, ' ')}</Badge><span className="text-xs text-ink-3">{when(x.createdAt)}{x.confidence ? ` · confidence ${Math.round(x.confidence * 100)}%` : ''}</span></div><p className="mt-1.5 text-sm">{x.summary}</p>{x.error && <p className="text-sm text-coral-500">{x.error}</p>}</div>
              {x.status === 'proposed' && can('automation:write') ? <div className="flex shrink-0 gap-2"><Button size="sm" loading={busy === x._id} onClick={() => void run(x._id, async () => { await api(`/admin/automation/decisions/${x._id}/approve`, { body: {} }); await dec.reload(); await reload(); }, 'Approved and executed')}>Approve</Button><Button size="sm" variant="ghost" onClick={() => void run(x._id + 'r', async () => { await api(`/admin/automation/decisions/${x._id}/reject`, { body: { reason: 'rejected by admin' } }); await dec.reload(); })}>Reject</Button></div> : <StatusBadge status={x.status} />}
            </li>
          ))}</ul>
        </Panel>
      )}
      {tab === 'schedules' && (
        <Panel title="Durable job schedules" subtitle={`Queue: ${Object.entries(d.queue).map(([k, v]) => `${v} ${k}`).join(' · ') || 'empty'}. Slots are claimed atomically in MongoDB so replicas never double-fire.`}>
          <ul className="divide-y divide-line">{d.schedules.map((s) => (
            <li key={s.name} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0"><div className="min-w-0"><p className="text-sm font-bold">{s.name.replace(/_/g, ' ')} <Badge tone={s.risk === 'high' ? 'coral' : s.risk === 'medium' ? 'warn' : 'ok'}>{s.risk}</Badge></p><p className="text-sm text-ink-3">{s.description}</p></div><div className="flex items-center gap-3"><span className="text-sm font-semibold tabular-nums">every {every(s.everyMs)}</span>{can('automation:write') && <select aria-label={`${s.name} interval`} value="" onChange={(e) => e.target.value && void run(s.name, async () => { await api(`/admin/automation/schedules/${s.name}`, { method: 'PUT', body: { everyMinutes: Number(e.target.value) } }); await reload(); }, 'Schedule updated')} className="h-9 rounded-md border border-line-strong bg-surface px-2 text-sm"><option value="">Change…</option>{[5, 15, 30, 60, 360, 1440].map((m) => <option key={m} value={m}>{m >= 60 ? `${m / 60}h` : `${m}m`}</option>)}</select>}{can('automation:write') && <Switch checked={s.enabled} label={`${s.name} enabled`} onChange={(v) => void run(s.name + 'e', async () => { await api(`/admin/automation/schedules/${s.name}`, { method: 'PUT', body: { enabled: v } }); await reload(); })} />}</div></li>
          ))}</ul>
        </Panel>
      )}
      {tab === 'agents' && (
        <div className="grid gap-4 xl:grid-cols-[1fr_24rem]">
          <div className="grid gap-3 md:grid-cols-2">{d.agents.map((a) => <Card key={a.name} className="flex flex-col p-4"><p className="font-bold">{a.name}</p><p className="mt-1 flex-1 text-sm text-ink-3">{a.description}</p><p className="mt-2 text-xs text-ink-3">tools: {a.tools.join(', ')}<br />permissions: {a.permissions.join(', ') || 'read-only'} · timeout {a.timeoutMs / 1000}s · retries {a.retries}</p>{can('ai:write') && !['FulfillmentAgent', 'ProductScoringAgent'].includes(a.name) && <Button size="sm" variant="secondary" className="mt-3 self-start" loading={busy === a.name} onClick={() => void run(a.name, async () => { await api(`/admin/automation/agents/${a.name}/run`, { body: { input: {} } }); await tasks.reload(); }, `${a.name} finished`)}>Run now</Button>}</Card>)}</div>
          <Panel title="Recent agent runs"><ul className="divide-y divide-line text-sm">{tasks.data?.items.map((t) => <li key={t._id} className="py-2.5 first:pt-0"><div className="flex items-center justify-between gap-2"><b>{t.agent}</b><StatusBadge status={t.status === 'succeeded' ? 'ok' : t.status === 'failed' ? 'failed' : 'processing'} /></div><p className="text-ink-2">{t.summary ?? t.error}</p><p className="text-xs text-ink-3">{when(t.createdAt)}{t.durationMs ? ` · ${t.durationMs}ms` : ''}{t.confidence ? ` · conf. ${pctf(t.confidence, 0)}` : ''}</p></li>)}</ul></Panel>
        </div>
      )}
    </>
  );
}
