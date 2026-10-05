import mongoose from 'mongoose';
import { Order, Product, Review } from '@orvia/database';
import { DomainError, forbidden, notFound } from '../infra/context';
import type { Ctx } from '../infra/context';
import { raiseException } from './exceptions';

export async function createReview(ctx: Ctx, userId: string, userName: string, productId: string, input: { rating: number; title: string; body: string; images: string[] }) {
  const product = await Product.findById(productId).select('_id').lean();
  if (!product) throw notFound('Product');
  const order = await Order.findOne({ userId, 'items.productId': productId, 'payment.status': { $in: ['succeeded', 'partially_refunded'] } }).select('_id').lean();
  try {
    const r = await Review.create({ productId, userId, authorName: userName.split(' ')[0], orderId: order?._id, rating: input.rating, title: input.title, body: input.body, images: input.images, verifiedPurchase: !!order, status: 'published', sentiment: input.rating >= 4 ? 'positive' : input.rating <= 2 ? 'negative' : 'neutral' });
    await recomputeRating(productId);
    return r;
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new DomainError('You have already reviewed this product', 'DUPLICATE_REVIEW', 409);
    throw e;
  }
}

export async function recomputeRating(productId: string) {
  const [agg] = await Review.aggregate<{ avg: number; n: number }>([{ $match: { productId: new mongoose.Types.ObjectId(productId), status: 'published' } }, { $group: { _id: null, avg: { $avg: '$rating' }, n: { $sum: 1 } } }]);
  await Product.updateOne({ _id: productId }, { $set: { 'stats.ratingAvg': agg ? Math.round(agg.avg * 10) / 10 : 0, 'stats.ratingCount': agg?.n ?? 0 } });
}

export async function voteHelpful(reviewId: string, userId: string) {
  const r = await Review.findOneAndUpdate({ _id: reviewId, votedBy: { $ne: userId } }, { $inc: { helpfulVotes: 1 }, $push: { votedBy: userId } }, { new: true });
  if (!r) throw forbidden('Already voted or review not found');
  return r.helpfulVotes;
}

export async function listReviews(productId: string, page: number, pageSize: number) {
  const q = { productId, status: 'published' };
  const [items, total, dist] = await Promise.all([
    Review.find(q).sort({ helpfulVotes: -1, createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).select('rating title body authorName verifiedPurchase helpfulVotes images createdAt').lean(),
    Review.countDocuments(q),
    Review.aggregate<{ _id: number; n: number }>([{ $match: { productId: new mongoose.Types.ObjectId(productId), status: 'published' } }, { $group: { _id: '$rating', n: { $sum: 1 } } }]),
  ]);
  return { items, total, distribution: Object.fromEntries([1, 2, 3, 4, 5].map((s) => [s, dist.find((d) => d._id === s)?.n ?? 0])) };
}

/** AI review analysis per product; alerts if negative sentiment rose significantly vs. the previous window. */
export async function analyzeProductReviews(ctx: Ctx, productId: string) {
  const since = new Date(ctx.now().getTime() - 30 * 86_400_000);
  const prev = new Date(ctx.now().getTime() - 60 * 86_400_000);
  const [recent, older] = await Promise.all([
    Review.find({ productId, status: 'published', createdAt: { $gte: since } }).select('rating body').limit(100).lean(),
    Review.find({ productId, status: 'published', createdAt: { $gte: prev, $lt: since } }).select('rating body').limit(100).lean(),
  ]);
  const a = await ctx.ai.analyzeReviews(recent.map((r) => ({ rating: r.rating, text: r.body ?? '' })));
  const b = await ctx.ai.analyzeReviews(older.map((r) => ({ rating: r.rating, text: r.body ?? '' })));
  const rise = a.data.negativePct - b.data.negativePct;
  let alert = false;
  if (recent.length >= 5 && rise >= 20 && a.data.negativePct >= 30) {
    alert = true;
    const p = await Product.findById(productId).select('title').lean();
    await raiseException(ctx, { kind: 'AUTHENTICITY', priority: 'high', productId, issue: `Negative review sentiment on "${p?.title}" rose ${rise} points (now ${a.data.negativePct}%). Complaints: ${a.data.complaints.join(', ') || 'n/a'}`, aiRecommendation: 'Check supplier quality and shipping; consider pausing the product.', suggestedAction: 'Review product / pause', actionCode: 'review_product', dedupeKey: `sentiment:${productId}` });
  }
  return { analysis: a.data, source: a.source, previousNegativePct: b.data.negativePct, alert };
}
