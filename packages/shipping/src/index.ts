import { computeTax } from '@orvia/analytics';
import type { CountryConfig, ShippingMethodConfig } from '@orvia/types';

export interface ShippingOption extends ShippingMethodConfig {
  /** The fee actually charged for this basket (0 if free-shipping threshold met). */
  charge: number;
  free: boolean;
}

export function shippingOptions(cfg: CountryConfig, subtotal: number, freeShippingPromo = false): ShippingOption[] {
  return cfg.shippingMethods.map((m) => {
    const free = freeShippingPromo || (m.freeOver !== null && subtotal >= m.freeOver);
    return { ...m, charge: free ? 0 : m.fee, free };
  });
}

export function pickShipping(cfg: CountryConfig, code: string, subtotal: number, freeShippingPromo = false): ShippingOption {
  const opts = shippingOptions(cfg, subtotal, freeShippingPromo);
  return opts.find((o) => o.code === code) ?? opts[0]!;
}

export interface DeliveryEstimate {
  earliest: string; // ISO date
  latest: string;
  label: string;
}

/**
 * Delivery estimate = supplier processing + transit window from the chosen supplier offer
 * (not a fixed promise), expressed as a date range in the customer's locale.
 */
export function estimateDelivery(minDays: number, maxDays: number, locale = 'en-US', from = new Date(), handlingDays = 1): DeliveryEstimate {
  const add = (d: number) => new Date(from.getTime() + (d + handlingDays) * 86_400_000);
  const fmt = (d: Date) => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(d);
  const e = add(minDays);
  const l = add(maxDays);
  return { earliest: e.toISOString(), latest: l.toISOString(), label: `${fmt(e)} – ${fmt(l)}` };
}

export interface OrderTotals {
  subtotal: number;
  discount: number;
  shipping: number;
  tax: number;
  total: number;
  taxInclusive: boolean;
  taxRate: number;
}

/** Tax on goods after discount (+ shipping). Inclusive markets (IN) never add tax on top. */
export function orderTotals(cfg: CountryConfig, region: string, subtotal: number, discount: number, shipping: number): OrderTotals {
  const taxable = Math.max(0, subtotal - discount) + shipping;
  const { tax, rate } = computeTax(cfg, region, taxable);
  const total = cfg.taxInclusive ? taxable : taxable + tax;
  return { subtotal, discount, shipping, tax, total, taxInclusive: cfg.taxInclusive, taxRate: rate };
}

/** Provider-agnostic tracking status normalisation used for customer-facing copy. */
export const TRACKING_LABELS: Record<string, string> = {
  PENDING_CREATE: 'Preparing order',
  CREATED: 'Order sent to supplier',
  SHIPPED: 'Shipped',
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  FAILED: 'Needs attention',
  RETURNED: 'Returned',
};
export * from './tax';
