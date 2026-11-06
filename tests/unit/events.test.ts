import { describe, expect, it } from 'vitest';
import { buildCanonicalEvent, buildEventId, consentForProvider, hasTrackingConsent, redactEvent, redactForDisplay } from '../../packages/core/src/domain/events/eventModel';
import { hashEmail, normalizeEmail, normalizeEmailForGoogle, normalizePhoneE164, hashPhoneDigits, hashPhoneE164, sha256Hex } from '../../packages/core/src/domain/events/hashing';
import { OUTBOX_MAX_ATTEMPTS, decideAfterFailure, eventRetryDelayMs, isExpiredForProvider } from '../../packages/core/src/domain/events/outboxPolicy';
import { buildGa4Body, buildGoogleAdsRequest, buildMetaEvent, buildTikTokEvent } from '../../packages/core/src/domain/events/providers';
import { evaluateSegment, buildCustomerPrefilter } from '../../packages/core/src/domain/events/segments';
import type { CustomerFacts } from '../../packages/core/src/domain/events/segments';
import { emailEligibility, planRecipients } from '../../packages/core/src/domain/events/campaignRules';
import { clickUrl, isAllowedRedirect, signToken, unsubscribeUrl, verifyToken } from '../../packages/core/src/domain/events/tokens';
import { assessExperiment, assignVariant, bucketUnit, normalCdf, twoProportionTest } from '../../packages/core/src/domain/events/experimentsMath';
import { classifyChannel, reportChannel } from '../../packages/core/src/domain/events/attributionRules';
import { buildGoogleFeedXml, buildMetaFeedCsv, csvCell, toFeedItem, xmlEscape } from '../../packages/core/src/domain/events/feeds';
import type { FeedProductInput } from '../../packages/core/src/domain/events/feeds';
import { buildBreadcrumbJsonLd, buildProductJsonLd, serializeJsonLd } from '../../apps/web/src/lib/structured-data';
import { renderTemplate } from '../../packages/notifications/src/index';
import { enabledEventProviders, eventsConfigProblems, loadConfig } from '../../packages/config/src/index';
import { enforceSpendCaps } from '../../packages/ads/src/rules';

const T = new Date('2026-11-05T12:00:00Z');

describe('hashing + normalisation vectors', () => {
  it('sha256 known vectors', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashEmail('  Test@Example.COM ')).toBe('973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b');
  });
  it('phone: Meta hashes digits without +, TikTok/GA4/Google hash E.164 with +', () => {
    expect(normalizePhoneE164('(415) 555-0100', 'US')).toBe('+14155550100');
    expect(hashPhoneDigits('(415) 555-0100', 'US')).toBe('5e7ec4c79ccac6e420876e65ad0e6b4b2ccf73ec3dccb50297bf2890a1ec73b9');
    expect(hashPhoneE164('+1 415 555 0100')).toBe('40d3f4e02db27d66cf4cfdda506c2c945f115a7955cc8491dda98ce5beabcda0');
    expect(normalizePhoneE164('098765 43210', 'IN')).toBe('+919876543210');
    expect(normalizePhoneE164('12', 'US')).toBeNull();
    expect(normalizePhoneE164('4155550100')).toBeNull(); // unknown country: refuse to guess
  });
  it('email: invalid -> undefined; google flavour strips gmail dots only', () => {
    expect(normalizeEmail('nope')).toBeNull();
    expect(hashEmail('nope')).toBeUndefined();
    expect(normalizeEmailForGoogle('J.Doe@Gmail.com')).toBe('jdoe@gmail.com');
    expect(normalizeEmailForGoogle('j.doe@example.com')).toBe('j.doe@example.com');
  });
});

describe('event ids (dedupe)', () => {
  it('are stable for the same business key and independent of time', () => {
    expect(buildEventId('purchase', 'abc123')).toBe('purchase:abc123');
    const a = buildCanonicalEvent({ name: 'purchase', businessKey: 'o1', occurredAt: T, consent: { marketing: true, analytics: true } });
    const b = buildCanonicalEvent({ name: 'purchase', businessKey: 'o1', occurredAt: new Date(T.getTime() + 9999), consent: { marketing: true, analytics: true } });
    expect(a.eventId).toBe(b.eventId);
  });
  it('browser id passes through unchanged and bad ids are rejected', () => {
    expect(buildCanonicalEvent({ name: 'add_to_cart', eventId: 'add_to_cart:1f4e-uuid', occurredAt: T, consent: { marketing: true, analytics: true } }).eventId).toBe('add_to_cart:1f4e-uuid');
    expect(() => buildCanonicalEvent({ name: 'add_to_cart', eventId: 'bad id!', occurredAt: T, consent: { marketing: true, analytics: true } })).toThrow();
  });
  it('raw PII never appears in the canonical event or its display form', () => {
    const e = buildCanonicalEvent({ name: 'purchase', businessKey: 'o1', occurredAt: T, email: 'Secret@Example.com', phone: '+14155550100', consent: { marketing: true, analytics: true } });
    expect(JSON.stringify(e)).not.toMatch(/secret@example|4155550100/i);
    expect(JSON.stringify(redactForDisplay(e))).not.toContain(e.user.emailSha256!);
    expect(redactEvent(e).user).toEqual({});
  });
});

describe('consent gating', () => {
  it('defaults to no consent', () => {
    expect(hasTrackingConsent(null)).toBe(false);
    expect(hasTrackingConsent({})).toBe(false);
    expect(hasTrackingConsent({ cart: { marketingConsent: false }, customer: { marketingConsent: false } })).toBe(false);
  });
  it('explicit grants count, explicit session denial wins', () => {
    expect(hasTrackingConsent({ cart: { marketingConsent: true } })).toBe(true);
    expect(hasTrackingConsent({ session: { consent: { marketing: true } } })).toBe(true);
    expect(hasTrackingConsent({ session: { consent: { marketing: false } }, cart: { marketingConsent: true } })).toBe(false);
  });
  it('GA4 accepts analytics-only consent; ad platforms need marketing', () => {
    const s = { session: { consent: { analytics: true, marketing: false } } };
    expect(consentForProvider('ga4', s)).toBe(true);
    expect(consentForProvider('meta', s)).toBe(false);
    expect(consentForProvider('ga4', { session: { consent: { analytics: false, marketing: false } }, cart: { marketingConsent: true } })).toBe(false);
  });
});

describe('outbox retry policy', () => {
  it('backs off exponentially, capped, then dead-letters', () => {
    expect(eventRetryDelayMs(1, 0.5)).toBe(30_000);
    expect(eventRetryDelayMs(2, 0.5)).toBe(60_000);
    expect(eventRetryDelayMs(30, 0.5)).toBe(6 * 3_600_000);
    expect(decideAfterFailure({ failedAttempts: 1, retryable: true, now: T, rand: 0.5 })).toEqual({ status: 'pending', nextAttemptAt: new Date(T.getTime() + 30_000) });
    expect(decideAfterFailure({ failedAttempts: OUTBOX_MAX_ATTEMPTS, retryable: true, now: T }).status).toBe('dead');
    expect(decideAfterFailure({ failedAttempts: 1, retryable: false, now: T }).status).toBe('dead');
  });
  it('expires events too old for each platform', () => {
    expect(isExpiredForProvider('ga4', new Date(T.getTime() - 80 * 3_600_000), T)).toBe(true);
    expect(isExpiredForProvider('meta', new Date(T.getTime() - 80 * 3_600_000), T)).toBe(false);
  });
});

describe('adapter request shapes (public-doc shapes; unverified against live accounts)', () => {
  const ev = buildCanonicalEvent({ name: 'purchase', businessKey: 'o1', occurredAt: T, email: 'a.b@gmail.com', phone: '+14155550100', clickIds: { fbclid: 'FB1', gclid: 'G1', ttclid: 'TT1' }, browserIds: { gaClientId: '123.456', fbp: 'fb.1.1.2' }, value: 49.5, currency: 'USD', orderId: 'o1', items: [{ id: 'p1', quantity: 2, price: 24.75 }], consent: { marketing: true, analytics: true } });
  it('Meta', () => {
    const m = buildMetaEvent(ev) as any;
    expect(m.event_name).toBe('Purchase');
    expect(m.event_id).toBe('purchase:o1');
    expect(m.event_time).toBe(Math.floor(T.getTime() / 1000));
    expect(m.user_data.em).toEqual([hashEmail('a.b@gmail.com')]);
    expect(m.user_data.ph).toEqual([hashPhoneDigits('+14155550100')]);
    expect(m.user_data.fbc).toBe(`fb.1.${T.getTime()}.FB1`);
    expect(m.action_source).toBe('system_generated'); // no ip/ua captured
    expect(m.custom_data).toMatchObject({ currency: 'USD', value: 49.5, order_id: 'o1', content_ids: ['p1'], num_items: 2 });
    expect(buildMetaEvent({ ...ev, name: 'refund' })).toBeNull();
  });
  it('TikTok', () => {
    const t = buildTikTokEvent(ev) as any;
    expect(t.event).toBe('CompletePayment');
    expect(t.event_id).toBe('purchase:o1');
    expect(t.user.phone).toBe(hashPhoneE164('+14155550100'));
    expect(t.user.ttclid).toBe('TT1');
    expect(t.properties.contents[0]).toMatchObject({ content_id: 'p1', quantity: 2, price: 24.75 });
  });
  it('GA4 uses the google-flavoured email hash, client id and consent signals', () => {
    const g = buildGa4Body(ev) as any;
    expect(g.client_id).toBe('123.456');
    expect(g.user_data.sha256_email_address).toEqual([hashEmail('ab@gmail.com')]);
    expect(g.events[0]).toMatchObject({ name: 'purchase', params: { transaction_id: 'o1', value: 49.5, currency: 'USD' } });
    expect(g.consent.ad_user_data).toBe('GRANTED');
    expect(buildGa4Body({ ...ev, user: { ...ev.user, gaClientId: undefined } })).toMatchObject({ client_id: expect.stringMatching(/^server\./) });
  });
  it('Google Ads: click conversion keyed by order id; refund becomes retraction/restatement; nothing to match -> null', () => {
    const o = { customerId: '123-456-7890', conversionActionId: '99', apiVersion: 'v21' };
    const up = buildGoogleAdsRequest(ev, o)!;
    expect(up.url).toBe('https://googleads.googleapis.com/v21/customers/1234567890:uploadClickConversions');
    expect((up.body as any).conversions[0]).toMatchObject({ gclid: 'G1', orderId: 'o1', conversionValue: 49.5, conversionDateTime: '2026-11-05 12:00:00+00:00', conversionAction: 'customers/1234567890/conversionActions/99' });
    const full = buildGoogleAdsRequest({ ...ev, name: 'refund', data: { ...ev.data, refundValue: 49.5 } }, o)!;
    expect((full.body as any).conversionAdjustments[0].adjustmentType).toBe('RETRACTION');
    const part = buildGoogleAdsRequest({ ...ev, name: 'refund', data: { ...ev.data, refundValue: 10 } }, o)!;
    expect((part.body as any).conversionAdjustments[0]).toMatchObject({ adjustmentType: 'RESTATEMENT', restatementValue: { adjustedValue: 39.5, currencyCode: 'USD' } });
    expect(buildGoogleAdsRequest({ ...ev, user: {} }, o)).toBeNull();
  });
});

describe('segments', () => {
  const f = (o: Partial<CustomerFacts> = {}): CustomerFacts => ({ email: 'a@b.co', ordersCount: 2, lifetimeValueUsd: 20_000, lastOrderAt: new Date(T.getTime() - 100 * 86_400_000), country: 'US', marketingConsent: true, categories: ['pet'], ...o });
  it('evaluates rules (AND)', () => {
    expect(evaluateSegment([{ field: 'ordersCount', op: 'gte', value: 1 }, { field: 'daysSinceLastOrder', op: 'gte', value: 90 }], f(), T)).toBe(true);
    expect(evaluateSegment([{ field: 'daysSinceLastOrder', op: 'gte', value: 120 }], f(), T)).toBe(false);
    expect(evaluateSegment([{ field: 'lifetimeValueUsd', op: 'gte', value: 150 }], f(), T)).toBe(true);
    expect(evaluateSegment([{ field: 'lifetimeValueUsd', op: 'lte', value: 150 }], f(), T)).toBe(false);
    expect(evaluateSegment([{ field: 'country', op: 'in', value: ['CA'] }], f(), T)).toBe(false);
    expect(evaluateSegment([{ field: 'categoryAffinity', op: 'in', value: ['pet', 'kids'] }], f(), T)).toBe(true);
    expect(evaluateSegment([], f(), T)).toBe(false);
  });
  it('never-ordered customers are not "lapsed"', () => {
    expect(evaluateSegment([{ field: 'daysSinceLastOrder', op: 'gte', value: 1 }], f({ ordersCount: 0, lastOrderAt: null }), T)).toBe(false);
  });
  it('pushes country / consent down to the query', () => {
    expect(buildCustomerPrefilter([{ field: 'country', op: 'in', value: ['US'] }, { field: 'marketingConsent', op: 'eq', value: true }])).toEqual({ country: { $in: ['US'] }, marketingConsent: true });
  });
});

describe('campaign recipients: never email non-consenting addresses', () => {
  const none = new Set<string>();
  it('eligibility', () => {
    expect(emailEligibility({ email: 'a@b.co', marketingConsent: false }, { unsubscribed: none })).toEqual({ ok: false, reason: 'no_consent' });
    expect(emailEligibility({ email: 'a@b.co', marketingConsent: true }, { unsubscribed: new Set(['a@b.co']) })).toEqual({ ok: false, reason: 'unsubscribed' });
    expect(emailEligibility({ email: 'bad', marketingConsent: true }, { unsubscribed: none })).toEqual({ ok: false, reason: 'invalid_email' });
    expect(emailEligibility({ email: 'a@b.co', marketingConsent: true }, { unsubscribed: none }).ok).toBe(true);
  });
  it('plan excludes non-consenting, unsubscribed, recent; applies caps; dedupes', () => {
    const plan = planRecipients(
      [{ email: 'yes@x.co', marketingConsent: true }, { email: 'YES@x.co', marketingConsent: true }, { email: 'no@x.co', marketingConsent: false }, { email: 'un@x.co', marketingConsent: true }, { email: 'recent@x.co', marketingConsent: true }, { email: 'c1@x.co', marketingConsent: true }, { email: 'c2@x.co', marketingConsent: true }],
      { unsubscribed: new Set(['un@x.co']), recentlyEmailed: new Set(['recent@x.co']), maxRecipients: 2, dailyRemaining: 1 },
    );
    expect(plan.recipients).toEqual(['yes@x.co']);
    expect(plan.recipients).not.toContain('no@x.co');
    expect(plan.excluded).toMatchObject({ no_consent: 1, unsubscribed: 1, frequency_cap: 1, campaign_cap: 1, daily_limit: 1 });
  });
});

describe('signed tokens', () => {
  const S = 'test-secret-0123456789-0123456789';
  it('verify, and reject tampering / wrong kind / wrong secret', () => {
    const t = signToken('unsub', { e: 'a@b.co' }, S);
    expect(verifyToken('unsub', t, S)).toEqual({ e: 'a@b.co' });
    expect(verifyToken('click', t, S)).toBeNull();
    expect(verifyToken('unsub', t, 'other-secret')).toBeNull();
    const [p, sig] = t.split('.');
    expect(verifyToken('unsub', `${Buffer.from('{"e":"x@y.co"}').toString('base64url')}.${sig}`, S)).toBeNull();
    expect(verifyToken('unsub', `${p}.`, S)).toBeNull();
    expect(verifyToken('unsub', 'garbage', S)).toBeNull();
  });
  it('urls + redirect allow-list', () => {
    expect(unsubscribeUrl('https://api.x.co/', 'A@B.co', S, 'c1')).toMatch(/^https:\/\/api\.x\.co\/api\/v1\/unsubscribe\?token=/);
    expect(clickUrl('https://api.x.co', 'c1', 'a@b.co', 'https://shop.x.co/p/1', S)).toContain('/api/v1/r?token=');
    expect(isAllowedRedirect('https://shop.x.co/p/1', 'https://shop.x.co')).toBe(true);
    expect(isAllowedRedirect('https://evil.co/', 'https://shop.x.co')).toBe(false);
    expect(isAllowedRedirect('javascript:alert(1)', 'https://shop.x.co')).toBe(false);
  });
  it('email template adds an unsubscribe footer only when given', () => {
    const r = renderTemplate('marketing_campaign', { subject: 'Hi', message: 'One\n\nTwo', unsubscribeUrl: 'https://api.x.co/api/v1/unsubscribe?token=abc' });
    expect(r.html).toContain('Unsubscribe');
    expect(r.html.trim().endsWith('</div>')).toBe(true);
    expect(r.body).toContain('Unsubscribe: https://api.x.co');
    expect(renderTemplate('marketing_campaign', { subject: 'Hi', message: 'x' }).html).not.toContain('Unsubscribe');
  });
});

describe('experiments', () => {
  const V = [{ key: 'control', weight: 50 }, { key: 'b', weight: 50 }];
  it('bucketing is deterministic and roughly uniform', () => {
    expect(assignVariant('exp', 'visitor-1', V)).toBe(assignVariant('exp', 'visitor-1', V));
    const counts: Record<string, number> = { control: 0, b: 0 };
    for (let i = 0; i < 20_000; i++) counts[assignVariant('hero', `v-${i}`, V)]!++;
    expect(Math.abs(counts['control']! - 10_000)).toBeLessThan(300); // ~4 sigma
    const w = { a: 0, b: 0 } as Record<string, number>;
    for (let i = 0; i < 20_000; i++) w[assignVariant('w', `v-${i}`, [{ key: 'a', weight: 80 }, { key: 'b', weight: 20 }])]!++;
    expect(Math.abs(w['a']! / 20_000 - 0.8)).toBeLessThan(0.02);
    const u = bucketUnit('k', 'v');
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(1);
  });
  it('different experiments bucket independently', () => {
    let same = 0;
    for (let i = 0; i < 2000; i++) if (assignVariant('e1', `v${i}`, V) === assignVariant('e2', `v${i}`, V)) same++;
    expect(same / 2000).toBeGreaterThan(0.44);
    expect(same / 2000).toBeLessThan(0.56);
  });
  it('normal CDF and two-proportion z-test match reference values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    const t = twoProportionTest(100, 1000, 130, 1000)!;
    expect(t.z).toBeCloseTo(2.1027, 3);
    expect(t.pValue).toBeCloseTo(0.0355, 3);
    expect(t.ciLow).toBeLessThan(0.03);
    expect(t.ciHigh).toBeGreaterThan(0.03);
    expect(twoProportionTest(0, 0, 1, 1)).toBeNull();
  });
  it('says "not enough data" below thresholds and never ships', () => {
    const r = assessExperiment([{ key: 'control', exposures: 100, conversions: 10 }, { key: 'b', exposures: 100, conversions: 30 }]);
    expect(r.variants[1]!.verdict).toBe('not_enough_data');
    const big = assessExperiment([{ key: 'control', exposures: 1000, conversions: 100 }, { key: 'b', exposures: 1000, conversions: 130 }]);
    expect(big.variants[1]!.verdict).toBe('likely_better');
    expect(big.variants[1]!.summary).toMatch(/evidence, not proof/);
    const flat = assessExperiment([{ key: 'control', exposures: 1000, conversions: 100 }, { key: 'b', exposures: 1000, conversions: 104 }]);
    expect(flat.variants[1]!.verdict).toBe('no_clear_difference');
  });
});

describe('attribution', () => {
  it('classifies channels', () => {
    expect(classifyChannel({ clickIdType: 'gclid' })).toBe('paid_google');
    expect(classifyChannel({ clickIdType: 'fbclid' })).toBe('paid_meta');
    expect(classifyChannel({ utmSource: 'tiktok', utmMedium: 'paid_social' })).toBe('paid_tiktok');
    expect(classifyChannel({ utmMedium: 'email' })).toBe('email');
    expect(classifyChannel({ referrerHost: 'www.google.com' })).toBe('organic_search');
    expect(classifyChannel({ referrerHost: 'l.facebook.com' })).toBe('organic_social');
    expect(classifyChannel({ referrerHost: 'blog.example.org' })).toBe('referral');
    expect(classifyChannel({})).toBe('direct');
    expect(classifyChannel(null)).toBe('unattributed');
  });
  it('guidance is contribution based and honest about small samples', () => {
    const base = { channel: 'paid_meta' as const, orders: 40, netSalesUsd: 400_000, contributionKnownOrders: 40, contributionUsd: 100_000, adSpendUsd: 150_000 };
    expect(reportChannel(base).retainedContributionUsd).toBe(-50_000);
    expect(reportChannel(base).guidance).toMatch(/negative/);
    expect(reportChannel(base).cacUsd).toBe(3750);
    expect(reportChannel({ ...base, orders: 5 }).guidance).toMatch(/Insufficient data/);
    expect(reportChannel({ ...base, contributionKnownOrders: 0 }).retainedContributionUsd).toBeNull();
  });
});

describe('ads spend stays capped (proposal-only conventions)', () => {
  it('enforceSpendCaps scales budgets down to the daily limit and never above', () => {
    const out = enforceSpendCaps([{ id: 'a', dailyBudget: 6000 }, { id: 'b', dailyBudget: 6000 }], { dailyLimit: 6000, monthlyLimit: 1_000_000, monthSpentSoFar: 0, daysLeftInMonth: 10 });
    expect(out.reduce((a, b) => a + b.dailyBudget, 0)).toBeLessThanOrEqual(6000);
    const none = enforceSpendCaps([{ id: 'a', dailyBudget: 5000 }], { dailyLimit: 6000, monthlyLimit: 1000, monthSpentSoFar: 1000, daysLeftInMonth: 10 });
    expect(none[0]!.dailyBudget).toBe(0);
  });
});

describe('feeds', () => {
  const p = (o: Partial<FeedProductInput> = {}): FeedProductInput => ({ id: 'p1', slug: 'bowl', sku: 'SKU1', title: 'Bowl & "Mat" <Pro>', description: 'Nice =bowl', brand: 'Orvia', state: 'PUBLISHED', complianceStatus: 'passed', imageStatus: 'READY', images: [{ url: '/products/a.jpg' }, { url: 'https://cdn.x.co/b.jpg' }], category: 'dogs', topCategory: 'pet', market: { enabled: true, price: 1999, currency: 'USD', stock: 5 }, ...o });
  it('eligibility: only real, sellable, priced, compliant, non-demo products', () => {
    expect('item' in toFeedItem(p(), 'https://s.co')).toBe(true);
    expect(toFeedItem(p({ state: 'DRAFT' }), 'https://s.co')).toEqual({ excluded: 'not_sellable' });
    expect(toFeedItem(p({ isDemo: true }), 'https://s.co')).toEqual({ excluded: 'demo' });
    expect(toFeedItem(p({ complianceStatus: 'pending' }), 'https://s.co')).toEqual({ excluded: 'compliance' });
    expect(toFeedItem(p({ images: [] }), 'https://s.co')).toEqual({ excluded: 'no_real_image' });
    expect(toFeedItem(p({ images: [{ url: '/img/placeholder.png' }] }), 'https://s.co')).toEqual({ excluded: 'no_real_image' });
    expect(toFeedItem(p({ imageStatus: 'PENDING' }), 'https://s.co')).toEqual({ excluded: 'no_real_image' });
    expect(toFeedItem(p({ market: { enabled: true, price: 0, currency: 'USD', stock: 1 } }), 'https://s.co')).toEqual({ excluded: 'invalid_price' });
    expect(toFeedItem(p({ market: undefined }), 'https://s.co')).toEqual({ excluded: 'no_market' });
  });
  it('availability mirrors stock; id is the product id (matches pixel content ids); no compare-at anywhere', () => {
    const out = toFeedItem(p({ market: { enabled: true, price: 1999, currency: 'USD', stock: 0 } }), 'https://s.co') as { item: ReturnType<typeof Object> & { availability: string; id: string; price: string } };
    expect(out.item.availability).toBe('out_of_stock');
    expect(out.item.id).toBe('p1');
    expect(out.item.price).toBe('19.99 USD');
    const xml = buildGoogleFeedXml([(toFeedItem(p(), 'https://s.co') as any).item], { title: 't', link: 'https://s.co', description: 'd' });
    expect(xml).not.toMatch(/sale_price|compare/i);
  });
  it('XML and CSV escaping', () => {
    expect(xmlEscape('a&b<c>"d"\'e\u0001')).toBe('a&amp;b&lt;c&gt;&quot;d&quot;&apos;e');
    const item = (toFeedItem(p(), 'https://s.co') as any).item;
    const xml = buildGoogleFeedXml([item], { title: 'T & Co', link: 'https://s.co', description: 'd' });
    expect(xml).toContain('<title>Bowl &amp; &quot;Mat&quot; &lt;Pro&gt;</title>');
    expect(xml).toContain('<g:price>19.99 USD</g:price>');
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    const csv = buildMetaFeedCsv([item]);
    expect(csv.split('\r\n')[0]).toBe('id,title,description,availability,condition,price,link,image_link,additional_image_link,brand,product_type');
    expect(csv).toContain('"Bowl & ""Mat"" <Pro>"');
    expect(csv).toContain('in stock');
  });
});

describe('JSON-LD', () => {
  const base = { id: 'p1', slug: 'bowl', title: 'Bowl', description: 'd', brand: 'Orvia', images: [{ url: '/a.jpg' }], price: 1999, currency: 'USD', available: true, rating: { avg: 4.5, count: 12 } };
  it('valid Product with offer and rating only from real data', () => {
    const ld = buildProductJsonLd(base, 'https://s.co/') as any;
    expect(ld['@type']).toBe('Product');
    expect(ld.offers).toMatchObject({ price: '19.99', priceCurrency: 'USD', availability: 'https://schema.org/InStock' });
    expect(ld.image).toEqual(['https://s.co/a.jpg']);
    expect(ld.aggregateRating).toEqual({ '@type': 'AggregateRating', ratingValue: 4.5, reviewCount: 12 });
    expect(buildProductJsonLd({ ...base, rating: { avg: 0, count: 0 } }, 'https://s.co') as any).not.toHaveProperty('aggregateRating');
    expect(buildProductJsonLd({ ...base, rating: null }, 'https://s.co') as any).not.toHaveProperty('aggregateRating');
    expect(buildProductJsonLd({ ...base, price: null }, 'https://s.co') as any).not.toHaveProperty('offers');
    expect((buildProductJsonLd({ ...base, available: false }, 'https://s.co') as any).offers.availability).toBe('https://schema.org/OutOfStock');
  });
  it('breadcrumbs and safe serialisation', () => {
    const b = buildBreadcrumbJsonLd([{ label: 'Home', href: '/' }, { label: 'Pet', href: '/c/pet' }], 'https://s.co') as any;
    expect(b.itemListElement[1]).toMatchObject({ position: 2, name: 'Pet', item: 'https://s.co/c/pet' });
    const s = serializeJsonLd({ name: '</script><script>alert(1)' });
    expect(s).not.toContain('</script>');
    expect(JSON.parse(s).name).toBe('</script><script>alert(1)');
  });
});

describe('config safety', () => {
  const env = { NODE_ENV: 'test', EVENTS_PROVIDERS: 'meta, ga4, nope' } as NodeJS.ProcessEnv;
  it('parses enabled providers and production refuses log mode / missing credentials', () => {
    const cfg = loadConfig(env);
    expect(enabledEventProviders(cfg)).toEqual(['meta', 'ga4']);
    const problems = eventsConfigProblems(cfg);
    expect(problems.join(' ')).toMatch(/EVENTS_MODE=log/);
    expect(problems.join(' ')).toMatch(/META_PIXEL_ID/);
    expect(eventsConfigProblems(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv))).toEqual([]);
    const ok = loadConfig({ ...env, EVENTS_MODE: 'live', EVENTS_PROVIDERS: 'ga4', GA4_MEASUREMENT_ID: 'G-1', GA4_API_SECRET: 's' } as NodeJS.ProcessEnv);
    expect(eventsConfigProblems(ok)).toEqual([]);
  });
});
