import type { Metadata } from 'next';
import { AftercarePanel } from '@/components/customer360';

export const metadata: Metadata = { title: 'Aftercare', robots: { index: false, follow: false } };

export default function Page() {
  return <AftercarePanel />;
}
