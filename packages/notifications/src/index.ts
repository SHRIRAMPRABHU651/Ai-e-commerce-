import { ProviderError, fetchJson } from '@orvia/config';

export type Channel = 'email' | 'sms' | 'push' | 'whatsapp';

export interface OutboundMessage {
  channel: Channel;
  to: string;
  subject?: string;
  body: string;
  html?: string;
}

export type SendOutcome =
  | { status: 'sent'; providerMessageId?: string; provider: string }
  /** Dev-only: message written to the log/outbox, NOT delivered. Never reported as "sent". */
  | { status: 'logged_dev'; provider: string };

export interface NotificationProvider {
  readonly key: string;
  readonly channels: Channel[];
  send(msg: OutboundMessage): Promise<SendOutcome>;
}

/** Development provider: records the message, delivers nothing, and says so. */
export class LogNotificationProvider implements NotificationProvider {
  readonly key = 'log';
  readonly channels: Channel[] = ['email', 'sms', 'push', 'whatsapp'];
  async send(_msg: OutboundMessage): Promise<SendOutcome> {
    return { status: 'logged_dev', provider: 'log' };
  }
}

/** Email via the Resend REST API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendEmailProvider implements NotificationProvider {
  readonly key = 'resend';
  readonly channels: Channel[] = ['email'];
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}
  async send(msg: OutboundMessage): Promise<SendOutcome> {
    if (msg.channel !== 'email') throw new ProviderError('Resend only supports email', { provider: 'resend', retryable: false });
    const r = await fetchJson<{ id: string }>('https://api.resend.com/emails', {
      provider: 'resend',
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: { from: this.from, to: [msg.to], subject: msg.subject ?? '(no subject)', text: msg.body, html: msg.html },
      fetchImpl: this.fetchImpl,
      idempotent: false,
    });
    return { status: 'sent', providerMessageId: r.id, provider: 'resend' };
  }
}

/** SMS and WhatsApp via Twilio's REST API. WhatsApp requires an approved sender + opt-in. */
export class TwilioProvider implements NotificationProvider {
  readonly key = 'twilio';
  readonly channels: Channel[] = ['sms', 'whatsapp'];
  constructor(
    private readonly sid: string,
    private readonly token: string,
    private readonly from: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}
  async send(msg: OutboundMessage): Promise<SendOutcome> {
    if (msg.channel !== 'sms' && msg.channel !== 'whatsapp') throw new ProviderError('Twilio supports sms/whatsapp', { provider: 'twilio', retryable: false });
    const wa = msg.channel === 'whatsapp';
    const r = await fetchJson<{ sid: string }>(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`, {
      provider: 'twilio',
      method: 'POST',
      form: true,
      headers: { authorization: 'Basic ' + Buffer.from(`${this.sid}:${this.token}`).toString('base64') },
      body: { To: wa ? `whatsapp:${msg.to}` : msg.to, From: wa ? `whatsapp:${this.from}` : this.from, Body: msg.body },
      fetchImpl: this.fetchImpl,
      idempotent: false,
    });
    return { status: 'sent', providerMessageId: r.sid, provider: 'twilio' };
  }
}

export interface NotifyConfig {
  mode: 'log' | 'live';
  isProduction: boolean;
  emailKey?: string;
  emailFrom: string;
  twilio?: { sid?: string; token?: string; from?: string };
  fetchImpl?: typeof fetch;
}

/** Picks a provider per channel. In live mode a channel with no credentials is *unavailable* (never faked). */
export class NotificationRouter {
  private log = new LogNotificationProvider();
  constructor(private readonly cfg: NotifyConfig) {}

  providerFor(channel: Channel): NotificationProvider | null {
    if (this.cfg.mode === 'log') {
      if (this.cfg.isProduction) return null;
      return this.log;
    }
    if (channel === 'email' && this.cfg.emailKey) return new ResendEmailProvider(this.cfg.emailKey, this.cfg.emailFrom, this.cfg.fetchImpl);
    const t = this.cfg.twilio;
    if ((channel === 'sms' || channel === 'whatsapp') && t?.sid && t.token && t.from) return new TwilioProvider(t.sid, t.token, t.from, this.cfg.fetchImpl);
    return null;
  }
}

/* ------------------------------- templates ------------------------------- */
export type TemplateName =
  | 'verify_email'
  | 'reset_password'
  | 'order_confirmation'
  | 'payment_confirmation'
  | 'shipped'
  | 'out_for_delivery'
  | 'delivered'
  | 'refund'
  | 'cancellation'
  | 'promotion'
  | 'abandoned_cart_1'
  | 'abandoned_cart_2'
  | 'abandoned_cart_3'
  | 'review_request';

export interface TemplateData {
  name?: string;
  orderNumber?: string;
  url?: string;
  trackingNumber?: string;
  carrier?: string;
  total?: string;
  items?: string;
  code?: string;
  discount?: string;
  eta?: string;
  amount?: string;
  productTitle?: string;
  benefits?: string;
}

const hi = (d: TemplateData) => `Hi ${d.name?.split(' ')[0] || 'there'},`;
const shell = (title: string, lines: string[], cta?: { label: string; url: string }): { html: string } => ({
  html: `<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:auto;color:#1a1a17"><h2 style="font-weight:600">${title}</h2>${lines
    .map((l) => `<p style="line-height:1.55">${l}</p>`)
    .join('')}${cta ? `<p><a href="${cta.url}" style="display:inline-block;background:#1f3d36;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none">${cta.label}</a></p>` : ''}<p style="color:#77746b;font-size:12px">Orvia · You are receiving this because of activity on your Orvia account or order.</p></div>`,
});

export function renderTemplate(name: TemplateName, d: TemplateData): { subject: string; body: string; html: string } {
  const mk = (subject: string, lines: string[], cta?: { label: string; url: string }) => ({
    subject,
    body: [...lines, cta ? `${cta.label}: ${cta.url}` : ''].filter(Boolean).join('\n\n'),
    ...shell(subject, lines, cta),
  });
  switch (name) {
    case 'verify_email':
      return mk('Verify your email', [hi(d), 'Confirm your email address to finish setting up your Orvia account.'], { label: 'Verify email', url: d.url ?? '' });
    case 'reset_password':
      return mk('Reset your password', [hi(d), 'We received a request to reset your password. This link expires in 1 hour. If this wasn’t you, ignore this email.'], { label: 'Reset password', url: d.url ?? '' });
    case 'order_confirmation':
      return mk(`Order ${d.orderNumber} confirmed`, [hi(d), `Thanks for your order. We’ve received ${d.items ?? 'your items'} (total ${d.total}).`, `We’ll email you tracking as soon as the supplier ships it.`], { label: 'View order', url: d.url ?? '' });
    case 'payment_confirmation':
      return mk(`Payment received for ${d.orderNumber}`, [hi(d), `We’ve received your payment of ${d.total}.`], { label: 'View order', url: d.url ?? '' });
    case 'shipped':
      return mk(`Your order ${d.orderNumber} has shipped`, [hi(d), `Your order is on its way${d.carrier ? ` with ${d.carrier}` : ''}.`, d.trackingNumber ? `Tracking number: ${d.trackingNumber}` : 'Tracking details will appear shortly.', d.eta ? `Estimated delivery: ${d.eta}` : ''].filter(Boolean), { label: 'Track order', url: d.url ?? '' });
    case 'out_for_delivery':
      return mk(`Order ${d.orderNumber} is out for delivery`, [hi(d), 'Your parcel is out for delivery today.'], { label: 'Track order', url: d.url ?? '' });
    case 'delivered':
      return mk(`Order ${d.orderNumber} delivered`, [hi(d), 'Your order has been delivered. We hope you love it.'], { label: 'Leave a review', url: d.url ?? '' });
    case 'refund':
      return mk(`Refund processed for ${d.orderNumber}`, [hi(d), `We’ve issued a refund of ${d.amount}. It can take 5–10 business days to appear, depending on your bank.`], { label: 'View order', url: d.url ?? '' });
    case 'cancellation':
      return mk(`Order ${d.orderNumber} cancelled`, [hi(d), 'Your order has been cancelled. If you were charged, a refund is on its way.']);
    case 'promotion':
      return mk(d.productTitle ? `${d.productTitle} — a note for you` : 'A little something from Orvia', [hi(d), d.discount ? `Use code ${d.code} for ${d.discount}.` : 'We picked a few things you may like.'], { label: 'Shop now', url: d.url ?? '' });
    case 'abandoned_cart_1':
      return mk('You left something behind', [hi(d), `${d.items ?? 'Your items'} are still in your cart.`], { label: 'Return to cart', url: d.url ?? '' });
    case 'abandoned_cart_2':
      return mk(`Why customers pick ${d.productTitle ?? 'this'}`, [hi(d), d.benefits ?? 'Easy returns and tracked delivery on every order.'], { label: 'Return to cart', url: d.url ?? '' });
    case 'abandoned_cart_3':
      return mk(`Here’s ${d.discount ?? 'a little discount'} on your cart`, [hi(d), `Use code ${d.code} at checkout. It expires soon.`], { label: 'Use my discount', url: d.url ?? '' });
    case 'review_request':
      return mk(`How was your ${d.productTitle ?? 'order'}?`, [hi(d), 'Your feedback helps other shoppers.'], { label: 'Write a review', url: d.url ?? '' });
  }
}
