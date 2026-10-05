/** Stripe adapter (official `stripe` SDK). Requires STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET. */
import Stripe from 'stripe';
import { ProviderError } from '@orvia/config';
import { WebhookSignatureError } from './types';
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  PaymentWebhookEvent,
  ProviderPayment,
  RefundInput,
} from './types';

export class StripePaymentProvider implements PaymentProvider {
  readonly key = 'stripe';
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
      default:
        return { id: event.id, type: 'ignored', intentId: String(obj['id'] ?? '') };
    }
  }

  async getPayment(intentId: string): Promise<ProviderPayment> {
    try {
      const pi = await this.stripe.paymentIntents.retrieve(intentId);
      const status = pi.status === 'succeeded' ? 'succeeded' : pi.status === 'canceled' || pi.status === 'requires_payment_method' ? 'pending' : 'pending';
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
}
