'use client';
import { Bot, MessageCircle, Send, ShieldCheck, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Button, Drawer, Input, Link, cn } from '@orvia/ui';
import type { AssistantCard, AssistantPending, AssistantReply } from '@orvia/types';
import { api, money } from '@/lib/api';
import { useStore } from './providers';

/**
 * ORVIA Shopping Assistant. Replies come from `POST /api/v1/assistant/message`: deterministic tools first, a model only when
 * nothing matched. Cards are rendered from tool results (never from model text). Guarded actions (start a return, price alert,
 * save a preference, request a replacement) appear as confirmation prompts: nothing happens until the customer presses Confirm.
 */
interface Msg {
  from: 'you' | 'bot';
  text: string;
  cards?: AssistantCard[];
  pending?: (AssistantPending & { state?: 'open' | 'confirmed' | 'cancelled' | 'failed' })[];
  escalated?: string;
  aiUsed?: boolean;
  suggestions?: string[];
  error?: boolean;
}

const KEY = 'orvia.assistant.session';
const store = {
  get: (): string | undefined => { try { return window.sessionStorage.getItem(KEY) ?? undefined; } catch { return undefined; } },
  set: (v: string | null) => { try { if (v) window.sessionStorage.setItem(KEY, v); else window.sessionStorage.removeItem(KEY); } catch { /* storage may be blocked */ } },
};
const INTRO: Msg = { from: 'bot', text: 'Hi! I can help you find and compare products, track an order, check a refund or start a return. I use our real catalogue and order data, and I can bring in a team member any time. What do you need?', suggestions: ['Find a gift under $50', 'Track my order', 'Where is my refund?'] };
const human = (s: string) => s.replace(/_/g, ' ').toLowerCase();

function Cards({ cards, onAsk }: { cards: AssistantCard[]; onAsk: (m: string) => void }) {
  return (
    <div className="mt-2 space-y-2">
      {cards.map((c, i) => {
        switch (c.type) {
          case 'products': return (
            <ul key={i} className="space-y-2" aria-label="Suggested products">
              {c.items.map((p) => (
                <li key={p.id} className="rounded-lg border border-line bg-surface p-2.5 text-ink">
                  <Link href={`/p/${p.slug}`} className="text-sm font-bold text-pine-700 hover:underline">{p.title}</Link>
                  <p className="text-sm">{money(p.price, p.currency)}{p.rating ? <span className="text-ink-3"> · rated {p.rating.toFixed(1)}</span> : null}</p>
                  <p className="text-xs text-ink-3">{p.inStock ? 'In stock' : 'Out of stock'}{p.delivery ? ` · usually ${p.delivery}` : ''}</p>
                  {p.why.length > 0 && <p className="text-xs text-ink-3">{p.why.join(' · ')}</p>}
                </li>
              ))}
            </ul>
          );
          case 'order': return (
            <div key={i} className="rounded-lg border border-line bg-surface p-2.5 text-sm text-ink">
              <Link href={`/orders/${c.orderNumber}`} className="font-bold text-pine-700 hover:underline">{c.orderNumber}</Link> <span className="text-xs text-ink-3">{human(c.status)}</span>
              <ul className="mt-1 text-xs text-ink-2">{c.items.map((it, j) => <li key={j}>{it.quantity} × {it.title}</li>)}</ul>
              {c.shipments.map((s, j) => <p key={j} className="mt-1 text-xs text-ink-3">{human(s.status)}{s.carrier ? ` · ${s.carrier}` : ''}{s.trackingNumber ? ` · ${s.trackingNumber}` : ''}{s.estimatedDelivery ? ` · est. ${s.estimatedDelivery}` : ''}</p>)}
            </div>
          );
          case 'orders': return (
            <ul key={i} className="space-y-1" aria-label="Your recent orders">
              {c.items.map((o) => <li key={o.orderNumber}><button type="button" onClick={() => onAsk(`Track order ${o.orderNumber}`)} className="w-full rounded-lg border border-line bg-surface p-2 text-left text-sm text-ink hover:bg-sunken"><b>{o.orderNumber}</b> <span className="text-xs text-ink-3">{human(o.status)}{o.firstItem ? ` · ${o.firstItem}` : ''}</span></button></li>)}
            </ul>
          );
          case 'comparison': return (
            <div key={i} className="overflow-x-auto rounded-lg border border-line bg-surface p-2.5 text-xs text-ink">
              {c.differences.length > 0 && <ul className="mb-2 list-disc pl-4">{c.differences.map((d, j) => <li key={j}>{d}</li>)}</ul>}
              <table className="w-full text-left"><thead><tr><th className="pr-2" />{c.products.map((p) => <th key={p} className="pr-2 font-bold">{p}</th>)}</tr></thead><tbody>{c.rows.map((r) => <tr key={r.label}><td className="pr-2 text-ink-3">{r.label}</td>{r.values.map((v, j) => <td key={j} className="pr-2">{v ?? '—'}</td>)}</tr>)}</tbody></table>
            </div>
          );
          case 'eligibility': return (
            <div key={i} className="rounded-lg border border-line bg-surface p-2.5 text-xs text-ink">
              <p className="font-bold">Return eligibility · {c.orderNumber}</p>
              <ul className="mt-1 space-y-1">{c.lines.map((l) => <li key={l.sku}><span className={l.eligible ? 'text-ok-500' : 'text-coral-700'}>{l.eligible ? 'Eligible' : 'Not eligible'}</span> · {l.title}{l.reasons.length ? <span className="block text-ink-3">{l.reasons.join(' ')}</span> : null}</li>)}</ul>
            </div>
          );
          case 'refund': return (
            <div key={i} className="rounded-lg border border-line bg-surface p-2.5 text-xs text-ink">
              <p className="font-bold">{c.headline}</p>
              <ol className="mt-1 space-y-0.5">{c.steps.map((s, j) => <li key={j}><span className="text-ink-3">{human(s.status)}</span> · {s.label}{s.detail ? ` (${s.detail})` : ''}</li>)}</ol>
            </div>
          );
          case 'facts': return (
            <div key={i} className="rounded-lg border border-line bg-surface p-2.5 text-xs text-ink">
              <p className="font-bold">{c.product}: facts on file</p>
              <ul className="mt-1 space-y-0.5">{c.facts.map((f, j) => <li key={j}>{f.label}: {f.value} <span className="text-ink-3">({f.provenance.replace('_', '-')})</span></li>)}</ul>
              {c.missing.length > 0 && <p className="mt-1 text-ink-3">Not on file: {c.missing.join(', ')}</p>}
            </div>
          );
          case 'resolution': return (
            <div key={i} className="rounded-lg border border-line bg-surface p-2.5 text-xs text-ink">
              <p className="font-bold">Options your policy allows</p>
              <ul className="mt-1 space-y-1">{c.options.map((o, j) => <li key={j} className={o.permitted ? '' : 'text-ink-3 line-through'}>{o.label}{o.label === c.recommended ? <b> (fairest)</b> : null}<span className="block text-ink-3 no-underline">{o.reason}</span></li>)}</ul>
              {c.outcomeId && <Rate outcomeId={c.outcomeId} />}
            </div>
          );
          default: return null;
        }
      })}
    </div>
  );
}

function Rate({ outcomeId }: { outcomeId: string }) {
  const [state, setState] = React.useState<'idle' | 'busy' | 'done' | 'wait'>('idle');
  const rate = async (n: number) => {
    setState('busy');
    try { await api(`/assistant/outcomes/${outcomeId}/rating`, { body: { rating: n } }); setState('done'); } catch { setState('wait'); }
  };
  if (state === 'done') return <p className="mt-2 text-ok-500">Thanks for the feedback.</p>;
  return (
    <div className="mt-2" role="group" aria-label="Rate how this was resolved">
      <p className="text-ink-3">Once your case is resolved you can rate it:</p>
      <div className="mt-1 flex gap-1">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" aria-label={`${n} out of 5`} disabled={state === 'busy'} onClick={() => void rate(n)} className="size-7 rounded border border-line bg-surface text-xs font-bold hover:bg-sunken">{n}</button>)}</div>
      {state === 'wait' && <p className="mt-1 text-ink-3">This can be rated after the case is resolved.</p>}
    </div>
  );
}

function Pending({ p, onResolved }: { p: NonNullable<Msg['pending']>[number]; onResolved: (state: 'confirmed' | 'cancelled' | 'failed', message: string) => void }) {
  const [busy, setBusy] = React.useState(false);
  const decide = async (decision: 'confirm' | 'cancel') => {
    setBusy(true);
    try {
      const r = await api<{ executed: boolean; cancelled: boolean; message: string }>('/assistant/confirm', { body: { actionId: p.actionId, token: p.token, decision } });
      onResolved(r.cancelled ? 'cancelled' : r.executed ? 'confirmed' : 'failed', r.message);
    } catch (e) { onResolved('failed', (e as Error).message); } finally { setBusy(false); }
  };
  if (p.state && p.state !== 'open') return null;
  return (
    <div className="mt-2 rounded-lg border border-saffron-500 bg-saffron-50 p-2.5 text-sm text-ink" role="group" aria-label="Confirm this action">
      <p className="font-bold">Please confirm</p>
      <p className="mt-0.5">{p.summary}</p>
      <p className="mt-0.5 text-xs text-ink-3">Nothing happens until you confirm. Refunds and approvals are decided by our rules and team, not by the assistant.</p>
      <div className="mt-2 flex gap-2"><Button size="sm" loading={busy} onClick={() => void decide('confirm')}>Confirm</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => void decide('cancel')}>Cancel</Button></div>
    </div>
  );
}

export function AssistantWidget() {
  const { user, country } = useStore();
  const [open, setOpen] = React.useState(false);
  const [msgs, setMsgs] = React.useState<Msg[]>([INTRO]);
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const session = React.useRef<string | undefined>(undefined);
  const end = React.useRef<HTMLDivElement>(null);
  const verified = !!user && user.role === 'CUSTOMER' && user.emailVerified;
  React.useEffect(() => { session.current = store.get(); }, []);
  React.useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [msgs, open]);

  const send = React.useCallback(async (message: string) => {
    const m = message.trim();
    if (!m || busy) return;
    setMsgs((x) => [...x, { from: 'you', text: m }]);
    setText('');
    setBusy(true);
    try {
      const r = await api<AssistantReply>('/assistant/message', { body: { message: m, sessionId: session.current, country, ...(!verified && email ? { email } : {}) } });
      session.current = r.sessionId;
      store.set(r.sessionId);
      setMsgs((x) => [...x, { from: 'bot', text: r.reply, cards: r.cards, pending: r.pending.map((p) => ({ ...p, state: 'open' as const })), escalated: r.escalated ? (r.escalationNote ?? 'A team member has been notified.') : undefined, aiUsed: r.aiUsed, suggestions: r.suggestions }]);
    } catch (e) {
      setMsgs((x) => [...x, { from: 'bot', error: true, text: `Sorry, I could not answer just now (${(e as Error).message}). Please try again, or contact support.` }]);
    } finally { setBusy(false); }
  }, [busy, country, email, verified]);

  const resolve = (mi: number, actionId: string, state: 'confirmed' | 'cancelled' | 'failed', message: string) =>
    setMsgs((x) => [...x.map((m, i) => (i === mi ? { ...m, pending: m.pending?.map((p) => (p.actionId === actionId ? { ...p, state } : p)) } : m)), { from: 'bot', text: message, error: state === 'failed' }]);

  const clear = async () => {
    try { if (session.current) await api(`/assistant/conversations/${session.current}`, { method: 'DELETE' }); } catch { /* already gone */ }
    session.current = undefined; store.set(null); setMsgs([INTRO]);
  };

  return (
    <>
      <button onClick={() => setOpen(true)} aria-label="Open shopping assistant" className="fixed bottom-[4.75rem] right-4 z-40 grid size-12 place-items-center rounded-full bg-pine-700 text-white shadow-pop transition hover:scale-105 md:bottom-6 md:right-6"><MessageCircle className="size-5" /></button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Orvia assistant" width="sm:max-w-md"
        footer={<form onSubmit={(e) => { e.preventDefault(); void send(text); }} className="flex gap-2"><Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about products, orders, returns…" aria-label="Message to the assistant" maxLength={1000} /><Button type="submit" aria-label="Send" loading={busy}><Send className="size-4" /></Button></form>}>
        <div className="flex min-h-full flex-col gap-3 p-4">
          <p className="flex items-start gap-1.5 rounded-lg bg-pine-50 p-2.5 text-xs text-pine-900"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />AI assistant. It answers from our catalogue and order data and can be wrong; it never decides refunds. {verified ? 'Signed in: I can help with your orders.' : 'Sign in with a verified email to use account help; guests get product help and order lookup by order number + email.'}</p>
          {!verified && <label className="rounded-lg bg-sunken p-3 text-xs text-ink-2">To look up an order as a guest, enter the email used at checkout and the order number:<Input className="mt-2 h-9 text-sm" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" aria-label="Email for guest order lookup" /></label>}
          <div role="log" aria-live="polite" aria-label="Conversation" className="flex flex-col gap-3">
            {msgs.map((m, i) => (
              <div key={i} className={cn('max-w-[92%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed', m.from === 'you' ? 'ml-auto rounded-br-sm bg-pine-600 text-white' : m.error ? 'rounded-bl-sm bg-coral-50 text-coral-700' : 'rounded-bl-sm bg-sunken text-ink')}>
                {m.from === 'bot' && <span className="mb-0.5 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-ink-3"><Bot className="size-3" aria-hidden />Assistant{m.aiUsed ? ' · AI-worded' : ''}</span>}
                <span className="whitespace-pre-line">{m.text}</span>
                {m.cards?.length ? <Cards cards={m.cards} onAsk={(q) => void send(q)} /> : null}
                {m.pending?.map((p) => <Pending key={p.actionId} p={p} onResolved={(s, msg) => resolve(i, p.actionId, s, msg)} />)}
                {m.escalated && <p className="mt-2 rounded bg-saffron-50 p-2 text-xs text-saffron-700" role="status">{m.escalated}</p>}
                {m.suggestions?.length ? <div className="mt-2 flex flex-wrap gap-1.5">{m.suggestions.map((s) => <button key={s} type="button" onClick={() => void send(s)} className="rounded-full bg-surface px-3 py-1 text-xs font-bold text-pine-700 hover:bg-pine-50">{s}</button>)}</div> : null}
              </div>
            ))}
            {busy && <div className="w-16 rounded-2xl rounded-bl-sm bg-sunken px-4 py-3 text-ink-3" aria-label="The assistant is typing">···</div>}
            <div ref={end} />
          </div>
          <button type="button" onClick={() => void clear()} className="mt-auto flex items-center gap-1 self-start text-xs text-ink-3 underline hover:text-ink"><Trash2 className="size-3" aria-hidden />Delete this conversation</button>
        </div>
      </Drawer>
    </>
  );
}
