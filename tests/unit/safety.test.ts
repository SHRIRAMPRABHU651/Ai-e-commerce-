import { describe, expect, it } from 'vitest';
import { checkCompliance, validateAddress, tokenize, editDistance } from '@orvia/core';
import { findForbiddenClaims, findInventedSpecs, findUngroundedNumbers, TemplateAIProvider, AIService, ProductContentSchema } from '@orvia/ai';
import { loadConfig, ConfigError, retry, ProviderError, CircuitBreaker, CircuitOpenError, fetchJson } from '@orvia/config';
import { hashPassword, verifyPassword, signSession, verifySession, encryptSecret, decryptSecret, can } from '@orvia/auth';

describe('compliance filter', () => {
  const base = { title: 'x', description: '', category: '', tags: [] as string[] };
  it('rejects weapons, counterfeits, medical claims, drugs, adult', () => {
    for (const [t, code] of [['Tactical Pocket Knife Set', 'WEAPON'], ['Designer Inspired Replica Handbag', 'COUNTERFEIT'], ['Slimming patch that cures obesity', 'MEDICAL_CLAIM'], ['CBD gummies', 'ILLEGAL_DRUG'], ['Disposable vape pen', 'TOBACCO_VAPE'], ['Adult toy kit', 'ADULT'], ['Fireworks bundle', 'DANGEROUS'], ['Vitamins supplement', 'REGULATED']] as const) {
      const r = checkCompliance({ ...base, title: t });
      expect(r.status, t).toBe('failed');
      expect(r.flags.map((f) => f.code)).toContain(code);
    }
  });
  it('sends brand usage to review and children’s / electrical products without safety info to review', () => {
    expect(checkCompliance({ ...base, title: 'Pokemon plush' }).status).toBe('review');
    const kids = checkCompliance({ ...base, title: 'Wooden blocks', topCategory: 'kids' });
    expect(kids.status).toBe('review');
    expect(kids.flags[0]!.code).toBe('KIDS_SAFETY_INFO_MISSING');
    expect(checkCompliance({ ...base, title: 'Wooden blocks', topCategory: 'kids', safetyInfo: { standards: ['EN71'], ageRange: '3+' } }).status).toBe('passed');
    expect(checkCompliance({ ...base, title: 'Rechargeable desk lamp' }).flags.map((f) => f.code)).toContain('ELECTRICAL_CERT_MISSING');
    expect(checkCompliance({ ...base, title: 'Rechargeable desk lamp', safetyInfo: { standards: ['CE'] } }).status).toBe('passed');
  });
  it('does not flag innocent pet products (dog treats, secure straps)', () => {
    expect(checkCompliance({ ...base, title: 'Dog treat dispenser ball', description: 'Secure fit, treats your dog' }).status).toBe('passed');
  });
  it('scans generated marketing for prohibited claims', () => {
    expect(checkCompliance({ ...base, title: 'Mat', marketingText: 'clinically proven miracle results' }).status).toBe('failed');
  });
});

describe('address validation', () => {
  it('validates US/CA/IN formats', () => {
    expect(validateAddress({ country: 'US', region: 'CA', postalCode: '94102', line1: '1 Market St', city: 'SF' }).ok).toBe(true);
    expect(validateAddress({ country: 'US', region: 'California', postalCode: '9410', line1: '1 Market St', city: 'SF' }).ok).toBe(false);
    expect(validateAddress({ country: 'CA', region: 'ON', postalCode: 'M5X 1A9', line1: '100 King St W', city: 'Toronto' }).ok).toBe(true);
    expect(validateAddress({ country: 'CA', region: 'ON', postalCode: '12345', line1: '100 King St W', city: 'Toronto' }).ok).toBe(false);
    expect(validateAddress({ country: 'IN', region: 'KA', postalCode: '560038', line1: '12 MG Road', city: 'Bengaluru' }).ok).toBe(true);
    expect(validateAddress({ country: 'IN', region: 'KA', postalCode: '56003', line1: '12 MG Road', city: 'Bengaluru' }).ok).toBe(false);
  });
});

describe('search helpers', () => {
  it('tokenizes and tolerates typos', () => {
    expect(tokenize('Snuffle-Mat 40cm!')).toEqual(['snuffle', 'mat', '40cm']);
    expect(editDistance('snufle', 'snuffle')).toBe(1);
    expect(editDistance('tarcker', 'tracker')).toBe(1); // transposition
    expect(editDistance('abc', 'xyzxyz', 2)).toBeGreaterThan(2);
  });
});

describe('AI output guardrails', () => {
  const src = 'Snuffle mat with layered strips. Size: 40 x 30 cm. Machine washable.';
  it('flags invented specs but accepts specs present in the source', () => {
    expect(findInventedSpecs(src, 'Measures 40 x 30 cm and is machine washable')).toEqual([]);
    expect(findInventedSpecs(src, 'Holds 5000mAh and weighs 2kg')).toEqual(expect.arrayContaining(['5000mah', '2kg']));
  });
  it('flags forbidden claims', () => {
    expect(findForbiddenClaims('This FDA approved miracle cures anxiety')).not.toHaveLength(0);
    expect(findForbiddenClaims('A sturdy washable mat')).toEqual([]);
  });
  it('flags numbers that are not in the analytics data', () => {
    const data = JSON.stringify({ revenue: 12345, orders: 12 });
    expect(findUngroundedNumbers(data, 'Revenue was 12,345 across 12 orders')).toEqual([]);
    expect(findUngroundedNumbers(data, 'Revenue grew 87% to 99999')).not.toHaveLength(0);
  });
  it('template provider builds schema-valid content only from source data', async () => {
    const t = new TemplateAIProvider();
    const out = await t.generateProductDescription({ title: 'Snuffle Mat', description: 'A washable mat for foraging. Anti-slip base.', category: 'Interactive dog toys', attributes: { Size: '40 x 30 cm' }, tags: ['dog'], safetyStandards: [], variants: [] });
    expect(ProductContentSchema.safeParse(out).success).toBe(true);
    expect(findInventedSpecs('Snuffle Mat A washable mat for foraging. Anti-slip base. Interactive dog toys Size 40 x 30 cm', JSON.stringify(out))).toEqual([]);
  });
});

describe('AI service resilience (Gemini unavailable / rate limited / invalid / hallucinating)', () => {
  const srcProduct = { title: 'Snuffle Mat', description: 'A washable mat. Size 40 x 30 cm.', category: 'Dog', attributes: {}, tags: [], safetyStandards: [], variants: [] };
  const gem = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  const ok = (text: unknown) => gem({ candidates: [{ content: { parts: [{ text: JSON.stringify(text) }] } }] });
  it('falls back to deterministic content on 429 and reports degraded', async () => {
    const svc = new AIService({ geminiApiKey: 'k', geminiModel: 'm', fetchImpl: gem({ error: 'quota' }, 429) });
    const r = await svc.productContent(srcProduct);
    expect(r.source).toBe('template');
    expect(r.degraded).toBe(true);
    expect(r.notes[0]).toMatch(/failed/);
  }, 30_000);
  it('rejects schema-invalid output and falls back', async () => {
    const svc = new AIService({ geminiApiKey: 'k', geminiModel: 'm', fetchImpl: ok({ seoTitle: 'x' }) });
    const r = await svc.productContent(srcProduct);
    expect(r.source).toBe('template');
    expect(r.notes[0]).toMatch(/rejected/);
  });
  it('rejects content with invented specifications', async () => {
    const good = (await new TemplateAIProvider().generateProductDescription(srcProduct));
    const svc = new AIService({ geminiApiKey: 'k', geminiModel: 'm', fetchImpl: ok({ ...good, bullets: ['Holds 5000mAh of charge', ...good.bullets.slice(1)] }) });
    const r = await svc.productContent(srcProduct);
    expect(r.source).toBe('template');
    expect(r.notes[0]).toMatch(/not present in source/);
  });
  it('accepts valid grounded output from Gemini', async () => {
    const good = await new TemplateAIProvider().generateProductDescription(srcProduct);
    const svc = new AIService({ geminiApiKey: 'k', geminiModel: 'm', fetchImpl: ok(good) });
    expect((await svc.productContent(srcProduct)).source).toBe('gemini');
  });
  it('works with no key at all', async () => {
    const svc = new AIService({ geminiModel: 'm' });
    expect(svc.llmConfigured).toBe(false);
    expect((await svc.productContent(srcProduct)).source).toBe('template');
    expect(await svc.businessNarrative({ a: 1 })).toBeNull();
  });
  it('rejects narratives quoting numbers that are not in the data', async () => {
    const svc = new AIService({ geminiApiKey: 'k', geminiModel: 'm', fetchImpl: ok({ headline: 'Revenue up 87% to 99999', bullets: [], recommendedActions: [] }) });
    expect(await svc.businessNarrative({ revenue: 100 })).toBeNull();
  });
});

describe('configuration safety (dev/staging/production separation)', () => {
  it('refuses mock providers and weak secrets in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'production', SUPPLIER_MODE: 'live', PAYMENT_MODE: 'live', ADS_MODE: 'live', NOTIFY_MODE: 'live', JWT_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET/);
    const cfg = loadConfig({ NODE_ENV: 'production', SUPPLIER_MODE: 'live', PAYMENT_MODE: 'live', ADS_MODE: 'live', NOTIFY_MODE: 'live', JWT_SECRET: 'x'.repeat(48) } as NodeJS.ProcessEnv);
    expect(cfg.isProduction).toBe(true);
    expect(cfg.COOKIE_SECURE).toBe(true);
  });
  it('allows mocks in development', () => {
    const cfg = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect(cfg.SUPPLIER_MODE).toBe('mock');
    expect(cfg.COOKIE_SECURE).toBe(false);
  });
});

describe('resilience primitives', () => {
  it('retries retryable errors with backoff and stops on non-retryable ones', async () => {
    let n = 0;
    const r = await retry(async () => { if (++n < 3) throw new ProviderError('x', { provider: 't', retryable: true }); return 'ok'; }, { retries: 3, baseMs: 1 });
    expect(r).toBe('ok');
    expect(n).toBe(3);
    let m = 0;
    await expect(retry(async () => { m++; throw new ProviderError('bad', { provider: 't', retryable: false }); }, { retries: 5, baseMs: 1 })).rejects.toThrow('bad');
    expect(m).toBe(1);
  });
  it('circuit breaker opens after repeated failures and fails fast', async () => {
    const b = new CircuitBreaker('t', { failureThreshold: 3, resetMs: 60_000 });
    for (let i = 0; i < 3; i++) await b.exec(async () => { throw new ProviderError('down', { provider: 't', retryable: true }); }).catch(() => undefined);
    expect(b.status).toBe('open');
    await expect(b.exec(async () => 'never')).rejects.toBeInstanceOf(CircuitOpenError);
  });
  it('fetchJson times out, retries GET, and never retries unsafe POSTs', async () => {
    let calls = 0;
    const slow = (async (_u: string, init: RequestInit) => { calls++; return new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('abort'), { name: 'AbortError' })))); }) as unknown as typeof fetch;
    await expect(fetchJson('http://x', { provider: 't', fetchImpl: slow, timeoutMs: 20, retries: 1 })).rejects.toThrow(/timed out/);
    expect(calls).toBe(2);
    calls = 0;
    await expect(fetchJson('http://x', { provider: 't', method: 'POST', body: {}, fetchImpl: slow, timeoutMs: 20, retries: 3 })).rejects.toThrow(/timed out/);
    expect(calls).toBe(1);
  });
});

describe('auth primitives', () => {
  it('hashes with unique salts and verifies', async () => {
    const a = await hashPassword('Correct-Horse-9', { fast: true });
    const b = await hashPassword('Correct-Horse-9', { fast: true });
    expect(a).not.toBe(b);
    expect(await verifyPassword('Correct-Horse-9', a)).toBe(true);
    expect(await verifyPassword('wrong', a)).toBe(false);
  });
  it('signs/verifies sessions and rejects tampering/expiry', async () => {
    const t = await signSession({ sub: 'u1', role: 'ADMIN', sid: 's1' }, 'secret-secret-secret-secret-1234', 1);
    expect((await verifySession(t, 'secret-secret-secret-secret-1234'))?.sub).toBe('u1');
    expect(await verifySession(t, 'other-secret-other-secret-1234567')).toBeNull();
    expect(await verifySession(t.slice(0, -3) + 'abc', 'secret-secret-secret-secret-1234')).toBeNull();
  });
  it('encrypts stored credentials with AES-GCM', () => {
    const c = encryptSecret('super-secret-token', 'k'.repeat(32));
    expect(c).not.toContain('super-secret');
    expect(decryptSecret(c, 'k'.repeat(32))).toBe('super-secret-token');
    expect(() => decryptSecret(c, 'z'.repeat(32))).toThrow();
  });
  it('role matrix', () => {
    expect(can('SUPER_ADMIN', 'users:manage')).toBe(true);
    expect(can('ADMIN', 'users:manage')).toBe(false);
    expect(can('CUSTOMER', 'orders:read')).toBe(false);
    expect(can('ANALYST', 'orders:write')).toBe(false);
  });
});
