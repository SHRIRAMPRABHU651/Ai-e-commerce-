import { describe, expect, it } from 'vitest';
import { CATEGORY_TREE, NEEDS, REFERRAL_TERMS, needBySlug, slugify } from '@orvia/types';

const validCategories = new Set(CATEGORY_TREE.flatMap((t) => t.children.map((c) => slugify(c))));

describe('shop-by-need definitions', () => {
  it('have unique slugs and every rule points at a real catalogue category', () => {
    expect(new Set(NEEDS.map((n) => n.slug)).size).toBe(NEEDS.length);
    for (const n of NEEDS) {
      expect(n.match.categories?.length || n.match.keywords?.length, n.slug).toBeTruthy();
      for (const c of n.match.categories ?? []) expect(validCategories.has(c), `${n.slug}: unknown category ${c}`).toBe(true);
      expect(needBySlug(n.slug)).toBe(n);
    }
  });

  it('reference only the 24 framework principles', () => {
    for (const n of NEEDS) for (const p of n.principles) expect(p >= 1 && p <= 24, n.slug).toBe(true);
  });

  it('use honest copy: no scarcity, fear, or outcome guarantees', () => {
    const banned = /\b(only \d+ left|hurry|last chance|don'?t miss|guarantee[ds]?|cure|fix your|before it'?s too late|you need)\b/i;
    for (const n of NEEDS) expect(`${n.name} ${n.tagline} ${n.promise}`, n.slug).not.toMatch(banned);
  });

  it('keyword rules compile as whole-word regexes', () => {
    for (const n of NEEDS) if (n.match.keywords?.length) expect(() => new RegExp(`\\b(${n.match.keywords!.join('|')})\\b`, 'i')).not.toThrow();
  });
});

describe('referral terms', () => {
  it('keep both discounts modest enough for margin protection to apply', () => {
    expect(REFERRAL_TERMS.friendPercent).toBeGreaterThan(0);
    expect(REFERRAL_TERMS.friendPercent).toBeLessThanOrEqual(0.2);
    expect(REFERRAL_TERMS.rewardPercent).toBeLessThanOrEqual(0.2);
    expect(REFERRAL_TERMS.rewardValidDays).toBeGreaterThan(0);
  });
});
