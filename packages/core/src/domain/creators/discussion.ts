/** Lightweight, moderated collection discussion. Display name only (first name + last initial); no contact details or links allowed. */
import { CollectionComment, CreatorCollection, CreatorProfile, User } from '@orvia/database';
import { DomainError, conflict, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { audit } from '../../infra/audit';

const MAX_PER_HOUR = 5;
const MAX_PER_DAY = 20;
const AUTO_HIDE_REPORTS = 3;

export const displayNameOf = (full: string): string => {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Customer';
  const first = parts[0]!.slice(0, 20);
  const last = parts.length > 1 ? ` ${parts[parts.length - 1]![0]!.toUpperCase()}.` : '';
  return `${first}${last}`;
};
/** Rejects links, emails and phone-number-like text. Returns a reason or null. */
export function commentProblem(body: string): string | null {
  if (/https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|io|co|in|ca|shop|store|xyz|ru|cn)\b/i.test(body)) return 'Please remove links';
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(body)) return 'Please remove email addresses';
  if (/(?:\+?\d[\s().-]*){9,}/.test(body)) return 'Please remove phone numbers';
  return null;
}

export async function addComment(ctx: Ctx, user: { id: string; name: string }, collectionId: string, body: string) {
  const col = await CreatorCollection.findOne({ _id: collectionId, published: true, discussionEnabled: true }).select('creatorId').lean();
  if (!col) throw notFound('Collection');
  const creator = await CreatorProfile.findOne({ _id: col.creatorId, status: 'approved' }).select('_id').lean();
  if (!creator) throw notFound('Collection');
  const problem = commentProblem(body);
  if (problem) throw new DomainError(problem, 'VALIDATION', 422);
  const now = ctx.now();
  const [hour, day, dup] = await Promise.all([
    CollectionComment.countDocuments({ userId: user.id, createdAt: { $gte: new Date(now.getTime() - 3_600_000) } }),
    CollectionComment.countDocuments({ userId: user.id, createdAt: { $gte: new Date(now.getTime() - 86_400_000) } }),
    CollectionComment.exists({ userId: user.id, collectionId, body }),
  ]);
  if (hour >= MAX_PER_HOUR || day >= MAX_PER_DAY) throw new DomainError('You are commenting too fast. Please try again later.', 'RATE_LIMITED', 429);
  if (dup) throw conflict('You already posted this comment', 'DUPLICATE');
  const c = await CollectionComment.create({ collectionId, creatorId: col.creatorId, userId: user.id, displayName: displayNameOf(user.name), body, status: 'pending' });
  await audit(ctx, { id: user.id, type: 'user' }, { action: 'creator.comment_posted', resource: 'creator_comment', resourceId: String(c._id) });
  return { id: String(c._id), status: 'pending' as const, message: 'Thanks. Your comment will appear once it has been reviewed.' };
}

export async function publicComments(collectionId: string, page = 1, pageSize = 20) {
  const f = { collectionId, status: 'published' };
  const [total, rows] = await Promise.all([CollectionComment.countDocuments(f), CollectionComment.find(f).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).select('displayName body createdAt').lean()]);
  return { total, items: rows.map((r) => ({ id: String(r._id), displayName: r.displayName, body: r.body, at: (r as { createdAt?: Date }).createdAt })) };
}

export async function reportComment(ctx: Ctx, userId: string, commentId: string, reason: string) {
  const c = await CollectionComment.findOne({ _id: commentId, status: 'published' });
  if (!c) throw notFound('Comment');
  if (String(c.userId) === userId) throw new DomainError('You cannot report your own comment', 'VALIDATION', 422);
  if (c.reports.some((r) => String(r.userId) === userId)) return { ok: true };
  c.reports.push({ userId: userId as never, reason, at: ctx.now() });
  c.reportCount = c.reports.length;
  if (c.reportCount >= AUTO_HIDE_REPORTS) c.status = 'pending'; // back to the moderation queue
  await c.save();
  await audit(ctx, { id: userId, type: 'user' }, { action: 'creator.comment_reported', resource: 'creator_comment', resourceId: commentId, reason });
  return { ok: true };
}

export async function moderationQueue(status: string, page: number, pageSize: number) {
  const f = status === 'reported' ? { status: 'published', reportCount: { $gt: 0 } } : { status };
  const [total, rows] = await Promise.all([CollectionComment.countDocuments(f), CollectionComment.find(f).sort({ reportCount: -1, createdAt: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean()]);
  const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('_id').lean();
  void users;
  return { total, page, pageSize, items: rows.map((r) => ({ id: String(r._id), collectionId: String(r.collectionId), displayName: r.displayName, body: r.body, status: r.status, reportCount: r.reportCount, reasons: r.reports.map((x) => x.reason), at: (r as { createdAt?: Date }).createdAt })) };
}

export async function moderateComment(ctx: Ctx, actor: Actor, id: string, decision: 'published' | 'rejected' | 'removed') {
  const c = await CollectionComment.findByIdAndUpdate(id, { $set: { status: decision, moderatedBy: actor.id, ...(decision === 'published' ? { reports: [], reportCount: 0 } : {}) } }, { new: true }).lean();
  if (!c) throw notFound('Comment');
  await audit(ctx, actor, { action: 'creator.comment_moderated', resource: 'creator_comment', resourceId: id, newValue: { status: decision } });
  return { ok: true };
}
