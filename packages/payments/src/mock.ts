/** DEV / TEST ONLY payment provider. Webhooks are HMAC-signed so the real verification path is exercised. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MemoryKVStore } from '@orvia/config';
import type { KVStore } from '@orvia/config';
import { WebhookSignatureError } from './types';
import type { DisputeEvidenceInput, ProviderDispute } from './disputes';
import type {
  CaptureInput,
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
  readonly capabilities = { manualCapture: true, disputes: true, disputeEvidenceSubmission: true } as const;
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
    outcome: 'succeeded' | 'failed' | 'authorized',
    opts: { eventId?: string; amountOverride?: number } = {},
  ): Promise<{ body: string; headers: Record<string, string> }> {
    const p = await this.store.get<ProviderPayment>('payment', intentId);
    if (!p) throw new Error('Unknown mock payment intent');
    const next: ProviderPayment = { ...p, status: outcome === 'succeeded' ? 'succeeded' : outcome === 'authorized' ? 'authorized' : 'failed', providerPaymentId: `mock_pay_${intentId.slice(-10)}` };
    await this.store.set('payment', intentId, next);
    const body = JSON.stringify({
      id: opts.eventId ?? `evt_${intentId.slice(-10)}_${outcome}`,
      type: outcome === 'succeeded' ? 'payment.succeeded' : outcome === 'authorized' ? 'payment.authorized' : 'payment.failed',
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
    if (e.dispute) {
      // JSON turned the dates into strings
      const d = e.dispute as unknown as Record<string, unknown>;
      for (const k of ['evidenceDueBy', 'openedAt']) if (typeof d[k] === 'string') d[k] = new Date(d[k] as string);
    }
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

  /** Dev/test only: signed `dispute.*` webhook as a card network dispute would be reported. */
  async simulateDispute(
    intentId: string,
    o: { status?: 'needs_response' | 'under_review' | 'won' | 'lost' | 'warning'; disputeId?: string; eventId?: string; amount?: number; reason?: string; dueInDays?: number } = {},
  ): Promise<{ body: string; headers: Record<string, string> }> {
    const p = await this.store.get<ProviderPayment>('payment', intentId);
    if (!p) throw new Error('Unknown mock payment intent');
    const status = o.status ?? 'needs_response';
    const disputeId = o.disputeId ?? `mock_dp_${intentId.slice(-10)}`;
    const dispute: ProviderDispute = {
      disputeId,
      intentId,
      chargeId: p.providerPaymentId,
      amount: o.amount ?? p.amount,
      currency: p.currency,
      reason: o.reason ?? 'fraudulent',
      providerStatus: status,
      state: status,
      evidenceDueBy: new Date(Date.now() + (o.dueInDays ?? 7) * 86_400_000),
      openedAt: new Date(),
      fee: 1500,
    };
    const closed = status === 'won' || status === 'lost';
    const body = JSON.stringify({ id: o.eventId ?? `evt_dp_${disputeId}_${status}`, type: closed ? 'dispute.closed' : status === 'needs_response' || status === 'warning' ? 'dispute.created' : 'dispute.updated', intentId, dispute });
    const t = String(Math.floor(Date.now() / 1000));
    return { body, headers: { 'x-mock-signature': `t=${t},v1=${sign(this.secret, t, body)}` } };
  }

  async capture(i: CaptureInput): Promise<{ status: 'succeeded' }> {
    const p = await this.store.get<ProviderPayment>('payment', i.intentId);
    if (!p) throw new Error('Unknown mock payment intent');
    if (p.status !== 'authorized' && p.status !== 'succeeded') throw new Error(`Cannot capture a ${p.status} mock payment`);
    await this.store.set('payment', i.intentId, { ...p, status: 'succeeded' });
    return { status: 'succeeded' };
  }

  async cancelAuthorization(intentId: string): Promise<void> {
    const p = await this.store.get<ProviderPayment>('payment', intentId);
    if (p && p.status === 'authorized') await this.store.set('payment', intentId, { ...p, status: 'failed' });
  }

  async resolveIntentFromCharge(_chargeId: string): Promise<string | null> {
    return null;
  }

  async submitDisputeEvidence(_i: DisputeEvidenceInput): Promise<{ accepted: boolean; providerStatus?: string }> {
    return { accepted: true, providerStatus: 'under_review' };
  }
}
