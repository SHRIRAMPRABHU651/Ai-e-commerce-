import { Providers } from '@/components/providers';
import { AnnouncementBar, CartDrawer, ChatWidget, Footer, Header, MobileTabBar } from '@/components/chrome';
import { resolveCountry, sget } from '@/lib/server';
import type { Meta, User } from '@/lib/types';

export default async function StoreLayout({ children }: { children: React.ReactNode }) {
  const country = await resolveCountry();
  const [meta, me] = await Promise.all([sget<Meta>('/meta', { country }), sget<{ user: User | null }>('/auth/me', { country })]);
  if (!meta) throw new Error('Store configuration unavailable');
  return (
    <Providers meta={meta} country={country} initialUser={me?.user ?? null}>
      <a href="#main" className="sr-only z-[100] rounded-md bg-ink px-4 py-2 font-semibold text-paper focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to content</a>
      <AnnouncementBar />
      <Header />
      <main id="main" className="min-h-[60dvh]">{children}</main>
      <Footer />
      <MobileTabBar />
      <CartDrawer />
      <ChatWidget />
    </Providers>
  );
}
