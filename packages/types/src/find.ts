/** find: shared types and zod schemas (ORVIA Find + Price Guard; owned by the find workstream). */
import { z } from 'zod';
import { countrySchema, objectId } from './schemas';

export const FIND_QUERY_MAX = 300;

/** Bounded, control-character-free free text. */
const freeText = (max: number) => z.string().trim().min(1).max(max);

export const findRequestSchema = z.object({
  query: freeText(FIND_QUERY_MAX),
  country: countrySchema.optional(),
  /** Major units of the market currency (e.g. 40 = $40). Overrides a budget parsed from the query. */
  budgetMax: z.number().positive().max(1_000_000).optional(),
  budgetMin: z.number().min(0).max(1_000_000).optional(),
  /** ISO date YYYY-MM-DD in the customer's country. Overrides a deadline parsed from the query. */
  deliverBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  inStockOnly: z.boolean().optional(),
  minRating: z.number().min(0).max(5).optional(),
  sort: z.enum(['relevance', 'price_asc', 'price_desc', 'rating', 'value', 'fastest', 'popular']).optional(),
  /** Skip the optional AI refinement (deterministic parse only). */
  useAI: z.boolean().default(true),
  limit: z.number().int().min(1).max(48).default(24),
});
export type FindRequest = z.infer<typeof findRequestSchema>;

export const compareRequestSchema = z.object({
  ids: z.array(objectId).min(2).max(4),
  country: countrySchema.optional(),
});
export type CompareRequest = z.infer<typeof compareRequestSchema>;

export const savedSearchInput = z.object({
  name: freeText(80),
  query: freeText(FIND_QUERY_MAX),
  country: countrySchema.optional(),
  budgetMax: z.number().positive().max(1_000_000).optional(),
  deliverBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Email me when new products match this search (at most once a day). */
  alertNewMatches: z.boolean().default(false),
});
export type SavedSearchInput = z.infer<typeof savedSearchInput>;
export const savedSearchPatch = savedSearchInput.partial().extend({ name: freeText(80).optional() });

export const PRICE_ALERT_MAX_PER_USER = 50;
export const SAVED_SEARCH_MAX_PER_USER = 25;

export const priceAlertInput = z.object({
  productId: objectId,
  country: countrySchema.optional(),
  /** Target price in major units of the market currency. */
  targetPrice: z.number().positive().max(1_000_000).optional(),
  /** Alert on any drop of at least this percentage versus the price when tracking started. */
  dropPercent: z.number().min(1).max(90).default(5),
  notifyOnDrop: z.boolean().default(true),
  notifyOnStock: z.boolean().default(true),
  notifyOnBetterOffer: z.boolean().default(true),
});
export type PriceAlertInput = z.infer<typeof priceAlertInput>;
export const priceAlertPatch = z.object({
  targetPrice: z.number().positive().max(1_000_000).nullable().optional(),
  dropPercent: z.number().min(1).max(90).optional(),
  notifyOnDrop: z.boolean().optional(),
  notifyOnStock: z.boolean().optional(),
  notifyOnBetterOffer: z.boolean().optional(),
  active: z.boolean().optional(),
});

/* ------------------------------ response shapes ------------------------------ */
export type MatchKind = 'need' | 'category' | 'keyword' | 'attribute' | 'budget' | 'delivery' | 'gift' | 'rating' | 'sort' | 'similar_text';
export interface WhyMatched {
  kind: MatchKind;
  text: string;
}
export type DeliveryFit = 'ok' | 'may_not_arrive' | 'unknown';

export interface FindUnderstood {
  needs: { slug: string; name: string }[];
  categories: { slug: string; name: string }[];
  keywords: string[];
  attributes: { kind: string; value: string }[];
  budget: { min?: number; max?: number; currency: string; converted?: boolean } | null;
  gift: { recipient?: string; occasion?: string } | null;
  deadline: { date: string; label: string } | null;
  sort: string;
  compare: boolean;
  notes: string[];
  /** deterministic | ai_refined | ai_failed_fallback */
  parser: 'deterministic' | 'ai_refined' | 'ai_fallback';
}

export interface FindItem {
  id: string;
  slug: string;
  title: string;
  brand: string;
  image: string | null;
  category: string;
  price: number;
  currency: string;
  /** price + standard shipping (before tax), minor units. An estimate, not a quote. */
  deliveredEstimate: number;
  rating: { avg: number; count: number };
  minDays: number | null;
  maxDays: number | null;
  /** Latest date (YYYY-MM-DD) the estimate says it could arrive, null when the window is unknown. */
  latestArrival: string | null;
  deliveryFit: DeliveryFit;
  stock: number;
  score: number;
  whyMatched: WhyMatched[];
}

export interface FindResponse {
  understood: FindUnderstood;
  items: FindItem[];
  total: number;
  excluded: { tooLate: number; overBudget: number };
  country: string;
  currency: string;
  /** Honest disclosure of how results were produced. */
  engine: { lexical: true; semantic: string; ai: 'not_used' | 'refined' | 'unavailable_fallback' };
  disclaimer: string;
}

export interface CompareRow {
  key: string;
  label: string;
  values: (string | null)[];
  differs: boolean;
}
export interface CompareResponse {
  country: string;
  currency: string;
  products: { id: string; slug: string; title: string; image: string | null; price: number; deliveredEstimate: number; available: boolean }[];
  rows: CompareRow[];
  keyDifferences: string[];
  bestFor: { label: string; productId: string; detail: string }[];
  note: string;
}

export interface PriceHistoryResponse {
  productId: string;
  country: string;
  currency: string;
  observations: number;
  firstObservedAt: string | null;
  points: { at: string; price: number; inStock: boolean }[];
  current: number | null;
  lowest: { price: number; at: string; windowDays: number } | null;
  /** Human sentence built only from the snapshots above; null when there is not enough data. */
  statement: string | null;
  sufficient: boolean;
}
