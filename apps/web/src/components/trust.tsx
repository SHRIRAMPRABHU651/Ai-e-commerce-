'use client';
import { BadgeCheck, Info, ShieldAlert } from 'lucide-react';
import * as React from 'react';
import { Badge, Card, Skeleton } from '@orvia/ui';
import type { Tone } from '@orvia/ui';
import type { Provenance, ProductPassport, PurchaseConfidenceReport, TrustStatus } from '@orvia/types';
import { api, money } from '@/lib/api';

/* ---------------------------- shared bits ---------------------------- */

const PROV: Record<Provenance, { label: string; tone: Tone; hint: string }> = {
  verified: { label: 'Verified', tone: 'ok', hint: 'Checked by Orvia against records or evidence' },
  supplier_provided: { label: 'Supplier-provided', tone: 'neutral', hint: 'Stated by the supplier; not independently checked' },
  customer_reported: { label: 'Customer-reported', tone: 'info', hint: 'Reported by customers' },
  ai_suggested: { label: 'AI-suggested', tone: 'saffron', hint: 'Generated text; not a safety or compliance statement' },
};

export function ProvenanceChip({ p }: { p: Provenance }) {
  const v = PROV[p];
  return <span title={v.hint}><Badge tone={v.tone}>{v.label}</Badge></span>;
}

function useEndpoint<T>(path: string) {
  const [state, set] = React.useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [n, setN] = React.useState(0);
  React.useEffect(() => {
    const ctl = new AbortController();
    set((s) => ({ ...s, loading: true }));
    api<T>(path, { signal: ctl.signal }).then((data) => set({ data, error: null, loading: false })).catch((e: Error) => { if (e.name !== 'AbortError') set({ data: null, error: e.message || 'Could not load', loading: false }); });
    return () => ctl.abort();
  }, [path, n]);
  return { ...state, retry: () => setN((x) => x + 1) };
}

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-lg font-bold tracking-tight">{title}</h2>
      {subtitle && <p className="mt-0.5 text-sm text-ink-3">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </Card>
  );
}
const Loading = () => <div className="space-y-3" aria-busy="true" aria-label="Loading"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>;
const Failed = ({ msg, retry }: { msg: string; retry: () => void }) => <div role="alert" className="rounded-lg border border-coral-500/30 bg-coral-50 p-3 text-sm text-coral-700">{msg} <button onClick={retry} className="ml-2 font-bold underline">Retry</button></div>;
const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6"><dt className="text-sm font-semibold sm:w-48 sm:shrink-0">{label}</dt><dd className="min-w-0 flex-1 text-sm text-ink-2">{children}</dd></div>
);

const statusTone = (s: TrustStatus): Tone => (s === 'established' ? 'ok' : s === 'provisional' ? 'warn' : 'neutral');
const statusText = (s: TrustStatus) => (s === 'established' ? 'Established' : s === 'provisional' ? 'Provisional' : 'Not enough history');

/** Compact trust signal for cards/headers. Never shows a number when there is not enough history. */
export function TrustBadge({ status, score, label }: { status: TrustStatus; score?: number | null; label?: string }) {
  const text = status === 'insufficient_data' || score == null ? 'Not enough delivery history yet' : `${label ?? 'Supplier reliability'} ${Math.round(score)}/100${status === 'provisional' ? ' (early)' : ''}`;
  return <Badge tone={statusTone(status)} dot>{text}</Badge>;
}

/* ---------------------------- Purchase Confidence ---------------------------- */

export function PurchaseConfidencePanel({ slug, country, quantity = 1 }: { slug: string; country?: string; quantity?: number }) {
  const qs = `?quantity=${quantity}${country ? `&country=${country}` : ''}`;
  const { data: r, error, loading, retry } = useEndpoint<PurchaseConfidenceReport>(`/products/${encodeURIComponent(slug)}/confidence${qs}`);
  if (loading) return <Shell title="Purchase confidence"><Loading /></Shell>;
  if (error || !r) return <Shell title="Purchase confidence"><Failed msg={error ?? 'Not available'} retry={retry} /></Shell>;
  const s = r.supplierReliability;
  const d = r.delivery;
  return (
    <section aria-label="Purchase confidence">
      <Shell title="Purchase confidence" subtitle="What we know, what we do not, and how sure we are.">
        <dl>
          <Row label="Product information">
            <div className="flex flex-wrap items-center gap-2">
              <ProvenanceChip p={r.infoCompleteness.verifiedShare > 0 ? 'verified' : 'supplier_provided'} />
              <span>{r.infoCompleteness.label}</span>
            </div>
            {r.infoCompleteness.missing.length > 0 && <p className="mt-1 text-ink-3">Not provided: {r.infoCompleteness.missing.join(', ')}.</p>}
          </Row>
          <Row label="Supplier reliability">
            <TrustBadge status={s.status} score={s.score} />
            {s.status === 'insufficient_data'
              ? <p className="mt-1 text-ink-3">We have not completed enough deliveries with this supplier to rate it. {s.known.join('. ')}.</p>
              : <p className="mt-1 text-ink-3">{s.range ? `Likely between ${s.range.low} and ${s.range.high}. ` : ''}Based on {s.sampleSize} completed shipments.</p>}
          </Row>
          <Row label="Delivery estimate">
            <p className="font-semibold text-ink">{d.minDays !== null && d.maxDays !== null ? `${d.minDays}-${d.maxDays} days${d.estimateLabel ? ` (${d.estimateLabel})` : ''}` : 'No estimate available yet'}</p>
            <p className="mt-1 text-ink-3">{d.statement}</p>
          </Row>
          <Row label="Total delivered price">
            {r.pricing ? (
              <div>
                <p className="text-base font-bold text-ink">{money(r.pricing.total, r.pricing.currency)}</p>
                <p className="text-ink-3">{money(r.pricing.subtotal, r.pricing.currency)} items + {money(r.pricing.shipping, r.pricing.currency)} shipping + {r.pricing.taxInclusive ? `${money(r.pricing.tax, r.pricing.currency)} tax (already included)` : `${money(r.pricing.tax, r.pricing.currency)} tax`} <em>(tax is an estimate)</em></p>
                {r.pricing.importChargesNote && <p className="mt-1 text-ink-3">{r.pricing.importChargesNote}</p>}
              </div>
            ) : <span className="text-ink-3">Price is not available for this destination.</span>}
          </Row>
          <Row label="Returns"><span>{r.returns.note}</span></Row>
          <Row label="Delivery destination">
            {r.restrictions.restricted ? <p className="flex items-start gap-2 text-coral-700"><ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{r.restrictions.reasons.join('. ')}</p> : <span>No restrictions recorded for {r.country}.</span>}
          </Row>
        </dl>
        <div className="mt-3 rounded-lg bg-sunken p-3 text-sm">
          <p className="flex items-center gap-2 font-semibold"><Info className="size-4" aria-hidden />What we are not sure about</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">{r.uncertainty.map((u) => <li key={u}>{u}</li>)}{r.knownLimitations.map((u) => <li key={u}>{u}</li>)}</ul>
        </div>
      </Shell>
    </section>
  );
}

/* ---------------------------- Product Passport ---------------------------- */

const when = (d?: string | null) => (d ? new Date(d).toLocaleDateString(undefined, { dateStyle: 'medium' }) : null);

export function ProductPassportPanel({ slug, country }: { slug: string; country?: string }) {
  const { data: p, error, loading, retry } = useEndpoint<ProductPassport>(`/products/${encodeURIComponent(slug)}/passport${country ? `?country=${country}` : ''}`);
  if (loading) return <Shell title="Product passport"><Loading /></Shell>;
  if (error || !p) return <Shell title="Product passport"><Failed msg={error ?? 'Not available'} retry={retry} /></Shell>;
  const specs = [...p.specifications, ...p.dimensions];
  return (
    <section aria-label="Product passport">
      <Shell title="Product passport" subtitle="Every fact below shows where it comes from.">
        <dl>
          <Row label="Seller of record"><span>{p.identity.supplier ? <>Fulfilled by {p.identity.supplier.value} <ProvenanceChip p={p.identity.supplier.provenance} /></> : 'Not available'}</span></Row>
          <Row label="Manufacturer">{p.identity.manufacturer ? <span>{p.identity.manufacturer.value} <ProvenanceChip p={p.identity.manufacturer.provenance} /></span> : <span className="text-ink-3">Manufacturer not identified yet.</span>}</Row>
          <Row label="Specifications">
            {specs.length || p.materials.length ? (
              <ul className="space-y-1.5">
                {p.materials.map((m) => <li key={m.value} className="flex flex-wrap items-center gap-2"><span>{m.value}</span><ProvenanceChip p={m.provenance} /></li>)}
                {specs.map((s) => <li key={s.key} className="flex flex-wrap items-center gap-2"><span><b>{s.key}:</b> {s.field.value}</span><ProvenanceChip p={s.field.provenance} /></li>)}
              </ul>
            ) : <span className="text-ink-3">No specifications provided.</span>}
          </Row>
          <Row label="Certificates & documents">
            {p.documents.length ? (
              <ul className="space-y-1.5">
                {p.documents.map((d) => (
                  <li key={d.title + d.kind} className="flex flex-wrap items-center gap-2">
                    {d.provenance === 'verified' && <BadgeCheck className="size-4 text-ok-500" aria-hidden />}
                    <span>{d.url ? <a className="underline" href={d.url} rel="noopener noreferrer nofollow" target="_blank">{d.title}</a> : d.title}</span>
                    <ProvenanceChip p={d.provenance} />
                    {d.expired && <Badge tone="coral">Expired</Badge>}
                    {d.expiresAt && !d.expired && <span className="text-xs text-ink-3">valid until {when(d.expiresAt)}</span>}
                    {d.provenance !== 'verified' && <span className="text-xs text-ink-3">not independently verified</span>}
                  </li>
                ))}
              </ul>
            ) : <span className="text-ink-3">No certificates on record.</span>}
          </Row>
          <Row label="Images">
            {p.images.length ? <p>{p.images.length} image{p.images.length === 1 ? '' : 's'}. {p.images[0]!.usageRights} <ProvenanceChip p={p.images[0]!.provenance} /></p> : <span className="text-ink-3">No images.</span>}
          </Row>
          <Row label="Destination">{p.restrictions.map((r) => <p key={r.country}>{r.restricted ? <span className="text-coral-700">{r.reasons.join('. ')}</span> : `No restrictions recorded for ${r.country}.`}</p>)}</Row>
          <Row label="Stock information"><span>{p.stock.note}</span> <ProvenanceChip p={p.stock.provenance} /></Row>
          <Row label="Price history"><span className="text-ink-3">{p.priceHistory.note}</span></Row>
          <Row label="Actual delivery">
            <p>{p.delivery.actual.statement}</p>
            {p.delivery.promised && <p className="text-ink-3">Supplier estimate: {p.delivery.promised.minDays}-{p.delivery.promised.maxDays} days. <ProvenanceChip p={p.delivery.provenance} /></p>}
          </Row>
          <Row label="Returns & defects"><span>{p.quality.note}</span>{p.quality.returnRate !== null && <p>Return rate {Math.round(p.quality.returnRate * 100)}%, defect rate {Math.round((p.quality.defectRate ?? 0) * 100)}%.</p>}</Row>
          <Row label="Risk">
            <div className="flex flex-wrap items-center gap-2">
              {p.risk.status === 'insufficient_data' ? <Badge tone="neutral" dot>Not enough history to score</Badge> : <Badge tone={p.risk.level === 'low' ? 'ok' : p.risk.level === 'medium' ? 'warn' : 'coral'} dot>{p.risk.level} risk{p.risk.score !== null ? ` (${Math.round(p.risk.score)}/100)` : ''}{p.risk.status === 'provisional' ? ', provisional' : ''}</Badge>}
              <ProvenanceChip p={p.risk.provenance} />
            </div>
            <ul className="mt-1 list-disc pl-5 text-ink-3">{[...p.risk.known, ...p.risk.caveats].map((k) => <li key={k}>{k}</li>)}</ul>
          </Row>
          <Row label="Customer feedback">
            {p.feedback.ratingCount ? <span>{p.feedback.ratingAvg?.toFixed(1)} / 5 from {p.feedback.ratingCount} review{p.feedback.ratingCount === 1 ? '' : 's'}. {p.feedback.note} <ProvenanceChip p="customer_reported" /></span> : <span className="text-ink-3">No reviews yet.</span>}
          </Row>
          {p.summary && <Row label="Description"><span>{p.summary.value}</span> <ProvenanceChip p={p.summary.provenance} /><p className="mt-1 text-xs text-ink-3">Text may be AI-assisted and is not a safety or compliance statement.</p></Row>}
          <Row label="Lifecycle"><span className="capitalize">{p.product.lifecycle.value}</span></Row>
          {p.alternatives.length > 0 && <Row label="Alternatives"><ul className="space-y-1">{p.alternatives.map((a) => <li key={a.slug}><a className="underline" href={`/p/${a.slug}`}>{a.title}</a>{a.price !== null && ` · ${money(a.price, a.currency)}`}</li>)}</ul></Row>}
        </dl>
      </Shell>
    </section>
  );
}
