/**
 * Razorpay adapter over the official REST API (https://razorpay.com/docs/api). No SDK dependency:
 * order creation, server-side status lookup, refunds, and HMAC-SHA256 webhook verification.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { fetchJson, ProviderError } from '@orvia/config';
import { WebhookSignatureError } from './types';
import { mapRazorpayDisputeStatus } from './disputes';
import type { DisputeEvidenceInput } from './disputes';
import type {
  CaptureInput,
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  PaymentWebhookEvent,
  ProviderPayment,
  RefundInput,
} from './types';

const BASE = 'https://api.razorpay.com/v1';

interface RzpPayment { id: string; status: string; amount: number; currency: string; error_description?: string }
interface RzpDispute { id: string; payment_id?: string; amount: number; currency: string; reason_code?: string; status?: string; respond_by?: number; created_at?: number; phase?: string }

export class RazorpayPaymentProvider implements PaymentProvider {
  readonly key = 'razorpay';
  /** Razorpay capture mode is an account/dashboard setting; `capture` works for payments left in `authorized`. */
  readonly capabilities = { manualCapture: true, disputes: true, disputeEvidenceSubmission: true } as const;
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  private auth(): Record<string, string> {
    return { authorization: 'Basic ' + Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64') };
  }

  async createPayment(i: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (i.currency !== 'INR') throw new ProviderError('Razorpay adapter is configured for INR only', { provider: 'razorpay', retryable: false });
    // `receipt` carries our idempotency key; one Razorpay order is created per Orvia order (guarded by the unique payments index).
    const o = await fetchJson<{ id: string }>(`${BASE}/orders`, {
      provider: 'razorpay',
      method: 'POST',
      headers: this.auth(),
      body: { amount: i.amount, currency: 'INR', receipt: i.orderNumber, notes: { orderId: i.orderId } },
      fetchImpl: this.fetchImpl,
      idempotent: false,
    });
    return { provider: 'razorpay', intentId: o.id, clientConfig: { keyId: this.keyId, orderId: o.id } };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): PaymentWebhookEvent {
    const h = headers['x-razorpay-signature'];
    const sig = Array.isArray(h) ? h[0] : h;
    if (!sig) throw new WebhookSignatureError('Missing X-Razorpay-Signature');
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookSignatureError();
    const evt = JSON.parse(rawBody) as { event: string; payload?: { payment?: { entity: RzpPayment & { order_id: string } }; dispute?: { entity: RzpDispute } } };
    const dsp = evt.payload?.dispute?.entity;
    const id = (Array.isArray(headers['x-razorpay-event-id']) ? headers['x-razorpay-event-id'][0] : headers['x-razorpay-event-id']) ?? `${evt.event}:${evt.payload?.payment?.entity.id ?? dsp?.id}`;
    const pay = evt.payload?.payment?.entity;
    if (dsp && evt.event.startsWith('payment.dispute.')) {
      const dispute = {
        disputeId: dsp.id,
        intentId: pay?.order_id || undefined,
        chargeId: dsp.payment_id ?? pay?.id,
        amount: dsp.amount,
        currency: dsp.currency,
        reason: dsp.reason_code,
        providerStatus: dsp.status ?? evt.event.replace('payment.dispute.', ''),
        state: mapRazorpayDisputeStatus(dsp.status ?? '', evt.event),
        evidenceDueBy: dsp.respond_by ? new Date(dsp.respond_by * 1000) : undefined,
        openedAt: dsp.created_at ? new Date(dsp.created_at * 1000) : undefined,
      };
      return { id, type: evt.event === 'payment.dispute.created' ? 'dispute.created' : ['payment.dispute.won', 'payment.dispute.lost', 'payment.dispute.closed'].includes(evt.event) ? 'dispute.closed' : 'dispute.updated', intentId: dispute.intentId ?? '', dispute };
    }
    if (!pay) return { id, type: 'ignored', intentId: '' };
    if (evt.event === 'payment.captured' || evt.event === 'order.paid') {
      return { id, type: 'payment.succeeded', intentId: pay.order_id, amount: pay.amount, currency: pay.currency, providerPaymentId: pay.id };
    }
    if (evt.event === 'payment.failed') {
      return { id, type: 'payment.failed', intentId: pay.order_id, failureReason: pay.error_description ?? 'payment_failed', providerPaymentId: pay.id };
    }
    return { id, type: 'ignored', intentId: pay.order_id };
  }

  async getPayment(intentId: string): Promise<ProviderPayment> {
    const r = await fetchJson<{ items: RzpPayment[] }>(`${BASE}/orders/${encodeURIComponent(intentId)}/payments`, {
      provider: 'razorpay',
      headers: this.auth(),
      fetchImpl: this.fetchImpl,
    });
    const captured = r.items.find((p) => p.status === 'captured');
    if (captured) return { status: 'succeeded', amount: captured.amount, currency: captured.currency, providerPaymentId: captured.id };
    const authorized = r.items.find((p) => p.status === 'authorized');
    if (authorized) return { status: 'authorized', amount: authorized.amount, currency: authorized.currency, providerPaymentId: authorized.id };
    const any = r.items[0];
    return { status: r.items.length && r.items.every((p) => p.status === 'failed') ? 'failed' : 'pending', amount: any?.amount ?? 0, currency: any?.currency ?? 'INR' };
  }

  async refund(i: RefundInput): Promise<{ refundId: string; status: 'succeeded' | 'pending' | 'failed' }> {
    const p = await this.getPayment(i.intentId);
    if (!p.providerPaymentId) throw new ProviderError('No captured Razorpay payment to refund', { provider: 'razorpay', retryable: false });
    const r = await fetchJson<{ id: string; status: string }>(`${BASE}/payments/${p.providerPaymentId}/refund`, {
      provider: 'razorpay',
      method: 'POST',
      headers: { ...this.auth(), 'X-Refund-Idempotency': i.idempotencyKey },
      body: { amount: i.amount, receipt: i.idempotencyKey.slice(0, 40) },
      fetchImpl: this.fetchImpl,
      idempotent: true,
    });
    return { refundId: r.id, status: r.status === 'processed' ? 'succeeded' : r.status === 'failed' ? 'failed' : 'pending' };
  }

  /** Captures an `authorized` Razorpay payment. UNVERIFIED against a live account. */
  async capture(i: CaptureInput): Promise<{ status: 'succeeded' | 'pending' | 'failed' }> {
    const p = await this.getPayment(i.intentId);
    if (p.status === 'succeeded') return { status: 'succeeded' };
    if (p.status !== 'authorized' || !p.providerPaymentId) throw new ProviderError('No authorized Razorpay payment to capture', { provider: 'razorpay', retryable: false });
    const r = await fetchJson<{ status: string }>(`${BASE}/payments/${p.providerPaymentId}/capture`, {
      provider: 'razorpay',
      method: 'POST',
      headers: this.auth(),
      body: { amount: i.amount ?? p.amount, currency: i.currency ?? p.currency },
      fetchImpl: this.fetchImpl,
      idempotent: false,
    });
    return { status: r.status === 'captured' ? 'succeeded' : 'pending' };
  }

  async resolveIntentFromCharge(paymentId: string): Promise<string | null> {
    const r = await fetchJson<{ order_id?: string }>(`${BASE}/payments/${encodeURIComponent(paymentId)}`, { provider: 'razorpay', headers: this.auth(), fetchImpl: this.fetchImpl });
    return r.order_id ?? null;
  }

  /** Contest a dispute. UNVERIFIED against a live account: body shaped from the public "contest dispute" docs (summary + submit; document uploads are not implemented). */
  async submitDisputeEvidence(i: DisputeEvidenceInput): Promise<{ accepted: boolean; providerStatus?: string }> {
    const r = await fetchJson<{ status?: string }>(`${BASE}/disputes/${encodeURIComponent(i.disputeId)}/contest`, {
      provider: 'razorpay',
      method: 'PATCH',
      headers: this.auth(),
      body: { summary: i.summary.slice(0, 1000), submit: i.submit },
      fetchImpl: this.fetchImpl,
      idempotent: false,
    });
    return { accepted: true, providerStatus: r.status };
  }
}
