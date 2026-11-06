/** customer360: shared types and zod schemas (owned by the customer360 workstream). */
import { z } from 'zod';

/* ------------------------------ consent ------------------------------ */
export const CONSENT_KINDS = ['marketing_email', 'personalization', 'analytics', 'data_processing'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];
export const CONSENT_SOURCES = ['account_settings', 'checkout', 'signup', 'staff_withdrawal', 'privacy_request', 'system'] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/** Versioned policy text ids. Bump when the wording shown to the customer changes; old records keep their version. */
export const POLICY_VERSIONS: Record<ConsentKind, string> = {
  marketing_email: 'marketing-email-2026-01',
  personalization: 'personalization-2026-01',
  analytics: 'analytics-2026-01',
  data_processing: 'data-processing-2026-01',
};

export const CHANNELS = ['email', 'sms', 'push'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * Contact topics. `transactional` topics are service messages the customer cannot opt out of while they have an order or
 * account (order updates, security, support replies); everything else is opt-in and consent-gated.
 */
export const CONTACT_TOPICS = [
  { id: 'order_updates', label: 'Order and delivery updates', transactional: true, personalized: false },
  { id: 'security', label: 'Account security', transactional: true, personalized: false },
  { id: 'support', label: 'Support replies', transactional: true, personalized: false },
  { id: 'promotions', label: 'Offers and promotions', transactional: false, personalized: false },
  { id: 'newsletter', label: 'Newsletter', transactional: false, personalized: false },
  { id: 'back_in_stock', label: 'Back-in-stock alerts you asked for', transactional: false, personalized: false },
  { id: 'price_drops', label: 'Price-drop alerts you asked for', transactional: false, personalized: false },
  { id: 'recommendations', label: 'Product suggestions', transactional: false, personalized: true },
  { id: 'replenishment', label: 'Reorder reminders', transactional: false, personalized: true },
] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number]['id'];
export const CONTACT_TOPIC_IDS = CONTACT_TOPICS.map((t) => t.id) as [ContactTopic, ...ContactTopic[]];

/* ------------------------------ lifegraph ------------------------------ */
export const LIFEGRAPH_SOURCES = ['declared', 'derived_from_purchases'] as const;
export type LifeGraphSource = (typeof LIFEGRAPH_SOURCES)[number];
export const LIFEGRAPH_PURPOSES = ['personalization', 'recommendations', 'gift_help', 'eco_filtering'] as const;
export type LifeGraphPurpose = (typeof LIFEGRAPH_PURPOSES)[number];

/* ------------------------------ commerce memory ------------------------------ */
export const MEMORY_KINDS = ['requirement', 'comparison', 'product_question', 'favourite_collection', 'note'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_RETENTION_OPTIONS = [30, 90, 180, 365, 0] as const; // 0 = keep until I delete it

/* ------------------------------ deletion ------------------------------ */
export const DELETION_STATUSES = ['requested', 'ready', 'on_hold', 'completed', 'cancelled', 'rejected'] as const;
export type DeletionStatus = (typeof DELETION_STATUSES)[number];
export const DELETION_COOLING_OFF_DAYS = 14;

/* ------------------------------ zod ------------------------------ */
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

export const consentChangeSchema = z.object({ granted: z.boolean(), source: z.enum(['account_settings', 'checkout', 'signup']).default('account_settings') });

export const commPrefsSchema = z.object({
  /** topic -> channel -> boolean. Unknown topics are rejected; transactional topics cannot be switched off. */
  topics: z.partialRecord(z.enum(CONTACT_TOPIC_IDS), z.object({ email: z.boolean().optional(), sms: z.boolean().optional(), push: z.boolean().optional() })),
  replenishmentOptIn: z.boolean().optional(),
});

export const lifeGraphNodeSchema = z.object({
  kind: z.string().trim().min(1).max(40),
  value: z.string().trim().min(1).max(60),
  parentId: objectId.optional(),
});
export const lifeGraphSettingsSchema = z.object({ enabled: z.boolean() });

export const memoryItemSchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  title: z.string().trim().min(1).max(120),
  payload: z.record(z.string().max(60), z.unknown()).default({}),
});
export const memoryPatchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  payload: z.record(z.string().max(60), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});
export const memorySettingsSchema = z.object({
  enabled: z.boolean().optional(),
  retentionDays: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365), z.literal(0)]).optional(),
});

export const deletionRequestSchema = z.object({ confirm: z.literal(true), reason: z.string().trim().max(500).optional() });

export const c360SearchSchema = z.object({ q: z.string().trim().min(2).max(120), page: z.coerce.number().int().min(1).max(50).default(1) });
export const c360ViewSchema = z.object({ reveal: z.enum(['email']).optional(), reason: z.string().trim().min(5).max(300).optional() });
export const staffNoteSchema = z.object({ body: z.string().trim().min(1).max(2000) });
export const staffConsentWithdrawSchema = z.object({ kind: z.enum(CONSENT_KINDS), reason: z.string().trim().min(5).max(300) });
export const deletionProcessSchema = z.object({ action: z.enum(['execute', 'reject', 'hold', 'release']), note: z.string().trim().min(3).max(500) });
