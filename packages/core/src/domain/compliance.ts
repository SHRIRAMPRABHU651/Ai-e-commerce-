/**
 * Product Safety / Compliance filter. Deterministic rules are the gate: an LLM may ADD flags but can
 * never clear one. Anything not clearly safe is routed to human review rather than auto-published.
 */
import { findForbiddenClaims } from '@orvia/ai';

export interface ComplianceInput {
  title: string;
  description?: string;
  category?: string;
  topCategory?: string;
  tags?: string[];
  attributes?: Record<string, string>;
  safetyInfo?: { standards?: string[]; ageRange?: string | null } | null;
  /** Generated marketing copy to scan for prohibited claims. */
  marketingText?: string;
}

export interface ComplianceFlag {
  code: string;
  severity: 'fail' | 'review';
  detail: string;
}

export interface ComplianceResult {
  status: 'passed' | 'failed' | 'review';
  flags: ComplianceFlag[];
  score: number; // 0-100, feeds the opportunity score
}

const w = (...words: string[]) => new RegExp(`\\b(?:${words.join('|')})\\b`, 'i');

const RULES: { code: string; re: RegExp; severity: 'fail' | 'review'; detail: string; unless?: RegExp }[] = [
  { code: 'WEAPON', re: w('knife', 'knives', 'dagger', 'sword', 'machete', 'firearm', 'pistol', 'rifle', 'ammo', 'ammunition', 'taser', 'stun gun', 'brass knuckles', 'crossbow', 'switchblade', 'tactical', 'pepper spray', 'nunchaku'), severity: 'fail', detail: 'Weapon-related product', unless: /\b(butter knife|toy)\b/i },
  { code: 'TOY_WEAPON', re: w('toy gun', 'water gun', 'nerf', 'toy sword'), severity: 'review', detail: 'Toy weapon — verify local restrictions' },
  { code: 'COUNTERFEIT', re: w('replica', 'counterfeit', 'knock-?off', 'fake', 'inspired by', 'dupe', '1:1', 'mirror quality', 'designer[- ]inspired'), severity: 'fail', detail: 'Counterfeit / replica indicators' },
  { code: 'ILLEGAL_DRUG', re: w('cocaine', 'heroin', 'marijuana', 'cannabis', 'cbd', 'thc', 'kratom', 'psilocybin', 'lsd', 'meth'), severity: 'fail', detail: 'Illegal or controlled substance' },
  { code: 'TOBACCO_VAPE', re: w('vape', 'vaping', 'e-?cigarette', 'nicotine', 'tobacco', 'cigar', 'hookah', 'alcohol', 'liquor', 'wine'), severity: 'fail', detail: 'Age-restricted / regulated product' },
  { code: 'ADULT', re: w('sex toy', 'adult toy', 'erotic', 'porn', 'fetish', 'vibrator', 'xxx'), severity: 'fail', detail: 'Adult product (unsupported)' },
  { code: 'DANGEROUS', re: w('explosive', 'fireworks?', 'firecrackers?', 'flammable', 'asbestos', 'mercury', 'pesticide', 'radioactive', 'poison', 'acid'), severity: 'fail', detail: 'Dangerous / hazardous goods' },
  { code: 'MEDICAL_CLAIM', re: w('cures?', 'heals?', 'treats? (?:disease|diabetes|cancer|anxiety|depression|obesity)', 'diabetes', 'cancer', 'obesity', 'clinically proven', 'fda[- ]approved', 'covid', 'weight loss', 'slimming', 'detox', 'anti-?aging'), severity: 'fail', detail: 'Unsubstantiated medical / health claim' },
  { code: 'REGULATED', re: w('prescription', 'medication', 'medicine', 'supplements?', 'vitamins?', 'steroids?', 'hormones?', 'pharmaceutical', 'contact lenses'), severity: 'fail', detail: 'Regulated health product' },
  { code: 'BRAND_IP', re: w('louis vuitton', 'louis-style', 'gucci', 'chanel', 'prada', 'rolex', 'hermes', 'burberry', 'supreme', 'nike', 'adidas', 'disney', 'marvel', 'pokemon', 'lego', 'barbie', 'hello kitty', 'nintendo', 'playstation'), severity: 'review', detail: 'Possible trademark / copyright use — verify authorisation' },
];

const KIDS_RE = /\b(kid|kids|child|children|baby|babies|infant|toddler|teether|teething|nursery|newborn)\b/i;
const SMALL_PARTS_RE = /\b(beads?|button cell|magnets?|marbles?|small parts)\b/i;
const ELECTRICAL_RE = /\b(charger|adapter|adaptor|battery|rechargeable|usb|power bank|lamp|projector|led|bluetooth|tracker|wireless|electric)\b/i;
const ELECTRICAL_CERT_RE = /\b(ce|fcc|ul|etl|rohs|bis|csa)\b/i;

export function checkCompliance(i: ComplianceInput): ComplianceResult {
  const text = [i.title, i.description, i.category, ...(i.tags ?? []), ...Object.values(i.attributes ?? {}), i.marketingText].filter(Boolean).join(' ');
  const flags: ComplianceFlag[] = [];
  for (const r of RULES) {
    if (r.re.test(text) && !(r.unless && r.unless.test(text))) flags.push({ code: r.code, severity: r.severity, detail: r.detail });
  }
  if (i.marketingText) {
    for (const c of findForbiddenClaims(i.marketingText)) flags.push({ code: 'PROHIBITED_CLAIM', severity: 'fail', detail: `Prohibited claim pattern: ${c}` });
  }
  const standards = i.safetyInfo?.standards ?? [];
  const isKids = i.topCategory === 'kids' || i.topCategory === 'Kids' || KIDS_RE.test(`${i.title} ${i.category ?? ''} ${(i.tags ?? []).join(' ')}`);
  if (isKids) {
    if (!standards.length) flags.push({ code: 'KIDS_SAFETY_INFO_MISSING', severity: 'review', detail: 'Children’s product requires supplier safety standard information before publication' });
    if (/\b(baby|infant|teething|newborn|teether)\b/i.test(text) && !standards.length) flags.push({ code: 'INFANT_PRODUCT', severity: 'review', detail: 'Infant product without safety documentation' });
    if (SMALL_PARTS_RE.test(text) && !i.safetyInfo?.ageRange) flags.push({ code: 'SMALL_PARTS', severity: 'review', detail: 'Possible small parts / choking hazard — age grading required' });
  }
  if (ELECTRICAL_RE.test(`${i.title} ${i.description ?? ''}`) && !standards.some((s) => ELECTRICAL_CERT_RE.test(s)) && !/\b(usb-c|usb cable|magnetic)\b/i.test(i.title) ) {
    flags.push({ code: 'ELECTRICAL_CERT_MISSING', severity: 'review', detail: 'Electrical product without a recognised safety certification (CE/FCC/UL/…)' });
  }
  const unique = [...new Map(flags.map((f) => [f.code, f])).values()];
  const hasFail = unique.some((f) => f.severity === 'fail');
  const hasReview = unique.some((f) => f.severity === 'review');
  const score = Math.max(0, 100 - unique.reduce((a, f) => a + (f.severity === 'fail' ? 60 : 25), 0));
  return { status: hasFail ? 'failed' : hasReview ? 'review' : 'passed', flags: unique, score };
}
