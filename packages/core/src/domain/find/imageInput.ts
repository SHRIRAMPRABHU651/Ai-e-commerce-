/** Validation of an uploaded search image. PURE. The image is processed in memory and never stored. */

export const IMAGE_SEARCH_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageSearchMime = (typeof IMAGE_SEARCH_MIMES)[number];

/** Detects the real format from magic bytes, so a renamed file or a spoofed content-type is rejected. */
export function sniffImage(buf: Uint8Array): ImageSearchMime | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  const tag = (o: number) => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
  if (tag(0) === 'RIFF' && tag(8) === 'WEBP') return 'image/webp';
  return null;
}

export type ImageCheck = { ok: true; mime: ImageSearchMime } | { ok: false; reason: 'empty' | 'too_large' | 'type_mismatch' | 'unsupported_type' };
export function checkSearchImage(buf: Uint8Array, claimedMime: string, maxBytes: number): ImageCheck {
  if (!buf.length) return { ok: false, reason: 'empty' };
  if (buf.length > maxBytes) return { ok: false, reason: 'too_large' };
  if (!(IMAGE_SEARCH_MIMES as readonly string[]).includes(claimedMime.toLowerCase())) return { ok: false, reason: 'unsupported_type' };
  const real = sniffImage(buf);
  if (!real || real !== claimedMime.toLowerCase()) return { ok: false, reason: 'type_mismatch' };
  return { ok: true, mime: real };
}
