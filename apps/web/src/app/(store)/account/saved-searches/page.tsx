import type { Metadata } from 'next';
import { SavedSearchesPanel } from '@/components/findSaved';

export const metadata: Metadata = { title: 'Saved searches', robots: { index: false, follow: false } };

export default function Page() {
  return (
    <div>
      <h2 className="mb-4 text-xl font-bold">Saved searches</h2>
      <SavedSearchesPanel />
    </div>
  );
}
