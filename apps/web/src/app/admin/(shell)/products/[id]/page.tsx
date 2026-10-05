'use client';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { Badge, Button, Card, Field, Input, Modal, ProductArt, Select, StatusBadge, Tabs } from '@orvia/ui';
import { ErrorBox, Loading, PageHeader, Panel, cur, pctf, useAction, useAdmin, useFetch, usd, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface CmpRow { supplierId: string; supplierName: string; supplierCode: string; warehouseCountry: string; productCost: number; shippingCost: number; duties: number; landedCost: number; minDays: number; maxDays: number; stock: number; reliability: number; rating: number; expectedProfit: number; margin: number; cxScore: number; finalScore: number; eligible: boolean; ineligibleReason?: string; currency: string }
interface Detail {
  product: { _id: string; title: string; slug: string; state: string; images: { url: string }[]; description: string; bullets: string[]; compliance: { status: string; flags: string[] }; markets: { country: string; price: number; currency: string; compareAtPrice: number; expectedMargin: number; expectedProfit: number; landedCost: number; stock: number; shipsFrom?: string; pricingStrategy: string }[]; opportunity?: { finalScore: number; action: string }; stateHistory: { state: string; at: string; by: string; reason: string }[]; pricingConfig?: { strategy: string; targetMarginPct: number }; intel?: { competitorPrices?: Record<string, number[]> } };
  comparisons: { country: string; currency: string; sellingPrice: number; rows: CmpRow[]; recommendation: { supplierName: string | null; reason: string } }[];
  plans: { country: string; economics: { supplier_cost: number; shipping_cost: number; landed_cost: number; selling_price: number; gross_margin: number; payment_fee: number; estimated_return_cost: number; estimated_ad_cost: number; customer_acquisition_cost: number; expected_profit: number; profit_margin: number; ROAS: number; break_even_ROAS: number; refund_rate: number } | null; pricing: { price: number; floorPrice: number; explanation: string } | null; strategy: string; competitorPrices: number[] }[];
  scores: { finalScore: number; action: string; components: Record<string, number>; reasons: string[]; computedAt: string }[]; campaigns: { _id: string; name: string; status: string; platform: string; country: string }[]; decisions: { _id: string; summary: string }[]; exceptions: { _id: string; issue: string; kind: string }[];
}
const STRATS = ['cost_plus', 'target_margin', 'competitor_based', 'dynamic_demand', 'ai_optimized'];

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAdmin();
  const { data: d, error, reload } = useFetch<Detail>(`/admin/products/${id}`);
  const { run, busy } = useAction();
  const [country, setCountry] = React.useState('US');
  const [tab, setTab] = React.useState('suppliers');
  const [priceModal, setPriceModal] = React.useState(false);
  const [price, setPrice] = React.useState('');
  const [test, setTest] = React.useState(false);
  const [platform, setPlatform] = React.useState('meta');
  if (error && !d) return <ErrorBox message={error} retry={reload} />;
  if (!d) return <Loading rows={5} />;
  const p = d.product;
  const cmp = d.comparisons.find((c) => c.country === country) ?? d.comparisons[0];
  const plan = d.plans.find((x) => x.country === (cmp?.country ?? country));
  const market = p.markets.find((m) => m.country === (cmp?.country ?? country));
  const e = plan?.economics;
  const post = (path: string, body: unknown, ok: string, key: string) => run(key, async () => { await api(path, { body }); await reload(); }, ok);
  return (
    <>
      <PageHeader title={p.title} subtitle={`${p.slug} · state history: ${p.stateHistory.slice(-3).map((s) => s.state).join(' → ')}`} actions={<>
        <StatusBadge status={p.state} />
        {can('products:write') && <Button variant="secondary" size="sm" loading={busy === 'refresh'} onClick={() => post(`/admin/products/${id}/refresh`, {}, 'Offers, pricing and score refreshed', 'refresh')}>Refresh from suppliers</Button>}
        {can('products:write') && ['DRAFT', 'PAUSED', 'OUT_OF_STOCK', 'ARCHIVED'].includes(p.state) && <Button size="sm" loading={busy === 'pub'} onClick={() => post(`/admin/products/${id}/publish`, {}, 'Published', 'pub')}>Publish</Button>}
        {can('products:write') && ['PUBLISHED', 'TESTING', 'WINNER', 'SCALING', 'DECLINING'].includes(p.state) && <Button variant="secondary" size="sm" loading={busy === 'pause'} onClick={() => post(`/admin/products/${id}/transition`, { to: 'PAUSED', reason: 'paused by admin' }, 'Paused', 'pause')}>Pause</Button>}
        {can('ads:write') && <Button variant="soft" size="sm" onClick={() => setTest(true)}>Start ad test</Button>}
      </>} />
      {d.exceptions.length > 0 && <div className="mb-4 rounded-lg bg-coral-50 p-4 text-sm text-coral-700"><b>Open exceptions:</b> {d.exceptions.map((x) => x.issue).join(' · ')}</div>}
      {d.decisions.length > 0 && <div className="mb-4 rounded-lg bg-saffron-50 p-4 text-sm text-saffron-700"><b>Awaiting approval:</b> {d.decisions.map((x) => x.summary).join(' · ')} <a className="font-bold underline" href="/admin/automation">Review</a></div>}
      <div className="grid gap-4 xl:grid-cols-[18rem_1fr]">
        <div className="space-y-4">
          <Card className="overflow-hidden"><ProductArt src={p.images[0]?.url} alt={p.title} /></Card>
          <Panel title="Opportunity score" subtitle={p.opportunity ? `Action: ${p.opportunity.action}` : undefined}>
            {d.scores[0] ? <><p className="text-4xl font-bold tabular-nums">{d.scores[0].finalScore.toFixed(1)}</p><ul className="mt-3 space-y-1.5 text-sm">{Object.entries(d.scores[0].components).map(([k, v]) => <li key={k} className="flex items-center gap-2"><span className="w-28 shrink-0 capitalize text-ink-3">{k.replace(/([A-Z])/g, ' $1')}</span><div className="h-1.5 flex-1 rounded-full bg-sunken"><div className="h-full rounded-full bg-pine-600" style={{ width: `${v}%` }} /></div><b className="w-8 text-right tabular-nums">{Math.round(v)}</b></li>)}</ul><p className="mt-3 text-xs text-ink-3">{d.scores[0].reasons.join(' · ')}</p></> : <p className="text-sm text-ink-3">Not scored yet.</p>}
          </Panel>
          <Panel title="Compliance"><StatusBadge status={p.compliance.status} />{p.compliance.flags.length > 0 && <p className="mt-2 text-sm text-ink-2">{p.compliance.flags.join(', ')}</p>}</Panel>
        </div>
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-2">{d.comparisons.map((c) => <button key={c.country} onClick={() => setCountry(c.country)} aria-pressed={(cmp?.country ?? country) === c.country} className={`h-9 rounded-full px-4 text-sm font-bold ${(cmp?.country ?? country) === c.country ? 'bg-pine-600 text-white' : 'bg-sunken text-ink-2'}`}>{c.country}</button>)}</div>
          {market && <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[['Selling price', cur(market.price, market.currency)], ['Typical elsewhere', market.compareAtPrice ? cur(market.compareAtPrice, market.currency) : '—'], ['Landed cost', cur(market.landedCost, market.currency)], ['Expected margin', pctf(market.expectedMargin)]].map(([k, v]) => <Card key={k} className="p-4"><p className="text-xs font-semibold text-ink-3">{k}</p><p className="mt-1 text-xl font-bold tabular-nums">{v}</p></Card>)}
          </div>}
          <Tabs tabs={[{ id: 'suppliers', label: 'Supplier comparison' }, { id: 'economics', label: 'Unit economics' }, { id: 'campaigns', label: `Campaigns (${d.campaigns.length})` }, { id: 'content', label: 'Content' }]} value={tab} onChange={setTab} />
          {tab === 'suppliers' && cmp && (
            <div className="space-y-3">
              {cmp.rows.map((r, i) => (
                <Card key={r.supplierId} className={`p-4 ${i === 0 && r.eligible ? 'ring-2 ring-pine-600' : ''} ${!r.eligible ? 'opacity-70' : ''}`}>
                  <div className="flex flex-wrap items-center gap-2"><b>{r.supplierName}</b>{i === 0 && r.eligible && <Badge tone="ok">Recommended</Badge>}{!r.eligible && <Badge tone="coral">{r.ineligibleReason}</Badge>}<span className="ml-auto text-sm text-ink-3">{r.warehouseCountry} warehouse</span></div>
                  <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:grid-cols-8">{[['Product', cur(r.productCost, r.currency)], ['Shipping', cur(r.shippingCost, r.currency)], ['Duties', cur(r.duties, r.currency)], ['Landed', cur(r.landedCost, r.currency)], ['Delivery', `${r.minDays}–${r.maxDays}d`], ['Stock', String(r.stock)], ['Reliability', String(r.reliability)], ['Exp. profit', cur(r.expectedProfit, r.currency)]].map(([k, v]) => <div key={k}><dt className="text-xs text-ink-3">{k}</dt><dd className="font-bold tabular-nums">{v}</dd></div>)}</dl>
                  <p className="mt-2 text-xs text-ink-3">Customer experience {r.cxScore}/100 · blended score {r.finalScore} · margin {pctf(r.margin)}</p>
                </Card>
              ))}
              <p className="rounded-lg bg-pine-50 p-4 text-sm text-pine-700"><b>AI recommendation: {cmp.recommendation.supplierName ?? 'none'}.</b> {cmp.recommendation.reason}</p>
            </div>
          )}
          {tab === 'economics' && (
            <Panel title="Unit economics" subtitle={`Strategy: ${plan?.strategy ?? '—'} · competitors: ${plan?.competitorPrices.length ? plan.competitorPrices.map((c) => cur(c, market?.currency ?? 'USD')).join(', ') : 'none entered'}`} action={can('products:write') && <Button size="sm" variant="secondary" onClick={() => { setPrice(market ? String(market.price / 100) : ''); setPriceModal(true); }}>Set price</Button>}>
              {e ? <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">{[['Supplier cost', cur(e.supplier_cost, market!.currency)], ['Shipping cost', cur(e.shipping_cost, market!.currency)], ['Landed cost', cur(e.landed_cost, market!.currency)], ['Selling price', cur(e.selling_price, market!.currency)], ['Gross margin', pctf(e.gross_margin)], ['Payment fee', cur(e.payment_fee, market!.currency)], ['Est. return cost', cur(e.estimated_return_cost, market!.currency)], ['Est. ad cost / order', cur(e.estimated_ad_cost, market!.currency)], ['Expected profit', cur(e.expected_profit, market!.currency)], ['Profit margin', pctf(e.profit_margin)], ['ROAS at this CAC', e.ROAS.toFixed(2)], ['Break-even ROAS', e.break_even_ROAS.toFixed(2)], ['Refund rate (est.)', pctf(e.refund_rate)]].map(([k, v]) => <div key={k}><dt className="text-xs text-ink-3">{k}</dt><dd className="text-base font-bold tabular-nums">{v}</dd></div>)}</dl> : <p className="text-sm text-ink-3">No eligible supplier in this country.</p>}
              {plan?.pricing && <p className="mt-4 rounded-md bg-sunken p-3 text-sm text-ink-2"><b>Pricing engine:</b> {plan.pricing.explanation}. Margin floor price: {cur(plan.pricing.floorPrice, market!.currency)}.</p>}
              {can('products:write') && <div className="mt-4 flex flex-wrap items-end gap-3"><Field label="Pricing strategy"><Select defaultValue={p.pricingConfig?.strategy ?? 'target_margin'} onChange={(ev) => void post(`/admin/products/${id}`, { pricingStrategy: ev.target.value }, 'Strategy saved — re-run pricing to apply', 'strat')} className="h-10 w-52 text-sm">{STRATS.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</Select></Field></div>}
            </Panel>
          )}
          {tab === 'campaigns' && <Panel pad>{d.campaigns.length === 0 ? <p className="text-sm text-ink-3">No campaigns yet.</p> : <ul className="divide-y divide-line">{d.campaigns.map((c) => <li key={c._id} className="flex items-center justify-between gap-3 py-2.5 text-sm"><span>{c.name} <span className="text-ink-3">· {c.platform} · {c.country}</span></span><StatusBadge status={c.status} /></li>)}</ul>}</Panel>}
          {tab === 'content' && <Panel title="Listing content"><p className="text-sm leading-relaxed text-ink-2">{p.description}</p><ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-2">{p.bullets.map((b) => <li key={b}>{b}</li>)}</ul></Panel>}
          <Panel title="Lifecycle history"><ol className="space-y-1.5 text-sm">{[...p.stateHistory].reverse().slice(0, 8).map((s, i) => <li key={i}><StatusBadge status={s.state} /> <span className="text-ink-3">{when(s.at)} · {s.by} — {s.reason}</span></li>)}</ol></Panel>
        </div>
      </div>
      <Modal open={priceModal} onClose={() => setPriceModal(false)} title={`Set ${cmp?.country ?? country} price`} size="sm" footer={<><Button variant="secondary" onClick={() => setPriceModal(false)}>Cancel</Button><Button loading={busy === 'price'} onClick={async () => { await post(`/admin/products/${id}/price`, { country: cmp?.country ?? country, price: Math.round(Number(price) * 100) }, 'Price updated', 'price'); setPriceModal(false); }}>Save</Button></>}>
        <Field label="Price" hint={plan?.pricing ? `Cannot go below the margin floor: ${cur(plan.pricing.floorPrice, market!.currency)}` : undefined}><Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
      </Modal>
      <Modal open={test} onClose={() => setTest(false)} title="Start an ad test" size="sm" footer={<><Button variant="secondary" onClick={() => setTest(false)}>Cancel</Button><Button variant="secondary" loading={busy === 'plan'} onClick={async () => { await post(`/admin/products/${id}/start-test`, { country: cmp?.country ?? country, platform, launch: false }, 'Test plan created (draft)', 'plan'); setTest(false); }}>Create plan only</Button><Button loading={busy === 'launch'} onClick={async () => { await post(`/admin/products/${id}/start-test`, { country: cmp?.country ?? country, platform, launch: true }, 'Campaign launched', 'launch'); setTest(false); }}>Create & launch</Button></>}>
        <p className="mb-3 text-sm text-ink-2">Creates a campaign with 5 creative concepts, the default test budget and success criteria. Launching respects your safe-mode spend limits; a failed ad-API call never shows as live.</p>
        <Field label="Platform"><Select value={platform} onChange={(e) => setPlatform(e.target.value)}><option value="meta">Meta</option><option value="tiktok">TikTok</option><option value="google">Google</option></Select></Field>
      </Modal>
    </>
  );
  void usd;
}
