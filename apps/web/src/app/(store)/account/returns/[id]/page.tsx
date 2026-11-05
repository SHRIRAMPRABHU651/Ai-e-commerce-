import type { Metadata } from 'next';
import { ReturnDetail } from '@/components/aftersales';

export const metadata: Metadata = { title: 'Return status', robots: { index: false, follow: false } };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReturnDetail id={id} />;
}
