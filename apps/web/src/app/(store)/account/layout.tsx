import { redirect } from 'next/navigation';
import { AccountNav } from '@/components/account';
import { sget } from '@/lib/server';
import type { User } from '@/lib/types';

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const me = await sget<{ user: User | null }>('/auth/me');
  if (!me?.user) redirect('/login?next=/account');
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-10">
      <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">Hi, {me.user.name.split(' ')[0]}</h1>
      <div className="mt-6 grid gap-6 md:grid-cols-[13rem_1fr] md:gap-10"><AccountNav /><div className="min-w-0">{children}</div></div>
    </div>
  );
}
