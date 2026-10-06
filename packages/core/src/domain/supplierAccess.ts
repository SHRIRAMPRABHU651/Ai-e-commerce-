import { decryptSecret, encryptSecret } from '@orvia/auth';
import { Supplier } from '@orvia/database';
import type { SupplierProvider } from '@orvia/suppliers';
import type { Ctx } from '../infra/context';

/** Key used to encrypt supplier credentials at rest (ENCRYPTION_KEY, falling back to JWT_SECRET so dev works out of the box). */
const keyOf = (ctx: Ctx): string => ctx.cfg.ENCRYPTION_KEY ?? ctx.cfg.JWT_SECRET;

export const sealCredentials = (ctx: Ctx, creds: Record<string, string>): string => encryptSecret(JSON.stringify(creds), keyOf(ctx));

/** Concrete provider for a supplier record, using that supplier's own credentials and API mapping. */
export async function providerFor(ctx: Ctx, s: { provider: string; code: string }): Promise<SupplierProvider> {
  const d = await Supplier.findOne({ code: s.code }).select('+credentialsEnc config updatedAt').lean();
  let credentials: Record<string, string> | undefined;
  if (d?.credentialsEnc) {
    try {
      credentials = JSON.parse(decryptSecret(d.credentialsEnc, keyOf(ctx))) as Record<string, string>;
    } catch {
      throw new Error(`Supplier ${s.code}: stored credentials cannot be decrypted (ENCRYPTION_KEY changed?) — re-enter them`);
    }
  }
  return ctx.suppliers.resolve({ provider: s.provider, code: s.code, credentials, config: d?.config, rev: d?.updatedAt ? String(d.updatedAt.valueOf?.() ?? d.updatedAt) : undefined });
}

/**
 * The variant id to send to a given supplier. A product can be sourced from several suppliers (e.g. one per country) and
 * each numbers its variants differently: prefer an exact match, then the same label, then the only variant.
 */
export function pickSupplierSku(
  supplierVariants: { sku?: string | null; label?: string | null }[] | null | undefined,
  variant: { supplierSku?: string | null; label?: string | null } | null | undefined,
): string | undefined {
  const vs = (supplierVariants ?? []).filter((v) => v.sku);
  if (!vs.length) return undefined;
  const exact = vs.find((v) => v.sku === variant?.supplierSku);
  if (exact) return exact.sku!;
  const byLabel = variant?.label ? vs.find((v) => v.label?.toLowerCase() === variant.label!.toLowerCase()) : undefined;
  if (byLabel) return byLabel.sku!;
  return vs.length === 1 ? vs[0]!.sku! : undefined;
}

/** A supplier with no declared coverage serves everywhere (legacy/demo); otherwise only the listed countries. */
export const servesCountry = (s: { servesCountries?: string[] | null }, country: string): boolean => !s.servesCountries?.length || s.servesCountries.includes(country);
