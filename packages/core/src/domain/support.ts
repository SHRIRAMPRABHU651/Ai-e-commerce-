import { Order, Product, Shipment, SupportTicket } from '@orvia/database';
import { TRACKING_LABELS } from '@orvia/shipping';
import type { CountryCode } from '@orvia/types';
import { getCountry } from '../infra/countries';
import type { Ctx } from '../infra/context';
import { searchProducts } from './search';
import { cancelOrder } from './orders';
import { SYSTEM } from '../infra/context';
import { raiseException } from './exceptions';

export type SupportIntent = 'tracking' | 'return' | 'refund_status' | 'cancel' | 'shipping' | 'product' | 'human' | 'general';

const INTENTS: [SupportIntent, RegExp][] = [
  ['human', /\b(human|agent|person|representative|speak to|talk to)\b/i],
  ['cancel', /\b(cancel|cancellation|stop (my )?order)\b/i],
  ['refund_status', /\b(refund status|where is my refund|refund (is )?(pending|late)|money back)\b/i],
  ['return', /\b(return|exchange|send (it )?back|wrong item|damaged|broken|not as described)\b/i],
  ['tracking', /\b(track|tracking|where is my (order|package|parcel)|order status|shipped|delivery status|hasn'?t arrived|not arrived)\b/i],
  ['shipping', /\b(shipping|delivery time|how long|ship to|customs|duties|import)\b/i],
  ['product', /\b(does it|is it|what (is|are)|size|material|compatible|dimension|warranty|come with|safe for)\b/i],
];

export interface SupportReply {
  reply: string;
  intent: SupportIntent;
  escalated: boolean;
  ticketId?: string;
  actions: { label: string; href?: string; action?: string }[];
  grounded: string[]; // data sources used
}

interface Ask {
  message: string;
  country: CountryCode;
  email?: string;
  userId?: string;
  orderNumber?: string;
  ticketId?: string;
  confirmCancel?: boolean;
}

async function findOrder(a: Ask) {
  const num = a.orderNumber ?? /ORV-[A-Z0-9]+-[A-F0-9]{6}/i.exec(a.message)?.[0]?.toUpperCase();
  if (!num) return null;
  const o = await Order.findOne({ orderNumber: num });
  if (!o) return null;
  // customers only ever see their own orders
  const mine = (a.userId && String(o.userId) === a.userId) || (a.email && o.email.toLowerCase() === a.email.toLowerCase());
  return mine ? o : 'forbidden';
}

export async function handleSupport(ctx: Ctx, a: Ask): Promise<SupportReply> {
  let intent: SupportIntent = INTENTS.find(([, re]) => re.test(a.message))?.[0] ?? 'general';
  if (intent === 'general' && ctx.ai.llmConfigured) {
    const c = await ctx.ai.classify(a.message, ['tracking', 'return', 'refund_status', 'cancel', 'shipping', 'product', 'human', 'general']);
    if (c.confidence >= 0.6) intent = c.label as SupportIntent;
  }
  const grounded: string[] = [];
  const actions: SupportReply['actions'] = [];
  let reply = '';
  let escalate = intent === 'human';
  const cfg = await getCountry(a.country);
  const found = ['tracking', 'return', 'refund_status', 'cancel'].includes(intent) ? await findOrder(a) : null;

  if (['tracking', 'return', 'refund_status', 'cancel'].includes(intent)) {
    if (!found) reply = 'I can help with that. Please send your order number (it looks like ORV-XXXX-XXXXXX) and sign in, or use the email address on the order.';
    else if (found === 'forbidden') reply = 'I can’t find an order with that number on your account. Please check the number and the email you used at checkout.';
  }

  if (found && found !== 'forbidden') {
    const o = found;
    grounded.push('orders');
    const ships = await Shipment.find({ orderId: o._id }).lean();
    if (ships.length) grounded.push('shipments');
    const link = { label: 'View order', href: `/orders/${o.orderNumber}` };
    if (intent === 'tracking') {
      if (['PENDING_PAYMENT'].includes(o.status)) reply = `Order ${o.orderNumber} is waiting for payment, so it hasn’t been sent to our supplier yet.`;
      else if (!ships.length) reply = `Order ${o.orderNumber} is paid (status: ${o.status.replace(/_/g, ' ').toLowerCase()}). It hasn’t been placed with the supplier yet, so there’s no tracking number to share. You’ll get an email the moment it ships.`;
      else {
        reply = ships
          .map((s) => {
            const label = TRACKING_LABELS[s.status] ?? s.status;
            const last = s.events?.[s.events.length - 1];
            return s.trackingNumber ? `Status: ${label}. ${s.carrier ?? 'Carrier'} tracking number ${s.trackingNumber}.${last ? ` Latest update: ${last.description}${last.location ? ` (${last.location})` : ''}.` : ''}${s.estimatedDelivery ? ` Estimated delivery by ${s.estimatedDelivery.toDateString()}.` : ''}` : `Status: ${label}. The supplier hasn’t issued a tracking number yet — I won’t guess one. We’ll email you as soon as it appears.`;
          })
          .join('\n');
      }
      actions.push(link);
    } else if (intent === 'return') {
      const days = cfg.returnWindowDays;
      reply = o.deliveredAt ? `You can request a return within ${days} days of delivery. Order ${o.orderNumber} was delivered on ${o.deliveredAt.toDateString()}.` : `Returns open once your order is delivered (${days}-day window). If your parcel never arrives or arrived damaged, tell me and I’ll open a case.`;
      actions.push({ label: 'Start a return', href: `/account/returns?order=${o.orderNumber}` });
      if (/damaged|broken|wrong item|not as described/i.test(a.message)) escalate = true;
    } else if (intent === 'refund_status') {
      const refunded = o.costs?.refunded ?? 0;
      reply = refunded > 0 ? `A refund of ${(refunded / 100).toFixed(2)} ${o.currency} was issued for ${o.orderNumber}. It can take 5–10 business days to appear on your statement.` : `There is no refund recorded for ${o.orderNumber} yet.${o.status === 'REFUND_REQUESTED' ? ' Your return request is being reviewed.' : ''}`;
      actions.push(link);
    } else if (intent === 'cancel') {
      const shipped = ships.some((s) => ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(s.status));
      if (['CANCELLED', 'REFUNDED'].includes(o.status)) reply = `Order ${o.orderNumber} is already ${o.status.toLowerCase()}.`;
      else if (shipped) reply = `Order ${o.orderNumber} has already shipped, so it can’t be cancelled. Once it arrives you can return it within ${cfg.returnWindowDays} days.`;
      else if (a.confirmCancel && (await ctx.settings.automationMode('customer_support')) === 'AUTOMATIC') {
        try {
          await cancelOrder(ctx, String(o._id), SYSTEM, 'customer requested via support assistant');
          reply = `Done — order ${o.orderNumber} is cancelled and any payment will be refunded.`;
        } catch (e) {
          reply = `I couldn’t cancel it automatically (${(e as Error).message}). I’ve passed it to our team.`;
          escalate = true;
        }
      } else {
        reply = `Order ${o.orderNumber} hasn’t shipped, so it can be cancelled. Please confirm and I’ll cancel it and refund you.`;
        actions.push({ label: 'Yes, cancel my order', action: 'confirm_cancel' });
      }
    }
  } else if (intent === 'shipping') {
    grounded.push('country_config');
    reply = `In ${cfg.name}: ${cfg.shippingMethods.map((m) => `${m.label} ${m.minDays}–${m.maxDays} days after processing (${m.fee === 0 ? 'free' : (m.fee / 100).toFixed(2) + ' ' + cfg.currency}${m.freeOver ? `, free over ${(m.freeOver / 100).toFixed(0)}` : ''})`).join('; ')}. The exact estimate for each product depends on the fulfilling warehouse and is shown on the product page. ${cfg.legalNotice}`;
  } else if (intent === 'product') {
    const r = await searchProducts({ q: a.message.replace(/\b(does it|is it|what is|what are|the|a|an|come with|safe for)\b/gi, ' '), page: 1, pageSize: 1, sort: 'relevance' }, a.country);
    const p = r.items[0];
    if (!p) {
      reply = 'I couldn’t find that product. Which item are you asking about?';
    } else {
      grounded.push('products');
      const full = await Product.findById(p.id).select('bullets attributes description').lean();
      const attrs = Object.entries((full?.attributes as unknown as Record<string, string>) ?? {}).filter(([k]) => k !== 'Top category').map(([k, v]) => `${k}: ${v}`);
      reply = `${p.title}: ${(full?.bullets ?? []).slice(0, 3).join(' ')} ${attrs.length ? `Details — ${attrs.join('; ')}.` : ''} I only have the details above; if you need a specific measurement or compatibility detail that isn’t listed, I’ll ask our team rather than guess.`;
      actions.push({ label: 'View product', href: `/p/${p.slug}` });
      if (/\b(size|dimension|compatible|warranty|weight|battery)\b/i.test(a.message) && !attrs.some((x) => /size|dimension|weight|battery|compat|warranty/i.test(x))) escalate = true;
    }
  } else if (intent === 'general' && !reply) {
    reply = 'I can track an order, start a return, check a refund, answer shipping questions or tell you about a product. What do you need? You can also ask for a human at any time.';
  }

  if (escalate && !reply.includes('team')) reply += `${reply ? ' ' : ''}I’ve flagged this for our support team and they’ll follow up by email.`;
  let ticketId = a.ticketId;
  const needTicket = escalate || (ticketId ? true : false);
  if (needTicket || a.email) {
    const t = ticketId ? await SupportTicket.findById(ticketId) : await SupportTicket.create({ userId: a.userId, email: a.email, subject: a.message.slice(0, 80), status: escalate ? 'escalated' : 'open', priority: escalate ? 'high' : 'normal', orderId: found && found !== 'forbidden' ? found._id : undefined, messages: [] });
    if (t) {
      t.messages.push({ from: 'customer', text: a.message, at: ctx.now() } as never, { from: 'ai', text: reply, at: ctx.now(), meta: { intent, grounded } } as never);
      if (escalate) t.status = 'escalated';
      await t.save();
      ticketId = String(t._id);
      if (escalate) await raiseException(ctx, { kind: 'OTHER', priority: 'medium', issue: `Support escalation: ${a.message.slice(0, 120)}`, customerEmail: a.email, orderId: found && found !== 'forbidden' ? String(found._id) : undefined, aiRecommendation: 'Reply to the customer.', suggestedAction: 'Open support ticket', actionCode: 'dismiss', dedupeKey: `support:${t._id}` });
    }
  }
  return { reply, intent, escalated: escalate, ticketId, actions, grounded };
}
