import type { Metadata } from 'next';
import { PriceGuardPanel } from '@/components/findPriceGuard';

export const metadata: Metadata = { title: 'Price Guard', robots: { index: false, follow: false } };

export default function Page() {
  return (
    <div>
      <h2 className="mb-1 text-xl font-bold">Price Guard</h2>
      <p className="mb-4 text-sm text-ink-3">Products you are tracking. We only email you about the products you chose to track.</p>
      <PriceGuardPanel />
    </div>
  );
}
