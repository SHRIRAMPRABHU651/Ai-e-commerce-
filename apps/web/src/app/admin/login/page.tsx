'use client';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Button, Card, Field, Input } from '@orvia/ui';
import { AdminLinks } from '@/components/admin/kit';
import { Logo } from '@/components/logo';
import { api } from '@/lib/api';

export default function AdminLogin() {
  const router = useRouter();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  return (
    <AdminLinks>
      <div className="grid min-h-dvh place-items-center bg-paper px-4">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex justify-center"><Logo /></div>
          <Card className="p-7">
            <h1 className="text-xl font-bold">Operations sign in</h1>
            <p className="mt-1 text-sm text-ink-3">Staff accounts only.</p>
            <form className="mt-6 space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(''); try { await api('/auth/admin/login', { body: { email, password } }); router.replace('/admin'); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); } }}>
              <Field label="Email" htmlFor="e"><Input id="e" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              <Field label="Password" htmlFor="p" error={err}><Input id="p" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} invalid={!!err} /></Field>
              <Button type="submit" size="lg" block loading={busy}>Sign in</Button>
            </form>
          </Card>
        </div>
      </div>
    </AdminLinks>
  );
}
