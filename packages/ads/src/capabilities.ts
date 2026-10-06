import type { AdPlatform } from './types';

/** What each adapter's code implements. SUPPORTED means "implemented", never "verified against the live API". */
export type AdCapability = 'createCampaign' | 'pauseResume' | 'updateBudget' | 'metrics' | 'healthCheck' | 'conversionTracking' | 'catalogSync';
export type CapabilityState = 'SUPPORTED' | 'UNSUPPORTED';
export type AdPlatformStatus = 'NOT_CONFIGURED' | 'UNVERIFIED' | 'VERIFIED' | 'ERROR';

export const AD_CAPABILITIES: Record<AdPlatform, Record<AdCapability, CapabilityState>> = {
  meta: { createCampaign: 'SUPPORTED', pauseResume: 'SUPPORTED', updateBudget: 'SUPPORTED', metrics: 'SUPPORTED', healthCheck: 'SUPPORTED', conversionTracking: 'UNSUPPORTED', catalogSync: 'UNSUPPORTED' },
  tiktok: { createCampaign: 'SUPPORTED', pauseResume: 'SUPPORTED', updateBudget: 'SUPPORTED', metrics: 'SUPPORTED', healthCheck: 'SUPPORTED', conversionTracking: 'UNSUPPORTED', catalogSync: 'UNSUPPORTED' },
  google: { createCampaign: 'SUPPORTED', pauseResume: 'SUPPORTED', updateBudget: 'SUPPORTED', metrics: 'SUPPORTED', healthCheck: 'SUPPORTED', conversionTracking: 'UNSUPPORTED', catalogSync: 'UNSUPPORTED' },
};

export function platformStatus(configured: boolean, verification?: { status: 'PASS' | 'WARN' | 'FAIL' }): AdPlatformStatus {
  if (!configured) return 'NOT_CONFIGURED';
  if (!verification) return 'UNVERIFIED';
  return verification.status === 'PASS' ? 'VERIFIED' : verification.status === 'FAIL' ? 'ERROR' : 'UNVERIFIED';
}

/** AI-managed spend needs a verified platform AND conversion tracking proven; otherwise it may only propose. */
export function canAutoSpend(status: AdPlatformStatus, trackingVerified: boolean): { ok: boolean; reason: string } {
  if (status !== 'VERIFIED') return { ok: false, reason: `platform is ${status}; run a live check first` };
  if (!trackingVerified) return { ok: false, reason: 'conversion tracking is not verified, so results cannot be trusted' };
  return { ok: true, reason: 'verified' };
}
