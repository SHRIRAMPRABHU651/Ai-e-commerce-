'use client';
import * as React from 'react';
import { Badge, Button, Card, EmptyState, StatusBadge, Tabs } from '@orvia/ui';
import { ErrorBox, Loading, PageHeader, useAction, useAdmin, useFetch, when } from '@/components/admin/kit';
import { api } from '@/lib/api';
import { CheckCircle2 } from 'lucide-react';

interface Ex { _id: string; kind: string; priority: string; status: string; issue: string; orderNumber?: string; orderId?: string; customerEmail?: string; aiRecommendation?: string; suggestedAction?: string; actionCode?: string; createdAt: string; resolution?: string }
const LABEL: Record<string, string> = { retry_supplier_order: 'Retry supplier order', approve_fulfillment: 'Approve & fulfil', cancel_order: 'Cancel & refund', refund_order: 'Refund', approve_refund: 'Approve refund', review_product: 'Open product', contact_customer: 'Contact customer', dismiss: 'Dismiss' };

export default function ExceptionsPage() {
  const [tab, setTab] = React.useState('open');
  const { data, error, loading, reload } = useFetch<{ items: Ex[]; total: number }>(`/admin/exceptions?status=${tab}&pageSize=50`, 30_000);
  const { can } = useAdmin();
  const { run, busy } = useAction();
  const act = (id: string, action: string, note = '') => run(id + action, async () => { await api(`/admin/exceptions/${id}/action`, { body: { action, note } }); await reload(); }, 'Done');
  return (
    <>
      <PageHeader title="Exceptions" subtitle="The system runs itself; anything it can’t safely decide lands here with a recommendation." />
      <Tabs tabs={[{ id: 'open', label: 'Open', count: tab === 'open' ? data?.total : undefined }, { id: 'resolved', label: 'Resolved' }, { id: 'dismissed', label: 'Dismissed' }]} value={tab} onChange={setTab} className="mb-4" />
      {error && !data && <ErrorBox message={error} retry={reload} />}
      {loading && !data && <Loading />}
      {data && data.items.length === 0 && <Card><EmptyState icon={<CheckCircle2 className="size-6" />} title={tab === 'open' ? 'All clear' : 'Nothing here'} body={tab === 'open' ? 'No open exceptions. Fraud holds, supplier failures, safety reviews and unprofitable orders appear here.' : undefined} /></Card>}
      <div className="space-y-3">
        {data?.items.map((e) => (
          <Card key={e._id} className="p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2"><StatusBadge status={e.priority} /><Badge tone="info">{e.kind.replace(/_/g, ' ').toLowerCase()}</Badge>{e.orderNumber && <Badge>{e.orderNumber}</Badge>}<span className="ml-auto text-xs text-ink-3">{when(e.createdAt)}</span></div>
            <p className="mt-2.5 text-[15px] font-semibold">{e.issue}</p>
            {e.customerEmail && <p className="text-sm text-ink-3">{e.customerEmail}</p>}
            {e.aiRecommendation && <p className="mt-2 rounded-md bg-pine-50 p-3 text-sm text-pine-700"><b>Recommendation:</b> {e.aiRecommendation}</p>}
            {e.resolution && <p className="mt-2 text-sm text-ink-3">Resolution: {e.resolution}</p>}
            {tab === 'open' && can('exceptions:write') && (
              <div className="mt-3 flex flex-wrap gap-2">
                {e.actionCode && ['retry_supplier_order', 'approve_fulfillment', 'cancel_order', 'refund_order'].includes(e.actionCode) && <Button size="sm" loading={busy === e._id + e.actionCode} onClick={() => act(e._id, e.actionCode!)}>{LABEL[e.actionCode]}</Button>}
                {e.actionCode === 'refund_order' || e.suggestedAction?.includes('refund') ? null : null}
                {e.actionCode === 'review_product' && <Button size="sm" variant="secondary" href="/admin/products">Open products</Button>}
                {e.orderId && <Button size="sm" variant="secondary" href="/admin/orders">Open orders</Button>}
                {e.kind === 'HIGH_VALUE_REFUND' && <Button size="sm" loading={busy === e._id + 'approve_refund'} onClick={() => act(e._id, 'approve_refund')}>Approve refund</Button>}
                <Button size="sm" variant="ghost" loading={busy === e._id + 'resolve'} onClick={() => act(e._id, 'resolve', 'Resolved manually')}>Mark resolved</Button>
                <Button size="sm" variant="ghost" loading={busy === e._id + 'dismiss'} onClick={() => act(e._id, 'dismiss', 'Not an issue')}>Dismiss</Button>
              </div>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
