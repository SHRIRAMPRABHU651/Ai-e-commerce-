import type { Metadata } from 'next';
import { ReferralPanel } from '@/components/growth';

export const metadata: Metadata = { title: 'Invite a friend', robots: { index: false, follow: false } };

export default function Page() {
  return <ReferralPanel />;
}
