'use client';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Button, Field, Input } from '@orvia/ui';

export default function TrackPage() {
  const router = useRouter();
  const [n, setN] = React.useState('');
  const [e, setE] = React.useState('');
  return (
    <div className="mx-auto max-w-md px-4 py-14">
      <h1 className="font-display text-4xl font-semibold tracking-tight">Track your order</h1>
      <p className="mt-2 text-ink-3">Enter your order number and the email you used at checkout.</p>
      <form className="mt-8 space-y-4" onSubmit={(ev) => { ev.preventDefault(); router.push(`/orders/${encodeURIComponent(n.trim().toUpperCase())}?email=${encodeURIComponent(e.trim())}`); }}>
        <Field label="Order number" htmlFor="n"><Input id="n" required value={n} onChange={(x) => setN(x.target.value)} placeholder="ORV-XXXXXXXX-XXXXXX" autoCapitalize="characters" /></Field>
        <Field label="Email" htmlFor="e"><Input id="e" type="email" required value={e} onChange={(x) => setE(x.target.value)} autoComplete="email" /></Field>
        <Button type="submit" size="lg" block>Track order</Button>
      </form>
    </div>
  );
}
