import type { Metadata } from 'next';
import { ReturnsPanel } from '@/components/account';

export const metadata: Metadata = { title: 'Your account', robots: { index: false, follow: false } };

export default function Page() {
  return <ReturnsPanel />;
}
