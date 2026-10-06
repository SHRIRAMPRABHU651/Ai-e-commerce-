'use client';
import * as React from 'react';
import { Badge, Button, Card, Checkbox, Field, Input } from '@orvia/ui';
import { ErrorBox, Loading, PageHeader, Panel, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

type Status = 'PASS' | 'WARN' | 'FAIL';
interface Check { id: string; area: string; status: Status; title: string; detail: string; blocking: boolean; fix?: string }
interface Readiness {
  generatedAt: string; environment: string; verdict: 'GO' | 'NO_GO';
  summary: { pass: number; warn: number; fail: number; blockers: number };
  areas: Record<string, { status: Status; checks: Check[] }>;
  blockers: Check[]; warnings: Check[];
  providers: { name: string; configured: boolean; mode: string; status: string }[];
  verifications: Record<string, { status: Status; at: string; detail: string }>;
}
interface Legal { businessName: string; registeredAddress: string; supportEmail: string; reviewConfirmed: boolean; emailDomainVerified: boolean; taxRegistrations: string; reviewedAt?: string }

const TONE: Record<Status, 'ok' | 'warn' | 'coral'> = { PASS: 'ok', WARN: 'warn', FAIL: 'coral' };
const ICON: Record<Status, string> = { PASS: '✓', WARN: '!', FAIL: '✕' };

export default function LaunchReadinessPage() {
  const { can } = useAdmin();
  const [live, setLive] = React.useState<Readiness | null>(null);
  const base = useFetch<Readiness>('/admin/launch-readiness', 120_000);
  const legal = useFetch<Legal>('/admin/settings/legal');
  const [form, setForm] = React.useState<Legal | null>(null);
  const { run, busy } = useAction();
  const r = live ?? base.data;
  React.useEffect(() => { if (legal.data && !form) setForm(legal.data); }, [legal.data, form]);

  return (
    <>
      <PageHeader
        title="Launch readiness"
        subtitle="Every area must pass before real customers are served. Failing checks block launch; warnings need an owner’s decision. Nothing here is assumed — unverified providers stay UNVERIFIED until a live check succeeds."
        actions={can('settings:write') ? <Button loading={busy === 'live'} onClick={() => void run('live', async () => { setLive(await api<Readiness>('/admin/launch-readiness?live=true')); }, 'Live provider checks finished')}>Run live checks</Button> : undefined}
      />
      {base.error && !r && <ErrorBox message={base.error} retry={base.reload} />}
      {!r ? <Loading /> : (
        <>
          <Card className={`mb-4 p-5 ${r.verdict === 'GO' ? 'border-ok-500' : 'border-coral-500'}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs text-ink-3">Verdict · {r.environment} · {when(r.generatedAt)}</p>
                <p className="text-3xl font-bold" role="status">{r.verdict === 'GO' ? 'GO' : 'NO-GO'}</p>
                <p className="text-sm text-ink-2">{r.summary.blockers} blocker(s) · {r.summary.warn} warning(s) · {r.summary.pass} passing</p>
              </div>
              <Badge tone={r.verdict === 'GO' ? 'ok' : 'coral'}>{r.verdict === 'GO' ? 'Ready' : 'Not ready'}</Badge>
            </div>
          </Card>

          {r.blockers.length > 0 && (
            <Panel title="Blockers" subtitle="Fix these before launch">
              <ul className="divide-y divide-line text-sm">{r.blockers.map((b) => <li key={b.id} className="py-2"><b>{b.area}: {b.title}</b><p className="text-ink-2">{b.detail}</p>{b.fix && <p className="text-xs text-ink-3">Fix: {b.fix}</p>}</li>)}</ul>
            </Panel>
          )}

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(r.areas).map(([area, a]) => (
              <Card key={area} className="p-4">
                <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-bold">{area}</h2><Badge tone={TONE[a.status]}><span aria-hidden>{ICON[a.status]}</span> {a.status}</Badge></div>
                <ul className="space-y-1.5 text-xs">{a.checks.map((c) => <li key={c.id}><span className="font-semibold">{c.title}</span> <span className="text-ink-3">({c.status}{c.blocking && c.status !== 'PASS' ? ', blocking' : ''})</span><p className="text-ink-3">{c.detail}</p></li>)}</ul>
              </Card>
            ))}
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Panel title="Providers" subtitle="Configured is not verified — only a successful live check or staging run verifies a provider">
              <ul className="divide-y divide-line text-sm">{r.providers.map((p) => <li key={p.name} className="flex items-center justify-between gap-3 py-2"><span><b>{p.name}</b> <span className="text-xs text-ink-3">{p.mode}</span></span><span className="flex gap-1.5"><Badge tone={p.configured ? 'neutral' : 'warn'}>{p.configured ? 'configured' : 'not configured'}</Badge><Badge tone={p.status === 'PASS' || p.status === 'HEALTHY' ? 'ok' : p.status === 'FAIL' || p.status === 'FAILING' ? 'coral' : 'warn'}>{p.status}</Badge></span></li>)}</ul>
            </Panel>
            <Panel title="Last verifications" subtitle="Recorded by production-check, verify:staging and live checks">
              {Object.keys(r.verifications).length ? <ul className="divide-y divide-line text-sm">{Object.entries(r.verifications).map(([k, v]) => <li key={k} className="py-2"><b>{k}</b> <Badge tone={TONE[v.status]}>{v.status}</Badge> <span className="text-xs text-ink-3">{when(v.at)}</span><p className="text-xs text-ink-2">{v.detail}</p></li>)}</ul> : <p className="text-sm text-ink-3">Nothing verified yet. Run <code>npm run production-check</code> and <code>npm run verify:staging</code>.</p>}
            </Panel>
          </div>
        </>
      )}

      <div className="mt-4">
        <Panel title="Business & legal" subtitle="Confirm only after the legal pages and policies were reviewed for every market you sell in. This is an attestation, not a detection.">
          {form ? (
            <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void run('legal', async () => { await api('/admin/settings/legal', { method: 'PUT', body: { ...form, reviewedAt: undefined } }); await Promise.all([legal.reload(), base.reload()]); setLive(null); }, 'Saved'); }}>
              <Field label="Business name"><Input value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} /></Field>
              <Field label="Support email"><Input type="email" value={form.supportEmail} onChange={(e) => setForm({ ...form, supportEmail: e.target.value })} /></Field>
              <Field label="Registered address"><Input value={form.registeredAddress} onChange={(e) => setForm({ ...form, registeredAddress: e.target.value })} /></Field>
              <Field label="Tax registrations"><Input value={form.taxRegistrations} onChange={(e) => setForm({ ...form, taxRegistrations: e.target.value })} /></Field>
              <Checkbox label="Sending email domain is verified (SPF/DKIM)" checked={form.emailDomainVerified} onChange={(e) => setForm({ ...form, emailDomainVerified: e.target.checked })} />
              <Checkbox label="Legal pages and policies reviewed for the markets served" checked={form.reviewConfirmed} onChange={(e) => setForm({ ...form, reviewConfirmed: e.target.checked })} />
              {can('settings:write') && <div className="sm:col-span-2"><Button type="submit" loading={busy === 'legal'}>Save</Button></div>}
            </form>
          ) : <Loading />}
        </Panel>
      </div>
    </>
  );
}
