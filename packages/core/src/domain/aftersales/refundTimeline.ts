/** Customer-visible refund status timeline, built only from real Return/Refund/Payment records. Pure. */
export interface TimelineRefund { status: string; amount: number; currency?: string | null; createdAt?: Date | null; updatedAt?: Date | null; failureReason?: string | null }
export interface TimelineInput {
  rmaState?: string | null;
  rmaCreatedAt?: Date | null;
  rmaEvents?: { state: string; at?: Date | null }[];
  refunds: TimelineRefund[];
  paymentStatus?: string | null;
}
export type StepStatus = 'done' | 'current' | 'pending' | 'problem';
export interface TimelineStep { key: string; label: string; status: StepStatus; at?: Date | null; detail?: string }

export function buildRefundTimeline(i: TimelineInput): { steps: TimelineStep[]; headline: string } {
  const steps: TimelineStep[] = [];
  const at = (s: string) => i.rmaEvents?.find((e) => e.state === s)?.at ?? null;
  if (i.rmaState) {
    steps.push({ key: 'requested', label: 'Return requested', status: 'done', at: i.rmaCreatedAt });
    if (i.rmaState === 'rejected') steps.push({ key: 'rejected', label: 'Return not approved', status: 'problem', at: at('rejected') });
    else {
      const authorized = !['submitted'].includes(i.rmaState);
      steps.push({ key: 'authorized', label: 'Return approved', status: authorized ? 'done' : 'current', at: at('authorized') });
      const received = ['received', 'inspected', 'refund_pending', 'replacement_pending', 'resolved'].includes(i.rmaState);
      if (i.rmaState !== 'cancelled') steps.push({ key: 'received', label: 'Item received and checked', status: received ? 'done' : authorized ? 'current' : 'pending', at: at('received') });
    }
  }
  const latest = [...i.refunds].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0];
  if (!latest) {
    if (i.rmaState && !['rejected', 'cancelled'].includes(i.rmaState)) steps.push({ key: 'refund', label: 'Refund', status: 'pending', detail: 'Starts after your return is approved' });
    return { steps, headline: i.rmaState === 'rejected' ? 'Your return was not approved' : 'No refund has been issued yet' };
  }
  const map: Record<string, { label: string; status: StepStatus; detail?: string }> = {
    pending_approval: { label: 'Refund awaiting review', status: 'current', detail: 'A team member is reviewing this refund' },
    processing: { label: 'Refund being sent to your payment method', status: 'current' },
    succeeded: { label: 'Refund sent', status: 'done', detail: 'Timing for the money to appear depends on your bank or card issuer' },
    failed: { label: 'Refund needs attention', status: 'problem', detail: 'We could not complete the refund automatically; our team has been alerted and will contact you' },
    rejected: { label: 'Refund declined', status: 'problem' },
  };
  const m = map[latest.status] ?? { label: `Refund ${latest.status}`, status: 'current' as StepStatus };
  steps.push({ key: 'refund', label: m.label, status: m.status, at: latest.updatedAt ?? latest.createdAt, detail: m.detail });
  const headline = latest.status === 'succeeded' ? 'Your refund has been sent' : latest.status === 'failed' ? 'There is a problem with your refund' : latest.status === 'rejected' ? 'Your refund was declined' : 'Your refund is in progress';
  return { steps, headline };
}
