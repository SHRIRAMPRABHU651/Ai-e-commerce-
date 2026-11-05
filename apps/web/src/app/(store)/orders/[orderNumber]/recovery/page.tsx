import type { Metadata } from 'next';
import { RecoveryPage } from '@/components/rescue-recovery';

export const metadata: Metadata = { title: 'Fixing your delivery', robots: { index: false, follow: false } };

export default async function Page({ params, searchParams }: { params: Promise<{ orderNumber: string }>; searchParams: Promise<{ token?: string }> }) {
  const { orderNumber } = await params;
  const sp = await searchParams;
  return <RecoveryPage orderNumber={orderNumber.toUpperCase()} token={sp.token} />;
}
