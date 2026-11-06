import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { CreatorPortal } from '@/components/creators-portal';
import { sget } from '@/lib/server';
import type { User } from '@/lib/types';

export const metadata: Metadata = { title: 'Creator portal', robots: { index: false, follow: false } };

export default async function Page() {
  const me = await sget<{ user: User | null }>('/auth/me');
  if (!me?.user) redirect('/login?next=/creator');
  return <div className="mx-auto max-w-5xl px-4 py-6 sm:py-10"><CreatorPortal /></div>;
}
