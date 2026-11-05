/**
 * Return labels. A label URL is stored only when a registered provider (or the supplier, recorded as such by staff)
 * actually returned one. Otherwise the customer gets written instructions and nothing is promised.
 */
export interface LabelRequest { rmaNumber: string; orderNumber: string; supplierId: string; from: { name?: string; line1?: string; city?: string; region?: string; postalCode?: string; country?: string }; to?: Record<string, unknown> }
export interface LabelResult { url: string; carrier?: string; trackingNumber?: string; providerRef?: string }
export interface ReturnLabelProvider {
  readonly key: string;
  issueLabel(req: LabelRequest): Promise<LabelResult>;
}

const providers = new Map<string, ReturnLabelProvider>();
/** No carrier integration ships enabled: real providers need carrier credentials and are registered by deployment code. */
export const registerLabelProvider = (p: ReturnLabelProvider): void => { providers.set(p.key, p); };
export const getLabelProvider = (key: string | undefined): ReturnLabelProvider | null => (key ? providers.get(key) ?? null : null);

export interface InstructionInput {
  rmaNumber: string;
  orderNumber: string;
  returnMethod: 'ship_back' | 'staff_decides' | 'none_needed';
  supplierInstructions?: string;
  returnAddress?: { name?: string; line1?: string; line2?: string; city?: string; region?: string; postalCode?: string; country?: string } | null;
  hasLabel: boolean;
}

/** Customer-facing instructions built only from data we hold. */
export function buildReturnInstructions(i: InstructionInput): string {
  const lines: string[] = [`Return authorization ${i.rmaNumber} for order ${i.orderNumber}.`];
  if (i.returnMethod === 'none_needed') return `${lines[0]} You do not need to send anything back. We will update you once we have checked with the carrier.`;
  if (i.returnMethod === 'staff_decides') lines.push('Our team will tell you whether the item needs to be sent back. Please do not ship anything until you hear from us.');
  else {
    if (i.hasLabel) lines.push('Use the prepaid return label attached to this return.');
    else lines.push('We do not have a prepaid label for this item. Ship it back using a tracked service and add the tracking number to your return.');
    const a = i.returnAddress;
    if (a?.line1) lines.push(`Return address: ${[a.name, a.line1, a.line2, a.city, a.region, a.postalCode, a.country].filter(Boolean).join(', ')}`);
    lines.push(`Write ${i.rmaNumber} on the parcel. Pack the item in its original packaging where possible.`);
  }
  if (i.supplierInstructions) lines.push(i.supplierInstructions);
  return lines.join('\n');
}
