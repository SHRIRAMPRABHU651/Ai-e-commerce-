import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ResetForm } from '@/components/auth-forms';

export const metadata: Metadata = { title: 'reset password', robots: { index: false, follow: false } };

export default function Page() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
