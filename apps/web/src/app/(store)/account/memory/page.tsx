import type { Metadata } from 'next';
import { MemoryPanel } from '@/components/customer360';

export const metadata: Metadata = { title: 'Memory', robots: { index: false, follow: false } };

export default function Page() {
  return <MemoryPanel />;
}
