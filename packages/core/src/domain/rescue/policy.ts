/**
 * Delivery Rescue authorization policy. Pure.
 * Decides who must say yes before an option runs. Money limits are USD-equivalent minor units; the caller converts.
 * An LLM is never an input and never an approver.
 */
import { DEFAULT_RESCUE_POLICY, RESCUE_AUTO_CAPABLE, rescuePolicySchema } from '@orvia/types';
import type { RescuePolicy } from '@orvia/types';
import type { RescueOption } from './options';

export type AuthMode = 'auto' | 'customer_consent' | 'staff_approval' | 'blocked';

export interface AuthDecision {
  mode: AuthMode;
  requiresCustomerConsent: boolean;
  requiresStaffApproval: boolean;
  /** True when the action could run with no human at all. */
  autoEligible: boolean;
  reasons: string[];
}

export interface UsageToday {
  autoCostUsd: number;
  autoActions: number;
}

export interface AuthInput {
  option: RescueOption;
  policy: RescuePolicy;
  usage: UsageToday;
  /** option.impact.exposure converted to USD minor units. */
  exposureUsd: number;
  /** Original landed cost (order currency) for the cost-tolerance check; 0 = unknown. */
  originalCost: number;
}

/** Merge stored (possibly partial / hand-edited) policy over the safe defaults and validate; invalid input falls back to defaults. */
export function resolvePolicy(stored: unknown): RescuePolicy {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<RescuePolicy>;
  const merged = { ...DEFAULT_RESCUE_POLICY, ...s, detection: { ...DEFAULT_RESCUE_POLICY.detection, ...(s.detection ?? {}) } };
  const parsed = rescuePolicySchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_RESCUE_POLICY;
}

/** Only these kinds can ever be auto-executed, whatever the stored policy says. */
export const autoCapable = (policy: RescuePolicy, kind: string): boolean =>
  (RESCUE_AUTO_CAPABLE as readonly string[]).includes(kind) && (policy.autoActions as readonly string[]).includes(kind);

export function authorize(a: AuthInput): AuthDecision {
  const { option: o, policy: p } = a;
  const reasons: string[] = [];
  if (o.kind === 'escalate_human') return { mode: 'staff_approval', requiresCustomerConsent: false, requiresStaffApproval: true, autoEligible: false, reasons: ['Handled by a person by definition.'] };
  if (!o.feasible) return { mode: 'blocked', requiresCustomerConsent: false, requiresStaffApproval: false, autoEligible: false, reasons: [o.infeasibleReason ?? 'Option is not feasible'] };

  let staff = false;
  const consent = o.requiresCustomerConsent;
  if (consent) reasons.push(...(o.materialReasons.length ? o.materialReasons.map((r) => `Customer must agree: ${r}`) : ['Customer must agree: material change.']));

  if (a.exposureUsd > p.maxCostPerCaseUsd) {
    staff = true;
    reasons.push(`Cost exposure exceeds the per-case limit.`);
  }
  if (a.usage.autoCostUsd + a.exposureUsd > p.maxCostPerDayUsd) {
    staff = true;
    reasons.push('Daily recovery budget would be exceeded.');
  }
  if (o.needsDuplicateAck) {
    staff = true;
    reasons.push('The original parcel may still arrive: staff must acknowledge the duplicate-order risk.');
  }
  if (o.kind === 'offer_full_refund' || o.kind === 'offer_partial_refund') {
    // Money to the customer: the refund function enforces its own limits; here we only require a human when no consent exists to rely on.
    if (!consent) {
      staff = true;
      reasons.push('Refund without a customer choice requires staff approval.');
    }
  }

  // Auto path: only no-material-change, auto-capable, in-policy actions.
  let autoEligible = false;
  if (!consent && !staff) {
    if (!autoCapable(p, o.kind)) {
      reasons.push(`"${o.kind}" is not enabled for automatic execution.`);
    } else if (o.kind === 'continue_shipment') {
      autoEligible = true;
      reasons.push('No-op monitoring: no money moves and nothing changes for the customer.');
    } else if (o.kind === 'reorder_same_product_alt_supplier') {
      const preApproved = !!o.supplier && p.preApprovedSupplierIds.includes(o.supplier.id);
      const within = a.originalCost > 0 ? o.plannedLandedCost <= a.originalCost * (1 + p.costTolerancePct) : false;
      if (!p.autoExecuteEnabled) reasons.push('Automatic execution is switched off in the policy.');
      else if (!preApproved) reasons.push('The alternative supplier is not pre-approved for automatic reorders.');
      else if (!within) reasons.push(a.originalCost > 0 ? `Landed cost is above the original plus ${Math.round(p.costTolerancePct * 100)}% tolerance.` : 'Original cost unknown: cannot verify the cost tolerance.');
      else if (a.usage.autoActions >= p.maxAutoActionsPerDay) reasons.push('Daily automatic-action cap reached.');
      else {
        autoEligible = true;
        reasons.push('Same product, pre-approved supplier, within cost tolerance and ETA threshold.');
      }
    }
  }
  const mode: AuthMode = consent ? 'customer_consent' : autoEligible ? 'auto' : 'staff_approval';
  return { mode, requiresCustomerConsent: consent, requiresStaffApproval: staff || (!consent && !autoEligible), autoEligible, reasons: [...new Set(reasons)] };
}

/** Has everything required for this option been satisfied? */
export function readyToExecute(d: AuthDecision, s: { consentAccepted: boolean; staffApproved: boolean }): { ready: boolean; missing: ('customer_consent' | 'staff_approval')[] } {
  const missing: ('customer_consent' | 'staff_approval')[] = [];
  if (d.mode === 'blocked') return { ready: false, missing };
  if (d.requiresCustomerConsent && !s.consentAccepted) missing.push('customer_consent');
  if (d.requiresStaffApproval && !s.staffApproved) missing.push('staff_approval');
  return { ready: missing.length === 0 && (d.autoEligible || d.requiresCustomerConsent || d.requiresStaffApproval), missing };
}
