import type { Metadata } from 'next';
import { CatalogView } from '../catalog-view';

export const metadata: Metadata = { title: 'Search', robots: { index: false, follow: true } };

export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return <CatalogView title={sp['q'] ? `Results for “${sp['q']}”` : 'All products'} basePath="/search" searchParams={sp} />;
}
