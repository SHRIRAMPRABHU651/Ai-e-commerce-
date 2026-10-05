/**
 * Deterministic, no-LLM provider. Builds content strictly from source product data, so it can
 * never invent specifications. Used when GEMINI_API_KEY is absent or Gemini fails/validation fails.
 * Everything it produces is labelled source:"template" by the AIService.
 */
import type { ZodType, ZodTypeDef } from 'zod';
import { AIUnavailableError } from './provider';
import type { AIProvider } from './provider';
import type { AdCreative, ProductContent, ProductSource, ReviewAnalysis } from './schemas';

const sentence = (s: string) => s.trim().replace(/\s+/g, ' ');
const firstSentences = (s: string, n: number) => sentence(s).split(/(?<=[.!?])\s+/).slice(0, n).join(' ');
const cap = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');

const POS = ['love', 'great', 'excellent', 'perfect', 'happy', 'amazing', 'good', 'works', 'recommend', 'sturdy', 'quality', 'fast'];
const NEG = ['broke', 'broken', 'bad', 'poor', 'terrible', 'late', 'slow', 'never arrived', 'damaged', 'cheap', 'disappointed', 'refund', 'smell', 'wrong', 'fake', 'returned'];
const SHIP = ['late', 'slow', 'never arrived', 'shipping', 'delivery', 'delayed', 'tracking', 'lost'];
const SUPPLIER = ['wrong item', 'wrong size', 'not as described', 'different', 'missing', 'fake'];

export class TemplateAIProvider implements AIProvider {
  readonly name = 'template';

  async generateText(): Promise<string> {
    throw new AIUnavailableError('Free-form generation requires a configured LLM (GEMINI_API_KEY)');
  }
  async generateStructuredOutput<T>(_p: string, _s: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
    throw new AIUnavailableError('Structured generation requires a configured LLM (GEMINI_API_KEY)');
  }

  async classify(text: string, labels: string[]) {
    const lower = text.toLowerCase();
    const hit = labels.find((l) => lower.includes(l.toLowerCase()));
    return { label: hit ?? labels[labels.length - 1]!, confidence: hit ? 0.5 : 0.2, reason: 'keyword match (template provider)' };
  }

  async analyzeProduct(src: ProductSource) {
    const flags: string[] = [];
    if (/kid|child|baby|toddler/i.test(`${src.category} ${src.title} ${src.tags.join(' ')}`) && !src.safetyStandards.length) {
      flags.push('Children’s product without safety standard information');
    }
    return {
      summary: cap(firstSentences(src.description || src.title, 2), 600),
      targetAudience: src.category ? `Shoppers browsing ${src.category}` : 'General shoppers',
      riskFlags: flags,
      videoPotential: /(roller|brush|mat|toy|kit|projector|lamp|organizer|clips|bottle)/i.test(src.title) ? 70 : 50,
      repeatPurchasePotential: /(treat|clay|refill|set|pack)/i.test(src.title) ? 60 : 40,
      confidence: 0.35,
    };
  }

  async generateProductDescription(src: ProductSource): Promise<ProductContent> {
    const attrs = Object.entries(src.attributes).filter(([, v]) => v);
    const attrLines = attrs.map(([k, v]) => `${k}: ${v}`);
    const base = sentence(src.description) || src.title;
    const sentences = base.split(/(?<=[.!?])\s+/).filter(Boolean);
    const bullets = [...sentences.slice(0, 3), ...attrLines.slice(0, 3)].slice(0, 6);
    while (bullets.length < 3) bullets.push(src.title);
    const features = attrLines.length >= 2 ? attrLines.slice(0, 6) : [...attrLines, ...sentences.slice(0, 2)].slice(0, 3);
    while (features.length < 2) features.push(src.title);
    const benefits = sentences.slice(0, 3);
    while (benefits.length < 2) benefits.push(`Designed for ${src.category || 'everyday use'}.`);
    const kw = [...new Set([src.title.toLowerCase(), ...src.tags, src.category.toLowerCase()].filter(Boolean))].slice(0, 12);
    while (kw.length < 3) kw.push('online store');
    const safetyLine = src.safetyStandards.length ? ` Listed standards: ${src.safetyStandards.join(', ')}${src.ageRange ? ` (age ${src.ageRange})` : ''}.` : '';
    const faqs = [
      { q: `What is the ${src.title}?`, a: cap(firstSentences(base, 2), 480) },
      { q: 'How long does delivery take?', a: 'Delivery time depends on your country and the fulfilling warehouse; the estimate is shown on the product page and at checkout.' },
      { q: 'Can I return it?', a: 'Yes. Returns are accepted within the return window shown on the product page.' },
    ];
    return {
      seoTitle: cap(`${src.title} | Orvia`, 70),
      metaDescription: cap(`${firstSentences(base, 1)} Shop ${src.title} with tracked delivery and easy returns.`, 165),
      description: cap(`${base}${safetyLine}`, 2400),
      bullets: bullets.map((b) => cap(b, 190)),
      features: features.map((b) => cap(b, 190)),
      benefits: benefits.map((b) => cap(b, 190)),
      faqs,
      keywords: kw,
      social: {
        instagram: cap(`${src.title} — ${firstSentences(base, 1)} #${(src.category || 'shop').replace(/[^a-z0-9]/gi, '').toLowerCase()}`, 2000),
        tiktokScript: cap(`Hook: Meet the ${src.title}. Show it in use for 5 seconds. Point out: ${bullets.slice(0, 2).join('; ')}. End card: link in bio.`, 1900),
        facebookAd: cap(`${src.title}: ${firstSentences(base, 1)}`, 900),
      },
      adCopy: {
        primaryText: cap(`${firstSentences(base, 1)} Tracked delivery and easy returns.`, 480),
        headline: cap(src.title, 75),
        description: cap(src.category ? `Shop ${src.category}` : 'Shop now', 190),
        cta: 'Shop now',
      },
    };
  }

  async generateAdCopy(src: ProductSource, concepts?: string[]): Promise<AdCreative[]> {
    const base = firstSentences(src.description || src.title, 1);
    const all: AdCreative[] = [
      { concept: 'problem_hook', hook: `Still dealing with the problem the ${src.title} is made for?`, primaryText: `${base} Tracked delivery, easy returns.`, headline: cap(src.title, 75), description: 'See how it works', cta: 'Shop now', videoScript: `0-3s: show the everyday problem. 3-10s: introduce the ${src.title}. 10-15s: show it working. CTA.` },
      { concept: 'emotional_hook', hook: `A small upgrade you’ll notice every day.`, primaryText: `${base}`, headline: cap(`Meet the ${src.title}`, 75), description: 'Made for everyday life', cta: 'Learn more', videoScript: `Warm lifestyle footage using the ${src.title}. Voiceover: one sentence from the product description. CTA.` },
      { concept: 'demonstration', hook: `Watch the ${src.title} in action.`, primaryText: `${base}`, headline: cap(`${src.title} — in action`, 75), description: 'See it in use', cta: 'Shop now', videoScript: `Single-take demo of the ${src.title} being used as described. On-screen captions for each listed feature.` },
      { concept: 'ugc', hook: `I tried the ${src.title} so you don’t have to guess.`, primaryText: `${base}`, headline: cap(`${src.title}: first impressions`, 75), description: 'Honest first look', cta: 'Shop now', videoScript: `Creator-style selfie video: unbox, show features from the listing, give a genuine first impression. No scripted claims beyond the listing.` },
      { concept: 'before_after', hook: `Before and after with the ${src.title}.`, primaryText: `${base}`, headline: cap(`Before / after: ${src.title}`, 75), description: 'See the difference', cta: 'Shop now', videoScript: `Split-screen of the task without and with the ${src.title}. Only show results the product actually delivers.` },
    ];
    return concepts ? all.filter((c) => concepts.includes(c.concept)) : all;
  }

  async analyzeReviews(reviews: { rating: number; text: string }[]): Promise<ReviewAnalysis> {
    const n = reviews.length;
    if (!n) return { positivePct: 0, neutralPct: 0, negativePct: 0, praise: [], complaints: [], quality: 'unknown', shippingComplaints: 0, supplierProblems: 0, confidence: 0 };
    let pos = 0, neg = 0, ship = 0, sup = 0;
    const praise = new Map<string, number>();
    const complaints = new Map<string, number>();
    for (const r of reviews) {
      const t = r.text.toLowerCase();
      const negHit = NEG.filter((w) => t.includes(w));
      const posHit = POS.filter((w) => t.includes(w));
      if (r.rating >= 4 && negHit.length <= posHit.length) pos++;
      else if (r.rating <= 2 || negHit.length > posHit.length) neg++;
      if (SHIP.some((w) => t.includes(w)) && (r.rating <= 3 || negHit.length)) ship++;
      if (SUPPLIER.some((w) => t.includes(w))) sup++;
      posHit.forEach((w) => praise.set(w, (praise.get(w) ?? 0) + 1));
      negHit.forEach((w) => complaints.set(w, (complaints.get(w) ?? 0) + 1));
    }
    const neutral = n - pos - neg;
    const avg = reviews.reduce((a, r) => a + r.rating, 0) / n;
    const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
    return {
      positivePct: Math.round((pos / n) * 100),
      neutralPct: Math.round((neutral / n) * 100),
      negativePct: Math.round((neg / n) * 100),
      praise: top(praise),
      complaints: top(complaints),
      quality: avg >= 4.2 ? 'good' : avg >= 3.3 ? 'mixed' : 'poor',
      shippingComplaints: ship,
      supplierProblems: sup,
      confidence: Math.min(0.7, n / 40),
    };
  }

  async analyzeBusiness(): Promise<never> {
    throw new AIUnavailableError('Narrative analysis requires a configured LLM; deterministic numbers are shown instead');
  }

  async recommendProducts(ctx: { candidates: { id: string; title: string; category: string }[]; viewed: string[]; limit: number }) {
    const viewedCats = new Set(ctx.candidates.filter((c) => ctx.viewed.includes(c.id)).map((c) => c.category));
    const ids = ctx.candidates
      .filter((c) => !ctx.viewed.includes(c.id))
      .sort((a, b) => Number(viewedCats.has(b.category)) - Number(viewedCats.has(a.category)))
      .slice(0, ctx.limit)
      .map((c) => c.id);
    return { productIds: ids, reason: 'Same-category rule (template provider)' };
  }
}
