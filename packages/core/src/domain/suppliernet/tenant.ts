/**
 * Tenant-isolation predicates for the supplier portal. Pure and tiny on purpose: every portal route resolves the
 * caller's supplier ids through `portalSupplierIds`, and every query is filtered by those ids server-side.
 * A supplier id coming from the URL/body is NEVER trusted: it is only checked for membership.
 */
export interface PortalUser { id: string; role: string }
export interface SupplierLinkLike { _id?: unknown; id?: string; userIds?: unknown[] | null }

const asId = (v: unknown): string => String(v ?? '');

/** The caller is a SUPPLIER user explicitly linked to this supplier record. Staff roles never qualify. */
export function canActOnSupplier(user: PortalUser | null | undefined, supplier: SupplierLinkLike | null | undefined): boolean {
  if (!user || user.role !== 'SUPPLIER' || !supplier) return false;
  return (supplier.userIds ?? []).some((u) => asId(u) === user.id);
}

/** Filter every portal query must start from (Supplier collection). */
export const portalSupplierFilter = (userId: string): { userIds: string } => ({ userIds: userId });

/** Of the ids a request asked for, the ones the caller may touch. An empty result means "answer 404, reveal nothing". */
export function intersectOwned(requested: string[], owned: string[]): string[] {
  const set = new Set(owned.map(asId));
  return requested.map(asId).filter((r) => set.has(r));
}

/** Fields a supplier user may see of an ORVIA customer order: what is needed to ship, never email or payment data. */
export const PORTAL_ADDRESS_FIELDS = ['fullName', 'line1', 'line2', 'city', 'region', 'postalCode', 'country', 'phone'] as const;
export function portalAddress(a: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PORTAL_ADDRESS_FIELDS) if (a && typeof a[k] === 'string' && a[k]) out[k] = a[k] as string;
  return out;
}

/** Tracking numbers: 6-40 chars, letters/digits and common separators only (no whitespace tricks, no markup). */
export const TRACKING_RE = /^[A-Za-z0-9][A-Za-z0-9\-_/.]{4,39}$/;
export const isValidTrackingNumber = (s: string): boolean => TRACKING_RE.test(s.trim());
