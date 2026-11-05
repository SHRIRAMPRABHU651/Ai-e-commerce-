import type { Metadata } from 'next';
import { PrivacyPanel } from '@/components/customer360';

export const metadata: Metadata = { title: 'Privacy', robots: { index: false, follow: false } };

export default function Page() {
  return <PrivacyPanel />;
}
