/**
 * customer360 data layer: consent, communication preferences, LifeGraph, Commerce Memory, privacy export and
 * deletion, the staff Customer 360 view, product companion and aftercare. DB-backed; the rules live in the pure
 * sibling files (lifegraph, consent, privacy, companion).
 */
import { createHmac } from 'node:crypto';
import { Types } from 'mongoose';
import {
  AddressModel, AnalyticsEvent, C360Consent, C360DeletionRequest, C360LifeNode, C360Memory, C360Profile, C360StaffNote, Cart, Customer, Notification, Order, Product,
  Referral, ReferralCode, Refund, ReturnRequest, Review, Session, Shipment, SupportTicket, User, Wishlist, rawCollection,
} from '@orvia/database';
import { CONSENT_KINDS, POLICY_VERSIONS } from '@orvia/types';
import type { Channel, ConsentKind, ConsentSource, ContactTopic, CountryCode, MemoryKind } from '@orvia/types';
import { DomainError, conflict, forbidden, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { audit } from '../../infra/audit';
import { similar, recommendedForYou } from '../recommendations';
import { applyPrefsPatch, canContact, canContactDecision, currentConsent } from './consent';
import type { ConsentState, ContactProfile, TopicPrefs } from './consent';
import { buildCompanion, decodeOrderItemId, encodeOrderItemId, replenishment } from './companion';
import { LIFEGRAPH_KINDS, deriveFromPurchases, personalizationSignals, rankWithSignals, toGraph, validateNode } from './lifegraph';
import type { GraphNode, LifeGraphInput } from './lifegraph';
import { EXPORT_SECTIONS, buildAnonymizationPlan, buildExport, coolingOffElapsed, coolingOffEnds, isAnonymizedEmail, maskEmail, maskName, memoryExpiry, minimizeProfileForStaff, notificationOwnerMatch, ownerMatch, stripSecrets } from './privacy';

type Obj = Record<string, unknown>;
const sid = (x: unknown) => String(x);
const MAX_NODES = 60;
const MAX_MEMORY = 200;
const MAX_PAYLOAD_BYTES = 8_000;

/** Salted-HMAC of an IP (never stored raw). The salt is the server secret, so hashes cannot be rebuilt by an attacker without it. */
export const hashIp = (ctx: Pick<Ctx, 'cfg'>, ip: string | undefined) => (ip ? createHmac('sha256', ctx.cfg.JWT_SECRET).update(`c360-ip:${ip}`).digest('hex').slice(0, 32) : undefined);

/* ====================================================================== */
/*  Profile row, consent and communication preferences                     */
/* ====================================================================== */
export async function getProfileRow(userId: string) {
  const row = await C360Profile.findOneAndUpdate({ userId }, { $setOnInsert: { userId } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  return row!;
}

export async function getConsentState(userId: string): Promise<ConsentState> {
  const rows = await C360Consent.find({ userId }).sort({ at: -1 }).limit(200).lean();
  return currentConsent(rows.map((r) => ({ kind: r.kind as ConsentKind, granted: r.granted, at: r.at ?? new Date(0), policyVersion: r.policyVersion })));
}

export async function consentHistory(userId: string, limit = 100) {
  const rows = await C360Consent.find({ userId }).sort({ at: -1 }).limit(limit).select('kind granted policyVersion source at actorId').lean();
  return rows.map((r) => ({ id: sid(r._id), kind: r.kind, granted: r.granted, policyVersion: r.policyVersion, source: r.source, at: r.at, byStaff: !!r.actorId }));
}

/** Record a consent change (append-only). Keeps Customer.marketingConsent (used by existing cart-recovery code) in sync. */
export async function recordConsent(ctx: Ctx, a: { userId: string; email?: string; kind: ConsentKind; granted: boolean; source: ConsentSource; ip?: string; actor?: Actor; reason?: string }) {
  if (!CONSENT_KINDS.includes(a.kind)) throw new DomainError('Unknown consent type', 'VALIDATION', 400);
  const prev = (await getConsentState(a.userId))[a.kind];
  const rec = await C360Consent.create({ userId: a.userId, kind: a.kind, granted: a.granted, policyVersion: POLICY_VERSIONS[a.kind], source: a.source, ipHash: hashIp(ctx, a.ip), actorId: a.actor?.type === 'user' ? a.actor.id : undefined, reason: a.reason, at: ctx.now() });
  if (a.kind === 'marketing_email') await Customer.updateOne({ $or: [{ userId: a.userId }, ...(a.email ? [{ email: a.email.toLowerCase() }] : [])] }, { $set: { marketingConsent: a.granted } });
  await audit(ctx, a.actor ?? { id: a.userId, type: 'user' }, { action: 'customer360.consent.changed', resource: 'user', resourceId: a.userId, previousValue: { kind: a.kind, granted: prev.granted }, newValue: { kind: a.kind, granted: a.granted, source: a.source, policyVersion: POLICY_VERSIONS[a.kind] }, reason: a.reason });
  return { id: sid(rec._id), kind: a.kind, granted: a.granted, policyVersion: POLICY_VERSIONS[a.kind], at: rec.at };
}

export async function privacyOverview(userId: string) {
  const [state, history, profile, deletion] = await Promise.all([getConsentState(userId), consentHistory(userId, 50), getProfileRow(userId), activeDeletion(userId)]);
  return {
    consents: CONSENT_KINDS.map((k) => ({ kind: k, granted: state[k].granted, at: state[k].at ?? null, policyVersion: state[k].policyVersion ?? null, currentPolicyVersion: POLICY_VERSIONS[k] })),
    history,
    switches: { lifegraphEnabled: profile.lifegraphEnabled, memoryEnabled: profile.memoryEnabled, memoryRetentionDays: profile.memoryRetentionDays, replenishmentOptIn: profile.replenishmentOptIn },
    deletion,
  };
}

export async function getCommPrefs(userId: string) {
  const p = await getProfileRow(userId);
  return { topics: (p.commPrefs ?? {}) as TopicPrefs, replenishmentOptIn: p.replenishmentOptIn };
}

export async function setCommPrefs(ctx: Ctx, userId: string, patch: TopicPrefs, replenishmentOptIn: boolean | undefined, actor: Actor) {
  const p = await getProfileRow(userId);
  const next = applyPrefsPatch((p.commPrefs ?? {}) as TopicPrefs, patch);
  const set: Obj = { commPrefs: next };
  if (replenishmentOptIn !== undefined) set.replenishmentOptIn = replenishmentOptIn;
  await C360Profile.updateOne({ userId }, { $set: set });
  await audit(ctx, actor, { action: 'customer360.preferences.changed', resource: 'user', resourceId: userId, previousValue: p.commPrefs, newValue: next });
  return getCommPrefs(userId);
}

/** Contact profile for `canContact`. Fails closed: a missing user is treated as deleted. */
export async function loadContactProfile(by: { userId?: string; email?: string }): Promise<ContactProfile> {
  const user = by.userId ? await User.findById(by.userId).select('disabled deletedAt email').lean() : by.email ? await User.findOne({ email: by.email.toLowerCase() }).select('disabled deletedAt email').lean() : null;
  if (!user) return { deleted: true, consents: currentConsent([]), prefs: {} };
  const userId = sid(user._id);
  const [consents, profile] = await Promise.all([getConsentState(userId), C360Profile.findOne({ userId }).select('commPrefs').lean()]);
  return { deleted: !!user.deletedAt || isAnonymizedEmail(user.email), suppressed: !!user.disabled && !user.deletedAt, consents, prefs: (profile?.commPrefs ?? {}) as TopicPrefs };
}

/** Convenience for senders (events workstream): `await canContactUser({ userId }, 'promotions', 'email')`. */
export async function canContactUser(by: { userId?: string; email?: string }, topic: ContactTopic, channel: Channel): Promise<boolean> {
  return canContact(await loadContactProfile(by), topic, channel);
}
export { canContact, canContactDecision };

/* ====================================================================== */
/*  LifeGraph                                                              */
/* ====================================================================== */
export async function lifeGraphView(userId: string) {
  const [profile, consents, nodes] = await Promise.all([getProfileRow(userId), getConsentState(userId), C360LifeNode.find({ userId }).sort({ createdAt: 1 }).limit(MAX_NODES).lean()]);
  const gnodes: GraphNode[] = nodes.map((n) => ({ id: sid(n._id), kind: n.kind, value: n.value, source: n.source as GraphNode['source'], parentId: n.parentId ? sid(n.parentId) : undefined }));
  return {
    enabled: profile.lifegraphEnabled,
    personalizationConsent: consents.personalization.granted,
    nodes: nodes.map((n) => ({ id: sid(n._id), kind: n.kind, label: LIFEGRAPH_KINDS[n.kind]?.label ?? n.kind, value: n.value, purpose: n.purpose, source: n.source, parentId: n.parentId ? sid(n.parentId) : null, consentVersion: n.consentVersion ?? null, createdAt: (n as unknown as { createdAt: Date }).createdAt })),
    graph: toGraph(gnodes),
    kinds: Object.entries(LIFEGRAPH_KINDS).map(([kind, s]) => ({ kind, label: s.label, values: s.values, purpose: s.purpose, parentKind: s.parentKind ?? null })),
  };
}

export async function loadLifeGraphInput(userId: string): Promise<LifeGraphInput> {
  const [profile, consents, nodes] = await Promise.all([getProfileRow(userId), getConsentState(userId), C360LifeNode.find({ userId }).limit(MAX_NODES).lean()]);
  return { enabled: profile.lifegraphEnabled, personalizationConsent: consents.personalization.granted, nodes: nodes.map((n) => ({ id: sid(n._id), kind: n.kind, value: n.value, source: n.source as GraphNode['source'], parentId: n.parentId ? sid(n.parentId) : undefined })) };
}

/** Public helper for discovery / other workstreams. Empty, inactive signals when off or without consent. */
export async function personalizationSignalsFor(userId: string) {
  return personalizationSignals(await loadLifeGraphInput(userId));
}

export async function setLifeGraphEnabled(ctx: Ctx, userId: string, enabled: boolean, actor: Actor) {
  await getProfileRow(userId);
  await C360Profile.updateOne({ userId }, { $set: { lifegraphEnabled: enabled } });
  await audit(ctx, actor, { action: 'customer360.lifegraph.toggled', resource: 'user', resourceId: userId, newValue: { enabled } });
  return { enabled };
}

export async function addLifeNode(ctx: Ctx, userId: string, input: { kind: string; value: string; parentId?: string }, actor: Actor) {
  const profile = await getProfileRow(userId);
  if (!profile.lifegraphEnabled) throw new DomainError('Turn LifeGraph on first', 'LIFEGRAPH_OFF', 409);
  const v = validateNode(input);
  if (!v.ok) throw new DomainError(v.reason, 'LIFEGRAPH_REJECTED', 422);
  if ((await C360LifeNode.countDocuments({ userId })) >= MAX_NODES) throw conflict('LifeGraph limit reached', 'LIMIT');
  let parentId: string | undefined;
  if (v.spec.parentKind) {
    if (!input.parentId) throw new DomainError(`This needs a ${LIFEGRAPH_KINDS[v.spec.parentKind]!.label.toLowerCase()} to attach to`, 'VALIDATION', 400);
    const parent = await C360LifeNode.findOne({ _id: input.parentId, userId }).lean(); // ownership: parent must be the caller's
    if (!parent || parent.kind !== v.spec.parentKind) throw notFound('Parent node');
    parentId = sid(parent._id);
  }
  if (v.spec.single) await C360LifeNode.deleteMany({ userId, kind: v.kind });
  try {
    const n = await C360LifeNode.create({ userId, kind: v.kind, value: v.value, parentId, purpose: v.spec.purpose, source: 'declared', consentVersion: POLICY_VERSIONS.personalization });
    await audit(ctx, actor, { action: 'customer360.lifegraph.node_added', resource: 'user', resourceId: userId, newValue: { kind: v.kind, source: 'declared' } });
    return { id: sid(n._id) };
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw conflict('You already added that', 'DUPLICATE');
    throw e;
  }
}

export async function deleteLifeNode(ctx: Ctx, userId: string, nodeId: string, actor: Actor) {
  const n = await C360LifeNode.findOneAndDelete({ _id: nodeId, userId }).lean(); // userId in the filter = ownership
  if (!n) throw notFound('LifeGraph item');
  await C360LifeNode.deleteMany({ userId, parentId: n._id });
  await audit(ctx, actor, { action: 'customer360.lifegraph.node_deleted', resource: 'user', resourceId: userId, previousValue: { kind: n.kind, source: n.source } });
  return { ok: true };
}

export async function deleteLifeGraph(ctx: Ctx, userId: string, actor: Actor) {
  const r = await C360LifeNode.deleteMany({ userId });
  await C360Profile.updateOne({ userId }, { $set: { lifegraphEnabled: false } });
  await audit(ctx, actor, { action: 'customer360.lifegraph.erased', resource: 'user', resourceId: userId, newValue: { removed: r.deletedCount } });
  return { removed: r.deletedCount };
}

/** Create `derived_from_purchases` nodes (visible, deletable) from delivered/paid orders. Needs LifeGraph on + personalization consent. */
export async function deriveLifeGraph(ctx: Ctx, user: { id: string; email: string; emailVerified?: boolean }, actor: Actor) {
  const [profile, consents] = await Promise.all([getProfileRow(user.id), getConsentState(user.id)]);
  if (!profile.lifegraphEnabled || !consents.personalization.granted) throw new DomainError('Turn on LifeGraph and personalization to use purchase-based suggestions', 'LIFEGRAPH_OFF', 409);
  const orders = await Order.find({ ...ownerMatch(user.id, user.email, !!user.emailVerified), 'payment.status': 'succeeded' }).sort({ createdAt: -1 }).limit(50).select('items.productId').lean();
  const ids = orders.flatMap((o) => o.items.map((i) => i.productId));
  const prods = await Product.find({ _id: { $in: ids } }).select('category').lean();
  const cat = new Map(prods.map((p) => [sid(p._id), p.category ?? '']));
  const derived = deriveFromPurchases(ids.map((id) => cat.get(sid(id)) ?? ''));
  let created = 0;
  for (const d of derived) {
    if ((await C360LifeNode.countDocuments({ userId: user.id })) >= MAX_NODES) break;
    const r = await C360LifeNode.updateOne({ userId: user.id, kind: d.kind, value: d.value }, { $setOnInsert: { userId: user.id, kind: d.kind, value: d.value, purpose: 'recommendations', source: 'derived_from_purchases', consentVersion: POLICY_VERSIONS.personalization } }, { upsert: true });
    created += r.upsertedCount;
  }
  await audit(ctx, actor, { action: 'customer360.lifegraph.derived', resource: 'user', resourceId: user.id, newValue: { created } });
  return { created, derived };
}

/* ====================================================================== */
/*  Commerce Memory                                                        */
/* ====================================================================== */
export interface MemoryInput { kind: MemoryKind; title: string; payload?: Record<string, unknown> }

/**
 * Write a memory item for a customer. Exported for the `find` workstream (saved comparisons, requirements ...).
 * Only call this in response to an explicit customer action ("Save this comparison"). Honors the customer's global switch
 * (returns `{ saved: false, reason: 'memory_off' }` instead of throwing) and the retention setting.
 */
export async function saveMemoryItem(ctx: Pick<Ctx, 'now'>, userId: string, input: MemoryInput, origin = 'customer'): Promise<{ saved: true; id: string } | { saved: false; reason: 'memory_off' | 'limit' | 'too_large' }> {
  const profile = await getProfileRow(userId);
  if (!profile.memoryEnabled) return { saved: false, reason: 'memory_off' };
  const payload = input.payload ?? {};
  if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) return { saved: false, reason: 'too_large' };
  if ((await C360Memory.countDocuments({ userId })) >= MAX_MEMORY) return { saved: false, reason: 'limit' };
  const now = ctx.now();
  const doc = await C360Memory.create({ userId, kind: input.kind, title: input.title.slice(0, 120), payload, origin, expiresAt: memoryExpiry(now, profile.memoryRetentionDays) ?? undefined });
  return { saved: true, id: sid(doc._id) };
}

const memView = (m: Obj) => ({ id: sid(m._id), kind: m.kind, title: m.title, payload: m.payload, enabled: m.enabled, origin: m.origin, expiresAt: m.expiresAt ?? null, createdAt: m.createdAt });

export async function listMemory(userId: string, page = 1, pageSize = 50) {
  const [profile, items, total] = await Promise.all([getProfileRow(userId), C360Memory.find({ userId }).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(), C360Memory.countDocuments({ userId })]);
  return { settings: { enabled: profile.memoryEnabled, retentionDays: profile.memoryRetentionDays }, items: items.map((m) => memView(m as unknown as Obj)), total, page, pageSize };
}

export async function patchMemory(ctx: Ctx, userId: string, id: string, patch: { title?: string; payload?: Record<string, unknown>; enabled?: boolean }, actor: Actor) {
  if (patch.payload && JSON.stringify(patch.payload).length > MAX_PAYLOAD_BYTES) throw new DomainError('Too large', 'VALIDATION', 400);
  const m = await C360Memory.findOneAndUpdate({ _id: id, userId }, { $set: patch }, { new: true }).lean(); // ownership in filter
  if (!m) throw notFound('Memory item');
  await audit(ctx, actor, { action: 'customer360.memory.updated', resource: 'user', resourceId: userId, newValue: { id, fields: Object.keys(patch) } });
  return memView(m as unknown as Obj);
}

export async function deleteMemory(ctx: Ctx, userId: string, id: string | null, actor: Actor) {
  const r = id ? await C360Memory.deleteOne({ _id: id, userId }) : await C360Memory.deleteMany({ userId });
  if (id && !r.deletedCount) throw notFound('Memory item');
  await audit(ctx, actor, { action: id ? 'customer360.memory.deleted' : 'customer360.memory.erased', resource: 'user', resourceId: userId, newValue: { removed: r.deletedCount } });
  return { removed: r.deletedCount };
}

export async function setMemorySettings(ctx: Ctx, userId: string, s: { enabled?: boolean; retentionDays?: number }, actor: Actor) {
  const set: Obj = {};
  if (s.enabled !== undefined) set.memoryEnabled = s.enabled;
  if (s.retentionDays !== undefined) set.memoryRetentionDays = s.retentionDays;
  await getProfileRow(userId);
  await C360Profile.updateOne({ userId }, { $set: set });
  if (s.retentionDays !== undefined) { // re-stamp expiry on existing items under the new policy
    const now = ctx.now();
    const items = await C360Memory.find({ userId }).select('createdAt').limit(MAX_MEMORY).lean();
    for (const m of items) await C360Memory.updateOne({ _id: m._id }, { $set: { expiresAt: memoryExpiry((m as unknown as { createdAt: Date }).createdAt, s.retentionDays) ?? null } });
    await C360Memory.deleteMany({ userId, expiresAt: { $lte: now } });
  }
  await audit(ctx, actor, { action: 'customer360.memory.settings', resource: 'user', resourceId: userId, newValue: s });
  const p = await getProfileRow(userId);
  return { enabled: p.memoryEnabled, retentionDays: p.memoryRetentionDays };
}

/* ====================================================================== */
/*  Defensive readers for other workstreams                                */
/* ====================================================================== */
export interface LoyaltyReader { read(userId: string): Promise<{ tier?: string; points?: number; updatedAt?: Date } | null> }
export interface RescueReader { list(user: { id: string; email: string }, limit: number): Promise<{ id: string; status: string; kind?: string; orderId?: string; createdAt?: Date }[]> }

/** Collection names owned by the creators / rescue workstreams. If they differ at integration time, change these constants only. */
export const LOYALTY_COLLECTION = 'loyalty_accounts';
export const RESCUE_COLLECTION = 'rescue_cases';
const idVariants = (id: string): unknown[] => (Types.ObjectId.isValid(id) ? [id, new Types.ObjectId(id)] : [id]);

export const loyaltyReader: LoyaltyReader = {
  async read(userId) {
    try {
      const col = rawCollection(LOYALTY_COLLECTION);
      if (!col) return null;
      const d = await col.findOne({ userId: { $in: idVariants(userId) } } as never);
      if (!d) return null;
      const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
      return { tier: typeof d.tier === 'string' ? d.tier : undefined, points: num(d.points) ?? num(d.balance), updatedAt: d.updatedAt instanceof Date ? d.updatedAt : undefined };
    } catch {
      return null;
    }
  },
};

export const rescueReader: RescueReader = {
  async list(user, limit) {
    try {
      const col = rawCollection(RESCUE_COLLECTION);
      if (!col) return [];
      const rows = await col.find({ $or: [{ userId: { $in: idVariants(user.id) } }, ...(user.email ? [{ customerEmail: user.email }, { email: user.email }] : [])] } as never).sort({ createdAt: -1 }).limit(limit).toArray();
      return rows.map((d) => ({ id: String(d._id), status: typeof d.status === 'string' ? d.status : 'open', kind: typeof d.kind === 'string' ? d.kind : undefined, orderId: d.orderId ? String(d.orderId) : undefined, createdAt: d.createdAt instanceof Date ? d.createdAt : undefined }));
    } catch {
      return [];
    }
  },
};

/* ====================================================================== */
/*  Recommendations (own endpoint only)                                    */
/* ====================================================================== */
export async function accountRecommendations(ctx: Ctx, user: { id: string }, country: CountryCode, limit = 12) {
  const input = await loadLifeGraphInput(user.id);
  const signals = personalizationSignals(input);
  const base = await recommendedForYou({ country, userId: user.id }, Math.min(limit * 3, 36));
  if (!signals.active) return { personalized: false, items: base.slice(0, limit).map((p) => ({ product: p, reasons: [] as string[] })), note: 'LifeGraph personalization is off, so these are general suggestions.' };
  const prods = await Product.find({ _id: { $in: base.map((b) => b.id) } }).select('tags organic.evidence').lean();
  const meta = new Map(prods.map((p) => [sid(p._id), p]));
  const ranked = rankWithSignals(base.map((b) => {
    const m = meta.get(b.id);
    return { id: b.id, category: b.category, topCategory: b.topCategory, tags: (m?.tags ?? []) as string[], price: b.price, ecoVerified: !!m?.organic?.evidence?.some((e) => e.verified) };
  }), signals);
  const byId = new Map(base.map((b) => [b.id, b]));
  return { personalized: true, items: ranked.slice(0, limit).map((r) => ({ product: byId.get(r.id)!, reasons: r.reasons })), note: null };
}

/* ====================================================================== */
/*  Export                                                                 */
/* ====================================================================== */
export async function exportCustomerData(ctx: Ctx, user: { id: string; email: string; emailVerified: boolean }, actor: Actor) {
  const owner = ownerMatch(user.id, user.email, user.emailVerified); // email only counts once verified (see ownerMatch)
  const [account, customerRecord, addresses, orders, returns, tickets, wishlist, reviews, referralCode, referralsMade, consents, profile, nodes, memory, events, loyalty, notes, deletions, notifications] = await Promise.all([
    User.findById(user.id).lean(),
    Customer.findOne(owner).select('-riskFlags').lean(),
    AddressModel.find({ userId: user.id }).limit(50).lean(),
    Order.find(owner).sort({ createdAt: -1 }).limit(500).select('-fraud -costs -profit -attribution -idempotencyKey').lean(),
    ReturnRequest.find(owner).limit(200).lean(),
    SupportTicket.find(owner).limit(200).lean(),
    Wishlist.findOne({ userId: user.id }).lean(),
    Review.find({ userId: user.id }).limit(500).lean(),
    ReferralCode.findOne({ userId: user.id }).lean(),
    Referral.find({ referrerUserId: user.id }).limit(200).select('code status createdAt').lean(),
    C360Consent.find({ userId: user.id }).sort({ at: -1 }).limit(500).select('-ipHash').lean(),
    getProfileRow(user.id),
    C360LifeNode.find({ userId: user.id }).limit(MAX_NODES).lean(),
    C360Memory.find({ userId: user.id }).limit(MAX_MEMORY).lean(),
    AnalyticsEvent.find({ userId: user.id }).sort({ ts: -1 }).limit(1000).select('type productId category country ts').lean(),
    loyaltyReader.read(user.id),
    C360StaffNote.find({ userId: user.id }).sort({ createdAt: -1 }).limit(200).select('body createdAt').lean(),
    C360DeletionRequest.find({ userId: user.id }).limit(20).select('-staffNote').lean(),
    Notification.find(notificationOwnerMatch(user.id, user.email, user.emailVerified)).sort({ createdAt: -1 }).limit(200).select('channel template subject status createdAt').lean(),
  ]);
  const orderIds = orders.map((o) => o._id);
  const refunds = orderIds.length ? await Refund.find({ orderId: { $in: orderIds } }).limit(200).select('orderId amount currency reason status createdAt').lean() : [];
  const out = buildExport({ userId: user.id }, {
    account, customerRecord, addresses, orders, returns, refunds, supportTickets: tickets,
    wishlist: wishlist?.productIds ?? [], reviews,
    referrals: { code: referralCode?.code ?? null, invitedFriends: referralsMade },
    consents, communicationPreferences: { topics: profile.commPrefs, replenishmentOptIn: profile.replenishmentOptIn },
    lifeGraph: { enabled: profile.lifegraphEnabled, nodes }, commerceMemory: { enabled: profile.memoryEnabled, retentionDays: profile.memoryRetentionDays, items: memory },
    productInteractions: events, loyalty, staffNotes: notes, deletionRequests: deletions, notificationsSent: notifications,
  }, ctx.now());
  await audit(ctx, actor, { action: 'customer360.export', resource: 'user', resourceId: user.id, newValue: { sections: EXPORT_SECTIONS.length } });
  return out;
}

/* ====================================================================== */
/*  Account deletion / anonymization                                       */
/* ====================================================================== */
export async function activeDeletion(userId: string) {
  const d = await C360DeletionRequest.findOne({ userId, status: { $in: ['requested', 'ready', 'on_hold'] } }).sort({ createdAt: -1 }).lean();
  return d ? { id: sid(d._id), status: d.status, requestedAt: d.requestedAt, coolingOffUntil: d.coolingOffUntil } : null;
}

export async function requestDeletion(ctx: Ctx, user: { id: string; email: string }, reason: string | undefined, actor: Actor) {
  if (await activeDeletion(user.id)) throw conflict('A deletion request is already open', 'ALREADY_REQUESTED');
  const now = ctx.now();
  const d = await C360DeletionRequest.create({ userId: user.id, reason, requestedAt: now, coolingOffUntil: coolingOffEnds(now) });
  await recordConsent(ctx, { userId: user.id, email: user.email, kind: 'marketing_email', granted: false, source: 'privacy_request', actor }); // stop marketing immediately
  await audit(ctx, actor, { action: 'customer360.deletion.requested', resource: 'user', resourceId: user.id, newValue: { requestId: sid(d._id), coolingOffUntil: d.coolingOffUntil } });
  return activeDeletion(user.id);
}

export async function cancelDeletion(ctx: Ctx, userId: string, actor: Actor) {
  const d = await C360DeletionRequest.findOneAndUpdate({ userId, status: { $in: ['requested', 'ready'] } }, { $set: { status: 'cancelled', processedAt: ctx.now() } }, { new: true }).lean();
  if (!d) throw notFound('Open deletion request'); // `on_hold` requests can only be resolved by staff
  await audit(ctx, actor, { action: 'customer360.deletion.cancelled', resource: 'user', resourceId: userId, newValue: { requestId: sid(d._id) } });
  return { ok: true };
}

/** Irreversible. Applies the pure anonymization plan; retains order/financial records minimally. Never touches other users' rows. */
export async function anonymizeAccount(ctx: Ctx, userId: string, actor: Actor) {
  const user = await User.findById(userId).lean();
  if (!user) throw notFound('Account');
  if (user.role !== 'CUSTOMER') throw forbidden('Only customer accounts can be anonymized here');
  const email = user.email;
  const plan = buildAnonymizationPlan(userId, email, ctx.cfg.JWT_SECRET, ctx.now());
  const verified = !!user.emailVerified;
  const owner = ownerMatch(userId, email, verified);
  const orderIds = (await Order.find(owner).select('_id').lean()).map((o) => o._id);
  // Order has immutable PII fields; the native driver bypasses mongoose immutability on purpose. Money / items / payment stay untouched.
  await Order.collection.updateMany({ _id: { $in: orderIds } }, { $set: plan.order });
  await Customer.updateMany(owner, { $set: plan.customer });
  await ReturnRequest.updateMany(owner, { $set: plan.returns });
  await SupportTicket.updateMany(owner, { $set: plan.ticket });
  await SupportTicket.updateMany(owner, { $set: { 'messages.$[m].text': '[removed]' } }, { arrayFilters: [{ 'm.from': 'customer' }] });
  await Review.updateMany({ userId }, { $set: plan.review });
  await Notification.updateMany(notificationOwnerMatch(userId, email, verified), { $set: plan.notification });
  const refs = await Referral.find({ $or: [{ referrerUserId: userId }, ...(verified ? [{ referrerEmail: email }, { refereeEmail: email }] : [])] }).select('_id').lean();
  for (const [i, r] of refs.entries()) await Referral.collection.updateOne({ _id: r._id }, { $set: plan.referral(String(i)) });
  await ReferralCode.deleteMany({ userId });
  await AddressModel.deleteMany({ userId });
  await Wishlist.deleteMany({ userId });
  await Cart.deleteMany({ userId });
  await Session.deleteMany({ userId });
  await AnalyticsEvent.deleteMany({ userId });
  await C360LifeNode.deleteMany({ userId });
  await C360Memory.deleteMany({ userId });
  await C360Profile.deleteMany({ userId });
  await C360StaffNote.deleteMany({ userId });
  // Consent log is kept as evidence; its IP hashes are dropped.
  await C360Consent.updateMany({ userId }, { $unset: { ipHash: 1 } });
  // password cannot be reset any more: reset/verify tokens are cleared, hash replaced by an unusable value
  await User.collection.updateOne({ _id: user._id }, { $set: { ...plan.user, passwordHash: `!${plan.token}` }, $unset: { verifyTokenHash: 1, resetTokenHash: 1, verifyTokenExpires: 1, resetTokenExpires: 1, lockUntil: 1 } });
  const result = { ordersRetained: orderIds.length, refsAnonymized: refs.length, retained: plan.retained };
  await audit(ctx, actor, { action: 'customer360.deletion.anonymized', resource: 'user', resourceId: userId, newValue: { ordersRetained: orderIds.length } });
  return result;
}

export async function listDeletionRequests(status?: string, page = 1, pageSize = 25) {
  const q = status ? { status } : {};
  const [rows, total] = await Promise.all([C360DeletionRequest.find(q).sort({ requestedAt: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean(), C360DeletionRequest.countDocuments(q)]);
  const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('email').lean();
  const em = new Map(users.map((u) => [sid(u._id), u.email]));
  const now = new Date();
  return { total, page, pageSize, items: rows.map((r) => ({ id: sid(r._id), userId: sid(r.userId), email: maskEmail(em.get(sid(r.userId))), status: r.status, reason: r.reason ?? null, requestedAt: r.requestedAt, coolingOffUntil: r.coolingOffUntil, coolingOffElapsed: coolingOffElapsed(r.requestedAt ?? now, now), processedAt: r.processedAt ?? null, staffNote: r.staffNote ?? null, result: r.result ?? null })) };
}

export async function processDeletion(ctx: Ctx, requestId: string, action: 'execute' | 'reject' | 'hold' | 'release', note: string, actor: Actor) {
  const d = await C360DeletionRequest.findById(requestId);
  if (!d) throw notFound('Deletion request');
  const userId = sid(d.userId);
  const open = ['requested', 'ready', 'on_hold'];
  if (!open.includes(d.status)) throw conflict(`Request is already ${d.status}`, 'ALREADY_PROCESSED');
  const now = ctx.now();
  if (action === 'execute') {
    if (d.status === 'on_hold') throw conflict('Release the legal hold first', 'ON_HOLD');
    if (!coolingOffElapsed(d.requestedAt ?? now, now)) throw conflict(`Cooling-off period runs until ${d.coolingOffUntil.toISOString()}`, 'COOLING_OFF');
    const result = await anonymizeAccount(ctx, userId, actor);
    d.status = 'completed'; d.processedAt = now; d.processedBy = actor.id; d.staffNote = note; d.result = result;
  } else if (action === 'reject') { d.status = 'rejected'; d.processedAt = now; d.processedBy = actor.id; d.staffNote = note; }
  else if (action === 'hold') { d.status = 'on_hold'; d.staffNote = note; }
  else { d.status = coolingOffElapsed(d.requestedAt ?? now, now) ? 'ready' : 'requested'; d.staffNote = note; }
  await d.save();
  await audit(ctx, actor, { action: `customer360.deletion.${action}`, resource: 'user', resourceId: userId, newValue: { requestId, status: d.status }, reason: note });
  return { id: requestId, status: d.status };
}

/* ====================================================================== */
/*  Staff: Customer 360                                                    */
/* ====================================================================== */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function searchCustomers(ctx: Ctx, actor: Actor, q: string, page = 1, pageSize = 20) {
  const term = q.trim().toLowerCase();
  const filter = { role: 'CUSTOMER', $or: [{ email: new RegExp(`^${escapeRe(term)}`) }, { name: new RegExp(escapeRe(term), 'i') }] };
  const [rows, total] = await Promise.all([User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).select('email name country createdAt deletedAt').lean(), User.countDocuments(filter)]);
  const cust = await Customer.find({ userId: { $in: rows.map((r) => r._id) } }).select('userId ordersCount lastOrderAt').lean();
  const cm = new Map(cust.map((c) => [sid(c.userId), c]));
  await audit(ctx, actor, { action: 'customer360.search', resource: 'user', newValue: { queryLength: term.length, results: rows.length } }); // the query itself is not logged (may be PII)
  return { total, page, pageSize, items: rows.map((u) => ({ userId: sid(u._id), email: maskEmail(u.email), name: maskName(u.name), country: u.country ?? null, ordersCount: cm.get(sid(u._id))?.ordersCount ?? 0, lastOrderAt: cm.get(sid(u._id))?.lastOrderAt ?? null, deleted: !!u.deletedAt })) };
}

export interface TimelineEvent { at: Date; type: string; summary: string; ref?: string }

export async function customer360Profile(ctx: Ctx, actor: Actor, userId: string, opts: { revealEmail: boolean; reason?: string }) {
  const user = await User.findById(userId).lean();
  if (!user || user.role !== 'CUSTOMER') throw notFound('Customer');
  const owner = { $or: [{ userId }, { email: user.email }] };
  const since = new Date(ctx.now().getTime() - 90 * 86_400_000);
  const [customer, profile, consents, history, nodes, orders, returns, tickets, notes, deletions, wishlist, mem, referralCode, referralsRewarded, ev, loyalty] = await Promise.all([
    Customer.findOne({ $or: [{ userId }, { email: user.email }] }).lean(),
    getProfileRow(userId), getConsentState(userId), consentHistory(userId, 30),
    C360LifeNode.find({ userId }).limit(MAX_NODES).select('kind value source').lean(),
    Order.find(owner).sort({ createdAt: -1 }).limit(25).select('orderNumber status amounts currency createdAt items.quantity payment.status deliveredAt').lean(),
    ReturnRequest.find(owner).sort({ createdAt: -1 }).limit(25).select('status reason createdAt orderId').lean(),
    SupportTicket.find(owner).sort({ updatedAt: -1 }).limit(25).select('subject status priority updatedAt createdAt').lean(),
    C360StaffNote.find({ userId }).sort({ createdAt: -1 }).limit(50).lean(),
    C360DeletionRequest.find({ userId }).sort({ createdAt: -1 }).limit(5).lean(),
    Wishlist.findOne({ userId }).select('productIds').lean(),
    C360Memory.find({ userId, kind: 'favourite_collection' }).limit(20).select('title').lean(),
    ReferralCode.findOne({ userId }).select('code').lean(),
    Referral.countDocuments({ referrerUserId: userId, status: 'rewarded' }),
    AnalyticsEvent.aggregate([{ $match: { userId: user._id, ts: { $gte: since } } }, { $group: { _id: '$type', n: { $sum: 1 }, last: { $max: '$ts' } } }, { $limit: 30 }]),
    loyaltyReader.read(userId),
  ]);
  const orderIds = orders.map((o) => o._id);
  const [shipments, refunds] = orderIds.length ? await Promise.all([
    Shipment.find({ orderId: { $in: orderIds } }).sort({ updatedAt: -1 }).limit(50).select('orderId status carrier estimatedDelivery').lean(),
    Refund.find({ orderId: { $in: orderIds } }).limit(25).select('amount currency status createdAt').lean(),
  ]) : [[], []];
  const num = new Map(orders.map((o) => [sid(o._id), o.orderNumber]));

  const timeline: TimelineEvent[] = [];
  for (const o of orders) timeline.push({ at: (o as unknown as { createdAt: Date }).createdAt, type: 'order', summary: `Order ${o.orderNumber} placed (${o.status})`, ref: o.orderNumber });
  for (const r of returns) timeline.push({ at: (r as unknown as { createdAt: Date }).createdAt, type: 'return', summary: `Return ${r.status}${num.get(sid(r.orderId)) ? ` for ${num.get(sid(r.orderId))}` : ''}` });
  for (const t of tickets) timeline.push({ at: (t as unknown as { createdAt: Date }).createdAt, type: 'support', summary: `Support ticket "${(t.subject ?? '').slice(0, 60)}" (${t.status})` });
  for (const n of notes) timeline.push({ at: (n as unknown as { createdAt: Date }).createdAt, type: 'staff_note', summary: `Staff note by ${n.authorName ?? 'staff'}` });
  for (const h of history) timeline.push({ at: h.at as Date, type: 'consent', summary: `${h.granted ? 'Granted' : 'Withdrew'} ${h.kind}${h.byStaff ? ' (by staff)' : ''}` });
  for (const d of deletions) timeline.push({ at: d.requestedAt as Date, type: 'deletion', summary: `Deletion request ${d.status}` });
  timeline.sort((a, b) => b.at.getTime() - a.at.getTime());

  const view = minimizeProfileForStaff({
    identity: { userId, email: user.email, name: user.name, country: user.country ?? null, emailVerified: user.emailVerified, createdAt: (user as unknown as { createdAt: Date }).createdAt, lastLoginAt: user.lastLoginAt ?? null, disabled: user.disabled, deleted: !!user.deletedAt },
    preferences: { communication: profile.commPrefs, replenishmentOptIn: profile.replenishmentOptIn, lifegraphEnabled: profile.lifegraphEnabled, memoryEnabled: profile.memoryEnabled, memoryRetentionDays: profile.memoryRetentionDays },
    shoppingInterests: nodes.map((n) => ({ kind: n.kind, value: n.value, source: n.source })),
    purchaseHistory: { ordersCount: customer?.ordersCount ?? 0, lifetimeValue: customer?.lifetimeValue ?? 0, lastOrderAt: customer?.lastOrderAt ?? null, recent: orders.map((o) => ({ orderNumber: o.orderNumber, status: o.status, total: o.amounts?.total ?? 0, currency: o.currency, createdAt: (o as unknown as { createdAt: Date }).createdAt, itemCount: o.items.length, paymentStatus: o.payment?.status })) },
    wishlistCount: wishlist?.productIds?.length ?? 0,
    savedCollections: mem.map((m) => m.title),
    productInteractions: ev.map((e: { _id: string; n: number; last: Date }) => ({ type: e._id, count: e.n, last: e.last })),
    supportHistory: tickets.map((t) => ({ id: sid(t._id), subject: t.subject, status: t.status, priority: t.priority, updatedAt: t.updatedAt })),
    deliveryHistory: shipments.map((s) => ({ orderNumber: num.get(sid(s.orderId)), status: s.status, carrier: s.carrier, estimatedDelivery: s.estimatedDelivery })),
    returns: returns.map((r) => ({ id: sid(r._id), status: r.status, reason: r.reason, orderNumber: num.get(sid(r.orderId)), createdAt: (r as unknown as { createdAt: Date }).createdAt })),
    refunds: refunds.map((r) => ({ amount: r.amount, currency: r.currency, status: r.status })),
    loyalty: loyalty ?? null,
    referrals: { code: referralCode?.code ?? null, rewardsEarned: referralsRewarded },
    consents: CONSENT_KINDS.map((k) => ({ kind: k, granted: consents[k].granted, at: consents[k].at ?? null, policyVersion: consents[k].policyVersion ?? null })),
    consentHistory: history,
    riskFlags: customer?.riskFlags ?? [],
    staffNotes: notes.map((n) => ({ id: sid(n._id), body: n.body, authorName: n.authorName, createdAt: (n as unknown as { createdAt: Date }).createdAt })),
    deletionRequests: deletions.map((d) => ({ id: sid(d._id), status: d.status, requestedAt: d.requestedAt, coolingOffUntil: d.coolingOffUntil })),
    timeline: timeline.slice(0, 100),
  }, { revealEmail: opts.revealEmail });

  // Every staff view is audited; a revealed email is a separate, reasoned entry.
  await audit(ctx, actor, { action: 'customer360.view', resource: 'user', resourceId: userId, newValue: { revealedEmail: opts.revealEmail } });
  if (opts.revealEmail) await audit(ctx, actor, { action: 'customer360.pii_reveal', resource: 'user', resourceId: userId, reason: opts.reason, newValue: { field: 'email,name' } });
  return stripSecrets(view);
}

export async function addStaffNote(ctx: Ctx, actor: Actor, author: { id: string; name: string }, userId: string, body: string) {
  if (!(await User.exists({ _id: userId, role: 'CUSTOMER' }))) throw notFound('Customer');
  const n = await C360StaffNote.create({ userId, authorId: author.id, authorName: author.name, body });
  await audit(ctx, actor, { action: 'customer360.note_added', resource: 'user', resourceId: userId, newValue: { noteId: sid(n._id), length: body.length } });
  return { id: sid(n._id) };
}

export async function staffWithdrawConsent(ctx: Ctx, actor: Actor, userId: string, kind: ConsentKind, reason: string) {
  const u = await User.findById(userId).select('email role').lean();
  if (!u || u.role !== 'CUSTOMER') throw notFound('Customer');
  return recordConsent(ctx, { userId, email: u.email, kind, granted: false, source: 'staff_withdrawal', actor, reason }); // staff can only withdraw, never grant on a customer's behalf
}

/* ====================================================================== */
/*  Product companion + aftercare (customer side)                          */
/* ====================================================================== */
const ownsOrder = (o: { userId?: unknown; email: string }, user: { id: string; email: string; emailVerified?: boolean }) => (o.userId && sid(o.userId) === user.id) || (!!user.emailVerified && o.email === user.email);

export async function listOwnedProducts(ctx: Ctx, user: { id: string; email: string; emailVerified?: boolean }, limit = 60) {
  const orders = await Order.find({ ...ownerMatch(user.id, user.email, !!user.emailVerified), status: 'DELIVERED' }).sort({ deliveredAt: -1, createdAt: -1 }).limit(40).select('orderNumber items deliveredAt createdAt country').lean();
  const rows = orders.flatMap((o) => o.items.map((it, i) => ({ orderItemId: encodeOrderItemId(sid(o._id), i), orderNumber: o.orderNumber, productId: sid(it.productId), title: it.title, image: it.image ?? null, quantity: it.quantity, deliveredAt: o.deliveredAt ?? (o as unknown as { createdAt: Date }).createdAt, country: o.country }))).slice(0, limit);
  const prods = await Product.find({ _id: { $in: rows.map((r) => r.productId) } }).select('slug tags').lean();
  const pm = new Map(prods.map((p) => [sid(p._id), p]));
  const profile = await getProfileRow(user.id);
  return {
    replenishmentOptIn: profile.replenishmentOptIn,
    items: rows.map((r) => {
      const tags = (pm.get(r.productId)?.tags ?? []) as string[];
      const consumable = buildCompanion({ title: r.title, tags }, ctx.now()).consumable;
      return { ...r, slug: pm.get(r.productId)?.slug ?? null, consumable };
    }),
  };
}

export async function productCompanion(ctx: Ctx, user: { id: string; email: string; emailVerified?: boolean }, orderItemId: string) {
  const ref = decodeOrderItemId(orderItemId);
  if (!ref) throw notFound('Product');
  const order = await Order.findById(ref.orderId).lean();
  // Not found and not-yours are indistinguishable on purpose (no IDOR oracle). Only delivered orders have a companion page.
  if (!order || !ownsOrder(order, user) || order.status !== 'DELIVERED') throw notFound('Product');
  const item = order.items[ref.index];
  if (!item) throw notFound('Product');
  const product = await Product.findById(item.productId).lean();
  if (!product) throw notFound('Product');
  const profile = await getProfileRow(user.id);
  const c = buildCompanion(product as never, ctx.now());
  const purchasedAt = order.deliveredAt ?? (order as unknown as { createdAt: Date }).createdAt;
  const rel = await similar(sid(product._id), order.country as CountryCode, 6);
  return {
    orderItemId, orderNumber: order.orderNumber, deliveredAt: order.deliveredAt ?? null,
    product: { id: sid(product._id), slug: product.slug, title: product.title, brand: product.brand, image: item.image ?? product.images?.[0]?.url ?? null },
    companion: c,
    // Related, NOT compatible: derived from category/tag overlap. Explicit compatibility (if any) is in companion.compatibility.
    related: { label: 'Related products', note: 'Suggested because they share a category or tags. This is not a compatibility guarantee.', items: rel.map((p) => ({ id: p.id, slug: p.slug, title: p.title, price: p.price, currency: p.currency, image: p.images[0]?.url ?? null })) },
    replenishment: replenishment({ consumable: c.consumable, intervalDays: c.replenishIntervalDays, purchasedAt, now: ctx.now(), optedIn: profile.replenishmentOptIn }),
    support: { chatHref: '/help', note: 'Open the support chat from the button at the bottom right.' },
    returns: { href: `/orders/${order.orderNumber}`, note: 'Start a return or exchange from the order page, within the return window.' },
  };
}

export async function aftercareHub(ctx: Ctx, user: { id: string; email: string; emailVerified?: boolean }) {
  const owner = ownerMatch(user.id, user.email, !!user.emailVerified);
  const now = ctx.now();
  const orders = await Order.find(owner).sort({ createdAt: -1 }).limit(50).select('orderNumber status').lean();
  const ids = orders.map((o) => o._id);
  const num = new Map(orders.map((o) => [sid(o._id), o.orderNumber]));
  const [returns, refunds, tickets, shipments, rescue] = await Promise.all([
    ReturnRequest.find({ ...owner, status: { $in: ['requested', 'approved', 'received'] } }).sort({ createdAt: -1 }).limit(20).select('status reason orderId createdAt').lean(),
    ids.length ? Refund.find({ orderId: { $in: ids }, status: { $in: ['pending_approval', 'processing'] } }).limit(20).select('orderId amount currency status').lean() : [],
    SupportTicket.find({ ...owner, status: { $ne: 'resolved' } }).sort({ updatedAt: -1 }).limit(20).select('subject status updatedAt').lean(),
    ids.length ? Shipment.find({ orderId: { $in: ids }, status: { $nin: ['DELIVERED', 'CANCELLED', 'PENDING_CREATE'] } }).limit(50).select('orderId status carrier estimatedDelivery').lean() : [],
    rescueReader.list({ id: user.id, email: user.emailVerified ? user.email : '' }, 20),
  ]);
  const issues = shipments.filter((s) => s.status === 'FAILED' || s.status === 'RETURNED' || (s.estimatedDelivery && s.estimatedDelivery.getTime() < now.getTime())).map((s) => ({ orderNumber: num.get(sid(s.orderId)) ?? '', status: s.status, carrier: s.carrier ?? null, estimatedDelivery: s.estimatedDelivery ?? null, late: !!s.estimatedDelivery && s.estimatedDelivery.getTime() < now.getTime() }));
  return {
    returns: returns.map((r) => ({ id: sid(r._id), status: r.status, reason: r.reason, orderNumber: num.get(sid(r.orderId)) ?? null, createdAt: (r as unknown as { createdAt: Date }).createdAt })),
    refunds: refunds.map((r) => ({ id: sid(r._id), orderNumber: num.get(sid(r.orderId)) ?? null, amount: r.amount, currency: r.currency, status: r.status })),
    tickets: tickets.map((t) => ({ id: sid(t._id), subject: t.subject, status: t.status, updatedAt: t.updatedAt })),
    deliveryIssues: issues,
    rescueCases: rescue.map((r) => ({ ...r, orderNumber: r.orderId ? (num.get(r.orderId) ?? null) : null })),
  };
}

/* ====================================================================== */
/*  Housekeeping (scheduled)                                               */
/* ====================================================================== */
/** Delete expired memory items; mark deletion requests whose cooling-off ended as `ready` for staff. Bounded. */
export async function customer360Sweep(ctx: Ctx) {
  const now = ctx.now();
  const expired = await C360Memory.deleteMany({ expiresAt: { $lte: now } });
  const ready = await C360DeletionRequest.updateMany({ status: 'requested', coolingOffUntil: { $lte: now } }, { $set: { status: 'ready' } });
  return { memoryExpired: expired.deletedCount, deletionReady: ready.modifiedCount };
}
