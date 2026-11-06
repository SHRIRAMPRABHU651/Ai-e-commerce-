import type { Model } from 'mongoose';
import type { FilterQuery } from 'mongoose';

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Email address that may be used as an ownership key for guest-created records (orders, returns, tickets).
 * Registration signs the user in before the address is verified, so an unverified email proves nothing: someone could
 * register with a victim's email and read the victim's guest records. Only verified addresses count.
 */
export const ownerEmail = (u: { email: string; emailVerified: boolean } | undefined): string | undefined => (u?.emailVerified ? u.email : undefined);

/** Mongo `$or` clauses that select the records owned by a signed-in user (by id, or by verified email). */
export const ownerOr = (u: { id: string; email: string; emailVerified: boolean }): Record<string, unknown>[] => [{ userId: u.id }, ...(u.emailVerified ? [{ email: u.email }] : [])];

/** Bounded, paginated query. Never returns unbounded result sets. */
export async function paginate<T>(model: Model<T>, filter: FilterQuery<T>, o: { page: number; pageSize: number; sort?: Record<string, 1 | -1>; select?: string }) {
  const pageSize = Math.min(Math.max(o.pageSize, 1), 100);
  const [items, total] = await Promise.all([
    model.find(filter).sort(o.sort ?? { createdAt: -1 }).skip((o.page - 1) * pageSize).limit(pageSize).select(o.select ?? '').lean(),
    model.countDocuments(filter),
  ]);
  return { items, total, page: o.page, pageSize };
}

export const rangeQuery = { preset: ['today', '7d', '30d', '90d', 'custom'] as const };
