import type { Metadata } from 'next';
import { CompanionPanel } from '@/components/customer360';

export const metadata: Metadata = { title: 'Product companion', robots: { index: false, follow: false } };

export default async function Page({ params }: { params: Promise<{ orderItemId: string }> }) {
  const { orderItemId } = await params;
  return <CompanionPanel orderItemId={orderItemId} />;
}
