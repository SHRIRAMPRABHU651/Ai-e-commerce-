import type { Metadata } from 'next';
import { OrderPage } from '@/components/order-view';

export const metadata: Metadata = { title: 'Your order', robots: { index: false, follow: false } };

export default async function Page({ params, searchParams }: { params: Promise<{ orderNumber: string }>; searchParams: Promise<{ email?: string; placed?: string }> }) {
  const { orderNumber } = await params;
  const sp = await searchParams;
  return <OrderPage orderNumber={orderNumber.toUpperCase()} initialEmail={sp.email} placed={sp.placed === '1'} />;
}
