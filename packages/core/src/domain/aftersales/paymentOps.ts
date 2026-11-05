/** Payments hardening: explicit capture, provider reconciliation, failed-payment handling. Not wired into checkout (default stays automatic capture). */
import { Order, Payment } from '@orvia/database';
import { audit } from '../../infra/audit';
import { conflict, DomainError, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { raiseException } from '../exceptions';
import { settlePayment } from '../orders';
import { comparePaymentState } from './webhookRules';
import type { PaymentDiscrepancy } from './webhookRules';

/** Capture a payment that the provider holds as `authorized` (manual capture), then settle the order exactly as a webhook would. */
export async function capturePayment(ctx: Ctx, orderId: string, actor: Actor) {
  const order = await Order.findById(orderId);
  if (!order) throw notFound('Order');
  const pay = await Payment.findOne({ orderId: order._id });
  if (!pay) throw notFound('Payment');
  const provider = ctx.payments.get(pay.provider);
  if (!provider.capture) throw new DomainError('This payment provider does not support manual capture', 'UNSUPPORTED', 422);
  const state = await provider.getPayment(pay.intentId);
  if (state.status === 'succeeded') return { status: 'already_captured' as const };
  if (state.status !== 'authorized') throw conflict(`Payment is ${state.status} at the provider, not authorized`);
  const r = await provider.capture({ intentId: pay.intentId, amount: order.amounts?.total, currency: order.currency, idempotencyKey: `capture:${pay._id}` });
  await audit(ctx, actor, { action: 'payment.captured', resource: 'order', resourceId: orderId, newValue: { status: r.status }, provider: pay.provider });
  const outcome = await settlePayment(ctx, order, pay, provider, pay.provider);
  return { status: r.status, outcome };
}

export interface ProviderReconcileResult { checked: number; discrepancies: { paymentId: string; kind: PaymentDiscrepancy }[]; failedMarked: number; settled: number; errors: number }

/**
 * Compares local Payment rows with the provider (read-only provider calls), raises one deduplicated RECONCILIATION
 * exception per discrepancy, settles payments the provider confirms, and marks provider-failed pending payments failed.
 */
export async function reconcileWithProvider(ctx: Ctx, o: { sinceHours?: number; graceMinutes?: number; limit?: number } = {}): Promise<ProviderReconcileResult> {
  const since = new Date(ctx.now().getTime() - (o.sinceHours ?? 72) * 3_600_000);
  const grace = new Date(ctx.now().getTime() - (o.graceMinutes ?? 30) * 60_000);
  const pays = await Payment.find({ createdAt: { $gte: since, $lte: grace }, status: { $in: ['pending', 'succeeded', 'failed'] } }).sort({ createdAt: -1 }).limit(Math.min(o.limit ?? 200, 500));
  const res: ProviderReconcileResult = { checked: 0, discrepancies: [], failedMarked: 0, settled: 0, errors: 0 };
  for (const pay of pays) {
    try {
      const provider = ctx.payments.get(pay.provider);
      const remote = await provider.getPayment(pay.intentId);
      res.checked++;
      for (const kind of comparePaymentState({ status: pay.status, amount: pay.amount ?? 0, currency: pay.currency ?? '' }, remote)) {
        res.discrepancies.push({ paymentId: String(pay._id), kind });
        const order = await Order.findById(pay.orderId);
        if (kind === 'provider_succeeded_local_pending' && order) {
          if ((await settlePayment(ctx, order, pay, provider, pay.provider)) === 'processed') { res.settled++; continue; }
        }
        if (kind === 'provider_failed_local_pending') {
          pay.status = 'failed';
          pay.failureReason = 'provider reports the payment failed';
          await pay.save();
          await Order.updateOne({ _id: pay.orderId, 'payment.status': 'pending' }, { $set: { 'payment.status': 'failed' } });
          res.failedMarked++;
          continue;
        }
        await raiseException(ctx, { kind: 'RECONCILIATION', priority: kind === 'local_succeeded_provider_not_succeeded' || kind === 'amount_mismatch' ? 'critical' : 'high', issue: `Provider reconciliation: ${kind.replace(/_/g, ' ')} for payment ${String(pay._id)}${order ? ` (${order.orderNumber})` : ''}`, aiRecommendation: 'Compare with the provider dashboard before money or stock moves.', suggestedAction: 'Review', dedupeKey: `provrecon:${kind}:${String(pay._id)}` });
      }
    } catch (e) {
      res.errors++;
      ctx.log.warn({ channel: 'payment', payment: String(pay._id), err: (e as Error).message }, 'provider reconciliation lookup failed');
    }
  }
  return res;
}
