import mongoose from 'mongoose';
import { AdMetric, ExceptionModel, Job, MarketSource, Product, Supplier, SystemSetting, User } from '@orvia/database';
import { EstimatedTaxProvider } from '@orvia/shipping';
import { providerDefinition } from '@orvia/suppliers';
import { getCountryConfigs } from '../infra/countries';
import type { Ctx } from '../infra/context';
import { automationReadiness, fulfillmentModeOf } from './supplierOps';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';
export interface Check { id: string; area: string; status: CheckStatus; title: string; detail: string; blocking: boolean; fix?: string }
export interface Readiness {
  generatedAt: string;
  environment: string;
  verdict: 'GO' | 'NO_GO';
  summary: { pass: number; warn: number; fail: number; blockers: number };
  areas: Record<string, { status: CheckStatus; checks: Check[] }>;
  blockers: Check[];
  warnings: Check[];
  providers: { name: string; configured: boolean; mode: string; status: string }[];
  verifications: Record<string, { status: CheckStatus; at: string; detail: string }>;
}

export const AREAS = ['DATABASE', 'STORAGE', 'AUTH', 'SUPPLIERS', 'PAYMENTS', 'SHIPPING', 'TAX', 'EMAIL', 'SMS', 'ADS', 'AI', 'MARKET INTEL', 'IMAGE SYSTEM', 'SECURITY', 'LEGAL', 'TESTS', 'INFRA'] as const;

const order: Record<CheckStatus, number> = { PASS: 0, WARN: 1, FAIL: 2 };
type Fetch = typeof fetch;
const timeout = <T>(p: Promise<T>, ms = 8000): Promise<T> => Promise.race([p, new Promise<T>((_r, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);

/** Live, read-only calls that prove credentials work (balance/list/me endpoints). Never creates orders, charges or campaigns. */
export async function runProviderChecks(ctx: Ctx, fetchImpl: Fetch = fetch): Promise<Record<string, { status: CheckStatus; detail: string }>> {
  const out: Record<string, { status: CheckStatus; detail: string }> = {};
  const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
  const call = async (key: string, fn: () => Promise<{ ok: boolean; detail: string }>) => {
    try { const r = await timeout(fn()); out[key] = { status: r.ok ? 'PASS' : 'FAIL', detail: r.detail }; } catch (e) { out[key] = { status: 'FAIL', detail: (e as Error).message }; }
  };
  const c = ctx.cfg;
  if (c.STRIPE_SECRET_KEY) await call('stripe', async () => { const r = await fetchImpl('https://api.stripe.com/v1/balance', { headers: { authorization: `Bearer ${c.STRIPE_SECRET_KEY}` } }); return { ok: r.ok, detail: r.ok ? `Stripe API reachable (${c.STRIPE_SECRET_KEY!.startsWith('sk_live') ? 'LIVE' : 'test'} key)` : `Stripe responded ${r.status}` }; });
  if (c.RAZORPAY_KEY_ID && c.RAZORPAY_KEY_SECRET) await call('razorpay', async () => { const r = await fetchImpl('https://api.razorpay.com/v1/payments?count=1', { headers: { authorization: basic(c.RAZORPAY_KEY_ID!, c.RAZORPAY_KEY_SECRET!) } }); return { ok: r.ok, detail: r.ok ? `Razorpay API reachable (${c.RAZORPAY_KEY_ID!.startsWith('rzp_live') ? 'LIVE' : 'test'} key)` : `Razorpay responded ${r.status}` }; });
  if (c.EMAIL_PROVIDER_KEY) await call('email', async () => {
    const r = await fetchImpl('https://api.resend.com/domains', { headers: { authorization: `Bearer ${c.EMAIL_PROVIDER_KEY}` } });
    if (!r.ok) return { ok: false, detail: `Resend responded ${r.status}` };
    const j = (await r.json()) as { data?: { name: string; status: string }[] };
    const domain = /<([^>]+)>/.exec(c.EMAIL_FROM)?.[1]?.split('@')[1] ?? c.EMAIL_FROM.split('@')[1] ?? '';
    const d = j.data?.find((x) => x.name === domain);
    return { ok: d?.status === 'verified', detail: d ? `sender domain ${domain}: ${d.status} (SPF/DKIM)` : `sender domain ${domain} is not registered with the email provider` };
  });
  if (c.TWILIO_ACCOUNT_SID && c.TWILIO_AUTH_TOKEN) await call('sms', async () => { const r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${c.TWILIO_ACCOUNT_SID}.json`, { headers: { authorization: basic(c.TWILIO_ACCOUNT_SID!, c.TWILIO_AUTH_TOKEN!) } }); return { ok: r.ok, detail: r.ok ? 'Twilio account reachable' : `Twilio responded ${r.status}` }; });
  if (c.GEMINI_API_KEY) await call('ai', async () => { const r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(c.GEMINI_API_KEY!)}`); return { ok: r.ok, detail: r.ok ? 'Gemini API reachable' : `Gemini responded ${r.status}` }; });
  for (const p of ['meta', 'tiktok', 'google'] as const) {
    if (!ctx.ads.status()[p]?.configured) continue;
    await call(`ads:${p}`, async () => { const h = await ctx.ads.get(p).healthCheck(); return { ok: h.ok, detail: h.message }; });
  }
  const st = await ctx.storage.health();
  out['storage'] = { status: st.ok ? 'PASS' : 'FAIL', detail: st.message };
  return out;
}

/** The launch gate. Pure reads (plus optional live provider calls); every FAIL with `blocking` makes the verdict NO_GO. */
export async function launchReadiness(ctx: Ctx, o: { live?: boolean; fetchImpl?: Fetch } = {}): Promise<Readiness> {
  const c = ctx.cfg;
  const checks: Check[] = [];
  const add = (area: (typeof AREAS)[number], id: string, status: CheckStatus, title: string, detail: string, blocking = status === 'FAIL', fix?: string) => checks.push({ id, area, status, title, detail, blocking: status === 'FAIL' && blocking, fix });
  const prod = c.APP_ENV === 'production';
  const live = o.live ? await runProviderChecks(ctx, o.fetchImpl) : {};
  const stored = (await ctx.settings.get('launch')).results;
  const verified = (k: string) => live[k] ?? stored[k];
  if (o.live) await SystemSetting.updateOne({ key: 'launch' }, { $set: { 'value.results': { ...stored, ...Object.fromEntries(Object.entries(live).map(([k, v]) => [k, { ...v, at: new Date().toISOString() }])) } } }, { upsert: true });
  if (o.live) ctx.settings.invalidate();

  // DATABASE
  try {
    await timeout(mongoose.connection.db!.admin().ping(), 5000);
    add('DATABASE', 'db.ping', 'PASS', 'MongoDB reachable', `${mongoose.connection.name}`);
    const missing: string[] = [];
    for (const name of mongoose.modelNames()) { const m = mongoose.model(name); const d = await m.diffIndexes().catch(() => ({ toCreate: [] as unknown[] })); if (d.toCreate.length) missing.push(`${name}(${d.toCreate.length})`); }
    add('DATABASE', 'db.indexes', missing.length ? 'FAIL' : 'PASS', 'Indexes match the code', missing.length ? `Missing: ${missing.slice(0, 6).join(', ')}` : 'all declared indexes exist', true, 'Run npm run migrate');
  } catch (e) { add('DATABASE', 'db.ping', 'FAIL', 'MongoDB unreachable', (e as Error).message); }

  // STORAGE
  const stHealth = await ctx.storage.health();
  const st: { status: CheckStatus; detail: string } = verified('storage') ?? { status: stHealth.ok ? 'PASS' : 'FAIL', detail: stHealth.message };
  add('STORAGE', 'storage.health', st.status, `Object storage (${ctx.storage.provider})`, st.detail);
  add('STORAGE', 'storage.provider', ctx.storage.provider === 's3' || !prod ? 'PASS' : 'FAIL', 'Production image storage', ctx.storage.provider === 's3' ? `S3-compatible bucket ${c.OBJECT_STORAGE_BUCKET}, served via ${c.CDN_BASE_URL}` : prod ? 'Local storage is not allowed in production' : 'Local storage (development only)');

  // AUTH
  add('AUTH', 'auth.jwt', c.JWT_SECRET.length >= 32 && !c.JWT_SECRET.startsWith('dev-only') ? 'PASS' : 'FAIL', 'JWT secret strength', c.JWT_SECRET.startsWith('dev-only') ? 'development fallback secret in use' : `${c.JWT_SECRET.length} characters`);
  add('AUTH', 'auth.enc', c.ENCRYPTION_KEY && /^[0-9a-f]{64}$/i.test(c.ENCRYPTION_KEY) ? 'PASS' : prod ? 'FAIL' : 'WARN', 'Credential encryption key', c.ENCRYPTION_KEY ? 'set' : 'ENCRYPTION_KEY missing: supplier credentials fall back to the JWT secret');
  const demoUsers = await User.countDocuments({ isDemo: true });
  const admins = await User.countDocuments({ role: { $in: ['SUPER_ADMIN', 'ADMIN'] }, isDemo: { $ne: true } });
  add('AUTH', 'auth.demo-users', demoUsers && prod ? 'FAIL' : demoUsers ? 'WARN' : 'PASS', 'No demo accounts', demoUsers ? `${demoUsers} demo account(s) exist (password is public)` : 'none');
  add('AUTH', 'auth.admin', admins > 0 ? 'PASS' : prod ? 'FAIL' : 'WARN', 'A real administrator exists', `${admins} non-demo admin account(s)`);

  // SUPPLIERS
  const countries = Object.values(await getCountryConfigs()).filter((x) => x.enabled);
  const sups = await Supplier.find({ active: true }).select('+credentialsEnc').lean();
  const real = sups.filter((s) => s.provider !== 'mock');
  const mocks = sups.filter((s) => s.provider === 'mock');
  add('SUPPLIERS', 'sup.mock', mocks.length && prod ? 'FAIL' : mocks.length ? 'WARN' : 'PASS', 'No mock suppliers', mocks.length ? `${mocks.length} mock supplier(s) active — they never count toward launch readiness` : 'none');
  for (const cn of countries) {
    const serving = real.filter((s) => !s.servesCountries?.length || s.servesCountries.includes(cn.code));
    const ok = serving.filter((s) => s.healthState !== 'FAILING' && (s.provider === 'manual' || s.credentialsEnc || (s.provider === 'cj' && c.CJ_API_KEY)));
    add('SUPPLIERS', `sup.cover.${cn.code}`, ok.length ? 'PASS' : 'FAIL', `${cn.name}: a working supplier`, ok.length ? ok.map((s) => `${s.code} [${fulfillmentModeOf(s)}]`).join(', ') : `no active, configured, non-failing supplier serves ${cn.name} — nothing can be sold or fulfilled there`, true, 'Add a supplier in Admin → Suppliers');
    const auto = ok.filter((s) => fulfillmentModeOf(s) === 'AUTOMATED' && automationReadiness(s).ok);
    if (ok.length && !auto.length) add('SUPPLIERS', `sup.auto.${cn.code}`, 'WARN', `${cn.name}: fulfilment is not automated`, 'Orders will wait for a human (ASSISTED/MANUAL) until a supplier passes the validation suite and is set to AUTOMATED');
  }
  for (const s of real) if (s.provider !== 'manual' && !automationReadiness(s).ok) add('SUPPLIERS', `sup.val.${s.code}`, 'WARN', `${s.code}: not fully validated`, `Missing checks: ${automationReadiness(s).missing.join(', ')}`);
  for (const s of real) if (providerDefinition(s.provider)?.integrationStatus === 'implemented_unverified') add('SUPPLIERS', `sup.unverified.${s.code}`, 'WARN', `${s.code} (${s.provider}) adapter is unverified`, 'Run the validation suite against the real account before enabling AUTOMATED fulfilment');

  // PAYMENTS
  const stripeNeeded = countries.some((x) => x.paymentProviders.includes('stripe')); const rzpNeeded = countries.some((x) => x.paymentProviders.includes('razorpay'));
  add('PAYMENTS', 'pay.mode', c.PAYMENT_MODE === 'live' ? 'PASS' : prod ? 'FAIL' : 'WARN', 'Live payment mode', `PAYMENT_MODE=${c.PAYMENT_MODE}`);
  if (stripeNeeded) { add('PAYMENTS', 'pay.stripe.cfg', c.STRIPE_SECRET_KEY && c.STRIPE_WEBHOOK_SECRET && c.STRIPE_PUBLISHABLE_KEY ? 'PASS' : 'FAIL', 'Stripe credentials + webhook secret', c.STRIPE_SECRET_KEY ? (c.STRIPE_WEBHOOK_SECRET ? 'configured' : 'webhook secret missing — webhooks could not be verified') : 'not configured'); const v = verified('stripe'); add('PAYMENTS', 'pay.stripe.live', v ? v.status : 'WARN', 'Stripe API verified', v?.detail ?? 'not verified yet — run verify:staging with live credentials', false); }
  if (rzpNeeded) { add('PAYMENTS', 'pay.rzp.cfg', c.RAZORPAY_KEY_ID && c.RAZORPAY_KEY_SECRET && c.RAZORPAY_WEBHOOK_SECRET ? 'PASS' : 'FAIL', 'Razorpay credentials + webhook secret', c.RAZORPAY_KEY_ID ? (c.RAZORPAY_WEBHOOK_SECRET ? 'configured' : 'webhook secret missing') : 'not configured'); const v = verified('razorpay'); add('PAYMENTS', 'pay.rzp.live', v ? v.status : 'WARN', 'Razorpay API verified', v?.detail ?? 'not verified yet', false); }

  // SHIPPING
  for (const cn of countries) add('SHIPPING', `ship.cfg.${cn.code}`, cn.shippingMethods.length ? 'PASS' : 'FAIL', `${cn.name}: shipping methods`, cn.shippingMethods.map((m) => m.label).join(', ') || 'none configured');
  add('SHIPPING', 'ship.tracking', real.some((s) => automationReadiness(s).checked['tracking'] === 'pass') ? 'PASS' : 'WARN', 'Tracking proven with a supplier', 'Tracking numbers only ever come from the supplier; run the tracking validation against a real order');

  // TAX
  const tax = new EstimatedTaxProvider();
  for (const cn of countries) { const v = tax.validate(cn); add('TAX', `tax.${cn.code}`, v.ok ? 'WARN' : 'FAIL', `${cn.name}: tax = ESTIMATED`, v.ok ? 'Using the built-in rate table. Shown to customers as estimated tax/duties; connect a tax engine (Stripe Tax, TaxJar, GST service) for filing-grade tax' : v.problems.join('; '), true); }

  // EMAIL / SMS
  add('EMAIL', 'email.mode', c.NOTIFY_MODE === 'live' && c.EMAIL_PROVIDER_KEY ? 'PASS' : prod ? 'FAIL' : 'WARN', 'Transactional email', c.NOTIFY_MODE === 'live' ? (c.EMAIL_PROVIDER_KEY ? 'provider key set' : 'EMAIL_PROVIDER_KEY missing') : 'NOTIFY_MODE=log (emails are not delivered)');
  const legal = await ctx.settings.get('legal');
  const ev = verified('email');
  add('EMAIL', 'email.domain', ev ? ev.status : legal.emailDomainVerified ? 'PASS' : 'WARN', 'Sender domain verified (SPF/DKIM)', ev?.detail ?? (legal.emailDomainVerified ? 'operator attested' : 'not verified — mail may land in spam'), false);
  add('SMS', 'sms.cfg', c.TWILIO_ACCOUNT_SID && c.TWILIO_AUTH_TOKEN && c.TWILIO_FROM ? 'PASS' : 'WARN', 'SMS / WhatsApp (optional)', c.TWILIO_ACCOUNT_SID ? 'configured' : 'not configured — order SMS disabled');

  // ADS
  add('ADS', 'ads.mode', c.ADS_MODE === 'live' ? 'PASS' : prod ? 'FAIL' : 'WARN', 'Ad provider mode', `ADS_MODE=${c.ADS_MODE}`, true);
  const adStatus = ctx.ads.status();
  add('ADS', 'ads.cfg', Object.values(adStatus).some((x) => x.configured) ? 'PASS' : 'WARN', 'An ad platform is configured (optional)', Object.entries(adStatus).map(([k, v]) => `${k}: ${v.configured ? 'configured' : 'not configured'}`).join(', '));
  const adm = await AdMetric.countDocuments({ isDemo: { $ne: true } });
  add('ADS', 'ads.spend-guard', 'PASS', 'Spend caps enforced in code', `automatic ads stay ${(await ctx.settings.automationMode('ad_optimization'))} and never launch unless the platform API accepted the campaign (${adm} real metric rows)`);

  // AI
  const ai = verified('ai');
  add('AI', 'ai.key', c.GEMINI_API_KEY ? (ai?.status ?? 'PASS') : 'WARN', 'Gemini (content, copilot summaries)', c.GEMINI_API_KEY ? (ai?.detail ?? 'key set') : 'no key — deterministic template content is used (labelled source: template)', false);

  // MARKET INTEL
  const srcs = await MarketSource.find({ enabled: true }).select('healthStatus').lean();
  add('MARKET INTEL', 'market.sources', srcs.length ? (srcs.some((s) => s.healthStatus === 'HEALTHY') ? 'PASS' : 'WARN') : 'WARN', 'Public market sources', srcs.length ? `${srcs.filter((s) => s.healthStatus === 'HEALTHY').length}/${srcs.length} healthy` : 'none configured — trends/competitor prices stay empty (nothing is invented)', false);

  // IMAGE SYSTEM
  let sharpOk = true; try { await import('sharp'); } catch { sharpOk = false; }
  add('IMAGE SYSTEM', 'img.sharp', sharpOk ? 'PASS' : 'FAIL', 'Image processing library', sharpOk ? 'sharp loaded' : 'sharp failed to load');
  const noImg = await Product.countDocuments({ state: { $in: ['PUBLISHED', 'TESTING', 'WINNER', 'SCALING'] }, imageStatus: { $ne: 'READY' } });
  add('IMAGE SYSTEM', 'img.live-products', noImg ? 'FAIL' : 'PASS', 'Every live product has an image', noImg ? `${noImg} live product(s) have no usable image` : 'ok', true);
  const demoArt = prod ? await Product.countDocuments({ 'images.url': /^\/art\// }) : 0;
  add('IMAGE SYSTEM', 'img.demo-art', demoArt ? 'FAIL' : 'PASS', 'No demo art in production', demoArt ? `${demoArt} product(s) still use demo art` : 'none');

  // SECURITY
  add('SECURITY', 'sec.cookie', c.COOKIE_SECURE ? 'PASS' : prod ? 'FAIL' : 'WARN', 'Secure cookies', String(c.COOKIE_SECURE));
  add('SECURITY', 'sec.cors', c.corsOrigins.every((x) => /^https:\/\//.test(x)) || !prod ? 'PASS' : 'FAIL', 'CORS origins are https', c.corsOrigins.join(', '));
  add('SECURITY', 'sec.private-fetch', c.ALLOW_PRIVATE_FETCH ? (prod ? 'FAIL' : 'WARN') : 'PASS', 'SSRF protection on', c.ALLOW_PRIVATE_FETCH ? 'ALLOW_PRIVATE_FETCH is on' : 'private addresses are blocked');
  add('SECURITY', 'sec.proxy', c.TRUST_PROXY || !prod ? 'PASS' : 'WARN', 'Client IPs trusted from the proxy', c.TRUST_PROXY ? 'TRUST_PROXY=true' : 'TRUST_PROXY=false: rate limits would apply per proxy, not per visitor', false);
  add('SECURITY', 'sec.metrics', c.METRICS_TOKEN || !prod ? 'PASS' : 'WARN', '/metrics protected', c.METRICS_TOKEN ? 'bearer token set' : 'METRICS_TOKEN not set', false);
  add('SECURITY', 'sec.mocks', c.SUPPLIER_MODE === 'live' && c.PAYMENT_MODE === 'live' && c.ADS_MODE === 'live' && c.NOTIFY_MODE === 'live' ? 'PASS' : prod ? 'FAIL' : 'WARN', 'No mock providers', `supplier=${c.SUPPLIER_MODE} payment=${c.PAYMENT_MODE} ads=${c.ADS_MODE} notify=${c.NOTIFY_MODE}`);

  // LEGAL
  const legalOk = !c.LEGAL_REVIEW_REQUIRED || (legal.reviewConfirmed && legal.businessName && legal.registeredAddress && legal.supportEmail);
  add('LEGAL', 'legal.review', legalOk ? 'PASS' : 'FAIL', 'Legal review confirmed', legalOk ? `confirmed${legal.reviewedBy ? ` by ${legal.reviewedBy}` : ''}` : 'LEGAL_REVIEW_REQUIRED is on: confirm business details and legal review in Settings before launch', true, 'Settings → Legal');

  // TESTS
  const cert = (await ctx.settings.get('launch')).certification;
  add('TESTS', 'tests.cert', cert ? (Object.values(cert.checks).every((v) => v === 'PASS') ? 'PASS' : 'FAIL') : 'WARN', 'Release certification (lint, typecheck, tests, build, E2E)', cert ? `recorded ${cert.at}${cert.commit ? ` @ ${cert.commit}` : ''}: ${Object.entries(cert.checks).map(([k, v]) => `${k}=${v}`).join(', ')}` : 'no certification record — run npm run production-check on the release commit and store it', false);

  // INFRA
  const lastJob = await Job.findOne({ status: 'completed' }).sort({ completedAt: -1 }).select('completedAt name').lean();
  const age = lastJob?.completedAt ? Date.now() - lastJob.completedAt.getTime() : Infinity;
  add('INFRA', 'infra.worker', age < 30 * 60_000 ? 'PASS' : prod ? 'FAIL' : 'WARN', 'Worker is processing jobs', lastJob ? `last job ${lastJob.name} ${Math.round(age / 60_000)} min ago` : 'no completed job yet — is the worker running?', true);
  const dead = await Job.countDocuments({ status: 'dead' });
  add('INFRA', 'infra.dead', dead ? 'WARN' : 'PASS', 'No dead-lettered jobs', `${dead} dead job(s)`, false);
  const crit = await ExceptionModel.countDocuments({ status: { $in: ['open', 'in_progress'] }, priority: 'critical' });
  add('INFRA', 'infra.critical', crit ? 'WARN' : 'PASS', 'No critical open exceptions', `${crit} critical exception(s)`, false);
  add('INFRA', 'infra.terraform', 'WARN', 'Infrastructure code validated', 'Run terraform validate/plan for the target account (not verifiable from the application)', false);

  const areas: Readiness['areas'] = {};
  for (const a of AREAS) {
    const list = checks.filter((x) => x.area === a);
    areas[a] = { status: list.reduce<CheckStatus>((m, x) => (order[x.status] > order[m] ? x.status : m), 'PASS'), checks: list };
  }
  const blockers = checks.filter((x) => x.blocking);
  const verdict: Readiness['verdict'] = blockers.length ? 'NO_GO' : 'GO';
  const providers = [
    { name: 'Stripe', configured: !!c.STRIPE_SECRET_KEY, mode: c.PAYMENT_MODE, status: verified('stripe')?.status ?? 'UNVERIFIED' },
    { name: 'Razorpay', configured: !!c.RAZORPAY_KEY_ID, mode: c.PAYMENT_MODE, status: verified('razorpay')?.status ?? 'UNVERIFIED' },
    { name: 'Email (Resend)', configured: !!c.EMAIL_PROVIDER_KEY, mode: c.NOTIFY_MODE, status: verified('email')?.status ?? 'UNVERIFIED' },
    { name: 'SMS (Twilio)', configured: !!c.TWILIO_ACCOUNT_SID, mode: c.NOTIFY_MODE, status: verified('sms')?.status ?? 'UNVERIFIED' },
    { name: 'Gemini', configured: !!c.GEMINI_API_KEY, mode: c.GEMINI_API_KEY ? 'live' : 'template', status: verified('ai')?.status ?? 'UNVERIFIED' },
    ...Object.entries(adStatus).map(([k, v]) => ({ name: `Ads: ${k}`, configured: v.configured, mode: c.ADS_MODE, status: verified(`ads:${k}`)?.status ?? 'UNVERIFIED' })),
    ...sups.map((s) => ({ name: `Supplier: ${s.code}`, configured: s.provider === 'mock' ? true : s.provider === 'manual' || !!s.credentialsEnc || !!(s.provider === 'cj' && c.CJ_API_KEY), mode: `${s.provider}/${fulfillmentModeOf(s)}`, status: s.provider === 'mock' ? 'MOCK' : s.healthState })),
  ];
  return {
    generatedAt: new Date().toISOString(), environment: c.APP_ENV, verdict,
    summary: { pass: checks.filter((x) => x.status === 'PASS').length, warn: checks.filter((x) => x.status === 'WARN').length, fail: checks.filter((x) => x.status === 'FAIL').length, blockers: blockers.length },
    areas, blockers, warnings: checks.filter((x) => x.status === 'WARN'), providers, verifications: { ...stored, ...Object.fromEntries(Object.entries(live).map(([k, v]) => [k, { ...v, at: new Date().toISOString() }])) },
  };
}
