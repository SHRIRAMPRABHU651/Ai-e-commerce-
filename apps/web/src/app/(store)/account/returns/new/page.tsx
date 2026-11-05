import type { Metadata } from 'next';
import { ReturnWizard } from '@/components/aftersales';

export const metadata: Metadata = { title: 'Start a return', robots: { index: false, follow: false } };

export default async function Page({ searchParams }: { searchParams: Promise<{ order?: string }> }) {
  const { order } = await searchParams;
  if (!order) return <p className="text-ink-3">Open an order and choose “Start a return”.</p>;
  return <ReturnWizard orderNumber={order} />;
}
