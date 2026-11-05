/** Stripe adapter (official `stripe` SDK). Requires STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET. */
import Stripe from 'stripe';
import { ProviderError } from '@orvia/config';
import { WebhookSignatureError } from './types';
import { mapStripeDisputeStatus } from './disputes';
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

export class StripePaymentProvider implements PaymentProvider {
  readonly key = 'stripe';
  readonly capabilities = { manualCapture: true, disputes: true, disputeEvidenceSubmission: true } as const;
  private readonly stripe: Stripe;
  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
    private readonly publishableKey?: string,
    client?: Stripe,
  ) {
    this.stripe = client ?? new Stripe(secretKey, { timeout: 15_000, maxNetworkRetries: 2 });
  }

  private wrap(err: unknown): never {
    const e = err as { message?: string; statusCode?: number; type?: string };
    const status = e.statusCode;
    throw new ProviderError(`Stripe error: ${e.message ?? 'unknown'}`, {
      provider: 'stripe',
      retryable: !status || status >= 500 || status === 429,
      status,
      cause: err,
    });
  }

  async createPayment(i: CreatePaymentInput): Promise<CreatePaymentResult> {
    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: i.amount,
          currency: i.currency.toLowerCase(),
          automatic_payment_methods: { enabled: true },
          ...(i.captureMode === 'manual' ? { capture_method: 'manual' as const } : {}),
          receipt_email: i.email,
          metadata: { orderId: i.orderId, orderNumber: i.orderNumber },
        },
        { idempotencyKey: i.idempotencyKey },
      );
      return {
        provider: 'stripe',
        intentId: intent.id,
        clientSecret: intent.client_secret ?? undefined,
        clientConfig: { publishableKey: this.publishableKey ?? '' },
      };
    } catch (e) {
      return this.wrap(e);
    }
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): PaymentWebhookEvent {
    const sig = headers['stripe-signature'];
    const header = Array.isArray(sig) ? sig[0] : sig;
    if (!header) throw new WebhookSignatureError('Missing Stripe-Signature');
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, header, this.webhookSecret);
    } catch {
      throw new WebhookSignatureError();
    }
    const obj = event.data.object as unknown as Record<string, unknown>;
    switch (event.type) {
      case 'payment_intent.succeeded':
        return { id: event.id, type: 'payment.succeeded', intentId: String(obj['id']), amount: Number(obj['amount_received'] ?? obj['amount']), currency: String(obj['currency']).toUpperCase(), providerPaymentId: String(obj['latest_charge'] ?? '') };
      case 'payment_intent.payment_failed': {
        const err = obj['last_payment_error'] as { message?: string } | null;
        return { id: event.id, type: 'payment.failed', intentId: String(obj['id']), failureReason: err?.message ?? 'payment_failed' };
      }
      case 'payment_intent.amount_capturable_updated':
        return { id: event.id, type: 'payment.authorized', intentId: String(obj['id']), amount: Number(obj['amount_capturable'] ?? obj['amount']), currency: String(obj['currency']).toUpperCase() };
      case 'charge.refund.updated':
      case 'refund.updated': {
        const failed = obj['status'] === 'failed';
        const intent = typeof obj['payment_intent'] === 'string' ? (obj['payment_intent'] as string) : '';
        return { id: event.id, type: failed ? 'refund.failed' : 'refund.succeeded', intentId: intent, amount: Number(obj['amount'] ?? 0), currency: String(obj['currency'] ?? '').toUpperCase(), failureReason: failed ? String(obj['failure_reason'] ?? 'refund_failed') : undefined, providerRefundId: String(obj['id'] ?? '') };
      }
      case 'charge.dispute.created':
      case 'charge.dispute.updated':
      case 'charge.dispute.closed':
      case 'charge.dispute.funds_withdrawn':
      case 'charge.dispute.funds_reinstated': {
        const due = (obj['evidence_details'] as { due_by?: number } | null | undefined)?.due_by;
        const bts = Array.isArray(obj['balance_transactions']) ? (obj['balance_transactions'] as { fee?: number }[]) : [];
        const fee = bts.reduce((a, b) => a + (b.fee ?? 0), 0);
        const status = String(obj['status'] ?? '');
        const dispute = {
          disputeId: String(obj['id']),
          intentId: typeof obj['payment_intent'] === 'string' ? (obj['payment_intent'] as string) : undefined,
          chargeId: typeof obj['charge'] === 'string' ? (obj['charge'] as string) : undefined,
          amount: Number(obj['amount'] ?? 0),
          currency: String(obj['currency'] ?? '').toUpperCase(),
          reason: typeof obj['reason'] === 'string' ? (obj['reason'] as string) : undefined,
          providerStatus: status,
          state: mapStripeDisputeStatus(status),
          evidenceDueBy: due ? new Date(due * 1000) : undefined,
          openedAt: typeof obj['created'] === 'number' ? new Date((obj['created'] as number) * 1000) : undefined,
          fee: fee > 0 ? fee : undefined,
        };
        return { id: event.id, type: event.type === 'charge.dispute.created' ? 'dispute.created' : event.type === 'charge.dispute.closed' ? 'dispute.closed' : 'dispute.updated', intentId: dispute.intentId ?? '', dispute };
      }
      default:
        return { id: event.id, type: 'ignored', intentId: String(obj['id'] ?? '') };
    }
  }

  async getPayment(intentId: string): Promise<ProviderPayment> {
    try {
      const pi = await this.stripe.paymentIntents.retrieve(intentId);
      const status = pi.status === 'succeeded' ? 'succeeded' : pi.status === 'requires_capture' ? 'authorized' : 'pending';
      return { status, amount: pi.amount_received || pi.amount, currency: pi.currency.toUpperCase(), providerPaymentId: typeof pi.latest_charge === 'string' ? pi.latest_charge : undefined };
    } catch (e) {
      return this.wrap(e);
    }
  }

  async refund(i: RefundInput): Promise<{ refundId: string; status: 'succeeded' | 'pending' | 'failed' }> {
    try {
      const r = await this.stripe.refunds.create({ payment_intent: i.intentId, amount: i.amount, reason: 'requested_by_customer' }, { idempotencyKey: i.idempotencyKey });
      return { refundId: r.id, status: r.status === 'succeeded' ? 'succeeded' : r.status === 'failed' ? 'failed' : 'pending' };
    } catch (e) {
      return this.wrap(e);
    }
  }

  async capture(i: CaptureInput): Promise<{ status: 'succeeded' | 'pending' | 'failed' }> {
    try {
      const pi = await this.stripe.paymentIntents.capture(i.intentId, i.amount ? { amount_to_capture: i.amount } : {}, { idempotencyKey: i.idempotencyKey });
      return { status: pi.status === 'succeeded' ? 'succeeded' : 'pending' };
    } catch (e) {
      return this.wrap(e);
    }
  }

  async cancelAuthorization(intentId: string, idempotencyKey: string): Promise<void> {
    try {
      await this.stripe.paymentIntents.cancel(intentId, {}, { idempotencyKey });
    } catch (e) {
      this.wrap(e);
    }
  }

  async resolveIntentFromCharge(chargeId: string): Promise<string | null> {
    try {
      const c = await this.stripe.charges.retrieve(chargeId);
      return typeof c.payment_intent === 'string' ? c.payment_intent : null;
    } catch (e) {
      return this.wrap(e);
    }
  }

  /** UNVERIFIED against a live Stripe account. Text-only evidence; file evidence (receipts, proof-of-delivery PDFs) is not uploaded. */
  async submitDisputeEvidence(i: DisputeEvidenceInput): Promise<{ accepted: boolean; providerStatus?: string }> {
    try {
      const d = await this.stripe.disputes.update(i.disputeId, {
        evidence: {
          uncategorized_text: i.summary.slice(0, 20_000),
          ...(i.productDescription ? { product_description: i.productDescription.slice(0, 20_000) } : {}),
          ...(i.refundPolicy ? { refund_policy_disclosure: i.refundPolicy.slice(0, 20_000) } : {}),
        },
        submit: i.submit,
      });
      return { accepted: true, providerStatus: d.status };
    } catch (e) {
      return this.wrap(e);
    }
  }
}
