/**
 * Deterministic response grounding check (pure). A customer-facing reply may not state prices, availability, delivery
 * promises, certifications, warranty terms or policy facts that are absent from the tool outputs of the same run.
 * It is intentionally strict: a false rejection falls back to a templated answer built from the tool outputs, which is
 * always acceptable; a false acceptance would be a fabricated claim.
 */
import { findEnvironmentalClaims } from '@orvia/ai';
import type { GroundingResult } from './framework';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

interface Facts {
  text: string;
  numbers: Set<number>;
  /** Numbers that appear under day/ETA/window/delivery keys or in sentences about days: the only valid basis for delivery and policy-day claims. */
  dayNumbers: Set<number>;
  /** Numbers that appear under stock/quantity keys. */
  stockNumbers: Set<number>;
  dates: Set<string>; // YYYY-MM-DD
  positiveStock: boolean;
  negativeStock: boolean;
}

function collect(value: unknown, f: Facts, key = '', depth = 0): void {
  if (depth > 10 || value === null || value === undefined) return;
  if (typeof value === 'number') {
    f.numbers.add(value);
    if (/days|eta|window|delivery|lead|transit|ship|week/i.test(key)) f.dayNumbers.add(value);
    if (/stock|quantity|left|available|units/i.test(key)) f.stockNumbers.add(value);
    if (/^(instock|in_stock|stock|available|quantity_available)$/i.test(key)) { if (value > 0) f.positiveStock = true; else f.negativeStock = true; }
    return;
  }
  if (typeof value === 'boolean') {
    if (/^(instock|in_stock|available|isavailable)$/i.test(key)) { if (value) f.positiveStock = true; else f.negativeStock = true; }
    return;
  }
  if (typeof value === 'string') {
    f.text += ` ${value.toLowerCase()}`;
    for (const m of value.matchAll(/\d{4}-\d{2}-\d{2}/g)) f.dates.add(m[0]);
    for (const m of value.matchAll(/\d+(?:\.\d+)?/g)) f.numbers.add(Number(m[0]));
    if (/\b(days?|weeks?)\b/i.test(value)) for (const m of value.matchAll(/\d+/g)) f.dayNumbers.add(Number(m[0]));
    if (/(^|[^a-z])(in stock|available)($|[^a-z])/i.test(value) && /^(availability|stocklabel|stockstatus)$/i.test(key)) f.positiveStock = true;
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collect(v, f, key, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      f.text += ` ${k.toLowerCase()}`;
      collect(v, f, k, depth + 1);
    }
  }
}

export function buildFacts(toolOutputs: unknown[]): Facts {
  const f: Facts = { text: '', numbers: new Set(), dayNumbers: new Set(), stockNumbers: new Set(), dates: new Set(), positiveStock: false, negativeStock: false };
  for (const o of toolOutputs) collect(o, f);
  return f;
}

const has = (f: Facts, n: number) => f.numbers.has(n);
const hasMoney = (f: Facts, v: number) => has(f, v) || has(f, Math.round(v * 100)) || has(f, Math.round(v * 100) / 100);

const MONEY_RES = [
  /(?:US\$|CA\$|C\$|A\$|\$|₹|Rs\.?\s?|INR\s?|USD\s?|CAD\s?)\s?(\d[\d,]*(?:\.\d{1,2})?)/gi,
  /(\d[\d,]*(?:\.\d{1,2})?)\s?(?:USD|CAD|INR|dollars|rupees)\b/gi,
];

const CERT_TERMS: { label: string; re: RegExp }[] = [
  { label: 'CE', re: /\bCE\s*(?:mark(?:ed|ing)?|certified|compliant)\b/gi },
  { label: 'UL', re: /\bUL[- ]?(?:listed|certified|\d{3,4})\b/gi },
  { label: 'FCC', re: /\bFCC\b/g },
  { label: 'RoHS', re: /\bRoHS\b/gi },
  { label: 'REACH', re: /\bREACH\b/g },
  { label: 'ISO', re: /\bISO[- ]?\d{3,6}\b/gi },
  { label: 'FDA', re: /\bFDA\b/g },
  { label: 'CPSC', re: /\bCPSC\b/g },
  { label: 'ASTM', re: /\bASTM\s?[A-Z]?\d+\b/gi },
  { label: 'EN standard', re: /\bEN[- ]?\d{3,6}\b/g },
  { label: 'OEKO-TEX', re: /\bOEKO[- ]?TEX\b/gi },
  { label: 'GOTS', re: /\bGOTS\b/g },
  { label: 'BIS', re: /\bBIS[- ](?:certified|registered|marked)\b/gi },
  { label: 'ETL', re: /\bETL[- ](?:listed|certified)\b/gi },
  { label: 'Energy Star', re: /\bEnergy[- ]Star\b/gi },
  { label: 'IP rating', re: /\bIP\s?[0-9]{2}\b/g },
  { label: 'hypoallergenic', re: /\bhypo-?allergenic\b/gi },
  { label: 'food safe', re: /\bfood[- ]?(?:safe|grade)\b/gi },
  { label: 'waterproof', re: /\bwater[- ]?proof\b/gi },
  { label: 'child safe', re: /\b(?:child|kid|baby)[- ]?safe\b|\bsafe for (?:children|kids|babies|toddlers)\b/gi },
  { label: 'tested/certified', re: /\b(?:lab[- ]tested|independently tested|safety[- ]tested|third[- ]party (?:tested|certified)|certified)\b/gi },
];

const POLICY_PHRASES = ['free returns', 'free return', 'free shipping', 'full refund', 'money-back guarantee', 'money back guarantee', 'lifetime warranty', 'no questions asked', 'price match', 'guaranteed delivery', 'guaranteed to arrive'];

export function checkGrounding(reply: string, toolOutputs: unknown[]): GroundingResult {
  const f = buildFacts(toolOutputs);
  const text = reply.normalize('NFKC');
  const lower = text.toLowerCase().replace(/[‐‑–—]/g, '-');
  const factsText = f.text.replace(/[‐‑–—]/g, '-');
  const violations: string[] = [];
  const add = (v: string) => { if (!violations.includes(v)) violations.push(v); };

  // 1. prices
  for (const re of MONEY_RES) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const v = Number((m[1] ?? '').replace(/,/g, ''));
      if (Number.isFinite(v) && !hasMoney(f, v)) add(`ungrounded price: ${m[0].trim()}`);
    }
  }

  // 2. delivery promises
  for (const m of lower.matchAll(/(\d{1,3})\s*(?:-|to)\s*(\d{1,3})\s*(?:business\s+|working\s+)?(days?|weeks?)\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!f.dayNumbers.has(a) || !f.dayNumbers.has(b)) add(`ungrounded delivery window: ${m[0]}`);
  }
  for (const m of lower.matchAll(/\b(?:within|in|by|after)\s+(\d{1,3})\s*(?:business\s+|working\s+)?(days?|weeks?)\b/g)) {
    if (!f.dayNumbers.has(Number(m[1]))) add(`ungrounded delivery time: ${m[0]}`);
  }
  for (const m of text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
    if (!f.dates.has(m[1] ?? '')) add(`ungrounded date: ${m[1]}`);
  }
  for (const m of lower.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/g)) {
    const day = Number(m[1] ?? m[4]);
    const mon = MONTHS.indexOf(m[2] ?? m[3] ?? '') + 1;
    const ok = [...f.dates].some((d) => Number(d.slice(5, 7)) === mon && Number(d.slice(8, 10)) === day);
    if (!ok) add(`ungrounded date: ${m[0]}`);
  }
  for (const w of ['tomorrow', 'next-day', 'next day', 'overnight', 'same-day', 'same day', 'guaranteed delivery', 'guaranteed to arrive']) {
    if (lower.includes(w) && !factsText.includes(w)) add(`ungrounded delivery claim: ${w}`);
  }

  // 3. availability
  if (/\b(?:in stock|available now|ready to ship|ships today|currently available)\b/.test(lower) && !f.positiveStock) add('ungrounded availability: in stock');
  if (/\b(?:out of stock|sold out|unavailable|backorder(?:ed)?|currently unavailable)\b/.test(lower) && !f.negativeStock) add('ungrounded availability: out of stock');
  for (const m of lower.matchAll(/\bonly\s+(\d{1,4})\s+(?:units?\s+)?(?:left|remaining|in stock)\b/g)) if (!f.stockNumbers.has(Number(m[1]))) add(`ungrounded stock level: ${m[0]}`);

  // 4. certifications / safety / warranty
  for (const c of CERT_TERMS) {
    for (const m of text.matchAll(new RegExp(c.re.source, c.re.flags))) {
      const needle = m[0].toLowerCase().replace(/[‐‑–—]/g, '-');
      const generic = c.label === 'tested/certified' ? /certif|tested|verified/.test(factsText) : factsText.includes(needle) || factsText.includes(c.label.toLowerCase());
      if (!generic) add(`ungrounded certification/claim: ${m[0]}`);
    }
  }
  for (const e of findEnvironmentalClaims(text)) if (!factsText.includes(e.match.toLowerCase())) add(`ungrounded claim: ${e.match}`);
  for (const m of lower.matchAll(/(\d{1,2})[- ]?(year|month|yr)s?\s+(?:limited\s+)?warranty|warranty\s+(?:of|for)\s+(\d{1,2})\s*(year|month|yr)s?/g)) {
    const n = Number(m[1] ?? m[3]);
    if (!has(f, n) || !factsText.includes('warranty')) add(`ungrounded warranty: ${m[0]}`);
  }

  // 5. policy facts
  for (const m of lower.matchAll(/(\d{1,3})[- ]days?\s+(?:return|refund|money|window|policy|guarantee|trial)/g)) if (!f.dayNumbers.has(Number(m[1]))) add(`ungrounded policy: ${m[0]}`);
  for (const p of POLICY_PHRASES) if (lower.includes(p) && !factsText.includes(p)) add(`ungrounded policy claim: ${p}`);

  return { ok: violations.length === 0, violations };
}
