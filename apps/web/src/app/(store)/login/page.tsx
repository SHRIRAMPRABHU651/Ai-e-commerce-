import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginForm } from '@/components/auth-forms';

export const metadata: Metadata = { title: 'login', robots: { index: false, follow: false } };

export default function Page() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
