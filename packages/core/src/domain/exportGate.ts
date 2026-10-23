import type { CountryCode } from '@orvia/types';
import { ExceptionModel } from '@orvia/database';
import { audit } from '../infra/audit';
import { resolveExceptionsFor } from './exceptions';
import { DomainError } from '../infra/context';
import type { Actor, Ctx } from '../infra/context';

export interface ExportGateState {
  required: boolean;
  attested: boolean;
  confirmedBy?: string;
  confirmedAt?: string;
  reference?: string;
}

/**
 * Export / destination-market compliance gate. Whether a supplier-direct, no-inventory model qualifies
 * under India's cross-border e-commerce export framework is a legal question; Orvia cannot answer it.
 * It can only refuse to publish or fulfil for a destination until an operator records that a qualified
 * adviser established the obligations for that destination.
 */
export async function exportGate(ctx: Ctx, country: CountryCode | string): Promise<ExportGateState> {
  const legal = await ctx.settings.get('legal');
  const a = legal.exportAttestations?.[country];
  return { required: legal.requireExportAttestation, attested: !!a?.confirmedBy, confirmedBy: a?.confirmedBy, confirmedAt: a?.confirmedAt, reference: a?.reference };
}

export const exportGateMessage = (country: string): string =>
  `No export / destination-market attestation recorded for ${country} — obtain advice from a qualified export adviser and record it in Settings → Legal before publishing or fulfilling here`;

export async function attestExport(ctx: Ctx, country: CountryCode, reference: string, actor: Actor): Promise<void> {
  if (actor.type !== 'user') throw new DomainError('Only a person can attest export compliance', 'FORBIDDEN', 403);
  if (reference.trim().length < 5) throw new DomainError('Provide a reference to the adviser opinion (name, firm, date or document id)', 'INVALID', 422);
  const legal = await ctx.settings.get('legal');
  await ctx.settings.set('legal', { exportAttestations: { ...legal.exportAttestations, [country]: { confirmedBy: actor.id, confirmedAt: ctx.now().toISOString(), reference: reference.trim() } } }, actor.id);
  await audit(ctx, actor, { action: 'compliance.export.attested', resource: 'legal', resourceId: country, newValue: { country, reference }, reason: 'export attestation recorded' });
  // Release orders that were held only because this destination was unattested.
  const held = await ExceptionModel.find({ kind: 'EXPORT_ATTESTATION', status: { $in: ['open', 'in_progress'] }, dedupeKey: new RegExp(`^export:${country}:`) }).select('dedupeKey orderId').lean();
  const { requestFulfillment } = await import('./orders');
  for (const e of held) {
    await resolveExceptionsFor(ctx, e.dedupeKey!, `Export attestation recorded for ${country}`);
    if (e.orderId) await requestFulfillment(ctx, String(e.orderId));
  }
}

export async function revokeExportAttestation(ctx: Ctx, country: CountryCode, actor: Actor): Promise<void> {
  const legal = await ctx.settings.get('legal');
  const next = { ...legal.exportAttestations };
  delete next[country];
  // deepMerge cannot delete keys, so write the whole setting document back.
  const { SystemSetting } = await import('@orvia/database');
  await SystemSetting.updateOne({ key: 'legal' }, { $set: { value: { ...legal, exportAttestations: next }, updatedBy: actor.id } }, { upsert: true });
  ctx.settings.invalidate();
  await audit(ctx, actor, { action: 'compliance.export.revoked', resource: 'legal', resourceId: country, reason: 'export attestation revoked' });
}
