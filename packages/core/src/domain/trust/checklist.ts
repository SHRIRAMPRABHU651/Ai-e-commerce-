/** Product evidence checklist (pure): which customer-relevant facts exist and how well each is evidenced. */
import type { Provenance } from '@orvia/types';
import type { EvidenceRecord } from './passport';

export interface ChecklistItem { key: string; label: string; present: boolean; provenance: Provenance | null }

const MATERIAL = /(material|fabric|composition|made of|filling|lining)/i;
const DIMENSION = /(dimension|size|length|width|height|depth|weight|capacity|diameter|volume|thickness)/i;

export interface ChecklistInputs {
  now: Date;
  attributes: Record<string, string>;
  description: string;
  safetyStandards: string[];
  organicVerified: boolean;
  images: { license: 'unknown' | 'supplier_provided' | 'owned' }[];
  evidence: EvidenceRecord[];
}

export function buildChecklist(i: ChecklistInputs): ChecklistItem[] {
  const active = i.evidence.filter((e) => (!e.expiresAt || e.expiresAt.getTime() > i.now.getTime()) && e.provenance !== 'ai_suggested');
  const verified = (kinds: string[]) => active.some((e) => e.provenance === 'verified' && kinds.includes(e.kind));
  const attrs = Object.entries(i.attributes).filter(([, v]) => v?.trim());
  const item = (key: string, label: string, present: boolean, verifiedFlag: boolean, supplierProvided = true): ChecklistItem => ({ key, label, present: present || verifiedFlag, provenance: verifiedFlag ? 'verified' : present ? (supplierProvided ? 'supplier_provided' : 'ai_suggested') : null });
  return [
    item('description', 'Product description', i.description.trim().length >= 40, false, false),
    item('specifications', 'Specifications', attrs.filter(([k]) => !MATERIAL.test(k) && !DIMENSION.test(k)).length >= 1 || active.some((e) => e.kind === 'specification'), verified(['specification'])),
    item('materials', 'Materials', attrs.some(([k]) => MATERIAL.test(k)) || active.some((e) => e.kind === 'material'), verified(['material'])),
    item('dimensions', 'Dimensions and weight', attrs.some(([k]) => DIMENSION.test(k)) || active.some((e) => e.kind === 'dimension'), verified(['dimension'])),
    item('manufacturer', 'Manufacturer identity', active.some((e) => e.kind === 'manufacturer'), active.some((e) => e.kind === 'manufacturer' && e.provenance === 'verified')),
    item('safety', 'Safety standards / certificates', i.safetyStandards.length > 0, verified(['certificate', 'test_report']) || i.organicVerified),
    { key: 'image_rights', label: 'Image sources and usage rights', present: i.images.length > 0, provenance: !i.images.length ? null : i.images.every((m) => m.license === 'owned') ? 'verified' : 'supplier_provided' },
  ];
}

const CREDIT = { verified: 1, supplier_provided: 0.6, customer_reported: 0.3, ai_suggested: 0.2 } as const;
/** 0..1 evidence completeness: verified facts count fully, supplier-provided 0.6, AI/customer lower, absent 0. */
export function completenessOf(items: ChecklistItem[]): number {
  if (!items.length) return 0;
  return Math.round((items.reduce((a, c) => a + (c.present && c.provenance ? CREDIT[c.provenance] : 0), 0) / items.length) * 1000) / 1000;
}
