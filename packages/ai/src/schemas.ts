import { z } from 'zod';

export const ProductSourceSchema = z.object({
  title: z.string(),
  description: z.string().default(''),
  category: z.string().default(''),
  attributes: z.record(z.string()).default({}),
  tags: z.array(z.string()).default([]),
  safetyStandards: z.array(z.string()).default([]),
  ageRange: z.string().optional(),
  variants: z.array(z.string()).default([]),
});
export type ProductSource = z.infer<typeof ProductSourceSchema>;

export const ProductContentSchema = z.object({
  seoTitle: z.string().min(5).max(70),
  metaDescription: z.string().min(20).max(170),
  description: z.string().min(20).max(2500),
  bullets: z.array(z.string().min(3).max(200)).min(3).max(7),
  features: z.array(z.string().min(3).max(200)).min(2).max(8),
  benefits: z.array(z.string().min(3).max(200)).min(2).max(6),
  faqs: z.array(z.object({ q: z.string().min(5).max(200), a: z.string().min(3).max(500) })).min(2).max(6),
  keywords: z.array(z.string().min(2).max(40)).min(3).max(15),
  social: z.object({
    instagram: z.string().max(2200),
    tiktokScript: z.string().max(2000),
    facebookAd: z.string().max(1000),
  }),
  adCopy: z.object({
    primaryText: z.string().max(500),
    headline: z.string().max(80),
    description: z.string().max(200),
    cta: z.string().max(30),
  }),
});
export type ProductContent = z.infer<typeof ProductContentSchema>;

export const AD_CONCEPTS = ['problem_hook', 'emotional_hook', 'demonstration', 'ugc', 'before_after'] as const;
export const AdCreativeSchema = z.object({
  concept: z.enum(AD_CONCEPTS),
  hook: z.string().min(3).max(200),
  primaryText: z.string().min(3).max(500),
  headline: z.string().min(3).max(80),
  description: z.string().max(200),
  cta: z.string().max(30),
  videoScript: z.string().max(1500),
});
export const AdCreativesSchema = z.object({ creatives: z.array(AdCreativeSchema).min(1).max(8) });
export type AdCreative = z.infer<typeof AdCreativeSchema>;

export const ProductAnalysisSchema = z.object({
  summary: z.string().max(600),
  targetAudience: z.string().max(300),
  riskFlags: z.array(z.string().max(200)).max(10),
  videoPotential: z.number().min(0).max(100),
  repeatPurchasePotential: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
});
export type ProductAnalysis = z.infer<typeof ProductAnalysisSchema>;

export const ClassificationSchema = z.object({ label: z.string(), confidence: z.number().min(0).max(1), reason: z.string().max(300).default('') });
export type Classification = z.infer<typeof ClassificationSchema>;

export const ReviewAnalysisSchema = z.object({
  positivePct: z.number().min(0).max(100),
  neutralPct: z.number().min(0).max(100),
  negativePct: z.number().min(0).max(100),
  praise: z.array(z.string().max(120)).max(6),
  complaints: z.array(z.string().max(120)).max(6),
  quality: z.enum(['good', 'mixed', 'poor', 'unknown']),
  shippingComplaints: z.number().int().min(0),
  supplierProblems: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
});
export type ReviewAnalysis = z.infer<typeof ReviewAnalysisSchema>;

export const BusinessNarrativeSchema = z.object({
  headline: z.string().max(240),
  bullets: z.array(z.string().max(300)).max(8),
  recommendedActions: z.array(z.string().max(300)).max(5),
});
export type BusinessNarrative = z.infer<typeof BusinessNarrativeSchema>;

export const RecommendationSchema = z.object({ productIds: z.array(z.string()).max(50), reason: z.string().max(300) });
export type RecommendationOut = z.infer<typeof RecommendationSchema>;

export const PriceSuggestionSchema = z.object({ price: z.number().int().positive(), reason: z.string().max(300) });
