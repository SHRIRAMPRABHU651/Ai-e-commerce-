'use client';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import * as React from 'react';
import { Badge, Button, Card, EmptyState, Skeleton, useToast } from '@orvia/ui';
import { api, ApiError, money } from '@/lib/api';
import { useStore } from './providers';

interface Offer { id: string; kind: string; label: string; text: string; materialChanges: string[]; refund: number | null; etaDays: { min: number | null; max: number | null } | null; status: string; expiresAt: string }
interface RecoveryCase { caseId: string; state: string; problem: string; item: string; currency: string; openedAt: string; resolvedAt: string | null; offers: Offer[]; statusText: string }
interface RecoveryView { orderNumber: string; cases: RecoveryCase[] }

/** Customer-facing Delivery Rescue page: plain-language options, accept/decline, single-use. Owners or consent-link holders only. */
export function RecoveryPage({ orderNumber, token }: { orderNumber: string; token?: string }) {
  const { user } = useStore();
  const toast = useToast();
  const [view, setView] = React.useState<RecoveryView | null>(null);
  const [err, setErr] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<Record<string, 'accepted' | 'declined'>>({});
  const load = React.useCallback(async () => {
    try {
      setView(await api<RecoveryView>(`/orders/${encodeURIComponent(orderNumber)}/recovery${token ? `?token=${encodeURIComponent(token)}` : ''}`));
      setErr('');
    } catch (e) { setErr((e as ApiError).message); } finally { setLoading(false); }
  }, [orderNumber, token]);
  React.useEffect(() => { void load(); }, [load, user?.id]);

  const decide = async (o: Offer, decision: 'accept' | 'decline') => {
    if (decision === 'accept' && o.materialChanges.length && !confirm(`${o.label}\n\n${o.materialChanges.join('\n')}\n\nConfirm your choice? It can only be made once.`)) return;
    setBusy(o.id + decision);
    try {
      const r = await api<{ status: 'accepted' | 'declined' }>(`/orders/${encodeURIComponent(orderNumber)}/recovery/decision`, { body: { optionId: o.id, decision, token } });
      setDone((d) => ({ ...d, [o.id]: r.status }));
      toast.success(decision === 'accept' ? 'Thank you. We are acting on your choice.' : 'Noted. Nothing was changed.');
      await load();
    } catch (e) { toast.error((e as Error).message); await load(); } finally { setBusy(null); }
  };

  if (loading) return <div className="mx-auto max-w-2xl px-4 py-10"><Skeleton className="h-64" /></div>;
  if (err || !view) {
    return (
      <div className="mx-auto max-w-md px-4 py-14 text-center" role="alert">
        <h1 className="font-display text-2xl font-semibold">We could not open this page</h1>
        <p className="mt-2 text-ink-3">{err || 'Something went wrong.'}</p>
        <p className="mt-2 text-sm text-ink-3">Use the link from our email, or sign in to the account that placed order {orderNumber}.</p>
        <div className="mt-5 flex justify-center gap-2"><Button onClick={() => { setLoading(true); void load(); }}>Try again</Button><Button variant="secondary" href={`/orders/${orderNumber}`}>View order</Button></div>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:py-12">
      <p className="text-sm text-ink-3">Order {view.orderNumber}</p>
      <h1 className="font-display text-3xl font-semibold tracking-tight">Fixing your delivery</h1>
      <p className="mt-2 flex items-start gap-2 text-sm text-ink-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-pine-600" aria-hidden /> Nothing changes unless you choose it. Each choice can only be made once, and it is recorded.</p>
      {view.cases.length === 0 && <Card className="mt-6"><EmptyState icon={<CheckCircle2 className="size-6" />} title="Nothing needs your attention" body="We have not found any problem with this order. You can follow it on your order page." /></Card>}
      <div className="mt-6 space-y-5">
        {view.cases.map((c) => (
          <Card key={c.caseId} className="p-5 sm:p-6">
            <div className="flex flex-wrap items-center gap-2"><Badge tone={c.state === 'resolved' ? 'ok' : c.state === 'awaiting_customer' ? 'warn' : 'info'}>{c.state === 'awaiting_customer' ? 'Your decision needed' : c.statusText}</Badge><span className="text-sm text-ink-3">{c.item}</span></div>
            <p className="mt-3 text-[15px]">The issue: {c.problem}.</p>
            {c.offers.length > 0 && (
              <ul className="mt-4 space-y-3" aria-label="Your options">
                {c.offers.map((o) => {
                  const open = o.status === 'pending';
                  return (
                    <li key={o.id} className="rounded-lg border border-line p-4">
                      <p className="font-semibold">{o.label}</p>
                      <p className="mt-1 text-sm text-ink-2">{o.text}</p>
                      {o.refund ? <p className="mt-1 text-sm font-semibold">Refund: {money(o.refund, c.currency)}</p> : null}
                      {o.materialChanges.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm text-warn-500">{o.materialChanges.map((m) => <li key={m}>{m}</li>)}</ul>}
                      {open ? (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <Button size="sm" loading={busy === o.id + 'accept'} disabled={!!busy} onClick={() => decide(o, 'accept')}>{o.kind === 'continue_shipment' ? 'Keep waiting' : 'Choose this'}</Button>
                          <Button size="sm" variant="ghost" loading={busy === o.id + 'decline'} disabled={!!busy} onClick={() => decide(o, 'decline')}>No thanks</Button>
                          <span className="text-xs text-ink-3">Valid until {new Date(o.expiresAt).toLocaleString()}</span>
                        </div>
                      ) : <p className="mt-3 text-sm text-ink-3">{done[o.id] === 'accepted' || o.status === 'accepted' ? 'You chose this option.' : o.status === 'declined' ? 'You declined this option.' : o.status === 'expired' ? 'This offer has expired.' : 'No longer available.'}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="mt-4"><Button size="sm" variant="secondary" href={`/orders/${view.orderNumber}`}>Back to my order</Button></div>
          </Card>
        ))}
      </div>
    </div>
  );
}
