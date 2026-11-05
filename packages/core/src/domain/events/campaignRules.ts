/** Email campaign recipient selection (pure). The one hard rule: nobody without recorded marketing consent is ever emailed. */

export interface Candidate {
  email: string;
  marketingConsent: boolean;
}

export type ExclusionReason = 'invalid_email' | 'no_consent' | 'unsubscribed' | 'frequency_cap' | 'campaign_cap' | 'daily_limit';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Consent + suppression check applied BOTH when planning and again immediately before each message is queued. */
export function emailEligibility(c: Candidate, o: { unsubscribed: ReadonlySet<string>; recentlyEmailed?: ReadonlySet<string> }): { ok: true } | { ok: false; reason: ExclusionReason } {
  const email = c.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, reason: 'invalid_email' };
  if (c.marketingConsent !== true) return { ok: false, reason: 'no_consent' };
  if (o.unsubscribed.has(email)) return { ok: false, reason: 'unsubscribed' };
  if (o.recentlyEmailed?.has(email)) return { ok: false, reason: 'frequency_cap' };
  return { ok: true };
}

export interface RecipientPlan {
  recipients: string[];
  excluded: Record<ExclusionReason, number>;
}

/** Applies consent, unsubscribe list, per-recipient frequency cap, then the campaign cap and the global daily limit (in that order). */
export function planRecipients(cands: Candidate[], o: { unsubscribed: ReadonlySet<string>; recentlyEmailed: ReadonlySet<string>; maxRecipients: number; dailyRemaining: number }): RecipientPlan {
  const excluded: Record<ExclusionReason, number> = { invalid_email: 0, no_consent: 0, unsubscribed: 0, frequency_cap: 0, campaign_cap: 0, daily_limit: 0 };
  const seen = new Set<string>();
  const ok: string[] = [];
  for (const c of cands) {
    const email = c.email.trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    const e = emailEligibility({ ...c, email }, o);
    if (e.ok) ok.push(email);
    else excluded[e.reason]++;
  }
  const afterCampaignCap = ok.slice(0, Math.max(0, o.maxRecipients));
  excluded.campaign_cap = ok.length - afterCampaignCap.length;
  const allowed = Math.max(0, Math.min(afterCampaignCap.length, o.dailyRemaining));
  excluded.daily_limit = afterCampaignCap.length - allowed;
  return { recipients: afterCampaignCap.slice(0, allowed), excluded };
}

export const maskEmail = (e: string): string => {
  const [l = '', d = ''] = e.split('@');
  return `${l.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(5, l.length - 1)))}@${d}`;
};
