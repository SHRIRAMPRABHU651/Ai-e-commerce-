/**
 * Customer-facing wording for Delivery Rescue. Pure. Plain language, no internal terms, no invented dates or promises.
 * Sent through the existing `custom` notification template (subject + message + optional link).
 */
import type { RescueFailureKind } from '@orvia/types';

export type RescueStage = 'detected' | 'options' | 'consent_accepted' | 'consent_declined' | 'resolved' | 'escalated' | 'refunded';

const WHAT: Record<RescueFailureKind, string> = {
  supplier_cancellation: 'the supplier cancelled the item on our side',
  supplier_acceptance_failure: 'we have not been able to place your item with a supplier yet',
  stock_shortage: 'the item turned out to be out of stock at the supplier',
  failed_delivery: 'the carrier could not deliver your parcel',
  suspected_lost: 'your parcel has not moved for a long time and may be lost',
  carrier_exception: 'the carrier reported a problem with your parcel',
  invalid_tracking: 'we could not get a reliable tracking number for your parcel yet',
  shipment_delay: 'your parcel is later than we estimated',
  unusual_delivery_pattern: 'the delivery record looks unusual',
};

export const customerKindText = (k: RescueFailureKind): string => WHAT[k];

export function rescueMessage(stage: RescueStage, p: { kind: RescueFailureKind; title: string; orderNumber: string; detail?: string }): { subject: string; message: string } {
  const item = `“${p.title}”`;
  switch (stage) {
    case 'detected':
      return {
        subject: `An update on your order ${p.orderNumber}`,
        message: `We noticed a problem with ${item} in order ${p.orderNumber}: ${WHAT[p.kind]}. We are already working on it and will tell you your options as soon as we have them. You do not need to do anything right now.`,
      };
    case 'options':
      return {
        subject: `Your options for order ${p.orderNumber}`,
        message: `About ${item}: ${WHAT[p.kind]}. We have prepared options for you. Nothing changes unless you choose one. Please open the link to see them in plain terms and pick the one you prefer.`,
      };
    case 'consent_accepted':
      return { subject: `We received your choice for order ${p.orderNumber}`, message: `Thank you. We recorded your choice${p.detail ? `: ${p.detail}` : ''} and are acting on it now. We will confirm when it is done.` };
    case 'consent_declined':
      return { subject: `We noted your answer for order ${p.orderNumber}`, message: `You declined${p.detail ? ` “${p.detail}”` : ' that option'}. Nothing was changed. A team member will follow up so you can still get a good outcome.` };
    case 'resolved':
      return { subject: `Order ${p.orderNumber}: update`, message: `${p.detail ?? 'The problem with your order has been resolved.'} You can see the latest status on your order page.` };
    case 'escalated':
      return { subject: `A team member is handling order ${p.orderNumber}`, message: `We could not fix the problem with ${item} automatically, so a member of our team is now handling it personally. We will contact you. Nothing further is needed from you.` };
    case 'refunded':
      return { subject: `Refund for order ${p.orderNumber}`, message: `${p.detail ?? 'Your refund has been started.'} Refunds usually take several business days to appear, depending on your bank.` };
  }
}
