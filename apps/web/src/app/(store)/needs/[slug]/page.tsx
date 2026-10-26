import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumb, Button, EmptyState, Link } from '@orvia/ui';
import { Search } from 'lucide-react';
import { ProductList, TrackPage } from '@/components/shelf';
import { sget } from '@/lib/server';
import type { StoreProduct } from '@/lib/types';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ page?: string }> };
interface NeedPage { need: { slug: string; name: string; tagline: string; promise: string }; items: StoreProduct[]; total: number; page: number; pageSize: number }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const r = await sget<NeedPage>(`/needs/${slug}?pageSize=1`);
  return r ? { title: r.need.name, description: r.need.promise, alternates: { canonical: `/needs/${slug}` } } : {};
}

export default async function NeedPageView({ params, searchParams }: Props) {
  const { slug } = await params;
  const { page } = await searchParams;
  const r = await sget<NeedPage>(`/needs/${slug}?pageSize=24&page=${Math.max(1, Number(page) || 1)}`);
  if (!r) notFound();
  const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
  const href = (p: number) => `/needs/${slug}?page=${p}`;
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:py-8">
      <TrackPage />
      <Breadcrumb items={[{ label: 'Home', href: '/' }, { label: r.need.name }]} />
      <div className="mb-6 mt-4">
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{r.need.name}</h1>
        <p className="mt-1.5 max-w-2xl text-ink-3">{r.need.promise}</p>
      </div>
      {r.items.length ? <ProductList products={r.items} priorityFirst={4} /> : <EmptyState icon={<Search className="size-6" />} title="Nothing here yet" body="We only show collections that have products in stock for your country." action={<Button href="/">Back to home</Button>} />}
      {pages > 1 && (
        <nav aria-label="Pagination" className="mt-10 flex items-center justify-center gap-3">
          {r.page > 1 && <Link href={href(r.page - 1)}>← Previous</Link>}
          <span className="text-sm text-ink-3">Page {r.page} of {pages}</span>
          {r.page < pages && <Link href={href(r.page + 1)}>Next →</Link>}
        </nav>
      )}
    </div>
  );
}
