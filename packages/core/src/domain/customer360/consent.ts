/**
 * Consent + communication preferences. PURE. `canContact` is the single decision point the events workstream (and any
 * future sender) must call before sending a non-transactional message.
 */
import { CHANNELS, CONSENT_KINDS, CONTACT_TOPICS } from '@orvia/types';
import type { Channel, ConsentKind, ContactTopic } from '@orvia/types';

export interface ConsentRecordLike { kind: ConsentKind; granted: boolean; at: Date | string; policyVersion?: string }
export type ConsentState = Record<ConsentKind, { granted: boolean; at?: Date; policyVersion?: string }>;
export type TopicPrefs = Partial<Record<ContactTopic, Partial<Record<Channel, boolean>>>>;

/** Consent is opt-in: with no record the state is "not granted". Latest record per kind wins (append-only log). */
export function currentConsent(records: ConsentRecordLike[]): ConsentState {
  const out = Object.fromEntries(CONSENT_KINDS.map((k) => [k, { granted: false }])) as ConsentState;
  const sorted = [...records].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  for (const r of sorted) out[r.kind] = { granted: r.granted, at: new Date(r.at), policyVersion: r.policyVersion };
  return out;
}

export interface ContactProfile {
  /** Account removed / anonymized / disabled: nothing may be sent. */
  deleted?: boolean;
  consents: ConsentState;
  prefs: TopicPrefs;
  /** Hard suppression (bounced / complained). */
  suppressed?: boolean;
}

export const topicMeta = (t: ContactTopic) => CONTACT_TOPICS.find((x) => x.id === t);

export type ContactDecision = { allowed: boolean; reason: string };

/**
 * May we contact this customer about `topic` on `channel`?
 * - never when deleted or suppressed;
 * - transactional topics: allowed on email always, on sms/push only if the customer enabled that channel for the topic;
 * - everything else needs: marketing_email consent, an explicit per-topic per-channel opt-in (default off), and for
 *   personalized topics also personalization consent.
 */
export function canContactDecision(c: ContactProfile, topic: ContactTopic, channel: Channel): ContactDecision {
  if (c.deleted) return { allowed: false, reason: 'account_deleted' };
  if (c.suppressed) return { allowed: false, reason: 'suppressed' };
  if (!CHANNELS.includes(channel)) return { allowed: false, reason: 'unknown_channel' };
  const meta = topicMeta(topic);
  if (!meta) return { allowed: false, reason: 'unknown_topic' };
  const chosen = c.prefs[topic]?.[channel];
  if (meta.transactional) {
    if (channel === 'email') return { allowed: true, reason: 'transactional' };
    return chosen === true ? { allowed: true, reason: 'transactional_opt_in' } : { allowed: false, reason: 'channel_not_enabled' };
  }
  if (!c.consents.marketing_email.granted) return { allowed: false, reason: 'no_marketing_consent' };
  if (meta.personalized && !c.consents.personalization.granted) return { allowed: false, reason: 'no_personalization_consent' };
  if (chosen !== true) return { allowed: false, reason: 'topic_not_opted_in' };
  return { allowed: true, reason: 'opted_in' };
}

export const canContact = (c: ContactProfile, topic: ContactTopic, channel: Channel): boolean => canContactDecision(c, topic, channel).allowed;

/** Merge a patch into stored prefs; transactional email topics cannot be switched off. Returns a new object. */
export function applyPrefsPatch(prefs: TopicPrefs, patch: TopicPrefs): TopicPrefs {
  const next: TopicPrefs = JSON.parse(JSON.stringify(prefs ?? {})) as TopicPrefs;
  for (const [topic, chans] of Object.entries(patch) as [ContactTopic, Partial<Record<Channel, boolean>>][]) {
    const meta = topicMeta(topic);
    if (!meta) continue;
    for (const [ch, v] of Object.entries(chans) as [Channel, boolean | undefined][]) {
      if (v === undefined || !CHANNELS.includes(ch)) continue;
      if (meta.transactional && ch === 'email' && v === false) continue; // service emails cannot be disabled
      (next[topic] ??= {})[ch] = v;
    }
  }
  return next;
}
