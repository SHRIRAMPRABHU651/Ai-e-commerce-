/**
 * Shopping Assistant logic (pure): deterministic intent detection, tool planning and templated replies.
 * Obvious intents never call a model. Every sentence in a template comes from a tool output, so the reply is grounded by
 * construction; the grounding check still runs on it. A model is only used when nothing matched.
 */
import type { AssistantCard } from '@orvia/types';
import type { AuthContext, PlannedCall, ToolResults } from './framework';

export const INTENTS = ['greeting', 'human', 'problem', 'track_order', 'refund_status', 'return_eligibility', 'start_return', 'replacement', 'price_alert', 'save_preference', 'previous_purchases', 'compare', 'product_facts', 'delivery_info', 'search', 'unknown'] as const;
export type Intent = (typeof INTENTS)[number];

const RULES: [Intent, RegExp][] = [
  ['greeting', /^\s*(hi|hello|hey|good (morning|afternoon|evening)|help|start)\W*$/i],
  ['human', /\b(human|real person|live agent|talk to (a |an )?(person|someone|agent)|speak (to|with) (a |an )?(person|someone|agent)|customer service|representative)\b/i],
  ['replacement', /\b(replace(ment)?|swap (it|this)|send (me )?(a )?(new|another) (one|item))\b/i],
  ['return_eligibility', /\b(can i return|am i able to return|return (policy|window|eligib\w*)|eligible (for|to) return|how (do|can) i return)\b/i],
  ['start_return', /\b((start|begin|open|make|want|need|like|would like|wish) (to )?(a )?return|return (this|it|my|the|that)|send (it |this )?back|want (my money|a refund)|exchange)\b/i],
  ['refund_status', /\b(refund (status|progress|update)|where('?s| is) my refund|refund (is )?(pending|late|missing|not)|money back|has my refund)\b/i],
  ['problem', /\b(damaged|broken|defective|faulty|doesn'?t work|not working|missing (item|part|parts)|wrong (item|product|size|colou?r)|never arrived|didn'?t arrive|hasn'?t arrived|not arrived|lost (in|my)|delayed|late|stuck)\b/i],
  ['track_order', /\b(track|tracking|where('?s| is) my (order|package|parcel|delivery)|order status|delivery status|when will (it|my)|has (it|my order) shipped|shipped yet)\b/i],
  ['price_alert', /\b(price alert|alert me|notify me|tell me|let me know)\b[^.?!]{0,40}\b(price|drop|cheaper|sale|stock)\b|\btrack (the )?price\b|\bwatch (the )?price\b/i],
  ['save_preference', /\b(remember (that|this|my)?|save (this|my|that)|note that|keep in mind|my (favou?rite|preference|size) is)\b/i],
  ['previous_purchases', /\b(i (bought|ordered|purchased)|previous(ly)? (purchase|order)|my (past|previous|recent|last) orders?|reorder|buy (it )?again|what did i (buy|order)|order history)\b/i],
  ['compare', /\b(compare|difference between|vs\.?|versus|which is better|better than)\b/i],
  ['product_facts', /\b(warranty|guarantee|certif\w*|safe for|material|made (of|from)|waterproof|compatible|dimensions?|specs?|specifications?|battery|weight|what'?s (in|included)|come with)\b/i],
  ['delivery_info', /\b(how long (does|will|would)|delivery (time|estimate|window)|ship(ping)? (time|to)|arrive by|when (can|will) (i|it) (get|arrive)|customs|duties)\b/i],
  ['search', /\b(looking for|i need|i want|find( me)?|show me|recommend|suggest|gift|best|cheap(est)?|under \$?\d+|below \$?\d+|buy|shop for|any good|ideas? for)\b/i],
];

export function detectIntent(message: string): Intent {
  const m = message.trim();
  for (const [i, re] of RULES) if (re.test(m)) return i;
  return 'unknown';
}

export const ORDER_NO = /\bORV-[A-Z0-9]+-[A-F0-9]{6}\b/i;
export const extractOrderNumber = (text: string): string | undefined => ORDER_NO.exec(text)?.[0]?.toUpperCase();

export type ReasonCode = 'damaged' | 'defective' | 'wrong_item' | 'missing_parts' | 'not_as_described' | 'not_delivered' | 'size_fit' | 'changed_mind' | 'better_price' | 'other';
export function extractReason(text: string): ReasonCode | undefined {
  const t = text.toLowerCase();
  if (/\b(damaged|broken|cracked|smashed|arrived (broken|damaged))\b/.test(t)) return 'damaged';
  if (/\b(defective|faulty|doesn'?t work|not working|stopped working|dead on arrival)\b/.test(t)) return 'defective';
  if (/\bwrong (item|product|one|size|colou?r)|not what i ordered|different (item|product)\b/.test(t)) return 'wrong_item';
  if (/\bmissing (item|part|parts|piece|pieces)\b/.test(t)) return 'missing_parts';
  if (/\bnot as described|different from (the )?(photo|picture|description)|doesn'?t match\b/.test(t)) return 'not_as_described';
  if (/\bnever arrived|didn'?t arrive|not delivered|hasn'?t arrived|lost\b/.test(t)) return 'not_delivered';
  if (/\b(too (small|big|large|tight|loose)|doesn'?t fit|size)\b/.test(t)) return 'size_fit';
  if (/\b(changed my mind|don'?t want|no longer (want|need)|ordered by mistake)\b/.test(t)) return 'changed_mind';
  if (/\b(cheaper (elsewhere|somewhere)|better price|found (it )?cheaper)\b/.test(t)) return 'better_price';
  return undefined;
}
const DEFECT_CONDITION: Partial<Record<ReasonCode, 'damaged' | 'defective'>> = { damaged: 'damaged', defective: 'defective' };
export function extractCondition(text: string): 'unopened' | 'opened_unused' | 'used' | undefined {
  const t = text.toLowerCase();
  if (/\b(unopened|sealed|never opened|still in (the )?(box|packaging))\b/.test(t)) return 'unopened';
  if (/\b(unused|never used|not used|opened but)\b/.test(t)) return 'opened_unused';
  if (/\b(used|worn)\b/.test(t)) return 'used';
  return undefined;
}

export interface AssistantInput { message: string; orderNumber?: string; country: string }
export interface AssistantMemory { lastOrderNumber?: string; lastProducts?: { id: string; slug: string }[] }

const memOf = (m: Record<string, unknown>): AssistantMemory => ({
  lastOrderNumber: typeof m['lastOrderNumber'] === 'string' ? (m['lastOrderNumber'] as string) : undefined,
  lastProducts: Array.isArray(m['lastProducts']) ? (m['lastProducts'] as { id: string; slug: string }[]).filter((p) => p && typeof p.id === 'string' && typeof p.slug === 'string').slice(0, 4) : [],
});
export const orderRef = (input: AssistantInput, mem: AssistantMemory): string | undefined => extractOrderNumber(input.message) ?? input.orderNumber?.toUpperCase() ?? mem.lastOrderNumber;

/* ---------------------------------- results helpers ---------------------------------- */
export const lastOk = <T,>(r: ToolResults, tool: string): T | null => {
  const a = (r.get(tool) ?? []).filter((x) => x.ok);
  return a.length ? (a[a.length - 1]!.data as T) : null;
};
export const allOk = <T,>(r: ToolResults, tool: string): T[] => (r.get(tool) ?? []).filter((x) => x.ok).map((x) => x.data as T);
export const awaiting = (r: ToolResults, tool: string): boolean => (r.get(tool) ?? []).some((x) => !x.ok && x.reason === 'awaiting_confirmation');
export const refusedWith = (r: ToolResults, tool: string): string | null => (r.get(tool) ?? []).find((x) => !x.ok && x.reason !== 'awaiting_confirmation')?.reason ?? null;

interface FindOut { total: number; currency: string; items: { id: string; slug: string; title: string; image: string | null; price: number; currency: string; rating: number | null; reviewCount: number; inStock: boolean; minDays: number | null; maxDays: number | null; deliveryFit: string; why: string[] }[] }
interface OrderOut { found: boolean; orderNumber?: string; status?: string; total?: number | null; currency?: string; delivered?: boolean; deliveredAt?: string | null; items?: { title: string; quantity: number; sku: string }[]; shipments?: { status: string; carrier: string | null; trackingNumber: string | null; trackingUrl: string | null; estimatedDelivery: string | null }[]; createdAt?: string | null }
interface OrdersOut { items: { orderNumber: string; status: string; createdAt: string | null; itemCount: number; firstItem: string | null; titles: string[] }[] }
interface EligOut { found: boolean; orderNumber?: string; eligible?: boolean; windowDays?: number | null; daysLeft?: number | null; orderReasons?: string[]; lines?: { sku: string; title: string; eligible: boolean; maxQuantity: number; reasons: string[]; resolutions: string[] }[] }
interface RefundOut { found: boolean; orderNumber?: string; headline?: string; steps?: { label: string; status: string; detail?: string }[]; returnState?: string | null; rmaNumber?: string | null }
interface CompareOut { currency: string; products: { id: string; title: string; price: number; deliveredEstimate: number; available: boolean }[]; keyDifferences: string[]; bestFor: { label: string; productId: string; detail: string }[]; rows: { label: string; values: (string | null)[]; differs: boolean }[] }
interface FactsOut { found: boolean; title?: string; facts: { label: string; value: string; provenance: string }[]; documents: { title: string; kind: string; provenance: string; expired: boolean }[]; warranty: string | null; missing: string[]; delivery: string | null }
interface ConfOut { found: boolean; title?: string; available?: boolean; minDays: number | null; maxDays: number | null; deliveryStatement: string | null; returnWindowDays: number | null; returnNote: string | null; uncertainty: string[] }

/* ------------------------------------- planning ------------------------------------- */
const accountIntents: Intent[] = ['track_order', 'refund_status', 'return_eligibility', 'start_return', 'replacement', 'previous_purchases', 'price_alert', 'save_preference', 'problem'];

export function planAssistant(input: AssistantInput, auth: AuthContext, memory: Record<string, unknown>): PlannedCall[] {
  const intent = detectIntent(input.message);
  const mem = memOf(memory);
  const order = orderRef(input, mem);
  const customer = auth.kind === 'customer';
  const q = input.message.slice(0, 300);
  if (intent === 'human') return [{ tool: 'request_human', args: { reason: q } }];
  if (accountIntents.includes(intent) && !customer) {
    // guests: only the documented order-number + email contract, read-only status
    if (intent === 'track_order' && order && auth.email) return [{ tool: 'guest_order_lookup', args: { orderNumber: order } }];
    return [];
  }
  switch (intent) {
    case 'greeting': return [];
    case 'track_order': return order ? [{ tool: 'get_order', args: { orderNumber: order } }] : [{ tool: 'my_orders', args: { limit: 5 } }];
    case 'refund_status': return order ? [{ tool: 'refund_progress', args: { orderNumber: order } }] : [{ tool: 'my_orders', args: { limit: 5 } }];
    case 'return_eligibility': return order ? [{ tool: 'return_eligibility', args: { orderNumber: order, reason: extractReason(q) } }] : [{ tool: 'my_orders', args: { limit: 5 } }];
    case 'start_return':
    case 'replacement': return order ? [{ tool: 'return_eligibility', args: { orderNumber: order, reason: extractReason(q) } }] : [{ tool: 'my_orders', args: { limit: 5 } }];
    case 'previous_purchases': {
      const t = /\b(?:bought|ordered|purchased)\s+(?:a |an |the |some )?([a-z][a-z0-9 -]{2,40}?)(?:\s+(?:last|a|in|before|earlier|from|recently)\b|[.?!]|$)/i.exec(q)?.[1]?.trim();
      return [{ tool: 'my_orders', args: { limit: 5, ...(t && t.length >= 2 ? { titleContains: t } : {}) } }];
    }
    case 'price_alert': return mem.lastProducts?.length ? [] : [{ tool: 'find_products', args: { query: q, limit: 1 } }];
    case 'save_preference': return [];
    case 'compare': {
      if ((mem.lastProducts?.length ?? 0) >= 2 && !/\b(vs\.?|versus)\b/i.test(q)) return [{ tool: 'compare_products', args: { ids: mem.lastProducts!.slice(0, 3).map((p) => p.id) } }];
      const parts = q.split(/\s+(?:vs\.?|versus|or|and)\s+/i).map((p) => p.replace(/\b(compare|difference between|which is better)\b/gi, '').trim()).filter((p) => p.length >= 2).slice(0, 3);
      return parts.length >= 2 ? parts.map((p) => ({ tool: 'find_products', args: { query: p, limit: 1 } })) : [{ tool: 'find_products', args: { query: q, limit: 3 } }];
    }
    case 'product_facts':
    case 'delivery_info': return mem.lastProducts?.length ? [] : [{ tool: 'find_products', args: { query: q, limit: 1 } }];
    case 'problem': return order ? [] : [{ tool: 'my_orders', args: { limit: 5 } }];
    case 'search':
    case 'unknown':
    default: return [{ tool: 'find_products', args: { query: q, limit: 5 } }];
  }
}

export function followUpAssistant(input: AssistantInput, results: ToolResults, auth: AuthContext, memory: Record<string, unknown>): PlannedCall[] {
  const intent = detectIntent(input.message);
  const mem = memOf(memory);
  const q = input.message;
  const find = allOk<FindOut>(results, 'find_products');
  const firstProd = find[0]?.items[0] ?? mem.lastProducts?.[0];
  const slugOf = (p: { slug: string } | undefined) => p?.slug;
  if (auth.kind !== 'customer' && ['price_alert'].includes(intent)) return [];
  switch (intent) {
    case 'compare': {
      if (results.has('compare_products')) return [];
      const ids = find.map((f) => f.items[0]?.id).filter((x): x is string => !!x);
      return ids.length >= 2 ? [{ tool: 'compare_products', args: { ids: [...new Set(ids)].slice(0, 3) } }] : [];
    }
    case 'product_facts': return slugOf(firstProd) ? [{ tool: 'product_facts', args: { slug: slugOf(firstProd) } }] : [];
    case 'delivery_info': return slugOf(firstProd) ? [{ tool: 'purchase_confidence', args: { slug: slugOf(firstProd), quantity: 1 } }] : [];
    case 'price_alert': {
      const id = firstProd && 'id' in firstProd ? firstProd.id : undefined;
      const target = /(?:under|below|at|to|reaches?|hits?)\s*[$₹]?\s*(\d{1,6}(?:\.\d{1,2})?)/i.exec(q)?.[1];
      return id ? [{ tool: 'create_price_alert', args: { productId: id, ...(target ? { targetPrice: Number(target) } : {}), dropPercent: 5 } }] : [];
    }
    case 'save_preference': {
      const text = q.replace(/^.*?\b(remember( that| this| my)?|save( this| my| that)?|note that|keep in mind)\b[:,]?\s*/i, '').trim().slice(0, 120);
      return text.length >= 2 ? [{ tool: 'save_preference', args: { kind: 'note', title: text } }] : [];
    }
    case 'start_return':
    case 'replacement': {
      const elig = lastOk<EligOut>(results, 'return_eligibility');
      if (!elig?.found || !elig.lines) return [];
      const reason = extractReason(q);
      if (!reason) return [];
      const lines = elig.lines.filter((l) => l.eligible && l.maxQuantity > 0);
      const byTitle = lines.filter((l) => q.toLowerCase().includes(l.title.toLowerCase().slice(0, 18)));
      const pick = lines.length === 1 ? lines[0] : byTitle.length === 1 ? byTitle[0] : undefined;
      if (!pick || !elig.orderNumber) return [];
      if (intent === 'replacement') {
        if (!['damaged', 'defective', 'wrong_item', 'missing_parts', 'not_as_described'].includes(reason) || !pick.resolutions.includes('replacement')) return [];
        return [{ tool: 'request_replacement', args: { orderNumber: elig.orderNumber, sku: pick.sku, quantity: 1, reason, details: '' } }];
      }
      const condition = DEFECT_CONDITION[reason] ?? extractCondition(q) ?? (['wrong_item', 'missing_parts', 'not_as_described', 'not_delivered'].includes(reason) ? 'unopened' : undefined);
      if (!condition || pick.maxQuantity > 1) return [];
      return [{ tool: 'start_return', args: { orderNumber: elig.orderNumber, sku: pick.sku, quantity: 1, reason, condition, resolution: 'refund', details: '' } }];
    }
    default: return [];
  }
}

/* -------------------------------------- rendering -------------------------------------- */
const SYMBOL: Record<string, string> = { USD: '$', CAD: 'CA$', INR: '₹' };
export const fmtMoney = (minor: number, currency: string): string => `${SYMBOL[currency] ?? ''}${(minor / 100).toFixed(2)}${SYMBOL[currency] ? '' : ` ${currency}`}`;
const human = (s: string) => s.replace(/_/g, ' ').toLowerCase();
const SIGN_IN = 'To look at or change anything on an account, please sign in with a verified email address. I can still help you find and compare products.';

export interface Rendered { reply: string; suggestions: string[]; needsHuman: boolean; confidence: number }

export function renderAssistant(input: AssistantInput, results: ToolResults, auth: AuthContext, memory: Record<string, unknown>): Rendered {
  const intent = detectIntent(input.message);
  const mem = memOf(memory);
  const customer = auth.kind === 'customer';
  const order = orderRef(input, mem);
  const out = (reply: string, suggestions: string[] = [], needsHuman = false, confidence = 0.85): Rendered => ({ reply, suggestions, needsHuman, confidence });
  const refused = [...results.entries()].find(([, v]) => v.some((x) => !x.ok && x.reason !== 'awaiting_confirmation'));
  const human_ = 'I can connect you with a team member if you would like.';

  if (intent === 'greeting') return out('Hi! I can help you find and compare products, track an order, check a refund, start a return or ask a team member to help. What do you need?', ['Find a gift under $50', 'Track my order', 'Where is my refund?']);
  if (intent === 'human') return awaiting(results, 'request_human') || lastOk<{ queued: boolean }>(results, 'request_human')?.queued
    ? out('I have passed this to our team. A team member will follow up; please keep your order number handy.', [], true, 0.9)
    : out(`I could not reach the team queue just now. ${human_}`, [], true, 0.5);
  if (accountIntents.includes(intent) && !customer) {
    if (intent === 'track_order') {
      const g = lastOk<OrderOut>(results, 'guest_order_lookup');
      if (g?.found) return out(orderSentence(g), ['Start a return', 'Ask for a person']);
      if (results.has('guest_order_lookup')) return out('I could not find an order with that number and email. Please check both and try again.', [], false, 0.8);
      return out(`${order ? '' : 'Please send your order number (it looks like ORV-XXXX-XXXXXX) and '}${auth.email ? '' : 'the email address used at checkout, '}so I can look it up. ${SIGN_IN}`.replace(/\s+/g, ' ').trim(), [], false, 0.8);
    }
    return out(SIGN_IN, [], false, 0.9);
  }

  const pendingTools = ['start_return', 'request_replacement', 'create_price_alert', 'save_preference'].filter((t) => awaiting(results, t));
  if (pendingTools.length) return out('I have prepared this for you. Nothing happens until you press Confirm below; you can also cancel.', [], false, 0.9);
  for (const t of ['start_return', 'request_replacement', 'create_price_alert', 'save_preference']) {
    const r = lastOk<{ message?: string }>(results, t);
    if (r?.message) return out(r.message);
  }

  switch (intent) {
    case 'track_order': {
      const o = lastOk<OrderOut>(results, 'get_order');
      if (o?.found) return out(orderSentence(o), ['Where is my refund?', 'Can I return this?']);
      if (results.has('get_order')) return out('I could not find that order on your account. Please check the order number.', [], false, 0.8);
      return listOrders(results, 'Which order would you like to track?');
    }
    case 'refund_status': {
      const r = lastOk<RefundOut>(results, 'refund_progress');
      if (r?.found) return out(`${r.headline ?? 'Here is the progress.'}${r.steps?.length ? ` Steps: ${r.steps.map((s) => `${s.label} (${human(s.status)})`).join(', ')}.` : ''}`);
      if (results.has('refund_progress')) return out('I could not find that order on your account.', [], false, 0.8);
      return listOrders(results, 'Which order is the refund for?');
    }
    case 'return_eligibility':
    case 'start_return':
    case 'replacement': {
      const e = lastOk<EligOut>(results, 'return_eligibility');
      if (e?.found && e.lines) {
        const ok = e.lines.filter((l) => l.eligible);
        const base = ok.length
          ? `Eligible for return on ${e.orderNumber}: ${ok.map((l) => l.title).join(', ')}.${typeof e.daysLeft === 'number' ? ` ${e.daysLeft} day(s) left in the ${e.windowDays}-day window.` : ''}`
          : `Nothing on ${e.orderNumber} can be returned right now. ${e.lines.flatMap((l) => l.reasons).slice(0, 2).join(' ') || e.orderReasons?.join(' ') || ''}`.trim();
        if (intent === 'return_eligibility') return out(base, ok.length ? ['Start a return'] : ['Ask for a person']);
        if (!ok.length) return out(base, ['Ask for a person']);
        const reason = extractReason(input.message);
        if (!reason) return out(`${base} What went wrong with the item (damaged, defective, wrong item, size, changed my mind...)?`, ['It arrived damaged', 'Wrong item', 'Changed my mind']);
        if (ok.length > 1) return out(`${base} Which item do you want to ${intent === 'replacement' ? 'replace' : 'return'}?`);
        if (intent === 'start_return' && !DEFECT_CONDITION[reason] && !extractCondition(input.message) && !['wrong_item', 'missing_parts', 'not_as_described', 'not_delivered'].includes(reason)) return out(`${base} Is the item unopened, opened but unused, or used?`, ['It is unopened', 'Opened but unused']);
        if (intent === 'replacement') return out(`A replacement is not available for this item under the current rules. ${human_}`, ['Ask for a person'], true, 0.6);
        return out(base);
      }
      if (results.has('return_eligibility')) return out('I could not find that order on your account.', [], false, 0.8);
      return listOrders(results, `Which order is this about?`);
    }
    case 'previous_purchases': {
      const o = lastOk<OrdersOut>(results, 'my_orders');
      if (o && o.items.length) return out(`Here are your most recent matching orders: ${o.items.map((x) => `${x.orderNumber} (${human(x.status)}${x.firstItem ? `, ${x.firstItem}` : ''})`).join('; ')}.`, ['Track the latest order']);
      return out('I could not find matching previous orders on your account.', [], false, 0.8);
    }
    case 'price_alert': {
      if (!mem.lastProducts?.length && !results.has('find_products')) return out('Which product should I watch? Tell me what it is or search for it first.');
      return out('I could not find a product to track. Tell me which product you mean.');
    }
    case 'problem': return listOrders(results, 'I am sorry about that. Which order is this about?');
    case 'save_preference': return out('What should I remember? For example: "remember that I prefer unscented products".');
    case 'compare': {
      const c = lastOk<CompareOut>(results, 'compare_products');
      if (c) return out(`${c.products.map((p) => `${p.title} (${fmtMoney(p.price, c.currency)}, ${p.available ? 'in stock' : 'out of stock'})`).join(' vs ')}. ${c.keyDifferences.length ? `Key differences: ${c.keyDifferences.slice(0, 4).join('; ')}.` : 'No notable differences were found in the data we hold.'}`, ['Track the price of one of them']);
      return out('Tell me which products to compare, or search for them first and I will compare the top results.');
    }
    case 'product_facts': {
      const f = lastOk<FactsOut>(results, 'product_facts');
      if (f?.found) {
        const lines = f.facts.slice(0, 8).map((x) => `${x.label}: ${x.value} (${x.provenance.replace('_', '-')})`);
        const docs = f.documents.filter((d) => !d.expired).map((d) => d.title);
        const parts = [`${f.title}: ${lines.length ? lines.join('; ') : 'no verified specifications are on file.'}`];
        if (f.warranty) parts.push(`Warranty information: ${f.warranty}.`);
        if (docs.length) parts.push(`Documents on file: ${docs.join(', ')}.`);
        if (f.missing.length) parts.push(`We do not have verified information about: ${f.missing.join(', ')}. I will not guess; ${human_}`);
        return out(parts.join(' '), f.missing.length ? ['Ask for a person'] : [], false, f.missing.length ? 0.7 : 0.85);
      }
      return out(`I could not find that product. Search for it and I will show what we have on file.`, [], false, 0.6);
    }
    case 'delivery_info': {
      const c = lastOk<ConfOut>(results, 'purchase_confidence');
      if (c?.found) return out(`${c.title}: ${c.deliveryStatement ?? 'no delivery estimate is available yet.'}${c.returnWindowDays ? ` Returns window: ${c.returnWindowDays} days.` : ''}${c.uncertainty.length ? ` Please note: ${c.uncertainty.slice(0, 2).join(' ')}` : ''}`);
      return out('Which product do you want a delivery estimate for? Search for it and I will check.');
    }
    default: {
      const f = lastOk<FindOut>(results, 'find_products');
      if (f && f.items.length) {
        const top = f.items.slice(0, 3);
        const line = (p: FindOut['items'][number]) => `${p.title} for ${fmtMoney(p.price, p.currency)}${p.minDays !== null && p.maxDays !== null ? `, usually ${p.minDays}-${p.maxDays} days delivery` : ''}${p.inStock ? ', in stock' : ', currently out of stock'}`;
        return out(`I found ${f.total} matching product${f.total === 1 ? '' : 's'}. Top picks: ${top.map(line).join('; ')}.`, top.length > 1 ? ['Compare these', 'Show cheaper options'] : []);
      }
      if (refused) return out(`I could not complete that. ${human_}`, ['Ask for a person'], true, 0.4);
      return out(`I could not find a matching product. Try describing what it is for or your budget. ${human_}`, ['Ask for a person'], false, 0.6);
    }
  }

  function orderSentence(o: OrderOut): string {
    const ships = o.shipments ?? [];
    const s = ships.length
      ? ships.map((x) => `${human(x.status)}${x.carrier ? ` with ${x.carrier}` : ''}${x.trackingNumber ? ` (tracking ${x.trackingNumber})` : ''}${x.estimatedDelivery ? `, estimated delivery ${x.estimatedDelivery}` : ''}`).join('; ')
      : 'no shipment has been created yet, so there is no tracking number';
    return `Order ${o.orderNumber} is ${human(o.status ?? 'unknown')}. ${o.delivered && o.deliveredAt ? `Delivered on ${o.deliveredAt.slice(0, 10)}. ` : ''}Shipping: ${s}.`;
  }
  function listOrders(r: ToolResults, ask: string): Rendered {
    const o = lastOk<OrdersOut>(r, 'my_orders');
    if (o && o.items.length) return out(`${ask} Your recent orders: ${o.items.map((x) => `${x.orderNumber} (${human(x.status)}${x.firstItem ? `, ${x.firstItem}` : ''})`).join('; ')}.`);
    return out(`${ask} I could not find any orders on your account. Please send the order number.`);
  }
}

/* ---------------------------------------- cards ---------------------------------------- */
/** UI cards come only from tool results (never from model text). */
export function buildAssistantCards(results: ToolResults): AssistantCard[] {
  const cards: AssistantCard[] = [];
  const f = lastOk<FindOut>(results, 'find_products');
  const compared = lastOk<CompareOut>(results, 'compare_products');
  if (f && f.items.length && !compared) cards.push({ type: 'products', items: f.items.map((p) => ({ id: p.id, slug: p.slug, title: p.title, image: p.image, price: p.price, currency: p.currency, rating: p.rating, inStock: p.inStock, delivery: p.minDays !== null && p.maxDays !== null ? `${p.minDays}-${p.maxDays} days` : null, why: p.why.slice(0, 2) })) });
  if (compared) cards.push({ type: 'comparison', products: compared.products.map((p) => p.title), differences: compared.keyDifferences.slice(0, 6), rows: compared.rows.slice(0, 10).map((r) => ({ label: r.label, values: r.values })) });
  for (const t of ['get_order', 'guest_order_lookup']) {
    const o = lastOk<OrderOut>(results, t);
    if (o?.found && o.orderNumber) cards.push({ type: 'order', orderNumber: o.orderNumber, status: o.status ?? '', total: o.total ?? null, currency: o.currency ?? '', items: (o.items ?? []).map((i) => ({ title: i.title, quantity: i.quantity })), shipments: o.shipments ?? [] });
  }
  const mine = lastOk<OrdersOut>(results, 'my_orders');
  if (mine && mine.items.length) cards.push({ type: 'orders', items: mine.items.map((o) => ({ orderNumber: o.orderNumber, status: o.status, createdAt: o.createdAt ?? '', firstItem: o.firstItem, itemCount: o.itemCount })) });
  const e = lastOk<EligOut>(results, 'return_eligibility');
  if (e?.found && e.lines && e.orderNumber) cards.push({ type: 'eligibility', orderNumber: e.orderNumber, eligible: !!e.eligible, lines: e.lines.map((l) => ({ sku: l.sku, title: l.title, eligible: l.eligible, reasons: l.reasons })), windowDays: e.windowDays ?? null });
  const r = lastOk<RefundOut>(results, 'refund_progress');
  if (r?.found && r.orderNumber) cards.push({ type: 'refund', orderNumber: r.orderNumber, headline: r.headline ?? '', steps: r.steps ?? [] });
  const facts = lastOk<FactsOut>(results, 'product_facts');
  if (facts?.found) cards.push({ type: 'facts', product: facts.title ?? '', facts: facts.facts.slice(0, 12), missing: facts.missing });
  return cards;
}

/** Context to remember between turns, derived only from tool results. */
export function memoryFromResults(results: ToolResults, prev: AssistantMemory): AssistantMemory {
  const next: AssistantMemory = { ...prev };
  for (const t of ['get_order', 'guest_order_lookup']) { const o = lastOk<OrderOut>(results, t); if (o?.found && o.orderNumber) next.lastOrderNumber = o.orderNumber; }
  const e = lastOk<EligOut>(results, 'return_eligibility'); if (e?.found && e.orderNumber) next.lastOrderNumber = e.orderNumber;
  const rf = lastOk<RefundOut>(results, 'refund_progress'); if (rf?.found && rf.orderNumber) next.lastOrderNumber = rf.orderNumber;
  const prods = allOk<FindOut>(results, 'find_products').flatMap((f) => f.items.slice(0, 1).concat(allOk<FindOut>(results, 'find_products').length === 1 ? f.items.slice(1, 4) : []));
  if (prods.length) next.lastProducts = prods.map((p) => ({ id: p.id, slug: p.slug })).slice(0, 4);
  return next;
}
