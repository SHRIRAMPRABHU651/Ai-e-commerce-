import type { Metadata } from 'next';
import { PreferencesPanel } from '@/components/customer360';

export const metadata: Metadata = { title: 'Preferences', robots: { index: false, follow: false } };

export default function Page() {
  return <PreferencesPanel />;
}
