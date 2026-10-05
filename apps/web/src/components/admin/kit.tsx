'use client';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';
import NextLink from 'next/link';
import { Button, LinkProvider, Select, ToastProvider, cn, useToast, Skeleton, Card, EmptyState } from '@orvia/ui';
import { api, ApiError } from '@/lib/api';

export interface Staff { id: string; email: string; name: string; role: string }
interface Ctx { user: Staff; permissions: string[]; can: (p: string) => boolean }
const AdminCtx = React.createContext<Ctx | null>(null);
export const useAdmin = () => {
  const c = React.useContext(AdminCtx);
  if (!c) throw new Error('outside admin');
  return c;
};
export const AdminProvider = AdminCtx.Provider;
export const AdminLinks = ({ children }: { children: React.ReactNode }) => (
  <LinkProvider value={(p) => <NextLink {...p} />}><ToastProvider>{children}</ToastProvider></LinkProvider>
);

/** Data hook with reload; keeps previous data while refetching. */
export function useFetch<T>(path: string | null, interval?: number) {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(!!path);
  const seq = React.useRef(0);
  const reload = React.useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    try { const r = await api<T>(path); if (my === seq.current) { setData(r); setError(null); } } catch (e) { if (my === seq.current) setError((e as ApiError).message); } finally { if (my === seq.current) setLoading(false); }
  }, [path]);
  React.useEffect(() => { setLoading(!!path); void reload(); }, [reload, path]);
  React.useEffect(() => { if (!interval) return; const t = setInterval(() => void reload(), interval); return () => clearInterval(t); }, [interval, reload]);
  return { data, error, loading, reload };
}

/** Run a mutation with toast feedback. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const run = React.useCallback(async <T,>(key: string, fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(key);
    try { const r = await fn(); if (ok) toast.success(ok); return r; } catch (e) { toast.error((e as Error).message); return undefined; } finally { setBusy(null); }
  }, [toast]);
  return { run, busy };
}

export const usd = (minor: number | null | undefined, opts: { compact?: boolean } = {}): string => {
  if (minor === null || minor === undefined) return '—';
  const v = minor / 100;
  return opts.compact && Math.abs(v) >= 10_000 ? `$${(v / 1000).toFixed(1)}k` : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 });
};
export const cur = (minor: number | null | undefined, c: string): string => (minor === null || minor === undefined ? '—' : new Intl.NumberFormat(c === 'INR' ? 'en-IN' : c === 'CAD' ? 'en-CA' : 'en-US', { style: 'currency', currency: c }).format(minor / 100));
export const pctf = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(d)}%`);
export const when = (d?: string | Date | null) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const delta = (cur: number, prev: number): number | null => (prev === 0 ? null : (cur - prev) / Math.abs(prev));

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-end sm:justify-between">
      <div><h1 className="text-2xl font-bold tracking-tight sm:text-[28px]">{title}</h1>{subtitle && <p className="mt-1 max-w-2xl text-sm text-ink-3">{subtitle}</p>}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export const RANGES = [{ v: 'today', l: 'Today' }, { v: '7d', l: '7 days' }, { v: '30d', l: '30 days' }, { v: '90d', l: '90 days' }, { v: 'custom', l: 'Custom' }];
export function RangeSelect({ value, onChange, from, to, onDates }: { value: string; onChange: (v: string) => void; from?: string; to?: string; onDates?: (f: string, t: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Date range" className="inline-flex rounded-md bg-sunken p-1">{RANGES.map((r) => <button key={r.v} onClick={() => onChange(r.v)} aria-pressed={value === r.v} className={cn('h-8 rounded px-3 text-xs font-bold', value === r.v ? 'bg-surface text-ink shadow-sm' : 'text-ink-3 hover:text-ink')}>{r.l}</button>)}</div>
      {value === 'custom' && onDates && <><input type="date" aria-label="From" value={from ?? ''} onChange={(e) => onDates(e.target.value, to ?? e.target.value)} className="h-9 rounded-md border border-line-strong bg-surface px-2 text-sm" /><span className="text-ink-3">–</span><input type="date" aria-label="To" value={to ?? ''} onChange={(e) => onDates(from ?? e.target.value, e.target.value)} className="h-9 rounded-md border border-line-strong bg-surface px-2 text-sm" /></>}
    </div>
  );
}
export const rangeQs = (preset: string, from?: string, to?: string) => `preset=${preset}${preset === 'custom' && from && to ? `&from=${from}&to=${to}` : ''}`;

export const Panel = ({ title, subtitle, action, children, className, pad = true }: { title?: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode; className?: string; pad?: boolean }) => (
  <Card className={cn('flex min-w-0 flex-col', className)}>
    {title && <div className="flex items-start justify-between gap-3 px-5 pt-5"><div><h2 className="text-[15px] font-bold">{title}</h2>{subtitle && <p className="mt-0.5 text-[13px] text-ink-3">{subtitle}</p>}</div>{action}</div>}
    <div className={cn('min-w-0 flex-1', pad && 'p-5', title && pad && 'pt-4')}>{children}</div>
  </Card>
);

export const ErrorBox = ({ message, retry }: { message: string; retry?: () => void }) => (
  <div role="alert" className="rounded-lg border border-coral-500/30 bg-coral-50 p-4 text-sm text-coral-700">{message}{retry && <button onClick={retry} className="ml-3 font-bold underline">Retry</button>}</div>
);
export const Loading = ({ rows = 3 }: { rows?: number }) => <div className="space-y-3">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>;

export function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-center gap-2">{children}</div>;
}
export function SearchBox({ value, onChange, placeholder = 'Search…' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [v, setV] = React.useState(value);
  React.useEffect(() => { const t = setTimeout(() => v !== value && onChange(v), 300); return () => clearTimeout(t); }, [v, value, onChange]);
  return <input type="search" aria-label={placeholder} placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} className="h-10 w-full rounded-md border border-line-strong bg-surface px-3.5 text-sm sm:w-64" />;
}
export const FilterSelect = ({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: [string, string][]; label: string }) => (
  <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="h-10 w-auto min-w-36 text-sm">{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
);
export { Button, EmptyState, useToast, usePathname, useRouter };
