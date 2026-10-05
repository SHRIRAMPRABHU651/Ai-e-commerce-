import type { Currency } from '@orvia/types';

export interface CreatePaymentInput {
  orderId: string;
  orderNumber: string;
  amount: number; // minor units
  currency: Currency;
  email: string;
  /** Stable per order: retries of this call must not create a second charge. */
  idempotencyKey: string;
}

export interface CreatePaymentResult {
  provider: string;
  intentId: string;
  clientSecret?: string;
  /** Public (non-secret) data the browser needs to render the provider's payment UI. */
  clientConfig: Record<string, string>;
}

export type PaymentEventType = 'payment.succeeded' | 'payment.failed' | 'refund.succeeded' | 'ignored';

export interface PaymentWebhookEvent {
  id: string;
  type: PaymentEventType;
  intentId: string;
  amount?: number;
  currency?: string;
  failureReason?: string;
  providerPaymentId?: string;
}

export interface ProviderPayment {
  status: 'pending' | 'succeeded' | 'failed';
  amount: number;
  currency: string;
  providerPaymentId?: string;
}

export interface RefundInput {
  intentId: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  reason?: string;
}

export interface PaymentProvider {
  readonly key: string;
  createPayment(i: CreatePaymentInput): Promise<CreatePaymentResult>;
  /** Verifies the signature and parses the event. Throws WebhookSignatureError if invalid. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): PaymentWebhookEvent;
  /** Server-side source of truth. Never trust a status sent by the browser. */
  getPayment(intentId: string): Promise<ProviderPayment>;
  refund(i: RefundInput): Promise<{ refundId: string; status: 'succeeded' | 'pending' | 'failed' }>;
}

export class WebhookSignatureError extends Error {
  constructor(msg = 'Invalid webhook signature') {
    super(msg);
    this.name = 'WebhookSignatureError';
  }
}
