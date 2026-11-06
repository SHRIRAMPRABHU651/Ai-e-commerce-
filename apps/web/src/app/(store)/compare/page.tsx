import type { Metadata } from 'next';
import { ComparePage } from '@/components/findCompare';

export const metadata: Metadata = { title: 'Compare products', robots: { index: false, follow: true } };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return <ComparePage idsParam={sp['ids']} />;
}
