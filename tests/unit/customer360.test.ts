import { describe, expect, it } from 'vitest';
import { ALLOWED_KINDS, deriveFromPurchases, guardKind, personalizationSignals, rankWithSignals, toGraph, validateNode } from '../../packages/core/src/domain/customer360/lifegraph';
import type { GraphNode } from '../../packages/core/src/domain/customer360/lifegraph';
import { applyPrefsPatch, canContact, canContactDecision, currentConsent } from '../../packages/core/src/domain/customer360/consent';
import type { ContactProfile } from '../../packages/core/src/domain/customer360/consent';
import { EXPORT_SCHEMA, EXPORT_SECTIONS, anonEmail, buildAnonymizationPlan, buildExport, coolingOffElapsed, isAnonymizedEmail, isExpired, maskEmail, maskName, memoryExpiry, minimizeProfileForStaff, stripSecrets } from '../../packages/core/src/domain/customer360/privacy';
import { NOT_PROVIDED, buildCompanion, decodeOrderItemId, encodeOrderItemId, replenishment } from '../../packages/core/src/domain/customer360/companion';

const d = (s: string) => new Date(s);

describe('LifeGraph allowlist and deny guard', () => {
  it('accepts allowlisted kinds with permitted values', () => {
    expect(validateNode({ kind: 'pet_type', value: 'dog' }).ok).toBe(true);
    expect(validateNode({ kind: 'budget_range', value: 'mid' }).ok).toBe(true);
    expect(validateNode({ kind: 'child_age_band', value: '3-5' }).ok).toBe(true);
    expect(validateNode({ kind: 'category_interest', value: 'dog-toys' }).ok).toBe(true);
    expect(validateNode({ kind: 'gift_occasion', value: 'birthday' }).ok).toBe(true);
  });
  it('rejects unknown kinds and every sensitive family by name', () => {
    for (const k of ['health_condition', 'religion', 'ethnicity', 'sexual_orientation', 'political_party', 'home_address', 'gps_location', 'child_birth_date', 'income', 'diagnosis', 'age']) {
      const r = guardKind(k);
      expect(r.ok, k).toBe(false);
    }
    expect(validateNode({ kind: 'favourite_colour', value: 'red' }).ok).toBe(false);
    expect(ALLOWED_KINDS).not.toContain('health');
  });
  it('rejects values outside the closed vocabulary and exact child ages', () => {
    expect(validateNode({ kind: 'child_age_band', value: '7' }).ok).toBe(false);
    expect(validateNode({ kind: 'pet_type', value: 'unicorn' }).ok).toBe(false);
    expect(validateNode({ kind: 'budget_range', value: 'rich' }).ok).toBe(false);
  });
  it('rejects sensitive free-form category values', () => {
    for (const v of ['diabetes-supplies', 'pregnancy-tests', 'church-supplies', 'maga-hats-trump', 'gay-pride', 'weight-loss-pills', '12345', 'age-7']) expect(validateNode({ kind: 'category_interest', value: v }).ok, v).toBe(false);
    expect(validateNode({ kind: 'category_interest', value: 'Dog Toys' }).ok).toBe(false); // not a slug
    expect(validateNode({ kind: 'category_interest', value: 'jewellery' }).ok).toBe(true); // no false positive on "jew"
    expect(validateNode({ kind: 'category_interest', value: 'environmental-cleaning' }).ok).toBe(true);
  });
  it('never derives sensitive categories from purchases and needs repeat purchases', () => {
    const out = deriveFromPurchases(['dog-toys', 'dog-toys', 'pregnancy-care', 'pregnancy-care', 'pregnancy-care', 'mugs']);
    expect(out).toEqual([{ kind: 'category_interest', value: 'dog-toys' }]);
  });
});

describe('personalizationSignals', () => {
  const nodes: GraphNode[] = [
    { id: '1', kind: 'pet_type', value: 'cat', source: 'declared' },
    { id: '2', kind: 'eco_preference', value: 'prefer_verified_eco', source: 'declared' },
    { id: '3', kind: 'category_interest', value: 'mugs', source: 'derived_from_purchases' },
    { id: '4', kind: 'health_condition', value: 'x', source: 'declared' },
  ];
  it('is inactive without enablement and consent', () => {
    expect(personalizationSignals({ enabled: false, personalizationConsent: true, nodes }).active).toBe(false);
    const s = personalizationSignals({ enabled: true, personalizationConsent: false, nodes });
    expect(s.active).toBe(false);
    expect(s.reasons).toEqual([]);
  });
  it('extracts signals with "because you told us" explanations and ignores non-allowlisted nodes', () => {
    const s = personalizationSignals({ enabled: true, personalizationConsent: true, nodes });
    expect(s.petTypes).toEqual(['cat']);
    expect(s.ecoVerifiedOnly).toBe(true);
    expect(s.derivedCategories).toEqual(['mugs']);
    expect(s.reasons.some((r) => r.text.startsWith('because you told us'))).toBe(true);
    expect(JSON.stringify(s)).not.toContain('health');
  });
  it('ranks boosted candidates first with explanations and keeps base order otherwise', () => {
    const s = personalizationSignals({ enabled: true, personalizationConsent: true, nodes });
    const r = rankWithSignals([
      { id: 'a', tags: [], price: 10, ecoVerified: false },
      { id: 'b', tags: ['cat'], price: 10, ecoVerified: true },
      { id: 'c', tags: [], price: 10, ecoVerified: false },
    ], s);
    expect(r.map((x) => x.id)).toEqual(['b', 'a', 'c']);
    expect(r[0]!.reasons.length).toBeGreaterThan(0);
    expect(r[1]!.reasons).toEqual([]);
  });
  it('builds typed nodes and edges with parent chains', () => {
    const g = toGraph([{ id: 'r', kind: 'gift_recipient', value: 'parent', source: 'declared' }, { id: 'o', kind: 'gift_occasion', value: 'birthday', source: 'declared', parentId: 'r' }]);
    expect(g.edges).toContainEqual({ from: 'self', rel: 'buys_gifts_for', to: 'r' });
    expect(g.edges).toContainEqual({ from: 'r', rel: 'for_occasion', to: 'o' });
  });
});

describe('canContact', () => {
  const base = (over: Partial<ContactProfile> = {}): ContactProfile => ({ consents: currentConsent([]), prefs: {}, ...over });
  const consented = currentConsent([{ kind: 'marketing_email', granted: true, at: d('2026-01-01') }, { kind: 'personalization', granted: true, at: d('2026-01-01') }]);
  it('defaults to opt-in: no consent, no marketing', () => {
    expect(canContact(base(), 'promotions', 'email')).toBe(false);
    expect(canContactDecision(base({ prefs: { promotions: { email: true } } }), 'promotions', 'email').reason).toBe('no_marketing_consent');
  });
  it('needs consent and per-topic channel opt-in', () => {
    expect(canContact(base({ consents: consented }), 'promotions', 'email')).toBe(false);
    expect(canContact(base({ consents: consented, prefs: { promotions: { email: true } } }), 'promotions', 'email')).toBe(true);
    expect(canContact(base({ consents: consented, prefs: { promotions: { email: true } } }), 'promotions', 'sms')).toBe(false);
  });
  it('personalized topics also need personalization consent', () => {
    const c = currentConsent([{ kind: 'marketing_email', granted: true, at: d('2026-01-01') }]);
    expect(canContactDecision(base({ consents: c, prefs: { replenishment: { email: true } } }), 'replenishment', 'email').reason).toBe('no_personalization_consent');
  });
  it('withdrawal (latest record) wins', () => {
    const c = currentConsent([{ kind: 'marketing_email', granted: true, at: d('2026-01-01') }, { kind: 'marketing_email', granted: false, at: d('2026-02-01') }]);
    expect(c.marketing_email.granted).toBe(false);
  });
  it('transactional email always allowed, except deleted or suppressed', () => {
    expect(canContact(base(), 'order_updates', 'email')).toBe(true);
    expect(canContact(base(), 'order_updates', 'sms')).toBe(false);
    expect(canContact(base({ deleted: true }), 'order_updates', 'email')).toBe(false);
    expect(canContact(base({ suppressed: true, consents: consented, prefs: { promotions: { email: true } } }), 'promotions', 'email')).toBe(false);
  });
  it('transactional email cannot be switched off via preferences', () => {
    expect(applyPrefsPatch({}, { order_updates: { email: false }, promotions: { email: true } })).toEqual({ promotions: { email: true } });
  });
});

describe('export, anonymization and retention', () => {
  it('export has every section, schema id and no secrets', () => {
    const e = buildExport({ userId: 'u1' }, { account: { email: 'a@b.co', passwordHash: 'x', resetTokenHash: 'y', version: 3 }, orders: [{ orderNumber: 'O1', fraud: undefined, payment: { cardNumber: '4242', status: 'succeeded' } }] }, d('2026-03-01'));
    expect(e.schema).toBe(EXPORT_SCHEMA);
    for (const s of EXPORT_SECTIONS) expect(e).toHaveProperty(s);
    const json = JSON.stringify(e);
    expect(json).not.toContain('passwordHash');
    expect(json).not.toContain('resetTokenHash');
    expect(json).not.toContain('4242');
    expect(e.consents).toEqual([]);
    expect(e.generatedAt).toBe('2026-03-01T00:00:00.000Z');
  });
  it('stripSecrets handles dates and nesting', () => {
    expect(stripSecrets({ a: { ip: '1.2.3.4', at: d('2026-01-01'), keep: 1 } })).toEqual({ a: { at: '2026-01-01T00:00:00.000Z', keep: 1 } });
  });
  it('anonymization plan removes PII, is deterministic and keeps money fields out of its patches', () => {
    const p = buildAnonymizationPlan('u1', 'jane@example.com', 'salt', d('2026-03-01'));
    expect(JSON.stringify(p)).not.toContain('jane@example.com');
    expect(isAnonymizedEmail(p.user.email as string)).toBe(true);
    expect(p.user.email).toBe(anonEmail('u1', 'salt'));
    expect(buildAnonymizationPlan('u1', 'jane@example.com', 'salt', d('2026-04-01')).token).toBe(p.token);
    expect(buildAnonymizationPlan('u2', 'x@example.com', 'salt', d('2026-03-01')).token).not.toBe(p.token);
    expect(p.order).toEqual({ email: p.user.email, address: null });
    for (const k of Object.keys(p.order)) expect(['email', 'address']).toContain(k); // amounts/items/payment untouched
    expect(p.referral('0').referrerEmail).not.toBe(p.referral('0').refereeEmail);
    expect(p.deleteFrom).toContain('lifegraph');
  });
  it('retention and cooling-off maths', () => {
    expect(memoryExpiry(d('2026-01-01'), 0)).toBeNull();
    expect(memoryExpiry(d('2026-01-01'), 30)).toEqual(d('2026-01-31'));
    expect(isExpired(d('2026-01-31'), d('2026-01-31'))).toBe(true);
    expect(isExpired(null, d('2026-01-31'))).toBe(false);
    expect(coolingOffElapsed(d('2026-01-01'), d('2026-01-14'))).toBe(false);
    expect(coolingOffElapsed(d('2026-01-01'), d('2026-01-15'))).toBe(true);
  });
  it('staff views mask PII unless revealed', () => {
    expect(maskEmail('jane.doe@example.com')).toBe('j***@e***.com');
    expect(maskName('Jane Q Doe')).toBe('Jane D.');
    const p = { identity: { email: 'jane@example.com', name: 'Jane Doe' }, x: 1 };
    expect(minimizeProfileForStaff(p, { revealEmail: false }).identity.email).toBe('j***@e***.com');
    expect(minimizeProfileForStaff(p, { revealEmail: true }).identity.email).toBe('jane@example.com');
  });
});

describe('product companion', () => {
  const now = d('2026-03-01');
  it('never invents guidance: missing fields are "not provided"', () => {
    const c = buildCompanion({ title: 'Mug' }, now);
    expect(c.care).toEqual({ status: 'not_provided', message: NOT_PROVIDED });
    expect(c.usage.status).toBe('not_provided');
    expect(c.warranty.status).toBe('not_provided');
    expect(c.safety.status).toBe('not_provided');
    expect(c.compatibility.explicit).toEqual([]);
    expect(c.verifiedClaims).toEqual([]);
  });
  it('uses only explicit attributes and verified, unexpired evidence', () => {
    const c = buildCompanion({
      title: 'Bowl', tags: ['Refill'], attributes: { 'Care Instructions': 'Hand wash', Warranty: '12 months', 'compatible-with': 'Model A; Model B', replenish_after_days: '30', Colour: 'Blue' },
      compliance: { safetyInfo: { standards: ['EN71'], ageRange: '3+' } },
      organic: { evidence: [{ claim: 'organic', type: 'certification', verified: true, certId: 'C1' }, { claim: 'eco', type: 'supplier_statement', verified: false }, { claim: 'biodegradable', type: 'test_report', verified: true, expiresAt: '2025-01-01' }] },
    }, now);
    expect(c.care).toMatchObject({ status: 'provided', text: 'Hand wash' });
    expect(c.warranty).toMatchObject({ status: 'provided', text: '12 months' });
    expect(c.compatibility.explicit).toEqual(['Model A', 'Model B']);
    expect(c.specs).toMatchObject({ status: 'provided', items: [{ name: 'Colour', value: 'Blue' }] });
    expect(c.verifiedClaims.map((x) => x.claim)).toEqual(['organic']);
    expect(c.consumable).toBe(true);
    expect(c.replenishIntervalDays).toBe(30);
  });
  it('replenishment makes no timing claim without a supplier interval', () => {
    const base = { purchasedAt: d('2026-01-01'), now, optedIn: true };
    expect(replenishment({ ...base, consumable: false, intervalDays: null }).eligible).toBe(false);
    const a = replenishment({ ...base, consumable: true, intervalDays: null });
    expect(a.dueAt).toBeNull();
    expect(a.due).toBe(false);
    expect(replenishment({ ...base, consumable: true, intervalDays: 30 }).due).toBe(true);
  });
  it('order item ids round-trip and reject junk', () => {
    const id = encodeOrderItemId('a'.repeat(24), 2);
    expect(decodeOrderItemId(id)).toEqual({ orderId: 'a'.repeat(24), index: 2 });
    expect(decodeOrderItemId('../etc')).toBeNull();
  });
});
