/** DEV / TEST ONLY payment provider. Webhooks are HMAC-signed so the real verification path is exercised. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MemoryKVStore } from '@orvia/config';
import type { KVStore } from '@orvia/config';
import { WebhookSignatureError } from './types';
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  PaymentWebhookEvent,
  ProviderPayment,
  RefundInput,
} from './types';

const sign = (secret: string, t: string, body: string) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

export class MockPaymentProvider implements PaymentProvider {
  readonly key = 'mock';
  constructor(
    private readonly secret: string,
    private readonly store: KVStore = new MemoryKVStore(),
  ) {}

  async createPayment(i: CreatePaymentInput): Promise<CreatePaymentResult> {
    const intentId = `mock_pi_${createHmac('sha256', this.secret).update(i.idempotencyKey).digest('hex').slice(0, 20)}`;
    await this.store.setIfAbsent<ProviderPayment>('payment', intentId, {
      status: 'pending',
      amount: i.amount,
      currency: i.currency,
    });
    return { provider: 'mock', intentId, clientSecret: `${intentId}_secret`, clientConfig: { mode: 'mock' } };
  }

  /** Produces a signed webhook as the (mock) provider would send it. Used by the dev "pay" endpoint and tests. */
  async simulate(
    intentId: string,
    outcome: 'succeeded' | 'failed',
    opts: { eventId?: string; amountOverride?: number } = {},
  ): Promise<{ body: string; headers: Record<string, string> }> {
    const p = await this.store.get<ProviderPayment>('payment', intentId);
    if (!p) throw new Error('Unknown mock payment intent');
    const next: ProviderPayment = { ...p, status: outcome === 'succeeded' ? 'succeeded' : 'failed', providerPaymentId: `mock_pay_${intentId.slice(-10)}` };
    await this.store.set('payment', intentId, next);
    const body = JSON.stringify({
      id: opts.eventId ?? `evt_${intentId.slice(-10)}_${outcome}`,
      type: outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed',
      intentId,
      amount: opts.amountOverride ?? p.amount,
      currency: p.currency,
      failureReason: outcome === 'failed' ? 'card_declined' : undefined,
      providerPaymentId: next.providerPaymentId,
    });
    const t = String(Math.floor(Date.now() / 1000));
    return { body, headers: { 'x-mock-signature': `t=${t},v1=${sign(this.secret, t, body)}` } };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): PaymentWebhookEvent {
    const hdr = headers['x-mock-signature'];
    const raw = Array.isArray(hdr) ? hdr[0] : hdr;
    if (!raw) throw new WebhookSignatureError('Missing signature');
    const parts = Object.fromEntries(raw.split(',').map((kv) => kv.split('=') as [string, string]));
    const t = parts['t'];
    const v1 = parts['v1'];
    if (!t || !v1) throw new WebhookSignatureError();
    if (Math.abs(Date.now() / 1000 - Number(t)) > 600) throw new WebhookSignatureError('Timestamp outside tolerance');
    const expected = Buffer.from(sign(this.secret, t, rawBody), 'hex');
    const given = Buffer.from(v1, 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new WebhookSignatureError();
    const e = JSON.parse(rawBody) as PaymentWebhookEvent;
    return e;
  }

  async getPayment(intentId: string): Promise<ProviderPayment> {
    const p = await this.store.get<ProviderPayment>('payment', intentId);
    if (!p) throw new Error('Unknown mock payment intent');
    return p;
  }

  async refund(i: RefundInput): Promise<{ refundId: string; status: 'succeeded' }> {
    const { data } = await this.store.setIfAbsent('refund', i.idempotencyKey, {
      refundId: `mock_re_${createHmac('sha256', this.secret).update(i.idempotencyKey).digest('hex').slice(0, 16)}`,
    });
    return { refundId: data.refundId, status: 'succeeded' };
  }
}
