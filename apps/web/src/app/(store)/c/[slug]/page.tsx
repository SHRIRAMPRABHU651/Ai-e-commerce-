import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { sget } from '@/lib/server';
import type { Meta } from '@/lib/types';
import { CatalogView } from '../../catalog-view';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> };

async function lookup(slug: string) {
  const meta = await sget<Meta>('/meta');
  if (!meta) return null;
  for (const c of meta.categories) {
    if (c.slug === slug) return { name: c.name, dynamic: c.dynamic };
    const ch = c.children.find((x) => x.slug === slug);
    if (ch) return { name: ch.name, dynamic: false, parent: c.name };
  }
  return null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const c = await lookup(slug);
  if (!c) return {};
  return { title: c.name, description: `Shop ${c.name.toLowerCase()} at Orvia — tracked delivery and easy returns.`, alternates: { canonical: `/c/${slug}` } };
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const c = await lookup(slug);
  if (!c) notFound();
  return <CatalogView title={c.name} slug={slug} basePath={`/c/${slug}`} searchParams={await searchParams} subtitle={c.dynamic ? 'Chosen by our trend engine from what shoppers are viewing and buying right now.' : undefined} />;
}
