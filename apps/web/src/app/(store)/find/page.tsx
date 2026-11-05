import type { Metadata } from 'next';
import { FindPage } from '@/components/find';

export const metadata: Metadata = { title: 'Find with AI', description: 'Describe what you want, your budget and when you need it. Orvia finds real, available products and shows why each one matched.', robots: { index: false, follow: true } };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const budget = sp['budget'] ? Number(sp['budget']) : undefined;
  const by = sp['by'];
  return <FindPage initialQuery={(sp['q'] ?? '').slice(0, 300)} initialBudget={budget && Number.isFinite(budget) && budget > 0 ? budget : undefined} initialBy={by && /^\d{4}-\d{2}-\d{2}$/.test(by) ? by : undefined} />;
}
