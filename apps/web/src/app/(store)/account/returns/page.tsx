import type { Metadata } from 'next';
import { ReturnsCenter } from '@/components/aftersales';

export const metadata: Metadata = { title: 'Your returns', robots: { index: false, follow: false } };

export default function Page() {
  return <ReturnsCenter />;
}
