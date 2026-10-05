'use client';
import { Badge, Card } from '@orvia/ui';
import { CATEGORY_TREE } from '@orvia/types';
import { PageHeader, Panel, useFetch } from '@/components/admin/kit';

interface Meta { categories: { slug: string; name: string; dynamic: boolean; children: { slug: string; name: string }[] }[] }
export default function CategoriesPage() {
  const meta = useFetch<Meta>('/meta');
  const counts = useFetch<{ items: { category: string }[]; total: number }>('/admin/products?pageSize=100');
  const byCat = new Map<string, number>();
  counts.data?.items.forEach((p) => byCat.set(p.category, (byCat.get(p.category) ?? 0) + 1));
  return (
    <>
      <PageHeader title="Categories" subtitle="The catalogue taxonomy. “Trending” is dynamic: the trend agent decides what qualifies, no one curates it by hand." />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(meta.data?.categories ?? CATEGORY_TREE.map((c) => ({ slug: c.slug, name: c.name, dynamic: 'dynamic' in c ? !!c.dynamic : false, children: c.children.map((n) => ({ slug: n, name: n })) }))).map((c) => (
          <Panel key={c.slug} title={c.name} action={c.dynamic ? <Badge tone="saffron">AI-determined</Badge> : <Badge>{c.children.length} sub-categories</Badge>}>
            {c.children.length === 0 ? <p className="text-sm text-ink-3">Membership is computed from trend scores (views, add-to-carts and purchases vs the prior week).</p> : <ul className="divide-y divide-line text-sm">{c.children.map((ch) => <li key={ch.slug} className="flex justify-between py-2"><span>{ch.name}</span><b className="tabular-nums text-ink-3">{byCat.get(ch.slug) ?? 0}</b></li>)}</ul>}
          </Panel>
        ))}
      </div>
      <Card className="mt-4 p-4 text-sm text-ink-3">Counts reflect the first 100 products. Categories are defined in code (<code>CATEGORY_TREE</code>) and synced to the database at startup.</Card>
    </>
  );
}
