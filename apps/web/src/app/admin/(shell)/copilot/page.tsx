'use client';
import { Bot, Send, User as UserIcon } from 'lucide-react';
import * as React from 'react';
import { Badge, Button, Card, Input, cn } from '@orvia/ui';
import { PageHeader, Panel, useAdmin, useFetch } from '@/components/admin/kit';
import { api } from '@/lib/api';

interface Ans { intent: string; answer: string; tables?: { title: string; columns: string[]; rows: (string | number)[][] }[]; plan?: { description: string }[]; requiresConfirmation?: boolean; executed?: { description: string; status: string }[]; sources: string[] }
interface Msg { from: 'you' | 'ai'; text: string; ans?: Ans; question?: string }
const SUGGEST = ['How are we doing today?', 'Why did profit fall yesterday?', 'Show me the best products to scale', 'Which products are losing money?', 'Pause products losing money', 'Country performance', 'Supplier health', 'Any open exceptions?'];

export default function CopilotPage() {
  const { can } = useAdmin();
  const [msgs, setMsgs] = React.useState<Msg[]>([{ from: 'ai', text: 'Ask about your business. Every number I give comes from a database query — never from a guess. I can also propose changes; I’ll show them first and only apply them if you confirm and your automation settings allow it.' }]);
  const [q, setQ] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const end = React.useRef<HTMLDivElement>(null);
  const brief = useFetch<{ items: { narrative: string; date: string }[] }>('/admin/brief');
  React.useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [msgs]);
  const ask = async (question: string, confirm = false) => {
    if (!question.trim() || busy) return;
    if (!confirm) setMsgs((m) => [...m, { from: 'you', text: question }]);
    setQ(''); setBusy(true);
    try { const a = await api<Ans>('/admin/copilot', { body: { question, confirm } }); setMsgs((m) => [...m, { from: 'ai', text: a.answer, ans: a, question }]); } catch (e) { setMsgs((m) => [...m, { from: 'ai', text: `Sorry — ${(e as Error).message}` }]); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title="AI Copilot" subtitle="Conversational analytics grounded in your live data." />
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <Card className="flex h-[calc(100dvh-14rem)] min-h-[32rem] flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
            {msgs.map((m, i) => (
              <div key={i} className={cn('flex gap-3', m.from === 'you' && 'flex-row-reverse')}>
                <span className={cn('grid size-8 shrink-0 place-items-center rounded-full', m.from === 'you' ? 'bg-ink text-paper' : 'bg-pine-50 text-pine-700')}>{m.from === 'you' ? <UserIcon className="size-4" /> : <Bot className="size-4" />}</span>
                <div className={cn('min-w-0 max-w-[92%] rounded-2xl px-4 py-3 text-sm leading-relaxed', m.from === 'you' ? 'bg-pine-600 text-white' : 'bg-sunken')}>
                  <p className="whitespace-pre-line">{m.text}</p>
                  {m.ans?.tables?.map((t) => (
                    <div key={t.title} className="mt-3 overflow-x-auto rounded-lg bg-surface"><p className="px-3 pt-2 text-xs font-bold text-ink-3">{t.title}</p><table className="w-full min-w-72 text-xs"><thead><tr>{t.columns.map((c) => <th key={c} className="px-3 py-1.5 text-left text-ink-3">{c}</th>)}</tr></thead><tbody>{t.rows.map((r, k) => <tr key={k} className="border-t border-line">{r.map((c, j) => <td key={j} className="px-3 py-1.5 tabular-nums">{c}</td>)}</tr>)}</tbody></table></div>
                  ))}
                  {m.ans?.requiresConfirmation && can('copilot:use') && <div className="mt-3 flex gap-2"><Button size="sm" loading={busy} onClick={() => void ask(m.question!, true)}>Confirm and apply</Button></div>}
                  {m.ans && m.ans.sources.length > 0 && <p className="mt-2 text-[11px] text-ink-3">Sources: {m.ans.sources.join(', ')}</p>}
                </div>
              </div>
            ))}
            {busy && <p className="text-sm text-ink-3">Querying your data…</p>}
            <div ref={end} />
          </div>
          <div className="border-t border-line p-3 sm:p-4">
            <div className="no-scrollbar mb-3 flex gap-2 overflow-x-auto">{SUGGEST.map((s) => <button key={s} onClick={() => void ask(s)} className="shrink-0 rounded-full border border-line-strong px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-sunken">{s}</button>)}</div>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void ask(q); }}><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about revenue, profit, products, countries, suppliers…" aria-label="Question" /><Button type="submit" loading={busy} aria-label="Send"><Send className="size-4" /></Button></form>
          </div>
        </Card>
        <Panel title="Today’s brief" subtitle={brief.data?.items[0]?.date} action={<Badge tone="pine">from database</Badge>}>
          {brief.data?.items[0] ? <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-ink-2">{brief.data.items[0].narrative}</pre> : <p className="text-sm text-ink-3">No brief generated yet.</p>}
        </Panel>
      </div>
    </>
  );
}
