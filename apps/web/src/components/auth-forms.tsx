'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { Button, Card, Field, Input, Link, useToast } from '@orvia/ui';
import { api } from '@/lib/api';
import type { User } from '@/lib/types';
import { Logo } from './logo';
import { useStore } from './providers';

function Shell({ title, sub, children, footer }: { title: string; sub?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-12 sm:py-16">
      <Link href="/" className="mb-8 self-center"><Logo /></Link>
      <Card className="p-6 sm:p-8"><h1 className="font-display text-3xl font-semibold tracking-tight">{title}</h1>{sub && <p className="mt-1.5 text-ink-3">{sub}</p>}<div className="mt-6">{children}</div></Card>
      {footer && <p className="mt-5 text-center text-sm text-ink-3">{footer}</p>}
    </div>
  );
}
const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/account');

export function LoginForm() {
  const router = useRouter(); const sp = useSearchParams(); const toast = useToast(); const { setUser, refreshCart } = useStore();
  const [email, setEmail] = React.useState(''); const [password, setPassword] = React.useState(''); const [busy, setBusy] = React.useState(false); const [err, setErr] = React.useState('');
  return (
    <Shell title="Welcome back" sub="Sign in to track orders and save favourites." footer={<>New to Orvia? <Link href={`/register${sp.get('next') ? `?next=${encodeURIComponent(sp.get('next')!)}` : ''}`} className="font-semibold text-pine-700 underline">Create an account</Link></>}>
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(''); try { const r = await api<{ user: User }>('/auth/login', { body: { email, password } }); setUser(r.user); await refreshCart(); router.push(safeNext(sp.get('next'))); router.refresh(); } catch (x) { setErr((x as Error).message); toast.error((x as Error).message); } finally { setBusy(false); } }}>
        <Field label="Email" htmlFor="email"><Input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password" htmlFor="pw" error={err}><Input id="pw" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} invalid={!!err} /></Field>
        <div className="text-right text-sm"><Link href="/forgot-password" className="font-semibold text-pine-700">Forgot password?</Link></div>
        <Button type="submit" size="lg" block loading={busy}>Sign in</Button>
      </form>
    </Shell>
  );
}

export function RegisterForm() {
  const router = useRouter(); const sp = useSearchParams(); const { setUser, refreshCart } = useStore();
  const [f, setF] = React.useState({ name: '', email: '', password: '' }); const [busy, setBusy] = React.useState(false); const [err, setErr] = React.useState('');
  const strong = f.password.length >= 10 && /[a-z]/.test(f.password) && /[A-Z]/.test(f.password) && /\d/.test(f.password);
  return (
    <Shell title="Create your account" sub="Faster checkout, order tracking and a wishlist." footer={<>Already registered? <Link href="/login" className="font-semibold text-pine-700 underline">Sign in</Link></>}>
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(''); try { const r = await api<{ user: User }>('/auth/register', { body: f }); setUser(r.user); await refreshCart(); router.push(safeNext(sp.get('next'))); router.refresh(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); } }}>
        <Field label="Full name" htmlFor="name"><Input id="name" required autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email" htmlFor="email"><Input id="email" type="email" required autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Password" htmlFor="pw" hint="10+ characters with upper and lower case letters and a number" error={err}><Input id="pw" type="password" required autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} invalid={!!err} /></Field>
        <Button type="submit" size="lg" block loading={busy} disabled={!strong}>Create account</Button>
      </form>
    </Shell>
  );
}

export function ForgotForm() {
  const [email, setEmail] = React.useState(''); const [done, setDone] = React.useState(false); const [busy, setBusy] = React.useState(false);
  return (
    <Shell title="Reset your password" sub="We’ll email you a link that’s valid for one hour." footer={<Link href="/login" className="font-semibold text-pine-700 underline">Back to sign in</Link>}>
      {done ? <p role="status" className="rounded-lg bg-ok-50 p-4 text-sm text-ok-500">If an account exists for {email}, a reset link is on its way.</p> : (
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await api('/auth/forgot-password', { body: { email } }); setDone(true); } finally { setBusy(false); } }}>
          <Field label="Email" htmlFor="email"><Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
          <Button type="submit" size="lg" block loading={busy}>Send reset link</Button>
        </form>
      )}
    </Shell>
  );
}

export function ResetForm() {
  const sp = useSearchParams(); const router = useRouter(); const toast = useToast();
  const [pw, setPw] = React.useState(''); const [busy, setBusy] = React.useState(false); const [err, setErr] = React.useState('');
  return (
    <Shell title="Choose a new password">
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(''); try { await api('/auth/reset-password', { body: { token: sp.get('token') ?? '', password: pw } }); toast.success('Password updated — please sign in'); router.push('/login'); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); } }}>
        <Field label="New password" htmlFor="pw" error={err} hint="10+ characters with upper and lower case letters and a number"><Input id="pw" type="password" required autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} invalid={!!err} /></Field>
        <Button type="submit" size="lg" block loading={busy}>Update password</Button>
      </form>
    </Shell>
  );
}

export function VerifyEmail() {
  const sp = useSearchParams();
  const [state, setState] = React.useState<'loading' | 'ok' | 'bad'>('loading');
  React.useEffect(() => { api('/auth/verify-email', { body: { token: sp.get('token') ?? '' } }).then(() => setState('ok')).catch(() => setState('bad')); }, [sp]);
  return (
    <Shell title={state === 'ok' ? 'Email verified' : state === 'bad' ? 'Link expired' : 'Verifying…'}>
      <p className="text-ink-2">{state === 'ok' ? 'Thanks — your email address is confirmed.' : state === 'bad' ? 'This verification link is invalid or has expired.' : 'One moment…'}</p>
      <Button className="mt-6" block href="/">Continue shopping</Button>
    </Shell>
  );
}
