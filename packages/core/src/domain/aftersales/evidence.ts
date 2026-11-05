/** Pure validation for customer evidence photos. Decode/re-encode (EXIF stripping) happens in the service via sharp. */
import { EVIDENCE_LIMITS } from '@orvia/types';

export type EvidenceFormat = 'jpeg' | 'png' | 'webp';
export interface EvidenceCheck { ok: boolean; format?: EvidenceFormat; error?: { code: 'size' | 'type' | 'mismatch' | 'limit' | 'empty'; message: string } }

/** Magic-byte sniffing: the declared MIME type is never trusted on its own. */
export function sniffEvidenceFormat(b: Buffer): EvidenceFormat | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

const MIME_FOR: Record<EvidenceFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export function validateEvidenceFile(file: { buffer: Buffer; mimetype: string }, o: { maxBytes: number; existingCount: number }): EvidenceCheck {
  if (o.existingCount >= EVIDENCE_LIMITS.maxFilesPerReturn) return { ok: false, error: { code: 'limit', message: `You can attach at most ${EVIDENCE_LIMITS.maxFilesPerReturn} photos` } };
  if (file.buffer.length < EVIDENCE_LIMITS.minBytes) return { ok: false, error: { code: 'empty', message: 'That file is empty or too small to be a photo' } };
  if (file.buffer.length > o.maxBytes) return { ok: false, error: { code: 'size', message: `Photo is larger than ${Math.round(o.maxBytes / 1_000_000)} MB` } };
  if (!EVIDENCE_LIMITS.allowedMime.includes(file.mimetype.toLowerCase())) return { ok: false, error: { code: 'type', message: 'Only JPEG, PNG and WebP photos are accepted' } };
  const format = sniffEvidenceFormat(file.buffer);
  if (!format) return { ok: false, error: { code: 'type', message: 'The file is not a valid JPEG, PNG or WebP image' } };
  if (MIME_FOR[format] !== file.mimetype.toLowerCase()) return { ok: false, error: { code: 'mismatch', message: 'The file content does not match its type' } };
  return { ok: true, format };
}

/** Evidence may be added by the return's owner (customer) while the RMA is still open, or by staff at any time. */
export function canAddEvidence(a: { isStaff: boolean; isOwner: boolean; state: string }): boolean {
  if (a.isStaff) return true;
  return a.isOwner && ['submitted', 'authorized', 'in_transit'].includes(a.state);
}

export const isReturnOwner = (rec: { userId?: string | null; email?: string | null }, who: { userId?: string; email?: string }): boolean =>
  (!!who.userId && !!rec.userId && String(rec.userId) === who.userId) || (!!who.email && !!rec.email && rec.email.toLowerCase() === who.email.toLowerCase());

/** Evidence requirement for a reason: `required` blocks submission without a photo. */
export function evidenceSatisfied(requirement: 'required' | 'recommended' | 'none', count: number): { ok: boolean; message?: string } {
  if (requirement === 'required' && count < 1) return { ok: false, message: 'Please attach at least one photo showing the problem' };
  return { ok: true };
}

export const evidenceStorageKey = (returnId: string, evidenceId: string, ext: string): string => `aftersales/evidence/${returnId}/${evidenceId}.${ext}`;
