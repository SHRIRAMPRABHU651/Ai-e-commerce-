import type { Currency } from '@orvia/types';
import type { DisputeEvidenceInput, ProviderDispute } from './disputes';

export interface CreatePaymentInput {
  orderId: string;
  orderNumber: string;
  amount: number; // minor units
  currency: Currency;
  email: string;
  /** Stable per order: retries of this call must not create a second charge. */
  idempotencyKey: string;
  /** `automatic` (default, current behaviour) captures immediately; `manual` only authorizes where the provider supports it. */
  captureMode?: 'automatic' | 'manual';
}

export interface CreatePaymentResult {
  provider: string;
  intentId: string;
  clientSecret?: string;
  /** Public (non-secret) data the browser needs to render the provider's payment UI. */
  clientConfig: Record<string, string>;
}

export type PaymentEventType = 'payment.succeeded' | 'payment.failed' | 'payment.authorized' | 'refund.succeeded' | 'refund.failed' | 'dispute.created' | 'dispute.updated' | 'dispute.closed' | 'ignored';

export interface PaymentWebhookEvent {
  id: string;
  type: PaymentEventType;
  intentId: string;
  amount?: number;
  currency?: string;
  failureReason?: string;
  providerPaymentId?: string;
  /** Present on dispute.* events. */
  dispute?: ProviderDispute;
  /** Present on refund.* events: the provider's refund id. */
  providerRefundId?: string;
}

export interface ProviderPayment {
  /** `authorized` = funds held but not captured (manual capture). */
  status: 'pending' | 'authorized' | 'succeeded' | 'failed';
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
  readonly capabilities?: ProviderCapabilities;
  createPayment(i: CreatePaymentInput): Promise<CreatePaymentResult>;
  /** Verifies the signature and parses the event. Throws WebhookSignatureError if invalid. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): PaymentWebhookEvent;
  /** Server-side source of truth. Never trust a status sent by the browser. */
  getPayment(intentId: string): Promise<ProviderPayment>;
  refund(i: RefundInput): Promise<{ refundId: string; status: 'succeeded' | 'pending' | 'failed' }>;
  /** Capture a previously authorized payment (manual capture). Absent when the provider adapter does not support it. */
  capture?(i: CaptureInput): Promise<{ status: 'succeeded' | 'pending' | 'failed' }>;
  /** Release an authorization that will not be captured. */
  cancelAuthorization?(intentId: string, idempotencyKey: string): Promise<void>;
  /** Maps a provider charge/payment id to our intent id (disputes reference charges). */
  resolveIntentFromCharge?(chargeId: string): Promise<string | null>;
  /**
   * Sends dispute evidence to the provider. UNVERIFIED against live accounts: shaped from public API docs.
   * Callers must treat success as "provider accepted the call", not as proof the evidence was valid.
   */
  submitDisputeEvidence?(i: DisputeEvidenceInput): Promise<{ accepted: boolean; providerStatus?: string }>;
}

export interface CaptureInput {
  intentId: string;
  /** Minor units; omit to capture the full authorized amount. */
  amount?: number;
  currency?: string;
  idempotencyKey: string;
}

export interface ProviderCapabilities {
  manualCapture: boolean;
  disputes: boolean;
  disputeEvidenceSubmission: boolean;
}

export class WebhookSignatureError extends Error {
  constructor(msg = 'Invalid webhook signature') {
    super(msg);
    this.name = 'WebhookSignatureError';
  }
}
