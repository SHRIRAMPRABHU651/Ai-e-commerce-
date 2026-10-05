import type { Metadata } from 'next';

export const metadata: Metadata = { title: { default: 'Orvia Admin', template: '%s · Orvia Admin' }, robots: { index: false, follow: false } };

export default function AdminRoot({ children }: { children: React.ReactNode }) {
  return children;
}
