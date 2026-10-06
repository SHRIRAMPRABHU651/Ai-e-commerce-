'use client';
import * as React from 'react';
import { Badge, Button, Card, Checkbox, Field, Input, Select } from '@orvia/ui';
import { Panel, useAction, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

export interface Evidence { claim: string; type: string; body?: string; certId?: string; certUrl?: string; sourceUrl?: string; jurisdiction?: string[]; expiresAt?: string; verified?: boolean; verifiedBy?: string; verifiedAt?: string; note?: string }
const CLAIMS: [string, string][] = [['organic', 'Organic'], ['non_toxic', 'Non-toxic / chemical-free'], ['eco', 'Eco-certified / sustainable'], ['biodegradable', 'Biodegradable / compostable'], ['plant_based', 'Plant-based / vegan']];
const JUR = ['US', 'CA', 'IN', 'EU', 'GLOBAL'];

export function ProductClaims({ productId, canWrite, organic, onChange }: { productId: string; canWrite: boolean; organic?: { sourceTitle?: string; removedClaims?: string[]; evidence?: Evidence[] }; onChange: () => void }) {
  const { run, busy } = useAction();
  const [f, setF] = React.useState({ claim: 'organic', type: 'certification', body: '', certId: '', certUrl: '', sourceUrl: '', jurisdiction: [] as string[], expiresAt: '', verified: false });
  const ev = organic?.evidence ?? [];
  return (
    <div className="space-y-4">
      <Panel title="Claims policy" subtitle="“Organic”, “non-toxic”, “eco-certified”, “biodegradable” and “plant-based” are only allowed with verified evidence for every market the product is sold in. Orvia never lets AI or a supplier’s wording make these claims on its own.">
        {organic?.removedClaims?.length ? <p className="text-sm text-ink-2">Supplier wording that was removed from the listing: <b>{organic.removedClaims.join(', ')}</b>. Original supplier title: <i>{organic.sourceTitle}</i></p> : <p className="text-sm text-ink-3">No unverified claims were found in the supplier’s wording.</p>}
      </Panel>
      <Panel title="Evidence on file">
        {ev.length === 0 ? <p className="text-sm text-ink-3">None. Without evidence no claim can appear in titles, descriptions, bullets, SEO text, FAQs or ads.</p> : (
          <ul className="divide-y divide-line text-sm">
            {ev.map((e, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div><b>{CLAIMS.find((c) => c[0] === e.claim)?.[1]}</b> · {e.type.replace('_', ' ')} {e.body && `· ${e.body}`} {e.certId && `· ${e.certId}`}<p className="text-xs text-ink-3">{(e.jurisdiction ?? []).join(', ') || 'no jurisdiction'}{e.expiresAt ? ` · expires ${when(e.expiresAt)}` : ''}{e.verifiedBy ? ` · verified by ${e.verifiedBy}` : ''}</p>{e.certUrl && <a className="text-xs text-pine-700 underline" href={e.certUrl} target="_blank" rel="noreferrer noopener">certificate</a>}</div>
                <div className="flex items-center gap-2"><Badge tone={e.verified ? 'ok' : 'warn'}>{e.verified ? 'Verified' : 'Not verified — has no effect'}</Badge>{canWrite && <Button size="sm" variant="ghost" loading={busy === 'd' + i} onClick={() => void run('d' + i, async () => { await api(`/admin/products/${productId}/claim-evidence/${i}`, { method: 'DELETE' }); onChange(); }, 'Evidence removed')}>Remove</Button>}</div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {canWrite && (
        <Card className="space-y-3 p-5">
          <h3 className="font-bold">Add evidence</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Claim"><Select value={f.claim} onChange={(e) => setF({ ...f, claim: e.target.value })}>{CLAIMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
            <Field label="Evidence type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="certification">Certification</option><option value="test_report">Test report</option><option value="supplier_statement">Supplier statement (not enough on its own)</option></Select></Field>
            <Field label="Certification body" hint="e.g. USDA, COSMOS, GOTS, OEKO-TEX, India Organic (NPOP)"><Input value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
            <Field label="Certificate ID"><Input value={f.certId} onChange={(e) => setF({ ...f, certId: e.target.value })} /></Field>
            <Field label="Certificate / report URL"><Input value={f.certUrl} onChange={(e) => setF({ ...f, certUrl: e.target.value })} placeholder="https://…" /></Field>
            <Field label="Expires (optional)"><Input type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></Field>
          </div>
          <fieldset><legend className="mb-1 text-sm font-semibold">Valid in</legend><div className="flex flex-wrap gap-4">{JUR.map((j) => <Checkbox key={j} checked={f.jurisdiction.includes(j)} onChange={() => setF({ ...f, jurisdiction: f.jurisdiction.includes(j) ? f.jurisdiction.filter((x) => x !== j) : [...f.jurisdiction, j] })} label={j} />)}</div></fieldset>
          <Checkbox checked={f.verified} onChange={() => setF({ ...f, verified: !f.verified })} label="I checked this certificate/report with the issuing body and it covers this exact product" />
          <Button loading={busy === 'add'} onClick={() => void run('add', async () => { await api(`/admin/products/${productId}/claim-evidence`, { body: { ...f, body: f.body || undefined, certId: f.certId || undefined, certUrl: f.certUrl || undefined, sourceUrl: undefined, expiresAt: f.expiresAt ? new Date(f.expiresAt).toISOString() : undefined } }); onChange(); }, 'Evidence saved')}>Save evidence</Button>
        </Card>
      )}
    </div>
  );
}
