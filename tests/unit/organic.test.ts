import { describe, expect, it } from 'vitest';
import { allowedClaims, checkCompliance, claimViolations, evidenceValid, findEnvironmentalClaims, sanitizeCopy } from '@orvia/core';
import type { ClaimEvidence } from '@orvia/core';

const cert = (over: Partial<ClaimEvidence> = {}): ClaimEvidence => ({ claim: 'organic', type: 'certification', body: 'USDA', certId: 'NOP-12345', jurisdiction: ['US'], verified: true, ...over });

describe('organic / eco claims need evidence', () => {
  it('detects the claim families the AI and suppliers like to use', () => {
    const kinds = (t: string) => findEnvironmentalClaims(t).map((c) => c.kind).sort();
    expect(kinds('100% Organic cotton, certified organic')).toEqual(['organic', 'organic']);
    expect(kinds('A non-toxic, chemical-free and BPA-free bottle')).toEqual(['non_toxic', 'non_toxic', 'non_toxic']);
    expect(kinds('Eco-certified, biodegradable and plant-based')).toEqual(['biodegradable', 'eco', 'plant_based']);
    expect(kinds('Soft natural cotton')).toEqual([]);
  });

  it('removes unverified claims from supplier/AI copy and keeps the text readable', () => {
    expect(sanitizeCopy('Organic Cotton Dino Pyjama Set').text).toBe('Cotton Dino Pyjama Set');
    const t = sanitizeCopy('Made from 100% organic cotton, non-toxic dyes and eco-certified.').text;
    expect(findEnvironmentalClaims(t)).toEqual([]);
    expect(t).toMatch(/^Made from cotton/);
    expect(t).not.toMatch(/,\s*\.|\s\.|\s{2}|organic|toxic|eco/i);
    expect(sanitizeCopy('Certified organic, chemical-free, and soft').removed.map((r) => r.toLowerCase())).toEqual(['certified organic', 'chemical-free']);
  });

  it('only verified, complete, unexpired, jurisdiction-matching evidence permits a claim', () => {
    expect(evidenceValid(cert())).toBe(true);
    expect(evidenceValid(cert({ verified: false }))).toBe(false); // an unverified upload proves nothing
    expect(evidenceValid(cert({ body: undefined }))).toBe(false); // no certification body
    expect(evidenceValid(cert({ certId: undefined, certUrl: undefined }))).toBe(false); // no certificate id/url
    expect(evidenceValid(cert({ expiresAt: new Date(Date.now() - 86_400_000) }))).toBe(false);
    expect(evidenceValid(cert(), 'IN')).toBe(false); // USDA evidence does not cover India
    expect(evidenceValid(cert({ jurisdiction: ['GLOBAL'] }), 'IN')).toBe(true);
    expect(evidenceValid({ claim: 'non_toxic', type: 'supplier_statement', verified: true })).toBe(false); // a bare statement is not evidence
    expect(allowedClaims([cert(), cert({ claim: 'eco', verified: false })], 'US')).toEqual(['organic']);
  });

  it('flags a listing that makes a claim in a market where it is not evidenced', () => {
    const base = { title: 'Organic Cotton Tee', description: 'Soft tee.', markets: [{ country: 'US' }, { country: 'IN' }] };
    expect(claimViolations({ ...base, organic: { evidence: [] } }).map((v) => v.kind)).toEqual(['organic']);
    expect(claimViolations({ ...base, organic: { evidence: [cert()] } })).toHaveLength(1); // US only, but sold in India too
    expect(claimViolations({ ...base, organic: { evidence: [cert({ jurisdiction: ['GLOBAL'] })] } })).toHaveLength(0);
    expect(claimViolations({ title: 'Cotton Tee', description: 'Soft tee.', bullets: ['100% organic'], markets: [{ country: 'US' }] }).map((v) => v.field)).toEqual(['bullets']);
  });

  it('personal-care, food and pet-food products are routed to compliance review, never auto-published', () => {
    expect(checkCompliance({ title: 'Lavender body lotion' }).status).toBe('review');
    expect(checkCompliance({ title: 'Dog food kibble' }).flags.map((f) => f.code)).toContain('PET_FOOD');
    expect(checkCompliance({ title: 'Wildflower honey jar' }).flags.map((f) => f.code)).toContain('FOOD_PRODUCT');
    expect(checkCompliance({ title: 'Slow feeder dog bowl', description: 'holds dog treats' }).status).toBe('passed');
  });
});
