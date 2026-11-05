/** Pure after-sales policy definitions (no IO). Overridable per deployment via the `aftersales_config` collection. */
import type { CountryCode } from '@orvia/types';

export type ShippingRefundRule = 'fault_only' | 'full_return' | 'always';

export interface AftersalesPolicy {
  /** Product `topCategory`/`category` slugs that are not returnable for customer-fault reasons. Empty by default: ops decides. */
  excludedCategories: string[];
  /** When the original shipping charge is refunded. Business defaults, not legal advice. */
  shippingRefund: Record<CountryCode, ShippingRefundRule>;
  /** Restocking fee in basis points of the returned goods value, customer-fault reasons only. 0 = none. */
  restockingFeeBps: number;
  /** Flat return-shipping cost deducted for customer-fault returns when no prepaid label exists (minor units). */
  returnShippingDeduction: Record<CountryCode, number>;
  /** Max days a supplier claim may be opened after delivery when the supplier gave no explicit window. */
  defaultClaimWindowDays: number;
}

export const DEFAULT_POLICY: AftersalesPolicy = {
  excludedCategories: [],
  shippingRefund: { US: 'fault_only', CA: 'fault_only', IN: 'fault_only' },
  restockingFeeBps: 0,
  returnShippingDeduction: { US: 0, CA: 0, IN: 0 },
  defaultClaimWindowDays: 30,
};

export function mergePolicy(override: Partial<AftersalesPolicy> | null | undefined): AftersalesPolicy {
  const o = override ?? {};
  return {
    excludedCategories: Array.isArray(o.excludedCategories) ? o.excludedCategories.map((s) => String(s).toLowerCase()) : DEFAULT_POLICY.excludedCategories,
    shippingRefund: { ...DEFAULT_POLICY.shippingRefund, ...(o.shippingRefund ?? {}) },
    restockingFeeBps: Number.isInteger(o.restockingFeeBps) && (o.restockingFeeBps as number) >= 0 && (o.restockingFeeBps as number) <= 5000 ? (o.restockingFeeBps as number) : DEFAULT_POLICY.restockingFeeBps,
    returnShippingDeduction: { ...DEFAULT_POLICY.returnShippingDeduction, ...(o.returnShippingDeduction ?? {}) },
    defaultClaimWindowDays: Number.isInteger(o.defaultClaimWindowDays) && (o.defaultClaimWindowDays as number) > 0 ? (o.defaultClaimWindowDays as number) : DEFAULT_POLICY.defaultClaimWindowDays,
  };
}

/** What we know about a supplier's willingness to take goods back. `unknown` is the honest default. */
export interface SupplierReturnPolicy {
  supportsReturns: 'yes' | 'no' | 'unknown';
  supportsReplacement: boolean;
  supportsExchange: boolean;
  returnWindowDays?: number;
  defectOnly: boolean;
}

export const UNKNOWN_SUPPLIER_POLICY: SupplierReturnPolicy = { supportsReturns: 'unknown', supportsReplacement: false, supportsExchange: false, defectOnly: false };
