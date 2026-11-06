'use client';
import * as React from 'react';
import { AlertTriangle, Moon, Sun } from 'lucide-react';
import { Button, cn, IconButton } from './core';
import { THEME_KEY } from './theme-script';

/* ------------------------------ Theme (light / dark) ------------------------------ */
/* One storage key shared by every surface. The inline script below runs before first paint so there is no flash. */
export type ThemeChoice = 'light' | 'dark';

function currentTheme(): ThemeChoice {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light' || attr === 'dark') return attr;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Toggle button. Renders a stable placeholder until mounted so SSR and first client render match. */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = React.useState<ThemeChoice | null>(null);
  React.useEffect(() => setTheme(currentTheme()), []);
  const toggle = () => {
    const next: ThemeChoice = (theme ?? currentTheme()) === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage blocked: the choice still applies for this page view */ }
  };
  const dark = theme === 'dark';
  return (
    <IconButton label={dark ? 'Switch to light theme' : 'Switch to dark theme'} aria-pressed={dark} onClick={toggle} className={className}>
      {dark ? <Sun className="size-5" aria-hidden /> : <Moon className="size-5" aria-hidden />}
    </IconButton>
  );
}

/* ----------------------------------- Error state ---------------------------------- */
export function ErrorState({ title = 'Something went wrong', body, onRetry, action, className }: { title?: string; body?: string; onRetry?: () => void; action?: React.ReactNode; className?: string }) {
  return (
    <div role="alert" className={cn('flex flex-col items-center px-6 py-12 text-center', className)}>
      <div className="mb-4 grid size-14 place-items-center rounded-full bg-coral-50 text-coral-700"><AlertTriangle className="size-6" aria-hidden /></div>
      <p className="text-base font-bold">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-ink-3">{body}</p>}
      <div className="mt-5 flex flex-wrap justify-center gap-2">{onRetry && <Button variant="secondary" onClick={onRetry}>Try again</Button>}{action}</div>
    </div>
  );
}

/* ------------------------------- Product comparison ------------------------------- */
export interface CompareColumn { id: string; header: React.ReactNode }
export interface CompareTableRow { key: string; label: string; differs?: boolean; values: (React.ReactNode | null)[] }

/** Accessible comparison table: caption, column + row headers, sticky label column, horizontal scroll on small screens. */
export function ProductCompare({ columns, rows, caption = 'Product comparison', missingLabel = 'Not listed' }: { columns: CompareColumn[]; rows: CompareTableRow[]; caption?: string; missingLabel?: string }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface" tabIndex={0} role="region" aria-label={caption}>
      <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 w-40 bg-surface p-3"><span className="sr-only">Attribute</span></th>
            {columns.map((c) => <th key={c.id} scope="col" className="min-w-40 p-3 align-top">{c.header}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.differs ? 'bg-pine-50/50' : undefined}>
              <th scope="row" className="sticky left-0 bg-surface p-3 align-top font-semibold text-ink-2">{r.label}{r.differs && <span className="sr-only"> (differs)</span>}</th>
              {r.values.map((v, i) => <td key={i} className="p-3 align-top">{v ?? <span className="text-ink-3">{missingLabel}</span>}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
