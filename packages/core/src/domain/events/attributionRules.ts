/** Channel classification and contribution-based guidance (pure). Optimises retained contribution, never clicks or platform-reported ROAS. */

export type Channel = 'paid_google' | 'paid_meta' | 'paid_tiktok' | 'paid_other' | 'email' | 'creator' | 'organic_search' | 'organic_social' | 'referral' | 'direct' | 'unattributed';

export interface TouchInput {
  utmSource?: string | null;
  utmMedium?: string | null;
  clickIdType?: string | null;
  referrerHost?: string | null;
}

const SEARCH = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex)\./i;
const SOCIAL = /(^|\.)(facebook|instagram|tiktok|pinterest|reddit|youtube|twitter|x|linkedin)\.com$|^t\.co$|^l\.facebook\.com$/i;

export function classifyChannel(t: TouchInput | null | undefined, ownHost?: string): Channel {
  if (!t) return 'unattributed';
  const src = (t.utmSource ?? '').toLowerCase(), med = (t.utmMedium ?? '').toLowerCase();
  if (t.clickIdType === 'gclid' || t.clickIdType === 'gbraid' || t.clickIdType === 'wbraid') return 'paid_google';
  if (t.clickIdType === 'fbclid') return 'paid_meta';
  if (t.clickIdType === 'ttclid') return 'paid_tiktok';
  if (/^(cpc|ppc|paid|paidsocial|paid_social|paid-social|display)$/.test(med)) {
    if (/google/.test(src)) return 'paid_google';
    if (/facebook|instagram|meta|fb|ig/.test(src)) return 'paid_meta';
    if (/tiktok/.test(src)) return 'paid_tiktok';
    return 'paid_other';
  }
  if (med === 'email' || /^(email|newsletter)$/.test(src)) return 'email';
  if (/^(creator|affiliate|influencer)$/.test(med)) return 'creator';
  if (med === 'organic') return 'organic_search';
  const host = (t.referrerHost ?? '').toLowerCase();
  if (host && ownHost && host === ownHost.toLowerCase()) return 'direct';
  if (host) return SEARCH.test(host) ? 'organic_search' : SOCIAL.test(host) ? 'organic_social' : 'referral';
  if (src) return 'referral';
  return 'direct';
}

/** Ad-platform spend maps onto paid channels (AdMetric.platform). */
export const PLATFORM_CHANNEL: Record<string, Channel> = { meta: 'paid_meta', tiktok: 'paid_tiktok', google: 'paid_google' };

export interface ChannelRow { channel: Channel; orders: number; netSalesUsd: number; contributionKnownOrders: number; contributionUsd: number; adSpendUsd: number }

export interface ChannelReport extends ChannelRow {
  /** Ad spend / attributed orders; null without spend or orders. */
  cacUsd: number | null;
  /** Contribution after refunds minus ad spend (USD cents). Null if no order has a known contribution. */
  retainedContributionUsd: number | null;
  contributionPerOrderAfterCacUsd: number | null;
  guidance: string;
}

export const MIN_ORDERS_FOR_GUIDANCE = 30;

export function reportChannel(r: ChannelRow): ChannelReport {
  const cac = r.adSpendUsd > 0 && r.orders > 0 ? Math.round(r.adSpendUsd / r.orders) : null;
  const retained = r.contributionKnownOrders > 0 ? r.contributionUsd - r.adSpendUsd : null;
  const perOrder = retained !== null && r.orders > 0 ? Math.round(retained / r.orders) : null;
  let guidance: string;
  if (r.channel === 'unattributed') guidance = 'Orders without consented attribution data. Not comparable; do not use for channel decisions.';
  else if (r.orders < MIN_ORDERS_FOR_GUIDANCE) guidance = `Insufficient data (${r.orders} attributed orders; need ${MIN_ORDERS_FOR_GUIDANCE}).`;
  else if (retained === null) guidance = 'Contribution not yet known for these orders (fulfilment costs missing).';
  else if (retained < 0) guidance = 'Retained contribution is negative after ad spend. Proposal only: review before any budget is kept or increased.';
  else guidance = 'Retained contribution is positive after ad spend on the attributed sample. Any scale-up still needs an authorised, capped proposal.';
  return { ...r, cacUsd: cac, retainedContributionUsd: retained, contributionPerOrderAfterCacUsd: perOrder, guidance };
}
