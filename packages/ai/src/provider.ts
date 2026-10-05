import type { ZodType, ZodTypeDef } from 'zod';
import type {
  AdCreative,
  BusinessNarrative,
  Classification,
  ProductAnalysis,
  ProductContent,
  ProductSource,
  RecommendationOut,
  ReviewAnalysis,
} from './schemas';

export interface GenerateOptions {
  system?: string;
  temperature?: number;
}

export interface AIProvider {
  readonly name: string;
  generateText(prompt: string, o?: GenerateOptions): Promise<string>;
  generateStructuredOutput<T>(prompt: string, schema: ZodType<T, ZodTypeDef, unknown>, o?: GenerateOptions): Promise<T>;
  classify(text: string, labels: string[], o?: GenerateOptions): Promise<Classification>;
  analyzeProduct(src: ProductSource): Promise<ProductAnalysis>;
  generateProductDescription(src: ProductSource): Promise<ProductContent>;
  generateAdCopy(src: ProductSource, concepts?: string[]): Promise<AdCreative[]>;
  analyzeReviews(reviews: { rating: number; text: string }[]): Promise<ReviewAnalysis>;
  analyzeBusiness(data: Record<string, unknown>): Promise<BusinessNarrative>;
  recommendProducts(ctx: { candidates: { id: string; title: string; category: string }[]; viewed: string[]; limit: number }): Promise<RecommendationOut>;
}

export class AIUnavailableError extends Error {
  constructor(msg = 'AI provider unavailable') {
    super(msg);
    this.name = 'AIUnavailableError';
  }
}
export class AIValidationError extends Error {
  constructor(
    msg: string,
    readonly issues: string[] = [],
  ) {
    super(msg);
    this.name = 'AIValidationError';
  }
}
