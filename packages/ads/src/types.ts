export type AdPlatform = 'meta' | 'tiktok' | 'google';

export interface CreativeSpec {
  id: string;
  concept: string;
  headline: string;
  primaryText: string;
  description: string;
  cta: string;
  imageUrl?: string;
  videoUrl?: string;
}

export interface CampaignSpec {
  name: string;
  country: string;
  currency: string;
  objective: 'sales';
  /** minor units of the account currency */
  dailyBudget: number;
  landingUrl: string;
  audience: { ageMin?: number; ageMax?: number; interests?: string[] };
  creatives: CreativeSpec[];
  startDate?: string;
  endDate?: string;
  /** mock provider only: average order value to synthesise revenue */
  mockHints?: { aov: number; quality?: number };
}

export interface CreatedCampaign {
  externalId: string;
  adSetIds: string[];
  /** creativeId (ours) -> platform ad id */
  creativeIds: Record<string, string>;
  /** Campaigns are created PAUSED; the caller activates them after safety checks. */
  status: 'paused';
}

export interface AdMetricRow {
  externalCampaignId: string;
  creativeId?: string;
  date: string; // YYYY-MM-DD
  impressions: number;
  clicks: number;
  spend: number; // minor units
  addToCart: number;
  checkouts: number;
  purchases: number;
  revenue: number; // minor units (platform-attributed)
}

export interface AdProvider {
  readonly key: AdPlatform | 'mock';
  createCampaign(spec: CampaignSpec): Promise<CreatedCampaign>;
  setStatus(externalId: string, status: 'active' | 'paused'): Promise<void>;
  updateDailyBudget(externalId: string, dailyBudget: number): Promise<void>;
  getMetrics(externalIds: string[], range: { from: string; to: string }): Promise<AdMetricRow[]>;
  healthCheck(): Promise<{ ok: boolean; message: string }>;
}

/** Thrown when a multi-step creation fails part-way. `partial` lists remote objects that now exist. */
export class PartialCreationError extends Error {
  constructor(
    message: string,
    readonly partial: { externalId?: string; adSetIds: string[] },
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'PartialCreationError';
  }
}
