import { ProviderError } from '@orvia/config';
import type { Logger } from '@orvia/config';
import { GeminiProvider } from './gemini';
import { AIUnavailableError, AIValidationError } from './provider';
import type { AIProvider } from './provider';
import { TemplateAIProvider } from './template';
import type { AdCreative, BusinessNarrative, ProductAnalysis, ProductContent, ProductSource, ReviewAnalysis } from './schemas';

export interface AIResult<T> {
  data: T;
  /** Where the output came from. "template" = deterministic, built only from source data. */
  source: 'gemini' | 'template';
  /** True if the LLM was configured but failed or was rejected by guardrails. */
  degraded: boolean;
  notes: string[];
}

export interface AIServiceConfig {
  geminiApiKey?: string;
  geminiModel: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

/**
 * Facade over the LLM provider with schema validation, grounding guards and a deterministic
 * fallback. AI output is never trusted: if validation fails we fall back, we do not "fix" it silently.
 */
export class AIService {
  readonly primary: AIProvider | null;
  readonly fallback: AIProvider = new TemplateAIProvider();

  constructor(private readonly cfg: AIServiceConfig) {
    this.primary = cfg.geminiApiKey
      ? new GeminiProvider(cfg.geminiApiKey, { model: cfg.geminiModel, timeoutMs: cfg.timeoutMs, fetchImpl: cfg.fetchImpl })
      : null;
  }

  get llmConfigured(): boolean {
    return !!this.primary;
  }

  private async run<T>(label: string, llm: (p: AIProvider) => Promise<T>, tpl: (p: AIProvider) => Promise<T>): Promise<AIResult<T>> {
    const notes: string[] = [];
    if (this.primary) {
      try {
        const data = await llm(this.primary);
        return { data, source: 'gemini', degraded: false, notes };
      } catch (err) {
        const msg =
          err instanceof AIValidationError
            ? `${label}: output rejected (${err.message}: ${err.issues.slice(0, 5).join(', ')})`
            : `${label}: LLM call failed (${(err as Error).message})`;
        notes.push(msg);
        this.cfg.logger?.warn({ channel: 'ai', label, err: msg }, 'AI fell back to template');
      }
    }
    try {
      const data = await tpl(this.fallback);
      return { data, source: 'template', degraded: !!this.primary, notes };
    } catch (err) {
      if (err instanceof AIUnavailableError) throw err;
      throw new ProviderError(`${label} failed: ${(err as Error).message}`, { provider: 'ai', retryable: false });
    }
  }

  productContent(src: ProductSource): Promise<AIResult<ProductContent>> {
    return this.run('productContent', (p) => p.generateProductDescription(src), (p) => p.generateProductDescription(src));
  }
  adCreatives(src: ProductSource, concepts?: string[]): Promise<AIResult<AdCreative[]>> {
    return this.run('adCreatives', (p) => p.generateAdCopy(src, concepts), (p) => p.generateAdCopy(src, concepts));
  }
  analyzeProduct(src: ProductSource): Promise<AIResult<ProductAnalysis>> {
    return this.run('analyzeProduct', (p) => p.analyzeProduct(src), (p) => p.analyzeProduct(src));
  }
  analyzeReviews(reviews: { rating: number; text: string }[]): Promise<AIResult<ReviewAnalysis>> {
    return this.run('analyzeReviews', (p) => p.analyzeReviews(reviews), (p) => p.analyzeReviews(reviews));
  }
  /** Returns null when no LLM is available: callers render the deterministic numbers instead. */
  async businessNarrative(data: Record<string, unknown>): Promise<AIResult<BusinessNarrative> | null> {
    if (!this.primary) return null;
    try {
      return { data: await this.primary.analyzeBusiness(data), source: 'gemini', degraded: false, notes: [] };
    } catch (err) {
      this.cfg.logger?.warn({ channel: 'ai', err: (err as Error).message }, 'business narrative unavailable');
      return null;
    }
  }
  async classify(text: string, labels: string[]): Promise<{ label: string; confidence: number; source: 'gemini' | 'template' }> {
    if (this.primary) {
      try {
        return { ...(await this.primary.classify(text, labels)), source: 'gemini' };
      } catch {
        /* fall through */
      }
    }
    return { ...(await this.fallback.classify(text, labels)), source: 'template' };
  }
}
