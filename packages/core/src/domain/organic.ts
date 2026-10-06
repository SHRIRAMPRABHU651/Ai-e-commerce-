import { CLAIM_PATTERNS, findEnvironmentalClaims, stripEnvironmentalClaims } from '@orvia/ai';
import type { ClaimKind } from '@orvia/ai';
import { Product } from '@orvia/database';
import { audit } from '../infra/audit';
import { DomainError, notFound } from '../infra/context';
import type { Actor, Ctx } from '../infra/context';

export { findEnvironmentalClaims, stripEnvironmentalClaims, CLAIM_PATTERNS };
export type { ClaimKind };

export interface ClaimEvidence {
  claim: ClaimKind;
  type: 'certification' | 'test_report' | 'supplier_statement';
  body?: string; // certification body, e.g. USDA, COSMOS, GOTS, OEKO-TEX, Ecocert
  certId?: string;
  certUrl?: string;
  sourceUrl?: string;
  observedAt?: Date | string;
  jurisdiction?: string[]; // US | CA | IN | EU | GLOBAL
  expiresAt?: Date | string | null;
  verified?: boolean;
  verifiedBy?: string;
  verifiedAt?: Date | string;
  note?: string;
}

/** Evidence is strong enough only when a human verified it AND it names a real certificate/report and a source. */
export function evidenceValid(e: ClaimEvidence, country?: string, now = new Date()): boolean {
  if (!e.verified) return false;
  if (e.expiresAt && new Date(e.expiresAt) < now) return false;
  if (e.type === 'certification' && !(e.body && (e.certId || e.certUrl))) return false;
  if (e.type !== 'certification' && !(e.certUrl || e.sourceUrl)) return false;
  if (country && e.jurisdiction?.length && !e.jurisdiction.includes(country) && !e.jurisdiction.includes('GLOBAL')) return false;
  return true;
}

/** Claim kinds the product may make in a country, given its stored evidence. */
export function allowedClaims(evidence: ClaimEvidence[] | undefined, country?: string, now = new Date()): ClaimKind[] {
  return [...new Set((evidence ?? []).filter((e) => evidenceValid(e, country, now)).map((e) => e.claim))];
}

export interface ClaimViolation { kind: ClaimKind; match: string; field: string }

/** Every customer-facing text field of a product, scanned for claims that are not backed by evidence for all markets it sells in. */
export function claimViolations(p: { title?: string; description?: string; bullets?: string[]; features?: string[]; benefits?: string[]; seo?: { title?: string | null; metaDescription?: string | null } | null; faqs?: { q?: string | null; a?: string | null }[]; social?: { instagram?: string | null; facebookAd?: string | null } | null; organic?: { evidence?: ClaimEvidence[] } | null; markets?: { country: string; enabled?: boolean }[] }): ClaimViolation[] {
  const countries = (p.markets ?? []).filter((m) => m.enabled !== false).map((m) => m.country);
  // a claim is allowed only if it is evidenced in EVERY market the product is sold in
  const allowed = new Set<ClaimKind>(countries.length ? (['organic', 'non_toxic', 'eco', 'biodegradable', 'plant_based'] as ClaimKind[]).filter((k) => countries.every((c) => allowedClaims(p.organic?.evidence, c).includes(k))) : allowedClaims(p.organic?.evidence));
  const fields: [string, string][] = [['title', p.title ?? ''], ['description', p.description ?? ''], ['bullets', (p.bullets ?? []).join(' | ')], ['features', (p.features ?? []).join(' | ')], ['benefits', (p.benefits ?? []).join(' | ')], ['seo', `${p.seo?.title ?? ''} ${p.seo?.metaDescription ?? ''}`], ['faqs', (p.faqs ?? []).map((f) => `${f.q ?? ''} ${f.a ?? ''}`).join(' | ')], ['social', `${p.social?.instagram ?? ''} ${p.social?.facebookAd ?? ''}`]];
  const out: ClaimViolation[] = [];
  for (const [field, text] of fields) for (const c of findEnvironmentalClaims(text)) if (!allowed.has(c.kind)) out.push({ kind: c.kind, match: c.match, field });
  return out;
}

/** Sanitise generated/supplier copy so it never asserts an unverified claim (no evidence ⇒ the claim words are removed). */
export function sanitizeCopy(text: string, evidence?: ClaimEvidence[]): { text: string; removed: string[] } {
  return stripEnvironmentalClaims(text, allowedClaims(evidence));
}

export async function addClaimEvidence(ctx: Ctx, productId: string, ev: ClaimEvidence, actor: Actor): Promise<void> {
  const p = await Product.findById(productId);
  if (!p) throw notFound('Product');
  if (ev.verified && !(actor.type === 'user' && actor.role)) throw new DomainError('Only a signed-in staff member can verify evidence', 'FORBIDDEN', 403);
  const entry = { ...ev, verified: !!ev.verified, verifiedBy: ev.verified ? actor.id : undefined, verifiedAt: ev.verified ? new Date() : undefined, observedAt: ev.observedAt ?? new Date() };
  if (ev.verified && !evidenceValid({ ...ev, verified: true })) throw new DomainError('Evidence needs a certification body plus a certificate id or URL (or, for reports, a URL) before it can be verified', 'VALIDATION', 422);
  (p.organic as { evidence: unknown[] }).evidence.push(entry);
  await p.save();
  await audit(ctx, actor, { action: 'product.claim_evidence_added', resource: 'product', resourceId: productId, newValue: { claim: ev.claim, type: ev.type, body: ev.body, certId: ev.certId, verified: !!ev.verified, jurisdiction: ev.jurisdiction } });
}

export async function removeClaimEvidence(ctx: Ctx, productId: string, index: number, actor: Actor): Promise<void> {
  const p = await Product.findById(productId);
  if (!p) throw notFound('Product');
  const list = (p.organic as { evidence: unknown[] }).evidence;
  if (index < 0 || index >= list.length) throw notFound('Evidence');
  const [removed] = list.splice(index, 1);
  await p.save();
  await audit(ctx, actor, { action: 'product.claim_evidence_removed', resource: 'product', resourceId: productId, previousValue: removed });
}
