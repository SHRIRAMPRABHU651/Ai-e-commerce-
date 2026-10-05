import type { Model } from 'mongoose';
import type { FilterQuery } from 'mongoose';

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
