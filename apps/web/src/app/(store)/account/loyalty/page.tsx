import type { Metadata } from 'next';
import { LoyaltyPanel } from '@/components/creators-loyalty';

export const metadata: Metadata = { title: 'Loyalty', robots: { index: false, follow: false } };

export default function Page() {
  return <LoyaltyPanel />;
}
