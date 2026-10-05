import type { CountryCode } from './enums';

export interface ShippingMethodConfig {
  code: string;
  label: string;
  /** Flat fee in minor units of the country's currency. */
  fee: number;
  /** Order subtotal (minor units) at or above which this method is free. null = never free. */
  freeOver: number | null;
  minDays: number;
  maxDays: number;
}

export interface CountryConfig {
  code: CountryCode;
  name: string;
  currency: 'USD' | 'CAD' | 'INR';
  locale: string;
  enabled: boolean;
  /** Whether displayed prices already include tax (India GST: yes). */
  taxInclusive: boolean;
  /** Default tax rate (fraction) when no region rule matches. */
  defaultTaxRate: number;
  /** Region (state/province) specific tax rates. */
  regionTaxRates: Record<string, number>;
  /** Cross-border import duty estimation. */
  duty: { deMinimis: number; rate: number };
  /** Units of this currency per 1 USD. Overridable in system settings. */
  fxPerUsd: number;
  paymentProviders: string[];
  paymentMethods: string[];
  shippingMethods: ShippingMethodConfig[];
  legalNotice: string;
  returnWindowDays: number;
  supportEmail: string;
}

export const DEFAULT_COUNTRIES: Record<CountryCode, CountryConfig> = {
  US: {
    code: 'US',
    name: 'United States',
    currency: 'USD',
    locale: 'en-US',
    enabled: true,
    taxInclusive: false,
    defaultTaxRate: 0,
    regionTaxRates: { CA: 0.0725, NY: 0.04, TX: 0.0625, FL: 0.06, WA: 0.065 },
    duty: { deMinimis: 80000, rate: 0.1 },
    fxPerUsd: 1,
    paymentProviders: ['stripe'],
    paymentMethods: ['card', 'apple_pay', 'google_pay'],
    shippingMethods: [
      { code: 'standard', label: 'Standard', fee: 499, freeOver: 5000, minDays: 4, maxDays: 8 },
      { code: 'express', label: 'Express', fee: 1299, freeOver: null, minDays: 2, maxDays: 4 },
    ],
    legalNotice:
      'Sales tax is estimated from your shipping state and finalised at checkout. Orders under $800 ship duty-free into the US.',
    returnWindowDays: 30,
    supportEmail: 'help@orvia.example',
  },
  CA: {
    code: 'CA',
    name: 'Canada',
    currency: 'CAD',
    locale: 'en-CA',
    enabled: true,
    taxInclusive: false,
    defaultTaxRate: 0.05,
    regionTaxRates: { ON: 0.13, BC: 0.12, AB: 0.05, QC: 0.14975, NS: 0.15, MB: 0.12, SK: 0.11 },
    duty: { deMinimis: 2000, rate: 0.08 },
    fxPerUsd: 1.37,
    paymentProviders: ['stripe'],
    paymentMethods: ['card', 'apple_pay', 'google_pay'],
    shippingMethods: [
      { code: 'standard', label: 'Standard', fee: 599, freeOver: 6500, minDays: 5, maxDays: 10 },
      { code: 'express', label: 'Express', fee: 1499, freeOver: null, minDays: 2, maxDays: 5 },
    ],
    legalNotice:
      'GST/HST/PST is calculated from your province. Items shipped from outside Canada may incur import charges, shown before you pay when we can estimate them.',
    returnWindowDays: 30,
    supportEmail: 'help@orvia.example',
  },
  IN: {
    code: 'IN',
    name: 'India',
    currency: 'INR',
    locale: 'en-IN',
    enabled: true,
    taxInclusive: true,
    defaultTaxRate: 0.18,
    regionTaxRates: {},
    duty: { deMinimis: 0, rate: 0.2 },
    fxPerUsd: 84,
    paymentProviders: ['razorpay'],
    paymentMethods: ['upi', 'card', 'netbanking', 'wallet', 'cod_disabled'],
    shippingMethods: [
      { code: 'standard', label: 'Standard', fee: 4900, freeOver: 49900, minDays: 3, maxDays: 7 },
      { code: 'express', label: 'Express', fee: 12900, freeOver: null, minDays: 1, maxDays: 3 },
    ],
    legalNotice:
      'Prices include GST. Products shipped from outside India may attract customs duty and IGST, which are shown before payment when applicable.',
    returnWindowDays: 7,
    supportEmail: 'help@orvia.example',
  },
};

export const isCountryCode = (v: unknown): v is CountryCode =>
  v === 'US' || v === 'CA' || v === 'IN';
