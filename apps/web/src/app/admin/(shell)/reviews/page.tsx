'use client';
import { Star } from 'lucide-react';
import * as React from 'react';
import { Badge, Button, Card, StatusBadge } from '@orvia/ui';
import { ErrorBox, FilterSelect, Loading, PageHeader, Toolbar, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface R { _id: string; productId: string; productTitle?: string; rating: number; title?: string; body?: string; authorName?: string; verifiedPurchase: boolean; status: string; createdAt: string }
interface An { analysis: { positivePct: number; neutralPct: number; negativePct: number; praise: string[]; complaints: string[]; quality: string; shippingComplaints: number; supplierProblems: number }; source: string; previousNegativePct: number; alert: boolean }
export default function ReviewsPage() {
  const { can } = useAdmin();
  const [max, setMax] = React.useState('');
  const [page, setPage] = React.useState(1);
  const { data, error, reload } = useFetch<{ items: R[]; total: number }>(`/admin/reviews?page=${page}&pageSize=20${max ? `&maxRating=${max}` : ''}`);
  const { run, busy } = useAction();
  const [analysis, setAnalysis] = React.useState<Record<string, An>>({});
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader title="Reviews" subtitle="Moderate reviews and run sentiment analysis. A sharp rise in negative sentiment raises an exception automatically." />
      <Toolbar><FilterSelect label="Rating" value={max} onChange={(v) => { setMax(v); setPage(1); }} options={[['', 'All ratings'], ['2', '2★ and below'], ['3', '3★ and below']]} /></Toolbar>
      <div className="space-y-3">
        {data.items.map((r) => (
          <Card key={r._id} className="p-4">
            <div className="flex flex-wrap items-center gap-2"><span className="flex">{Array.from({ length: 5 }, (_, i) => <Star key={i} className={`size-4 ${i < r.rating ? 'fill-saffron-500 text-saffron-500' : 'text-line-strong'}`} />)}</span><b className="text-sm">{r.title}</b>{r.verifiedPurchase && <Badge tone="ok">Verified</Badge>}<StatusBadge status={r.status} /><span className="ml-auto text-xs text-ink-3">{when(r.createdAt)}</span></div>
            <p className="mt-1.5 text-sm text-ink-2">{r.body}</p>
            <p className="mt-1 text-xs text-ink-3">{r.authorName} on <b>{r.productTitle}</b></p>
            <div className="mt-3 flex flex-wrap gap-2">
              {can('reviews:write') && (r.status === 'published' ? <Button size="sm" variant="ghost" loading={busy === r._id} onClick={() => void run(r._id, async () => { await api(`/admin/reviews/${r._id}`, { method: 'PATCH', body: { status: 'rejected' } }); await reload(); }, 'Hidden')}>Hide</Button> : <Button size="sm" variant="secondary" onClick={() => void run(r._id, async () => { await api(`/admin/reviews/${r._id}`, { method: 'PATCH', body: { status: 'published' } }); await reload(); })}>Publish</Button>)}
              <Button size="sm" variant="secondary" loading={busy === r.productId} onClick={() => void run(r.productId, async () => { const a = await api<An>(`/admin/reviews/analysis/${r.productId}`); setAnalysis((s) => ({ ...s, [r.productId]: a })); })}>Analyse product sentiment</Button>
            </div>
            {analysis[r.productId] && (() => { const a = analysis[r.productId]!; return <div className="mt-3 rounded-lg bg-sunken p-3 text-sm"><p><b>{a.analysis.positivePct}%</b> positive · {a.analysis.neutralPct}% neutral · <b className={a.analysis.negativePct >= 30 ? 'text-coral-500' : ''}>{a.analysis.negativePct}%</b> negative (previously {a.previousNegativePct}%) · quality: {a.analysis.quality}{a.alert ? ' · ALERT raised' : ''}</p><p className="mt-1 text-ink-3">Complaints: {a.analysis.complaints.join(', ') || '—'} · shipping complaints {a.analysis.shippingComplaints} · supplier problems {a.analysis.supplierProblems} · analysed by {a.source}</p></div>; })()}
          </Card>
        ))}
        {data.items.length === 0 && <Card className="p-8 text-center text-sm text-ink-3">No reviews match.</Card>}
      </div>
      {data.total > 20 && <div className="mt-4 flex justify-center gap-2"><Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button variant="secondary" size="sm" disabled={page * 20 >= data.total} onClick={() => setPage(page + 1)}>Next</Button></div>}
    </>
  );
}
