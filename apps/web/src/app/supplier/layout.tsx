import type { Metadata } from 'next';

export const metadata: Metadata = { title: { default: 'Orvia Supplier Portal', template: '%s · Orvia Supplier Portal' }, robots: { index: false, follow: false } };

export default function SupplierRoot({ children }: { children: React.ReactNode }) {
  return children;
}
