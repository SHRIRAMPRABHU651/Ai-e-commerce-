import { describe, expect, it } from 'vitest';
import { evaluateEligibility, validateSelection } from '../../packages/core/src/domain/aftersales/eligibility';
import type { EligibilityInput } from '../../packages/core/src/domain/aftersales/eligibility';
import { computeRefund, exchangeDifference } from '../../packages/core/src/domain/aftersales/refundMath';
import type { RefundMathInput } from '../../packages/core/src/domain/aftersales/refundMath';
import { CHARGEBACK_MACHINE, CLAIM_MACHINE, RMA_MACHINE, canTransition, isTerminal, validateClaimAmounts } from '../../packages/core/src/domain/aftersales/stateMachines';
import { canAddEvidence, evidenceSatisfied, isReturnOwner, sniffEvidenceFormat, validateEvidenceFile } from '../../packages/core/src/domain/aftersales/evidence';
import { comparePaymentState, decideWebhookDedupe } from '../../packages/core/src/domain/aftersales/webhookRules';
import { chargebackRate, chargebackReserve, deadlineState, nextChargebackState, sumReserves } from '../../packages/core/src/domain/aftersales/chargebackRules';
import { buildRefundTimeline } from '../../packages/core/src/domain/aftersales/refundTimeline';
import { buildReturnInstructions } from '../../packages/core/src/domain/aftersales/labels';
import { mapRazorpayDisputeStatus, mapStripeDisputeStatus } from '../../packages/payments/src/disputes';

const now = new Date('2026-06-30T12:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const yes = { supportsReturns: 'yes' as const, supportsReplacement: true, supportsExchange: false, defectOnly: false };
const base = (o: Partial<EligibilityInput> = {}): EligibilityInput => ({
  now, deliveredAt: daysAgo(5), paymentOk: true, countryWindowDays: 30, reason: 'changed_mind', excludedCategories: [], openReturn: false,
  lines: [{ sku: 'A', title: 'Thing', quantity: 2, alreadyReturned: 0, supplier: yes, condition: 'unopened' }], ...o,
});

describe('eligibility', () => {
  it('allows a normal return and reports days left', () => {
    const r = evaluateEligibility(base());
    expect(r.eligible).toBe(true);
    expect(r.daysLeft).toBe(25);
    expect(r.lines[0]!.returnMethod).toBe('ship_back');
    expect(r.lines[0]!.resolutionsAllowed).toEqual(['refund']);
  });
  it('blocks after the window with a reason; defects use the country window not the shorter supplier window', () => {
    expect(evaluateEligibility(base({ deliveredAt: daysAgo(31) })).lines[0]!.reasons[0]!.code).toBe('WINDOW_PASSED');
    const l = [{ sku: 'A', title: 'T', quantity: 1, alreadyReturned: 0, supplier: { ...yes, returnWindowDays: 7 } }];
    expect(evaluateEligibility(base({ lines: l, deliveredAt: daysAgo(10) })).lines[0]!.reasons[0]!.code).toBe('WINDOW_PASSED');
    expect(evaluateEligibility(base({ lines: l, deliveredAt: daysAgo(10), reason: 'damaged' })).lines[0]!.eligible).toBe(true);
  });
  it('never promises a return the supplier cannot support', () => {
    const l = [{ sku: 'A', title: 'T', quantity: 1, alreadyReturned: 0, supplier: { ...yes, supportsReturns: 'no' as const } }];
    const pref = evaluateEligibility(base({ lines: l }));
    expect(pref.eligible).toBe(false);
    expect(pref.lines[0]!.reasons[0]!.code).toBe('SUPPLIER_NO_RETURNS');
    const defect = evaluateEligibility(base({ lines: l, reason: 'defective' }));
    expect(defect.lines[0]!.eligible).toBe(true);
    expect(defect.lines[0]!.returnMethod).toBe('staff_decides');
    expect(defect.lines[0]!.needsStaffReview).toBe(true);
  });
  it('unknown supplier policy needs staff review and offers no replacement', () => {
    const l = [{ sku: 'A', title: 'T', quantity: 1, alreadyReturned: 0, supplier: null }];
    const r = evaluateEligibility(base({ lines: l, reason: 'damaged' })).lines[0]!;
    expect(r.eligible).toBe(true);
    expect(r.needsStaffReview).toBe(true);
    expect(r.resolutionsAllowed).toEqual(['refund']);
  });
  it('applies category exclusions to preference reasons only, condition rules, defect-only and quantities', () => {
    const l = [{ sku: 'A', title: 'T', quantity: 2, alreadyReturned: 1, category: 'Hygiene', supplier: yes, condition: 'used' as const }];
    const codes = evaluateEligibility(base({ lines: l, excludedCategories: ['hygiene'] })).lines[0]!.reasons.map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['CATEGORY_EXCLUDED', 'CONDITION_NOT_RETURNABLE']));
    expect(evaluateEligibility(base({ lines: l, excludedCategories: ['hygiene'], reason: 'damaged' })).lines[0]!.eligible).toBe(true);
    expect(evaluateEligibility(base({ lines: l, reason: 'damaged' })).lines[0]!.maxQuantity).toBe(1);
    const gone = [{ sku: 'A', title: 'T', quantity: 1, alreadyReturned: 1, supplier: yes }];
    expect(evaluateEligibility(base({ lines: gone })).lines[0]!.reasons[0]!.code).toBe('ALREADY_RETURNED');
    const dOnly = [{ sku: 'A', title: 'T', quantity: 1, alreadyReturned: 0, supplier: { ...yes, defectOnly: true } }];
    expect(evaluateEligibility(base({ lines: dOnly })).lines[0]!.reasons[0]!.code).toBe('SUPPLIER_DEFECT_ONLY');
  });
  it('handles undelivered, unpaid and open-return orders', () => {
    expect(evaluateEligibility(base({ deliveredAt: null })).orderReasons[0]!.code).toBe('NOT_DELIVERED');
    const nd = evaluateEligibility(base({ deliveredAt: null, reason: 'not_delivered' }));
    expect(nd.eligible).toBe(true);
    expect(nd.lines[0]!.returnMethod).toBe('none_needed');
    expect(evaluateEligibility(base({ paymentOk: false })).eligible).toBe(false);
    expect(evaluateEligibility(base({ openReturn: true })).orderReasons[0]!.code).toBe('RETURN_OPEN');
  });
  it('validates a selection server-side', () => {
    const r = evaluateEligibility(base());
    expect(validateSelection(r, [{ sku: 'A', quantity: 2 }], 'refund')).toEqual([]);
    expect(validateSelection(r, [{ sku: 'A', quantity: 3 }], 'refund')[0]!.code).toBe('QUANTITY_EXCEEDED');
    expect(validateSelection(r, [{ sku: 'Z', quantity: 1 }], 'refund')[0]!.code).toBe('BAD_ITEMS');
    expect(validateSelection(r, [{ sku: 'A', quantity: 1 }], 'replacement')[0]!.code).toBe('RESOLUTION_UNAVAILABLE');
    expect(validateSelection(r, [{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 1 }], 'refund')[0]!.code).toBe('DUPLICATE_ITEM');
  });
});

const order = (o: Partial<RefundMathInput> = {}): RefundMathInput => ({
  currency: 'USD', amounts: { subtotal: 3000, discount: 300, shipping: 499, tax: 200, total: 3399, taxInclusive: false },
  lines: [{ sku: 'A', unitPrice: 1000, quantity: 2, returnQty: 1, alreadyReturnedQty: 0 }, { sku: 'B', unitPrice: 1000, quantity: 1, returnQty: 0, alreadyReturnedQty: 0 }],
  alreadyRefunded: 0, fault: 'customer', shippingRule: 'fault_only', restockingFeeBps: 0, returnShippingDeduction: 0, ...o,
});
// total = (3000-300+499) + 200 = 3399

describe('refund math', () => {
  it('partial customer-fault return: discount and tax pro-rata, no shipping', () => {
    const r = computeRefund(order());
    expect(r.goods).toBe(1000);
    expect(r.discountShare).toBe(100);
    expect(r.goodsNet).toBe(900);
    expect(r.shipping).toBe(0);
    expect(r.tax).toBe(Math.round((200 * 900) / 3199));
    expect(r.refundable).toBe(r.goodsNet + r.tax);
    expect(Number.isInteger(r.refundable)).toBe(true);
  });
  it('seller-fault partial return refunds pro-rata shipping', () => {
    const r = computeRefund(order({ fault: 'merchant' }));
    expect(r.shipping).toBe(Math.round((499 * 1000) / 3000));
  });
  it('full return refunds exactly the remaining total for seller fault and for the full_return rule', () => {
    const lines = [{ sku: 'A', unitPrice: 1000, quantity: 2, returnQty: 2, alreadyReturnedQty: 0 }, { sku: 'B', unitPrice: 1000, quantity: 1, returnQty: 1, alreadyReturnedQty: 0 }];
    expect(computeRefund(order({ lines, fault: 'merchant' })).refundable).toBe(3399);
    expect(computeRefund(order({ lines, shippingRule: 'full_return' })).refundable).toBe(3399);
    expect(computeRefund(order({ lines })).refundable).toBeLessThan(3399); // customer fault: shipping kept
  });
  it('splitting a full return across steps never exceeds the total (no drift)', () => {
    const a = computeRefund(order({ fault: 'merchant', lines: [{ sku: 'A', unitPrice: 1000, quantity: 2, returnQty: 1, alreadyReturnedQty: 0 }, { sku: 'B', unitPrice: 1000, quantity: 1, returnQty: 0, alreadyReturnedQty: 0 }] }));
    const b = computeRefund(order({ fault: 'merchant', alreadyRefunded: a.refundable, lines: [{ sku: 'A', unitPrice: 1000, quantity: 2, returnQty: 1, alreadyReturnedQty: 1 }, { sku: 'B', unitPrice: 1000, quantity: 1, returnQty: 1, alreadyReturnedQty: 0 }] }));
    expect(a.refundable + b.refundable).toBe(3399);
    expect(b.remainingAfter).toBe(0);
  });
  it('tax-inclusive countries (India) add no separate tax; INR minor units stay integers', () => {
    const r = computeRefund({ currency: 'INR', amounts: { subtotal: 99900, discount: 0, shipping: 4900, tax: 15800, total: 104800, taxInclusive: true }, lines: [{ sku: 'A', unitPrice: 33300, quantity: 3, returnQty: 1, alreadyReturnedQty: 0 }], alreadyRefunded: 0, fault: 'merchant', shippingRule: 'fault_only', restockingFeeBps: 0, returnShippingDeduction: 0 });
    expect(r.tax).toBe(0);
    expect(r.shipping).toBe(Math.round(4900 / 3));
    expect(Number.isInteger(r.refundable)).toBe(true);
  });
  it('applies restocking fee and return shipping only for customer fault, and caps at what is left', () => {
    const c = computeRefund(order({ restockingFeeBps: 1000, returnShippingDeduction: 100 }));
    expect(c.restockingFee).toBe(90);
    expect(c.returnShippingDeduction).toBe(100);
    expect(c.refundable).toBe(c.gross - 190);
    expect(computeRefund(order({ fault: 'merchant', restockingFeeBps: 1000, returnShippingDeduction: 100 })).restockingFee).toBe(0);
    const capped = computeRefund(order({ alreadyRefunded: 3300 }));
    expect(capped.refundable).toBe(99);
    expect(capped.cappedByRemaining).toBe(true);
  });
  it('rejects invalid input', () => {
    expect(() => computeRefund(order({ currency: 'JPY' }))).toThrow();
    expect(() => computeRefund(order({ lines: [{ sku: 'A', unitPrice: 1000, quantity: 1, returnQty: 2, alreadyReturnedQty: 0 }] }))).toThrow();
    expect(() => computeRefund(order({ alreadyRefunded: 1.5 }))).toThrow();
  });
  it('exchange price difference', () => {
    expect(exchangeDifference(1000, 800, 2)).toEqual({ customerOwes: 0, refundDue: 400 });
    expect(exchangeDifference(1000, 1200, 1)).toEqual({ customerOwes: 200, refundDue: 0 });
  });
});

describe('state machines', () => {
  it('RMA: valid and invalid moves, terminal states', () => {
    expect(canTransition(RMA_MACHINE, 'submitted', 'authorized')).toBe(true);
    expect(canTransition(RMA_MACHINE, 'submitted', 'resolved')).toBe(false);
    expect(canTransition(RMA_MACHINE, 'received', 'inspected')).toBe(true);
    expect(canTransition(RMA_MACHINE, 'resolved', 'submitted')).toBe(false);
    expect(canTransition(RMA_MACHINE, 'submitted', 'submitted')).toBe(false);
    for (const s of ['resolved', 'rejected', 'cancelled'] as const) expect(isTerminal(RMA_MACHINE, s)).toBe(true);
  });
  it('claims and their money rules', () => {
    expect(canTransition(CLAIM_MACHINE, 'draft', 'submitted')).toBe(true);
    expect(canTransition(CLAIM_MACHINE, 'draft', 'recovered')).toBe(false);
    expect(canTransition(CLAIM_MACHINE, 'rejected', 'submitted')).toBe(true);
    expect(validateClaimAmounts('partially_accepted', { claimed: 1000, approved: 1000 })).not.toBeNull();
    expect(validateClaimAmounts('partially_accepted', { claimed: 1000, approved: 600 })).toBeNull();
    expect(validateClaimAmounts('recovered', { claimed: 1000, approved: 600, recovered: 700 })).not.toBeNull();
    expect(validateClaimAmounts('recovered', { claimed: 1000, approved: 600, recovered: 600 })).toBeNull();
  });
  it('chargebacks: terminal states cannot be reopened', () => {
    expect(canTransition(CHARGEBACK_MACHINE, 'needs_response', 'evidence_recorded')).toBe(true);
    expect(canTransition(CHARGEBACK_MACHINE, 'won', 'needs_response')).toBe(false);
    expect(nextChargebackState('won', 'needs_response')).toBe('won');
    expect(nextChargebackState('submitted', 'needs_response')).toBe('submitted');
    expect(nextChargebackState('needs_response', 'under_review')).toBe('under_review');
    expect(nextChargebackState('under_review', 'lost')).toBe('lost');
  });
});

describe('evidence validation', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000)]);
  const lim = { maxBytes: 10_000_000, existingCount: 0 };
  it('sniffs magic bytes, rejects disguised files, big files, too many files', () => {
    expect(sniffEvidenceFormat(jpeg)).toBe('jpeg');
    expect(validateEvidenceFile({ buffer: jpeg, mimetype: 'image/jpeg' }, lim).ok).toBe(true);
    expect(validateEvidenceFile({ buffer: png, mimetype: 'image/jpeg' }, lim).error?.code).toBe('mismatch');
    expect(validateEvidenceFile({ buffer: Buffer.from('<svg/>'.repeat(500)), mimetype: 'image/png' }, lim).error?.code).toBe('type');
    expect(validateEvidenceFile({ buffer: jpeg, mimetype: 'application/pdf' }, lim).error?.code).toBe('type');
    expect(validateEvidenceFile({ buffer: jpeg, mimetype: 'image/jpeg' }, { ...lim, maxBytes: 1500 }).error?.code).toBe('size');
    expect(validateEvidenceFile({ buffer: jpeg, mimetype: 'image/jpeg' }, { ...lim, existingCount: 6 }).error?.code).toBe('limit');
    expect(validateEvidenceFile({ buffer: Buffer.alloc(10), mimetype: 'image/jpeg' }, lim).error?.code).toBe('empty');
  });
  it('ownership and requirements', () => {
    expect(isReturnOwner({ userId: 'u1', email: 'a@x.com' }, { userId: 'u1' })).toBe(true);
    expect(isReturnOwner({ userId: 'u1', email: 'a@x.com' }, { userId: 'u2', email: 'b@x.com' })).toBe(false);
    expect(isReturnOwner({ email: 'A@x.com' }, { email: 'a@X.com' })).toBe(true);
    expect(canAddEvidence({ isStaff: false, isOwner: true, state: 'resolved' })).toBe(false);
    expect(canAddEvidence({ isStaff: false, isOwner: false, state: 'submitted' })).toBe(false);
    expect(canAddEvidence({ isStaff: true, isOwner: false, state: 'resolved' })).toBe(true);
    expect(evidenceSatisfied('required', 0).ok).toBe(false);
    expect(evidenceSatisfied('recommended', 0).ok).toBe(true);
  });
});

describe('webhook idempotency decisions and reconciliation', () => {
  it('dedupe: new, finished, in-flight, crashed', () => {
    expect(decideWebhookDedupe(null, now)).toBe('process');
    expect(decideWebhookDedupe({ outcome: 'processed', processedAt: daysAgo(1) }, now)).toBe('duplicate');
    expect(decideWebhookDedupe({ processedAt: new Date(now.getTime() - 10_000) }, now)).toBe('duplicate');
    expect(decideWebhookDedupe({ processedAt: new Date(now.getTime() - 5 * 60_000) }, now)).toBe('retry_stale');
  });
  it('compares local and provider payment state', () => {
    const l = { status: 'pending', amount: 1000, currency: 'USD' };
    expect(comparePaymentState(l, { status: 'succeeded', amount: 1000, currency: 'USD' })).toEqual(['provider_succeeded_local_pending']);
    expect(comparePaymentState(l, { status: 'failed', amount: 1000, currency: 'USD' })).toEqual(['provider_failed_local_pending']);
    expect(comparePaymentState({ ...l, status: 'succeeded' }, { status: 'pending', amount: 0, currency: 'USD' })).toEqual(['local_succeeded_provider_not_succeeded']);
    expect(comparePaymentState({ ...l, status: 'partially_refunded' }, { status: 'succeeded', amount: 900, currency: 'USD' })).toEqual(['amount_mismatch']);
    expect(comparePaymentState({ ...l, status: 'succeeded' }, { status: 'succeeded', amount: 1000, currency: 'usd' })).toEqual([]);
  });
});

describe('chargeback rules', () => {
  it('maps provider statuses', () => {
    expect(mapStripeDisputeStatus('needs_response')).toBe('needs_response');
    expect(mapStripeDisputeStatus('warning_needs_response')).toBe('warning');
    expect(mapStripeDisputeStatus('won')).toBe('won');
    expect(mapRazorpayDisputeStatus('open', 'payment.dispute.created')).toBe('needs_response');
    expect(mapRazorpayDisputeStatus('lost', 'payment.dispute.lost')).toBe('lost');
  });
  it('tracks deadlines', () => {
    expect(deadlineState(now, new Date(now.getTime() + 10 * 86_400_000), 'needs_response')).toBe('ok');
    expect(deadlineState(now, new Date(now.getTime() + 3_600_000), 'needs_response')).toBe('due_soon');
    expect(deadlineState(now, new Date(now.getTime() - 1), 'evidence_recorded')).toBe('overdue');
    expect(deadlineState(now, new Date(now.getTime() - 1), 'won')).toBe('none');
  });
  it('reserve accounting', () => {
    expect(chargebackReserve({ state: 'needs_response', amount: 5000, fee: 1500 })).toEqual({ held: 6500, lost: 0, released: 0, fee: 1500 });
    expect(chargebackReserve({ state: 'won', amount: 5000, fee: 1500 })).toEqual({ held: 0, lost: 1500, released: 5000, fee: 1500 });
    expect(chargebackReserve({ state: 'lost', amount: 5000, fee: 1500 }).lost).toBe(6500);
    expect(sumReserves([{ state: 'under_review', amount: 100 }, { state: 'lost', amount: 200 }])).toMatchObject({ held: 100, lost: 200 });
  });
  it('rate is insufficient data on small samples', () => {
    expect(chargebackRate({ disputes: 1, transactions: 20, disputedAmount: 1, transactedAmount: 2 }).reliable).toBe(false);
    const r = chargebackRate({ disputes: 2, transactions: 400, disputedAmount: 100, transactedAmount: 10000 });
    expect(r.reliable).toBe(true);
    expect(r.countRate).toBeCloseTo(0.005);
  });
});

describe('timeline and instructions', () => {
  it('builds a refund timeline from real records', () => {
    expect(buildRefundTimeline({ refunds: [] }).headline).toMatch(/No refund/);
    const t = buildRefundTimeline({ rmaState: 'refund_pending', rmaCreatedAt: now, refunds: [{ status: 'pending_approval', amount: 100 }] });
    expect(t.steps.at(-1)!.label).toMatch(/awaiting review/);
    expect(buildRefundTimeline({ refunds: [{ status: 'failed', amount: 1 }] }).steps[0]!.status).toBe('problem');
    expect(buildRefundTimeline({ refunds: [{ status: 'succeeded', amount: 1 }] }).headline).toMatch(/sent/);
  });
  it('instructions never mention a label that does not exist', () => {
    const t = buildReturnInstructions({ rmaNumber: 'RMA-1', orderNumber: 'O1', returnMethod: 'ship_back', hasLabel: false });
    expect(t).toMatch(/do not have a prepaid label/);
    expect(buildReturnInstructions({ rmaNumber: 'RMA-1', orderNumber: 'O1', returnMethod: 'staff_decides', hasLabel: false })).toMatch(/do not ship/);
  });
});
