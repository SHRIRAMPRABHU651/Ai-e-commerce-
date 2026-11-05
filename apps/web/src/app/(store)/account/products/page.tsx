import type { Metadata } from 'next';
import { ProductsPanel } from '@/components/customer360';

export const metadata: Metadata = { title: 'My products', robots: { index: false, follow: false } };

export default function Page() {
  return <ProductsPanel />;
}
