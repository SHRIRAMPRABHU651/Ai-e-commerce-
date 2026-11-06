import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { CollectionComment, CreatorClick, CreatorCollection, CreatorLink, CreatorProfile, Product, User } from '@orvia/database';
import { AFFILIATE_DISCLOSURE, creatorApplySchema, creatorProfileSchema, collectionInputSchema, collectionPatchSchema, linkInputSchema, slugify, validateHandle } from '@orvia/types';
import type { CountryCode } from '@orvia/types';
import type { z } from 'zod';
import { DomainError, conflict, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { audit } from '../../infra/audit';
import { isSellable, toStoreProduct } from '../catalog';
import { inspectImage } from '../imagePipeline';
import { listableImageFilter } from '../images';

type Apply = z.infer<typeof creatorApplySchema>;
type ProfilePatch = z.infer<typeof creatorProfileSchema>;
type CollectionInput = z.infer<typeof collectionInputSchema>;
type CollectionPatch = z.infer<typeof collectionPatchSchema>;
type LinkInput = z.infer<typeof linkInputSchema>;

const isDup = (e: unknown) => (e as { code?: number }).code === 11000;

/* ------------------------------ application & profile ------------------------------ */
export async function applyToBeCreator(ctx: Ctx, user: { id: string; email: string; role: string }, input: Apply) {
  if (user.role !== 'CUSTOMER') throw new DomainError('Staff accounts cannot apply. Use a customer account.', 'FORBIDDEN', 403);
  if (await CreatorProfile.exists({ userId: user.id })) throw conflict('You have already applied', 'ALREADY_APPLIED');
  const h = validateHandle(input.handle);
  if (!h.ok) throw new DomainError('Invalid handle', 'VALIDATION', 400);
  const now = ctx.now();
  try {
    const p = await CreatorProfile.create({
      userId: user.id, handle: h.handle, displayName: input.displayName, bio: input.bio, socialLinks: input.socialLinks, audience: input.audience,
      status: 'pending', appliedAt: now, termsAcceptedAt: now,
    });
    await audit(ctx, { id: user.id, type: 'user' }, { action: 'creator.applied', resource: 'creator', resourceId: String(p._id), newValue: { handle: h.handle } });
    return privateView(p.toObject() as never);
  } catch (e) {
    if (isDup(e)) throw conflict('That handle is already taken', 'HANDLE_TAKEN');
    throw e;
  }
}

type ProfileDoc = Awaited<ReturnType<typeof getProfileByUser>>;
export const getProfileByUser = (userId: string) => CreatorProfile.findOne({ userId }).lean();

/** The creator's own view. Includes private status/payout checklist, never other people's data. */
export function privateView(p: NonNullable<ProfileDoc>) {
  return {
    id: String(p._id), handle: p.handle, displayName: p.displayName, bio: p.bio ?? '', avatarUrl: p.avatarUrl ?? null, socialLinks: (p.socialLinks ?? []).map((l) => ({ platform: l.platform, url: l.url })),
    status: p.status, appliedAt: p.appliedAt, reviewNote: p.status === 'rejected' ? p.reviewNote ?? null : null,
    payout: { kycStatus: p.payoutProfile?.kycStatus ?? 'not_started', taxInfoCollected: !!p.payoutProfile?.taxInfoCollected, method: p.payoutProfile?.method ?? null, held: !!p.payoutsHeld },
    profileUrl: `/creators/${p.handle}`,
  };
}

export async function requireApprovedCreator(userId: string) {
  const p = await getProfileByUser(userId);
  if (!p) throw new DomainError('You are not a creator yet', 'NOT_A_CREATOR', 403);
  if (p.status !== 'approved') throw new DomainError(`Your creator account is ${p.status}`, 'CREATOR_NOT_APPROVED', 403);
  return p;
}

export async function reviewApplication(ctx: Ctx, actor: Actor, creatorId: string, decision: 'approve' | 'reject', note?: string) {
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const p = await CreatorProfile.findOneAndUpdate({ _id: creatorId, status: 'pending' }, { $set: { status, reviewedAt: ctx.now(), reviewedBy: actor.id, reviewNote: note } }, { new: true }).lean();
  if (!p) throw conflict('Application is not pending', 'NOT_PENDING');
  await audit(ctx, actor, { action: `creator.${decision}d`, resource: 'creator', resourceId: creatorId, newValue: { status }, reason: note });
  return p;
}

/** Staff status changes after the initial review: suspend / reinstate. Suspension unpublishes nothing but stops attribution and payouts. */
export async function setCreatorStatus(ctx: Ctx, actor: Actor, creatorId: string, status: 'approved' | 'suspended', reason?: string) {
  const prev = await CreatorProfile.findById(creatorId).select('status').lean();
  if (!prev) throw notFound('Creator');
  if (prev.status === 'pending' || prev.status === 'rejected') throw conflict('Review the application first', 'NOT_REVIEWED');
  await CreatorProfile.updateOne({ _id: creatorId }, { $set: { status } });
  await audit(ctx, actor, { action: 'creator.status_changed', resource: 'creator', resourceId: creatorId, previousValue: { status: prev.status }, newValue: { status }, reason });
}

export async function updateProfile(ctx: Ctx, userId: string, patch: ProfilePatch) {
  const p = await getProfileByUser(userId);
  if (!p) throw new DomainError('You are not a creator yet', 'NOT_A_CREATOR', 403);
  if (p.status === 'suspended' || p.status === 'rejected') throw new DomainError(`Your creator account is ${p.status}`, 'CREATOR_NOT_APPROVED', 403);
  const set: Record<string, unknown> = {};
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.bio !== undefined) set.bio = patch.bio;
  if (patch.socialLinks !== undefined) set.socialLinks = patch.socialLinks;
  const out = await CreatorProfile.findOneAndUpdate({ _id: p._id }, { $set: set }, { new: true }).lean();
  await audit(ctx, { id: userId, type: 'user' }, { action: 'creator.profile_updated', resource: 'creator', resourceId: String(p._id), newValue: Object.keys(set) });
  return privateView(out!);
}

/** Avatar follows the product-image upload rules (real format sniffing, size, decode, min dimension), then re-encodes to a 512px square WebP with metadata stripped. */
export async function setAvatar(ctx: Ctx, userId: string, buffer: Buffer) {
  const p = await getProfileByUser(userId);
  if (!p) throw new DomainError('You are not a creator yet', 'NOT_A_CREATOR', 403);
  await inspectImage(buffer, { maxBytes: ctx.cfg.MEDIA_MAX_BYTES, minDimension: ctx.cfg.MEDIA_MIN_DIMENSION });
  const body = await sharp(buffer, { limitInputPixels: 50_000_000 }).rotate().resize(512, 512, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
  const key = `creators/${String(p._id)}/avatar-${randomUUID()}.webp`;
  await ctx.storage.put(key, body, 'image/webp');
  const url = ctx.storage.publicUrl(key);
  await CreatorProfile.updateOne({ _id: p._id }, { $set: { avatarUrl: url } });
  await audit(ctx, { id: userId, type: 'user' }, { action: 'creator.avatar_updated', resource: 'creator', resourceId: String(p._id) });
  return { avatarUrl: url };
}

/* ------------------------------ collections ------------------------------ */
async function assertSellableProducts(ids: string[]) {
  if (!ids.length) return;
  if (new Set(ids).size !== ids.length) throw new DomainError('A product appears twice in the collection', 'VALIDATION', 422);
  const rows = await Product.find({ _id: { $in: ids } }).select('state').lean();
  const ok = new Set(rows.filter((r) => isSellable(r.state)).map((r) => String(r._id)));
  const bad = ids.filter((i) => !ok.has(i));
  if (bad.length) throw new DomainError('Some products are not available to recommend', 'VALIDATION', 422, bad);
}

async function uniqueSlug(creatorId: string, title: string): Promise<string> {
  const base = slugify(title).slice(0, 60) || 'collection';
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await CreatorCollection.exists({ creatorId, slug }))) return slug;
  }
  return `${base}-${randomBytes(3).toString('hex')}`;
}

const itemsOf = (ids: string[], notes: Record<string, string>) => ids.map((id) => ({ productId: id, note: notes[id] || undefined }));

const collectionView = (c: { _id: unknown; slug: string; title: string; description?: string | null; items?: { productId: unknown; note?: string | null }[]; published: boolean; publishedAt?: Date | null; updatedAt?: Date }) => ({
  id: String(c._id), slug: c.slug, title: c.title, description: c.description ?? '', published: c.published, publishedAt: c.publishedAt ?? null, updatedAt: c.updatedAt,
  items: (c.items ?? []).map((i) => ({ productId: String(i.productId), note: i.note ?? '' })),
});

export async function listMyCollections(creatorId: string) {
  const rows = await CreatorCollection.find({ creatorId }).sort({ updatedAt: -1 }).limit(100).lean();
  const prods = await Product.find({ _id: { $in: rows.flatMap((r) => r.items.map((i) => i.productId)) } }).select('title').lean();
  const title = new Map(prods.map((p) => [String(p._id), p.title]));
  return rows.map((r) => { const v = collectionView(r); return { ...v, items: v.items.map((i) => ({ ...i, title: title.get(i.productId) ?? 'Unavailable product' })) }; });
}

export async function createCollection(ctx: Ctx, creator: { _id: unknown }, input: CollectionInput) {
  const creatorId = String(creator._id);
  if ((await CreatorCollection.countDocuments({ creatorId })) >= 50) throw new DomainError('Collection limit reached (50)', 'LIMIT', 409);
  await assertSellableProducts(input.productIds);
  if (input.published && input.productIds.length === 0) throw new DomainError('Add at least one product before publishing', 'VALIDATION', 422);
  const slug = await uniqueSlug(creatorId, input.title);
  const c = await CreatorCollection.create({ creatorId, slug, title: input.title, description: input.description, items: itemsOf(input.productIds, input.notes), published: input.published, publishedAt: input.published ? ctx.now() : undefined });
  await audit(ctx, { id: creatorId, type: 'user' }, { action: 'creator.collection_created', resource: 'creator_collection', resourceId: String(c._id), newValue: { slug, published: input.published } });
  return collectionView(c.toObject());
}

export async function updateCollection(ctx: Ctx, creator: { _id: unknown }, id: string, patch: CollectionPatch) {
  const c = await CreatorCollection.findOne({ _id: id, creatorId: creator._id }); // ownership enforced in the query (IDOR)
  if (!c) throw notFound('Collection');
  if (patch.productIds) {
    await assertSellableProducts(patch.productIds);
    const notes = patch.notes ?? Object.fromEntries(c.items.map((i) => [String(i.productId), i.note ?? '']));
    c.set('items', itemsOf(patch.productIds, notes));
  } else if (patch.notes) {
    c.set('items', c.items.map((i) => ({ productId: i.productId, note: patch.notes![String(i.productId)] ?? i.note })));
  }
  if (patch.title !== undefined) c.title = patch.title;
  if (patch.description !== undefined) c.description = patch.description;
  if (patch.published !== undefined) {
    if (patch.published && c.items.length === 0) throw new DomainError('Add at least one product before publishing', 'VALIDATION', 422);
    if (patch.published && !c.published) c.publishedAt = ctx.now();
    c.published = patch.published;
  }
  await c.save();
  await audit(ctx, { id: String(creator._id), type: 'user' }, { action: 'creator.collection_updated', resource: 'creator_collection', resourceId: id, newValue: { published: c.published, items: c.items.length } });
  return collectionView(c.toObject());
}

export async function deleteCollection(ctx: Ctx, creator: { _id: unknown }, id: string) {
  const c = await CreatorCollection.findOneAndDelete({ _id: id, creatorId: creator._id });
  if (!c) throw notFound('Collection');
  await CollectionComment.deleteMany({ collectionId: id });
  await CreatorLink.updateMany({ collectionId: id }, { $set: { active: false } });
  await audit(ctx, { id: String(creator._id), type: 'user' }, { action: 'creator.collection_deleted', resource: 'creator_collection', resourceId: id });
}

/* ------------------------------ share links ------------------------------ */
export async function createLink(ctx: Ctx, creator: { _id: unknown; handle: string }, input: LinkInput) {
  const creatorId = String(creator._id);
  if ((await CreatorLink.countDocuments({ creatorId, active: true })) >= 200) throw new DomainError('Link limit reached (200)', 'LIMIT', 409);
  let path = `/creators/${creator.handle}`;
  if (input.productId) {
    const p = await Product.findById(input.productId).select('slug state').lean();
    if (!p || !isSellable(p.state)) throw new DomainError('This product is not available to share', 'VALIDATION', 422);
    path = `/p/${p.slug}`;
  } else if (input.collectionId) {
    const c = await CreatorCollection.findOne({ _id: input.collectionId, creatorId, published: true }).select('slug').lean();
    if (!c) throw new DomainError('Publish the collection before sharing it', 'VALIDATION', 422);
    path = `/creators/${creator.handle}/${c.slug}`;
  }
  const code = randomBytes(6).toString('hex'); // 12 hex chars
  const l = await CreatorLink.create({ creatorId, code, label: input.label, productId: input.productId, collectionId: input.collectionId });
  await audit(ctx, { id: creatorId, type: 'user' }, { action: 'creator.link_created', resource: 'creator_link', resourceId: String(l._id) });
  return { id: String(l._id), code, label: l.label, url: `${ctx.cfg.WEB_URL}${path}?cl=${code}`, clicks: 0 };
}

export async function listLinks(ctx: Ctx, creator: { _id: unknown; handle: string }) {
  const links = await CreatorLink.find({ creatorId: creator._id, active: true }).sort({ createdAt: -1 }).limit(200).lean();
  const pids = links.filter((l) => l.productId).map((l) => l.productId);
  const cids = links.filter((l) => l.collectionId).map((l) => l.collectionId);
  const [prods, cols] = await Promise.all([Product.find({ _id: { $in: pids } }).select('slug').lean(), CreatorCollection.find({ _id: { $in: cids } }).select('slug').lean()]);
  const ps = new Map(prods.map((p) => [String(p._id), p.slug]));
  const cs = new Map(cols.map((c) => [String(c._id), c.slug]));
  return links.map((l) => {
    const path = l.productId ? `/p/${ps.get(String(l.productId)) ?? ''}` : l.collectionId ? `/creators/${creator.handle}/${cs.get(String(l.collectionId)) ?? ''}` : `/creators/${creator.handle}`;
    return { id: String(l._id), code: l.code, label: l.label, url: `${ctx.cfg.WEB_URL}${path}?cl=${l.code}`, clicks: l.clicks };
  });
}

export async function deactivateLink(ctx: Ctx, creator: { _id: unknown }, id: string) {
  const r = await CreatorLink.updateOne({ _id: id, creatorId: creator._id }, { $set: { active: false } });
  if (!r.matchedCount) throw notFound('Link');
  await audit(ctx, { id: String(creator._id), type: 'user' }, { action: 'creator.link_removed', resource: 'creator_link', resourceId: id });
}

/* ------------------------------ public views (no private data) ------------------------------ */
export async function publicCreator(handle: string, country: CountryCode) {
  const p = await CreatorProfile.findOne({ handle: handle.toLowerCase(), status: 'approved' }).lean();
  if (!p) return null;
  const cols = await CreatorCollection.find({ creatorId: p._id, published: true }).sort({ publishedAt: -1 }).limit(50).lean();
  const firstIds = cols.map((c) => c.items?.[0]?.productId).filter(Boolean);
  const prods = await Product.find({ _id: { $in: firstIds } }).select('images title').lean();
  const img = new Map(prods.map((x) => [String(x._id), x.images?.[0]?.url ?? undefined]));
  void country;
  return {
    creator: { handle: p.handle, displayName: p.displayName, bio: p.bio ?? '', avatarUrl: p.avatarUrl ?? null, socialLinks: (p.socialLinks ?? []).map((l) => ({ platform: l.platform, url: l.url })) },
    collections: cols.map((c) => ({ slug: c.slug, title: c.title, description: c.description ?? '', productCount: c.items?.length ?? 0, image: c.items?.[0] ? img.get(String(c.items[0].productId)) : undefined })),
    disclosure: AFFILIATE_DISCLOSURE,
  };
}

export async function publicCollection(handle: string, slug: string, country: CountryCode) {
  const p = await CreatorProfile.findOne({ handle: handle.toLowerCase(), status: 'approved' }).select('handle displayName avatarUrl').lean();
  if (!p) return null;
  const c = await CreatorCollection.findOne({ creatorId: p._id, slug, published: true }).lean();
  if (!c) return null;
  const ids = c.items.map((i) => i.productId);
  const rows = await Product.find({ _id: { $in: ids }, $and: [listableImageFilter()] }).lean();
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  const items = c.items.flatMap((i) => {
    const r = byId.get(String(i.productId));
    if (!r) return [];
    const product = toStoreProduct(r as never as Parameters<typeof toStoreProduct>[0], country);
    return product.available ? [{ product, note: i.note ?? '' }] : [];
  });
  return {
    creator: { handle: p.handle, displayName: p.displayName, avatarUrl: p.avatarUrl ?? null },
    collection: { id: String(c._id), slug: c.slug, title: c.title, description: c.description ?? '', publishedAt: c.publishedAt ?? null, updatedAt: (c as { updatedAt?: Date }).updatedAt ?? null, discussionEnabled: c.discussionEnabled },
    items, unavailableCount: c.items.length - items.length, disclosure: AFFILIATE_DISCLOSURE,
  };
}

/** Staff-facing creator summary used for display names only. */
export async function userName(userId: string): Promise<string> {
  const u = await User.findById(userId).select('name').lean();
  return u?.name ?? 'Customer';
}

export async function clickCount(creatorId: string, since?: Date): Promise<number> {
  return CreatorClick.countDocuments({ creatorId, ...(since ? { at: { $gte: since } } : {}) });
}
