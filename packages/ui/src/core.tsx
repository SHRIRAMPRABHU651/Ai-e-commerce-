'use client';
import * as React from 'react';
import { Loader2 } from 'lucide-react';

export const cn = (...v: (string | false | null | undefined)[]): string => v.filter(Boolean).join(' ');

/* Link abstraction: apps inject Next's <Link> so the UI package stays framework-free. */
type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };
const LinkCtx = React.createContext<React.ComponentType<LinkProps>>((p) => <a {...p} />);
export const LinkProvider = LinkCtx.Provider;
export const useLink = () => React.useContext(LinkCtx);
export function Link(props: LinkProps) {
  const L = useLink();
  return <L {...props} />;
}

/* ---------------------------------- Button --------------------------------- */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent' | 'soft';
type Size = 'sm' | 'md' | 'lg';
const variants: Record<Variant, string> = {
  primary: 'bg-pine-600 text-white hover:bg-pine-700 active:bg-pine-900 disabled:bg-pine-600/50',
  accent: 'bg-ink text-paper hover:bg-ink-2 disabled:opacity-50',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-sunken disabled:opacity-50',
  soft: 'bg-pine-50 text-pine-700 hover:bg-pine-100 disabled:opacity-50',
  ghost: 'text-ink-2 hover:bg-sunken disabled:opacity-50',
  danger: 'bg-coral-500 text-white hover:bg-coral-700 disabled:opacity-50',
};
const sizes: Record<Size, string> = { sm: 'h-9 px-3 text-sm gap-1.5', md: 'h-11 px-5 text-[15px] gap-2', lg: 'h-12 px-6 text-base gap-2' };

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  block?: boolean;
  href?: string;
}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'primary', size = 'md', loading, block, href, className, children, disabled, ...rest }, ref) {
  const cls = cn('inline-flex select-none items-center justify-center rounded-md font-semibold transition-colors disabled:cursor-not-allowed', variants[variant], sizes[size], block && 'w-full', className);
  if (href) return <Link href={href} className={cls}>{children}</Link>;
  return (
    <button ref={ref} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

export const IconButton = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; badge?: number | string }>(function IconButton({ label, badge, className, children, ...rest }, ref) {
  return (
    <button ref={ref} aria-label={label} title={label} className={cn('relative inline-flex size-11 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-sunken hover:text-ink', className)} {...rest}>
      {children}
      {badge !== undefined && badge !== 0 && <span className="absolute right-1 top-1 grid min-w-4.5 place-items-center rounded-full bg-pine-600 px-1 text-[10px] font-bold leading-4.5 text-white">{badge}</span>}
    </button>
  );
});

/* ---------------------------------- Inputs ---------------------------------- */
const fieldBase = 'w-full rounded-md border bg-surface px-3.5 text-[15px] text-ink placeholder:text-ink-3 transition-colors focus:border-pine-500 focus:outline-none focus:ring-2 focus:ring-pine-500/20 disabled:bg-sunken disabled:text-ink-3';

export const Field = ({ label, error, hint, children, htmlFor, className }: { label?: string; error?: string; hint?: string; children: React.ReactNode; htmlFor?: string; className?: string }) => (
  <div className={cn('block', className)}>
    {label && <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-semibold text-ink-2">{label}</label>}
    {children}
    {error ? <p role="alert" className="mt-1.5 text-sm text-coral-500">{error}</p> : hint ? <p className="mt-1.5 text-sm text-ink-3">{hint}</p> : null}
  </div>
);

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ className, invalid, ...rest }, ref) {
  return <input ref={ref} aria-invalid={invalid || undefined} className={cn(fieldBase, 'h-11', invalid ? 'border-coral-500' : 'border-line-strong', className)} {...rest} />;
});
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea({ className, invalid, ...rest }, ref) {
  return <textarea ref={ref} aria-invalid={invalid || undefined} className={cn(fieldBase, 'min-h-24 py-2.5', invalid ? 'border-coral-500' : 'border-line-strong', className)} {...rest} />;
});
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(function Select({ className, invalid, children, ...rest }, ref) {
  return (
    <select ref={ref} aria-invalid={invalid || undefined} className={cn(fieldBase, 'h-11 appearance-none bg-[length:16px] bg-[position:right_12px_center] bg-no-repeat pr-9', invalid ? 'border-coral-500' : 'border-line-strong', className)} style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236e6a60' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }} {...rest}>
      {children}
    </select>
  );
});
export const Checkbox = ({ label, className, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode }) => (
  <label className={cn('flex cursor-pointer items-start gap-2.5 text-sm text-ink-2', className)}>
    <input type="checkbox" className="mt-0.5 size-4.5 shrink-0 rounded-sm border-line-strong accent-[var(--pine-600)]" {...rest} />
    <span>{label}</span>
  </label>
);
export const Switch = ({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) => (
  <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50', checked ? 'bg-pine-600' : 'bg-line-strong')}>
    <span className={cn('absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow transition-transform', checked && 'translate-x-5')} />
  </button>
);
export const QuantityStepper = ({ value, onChange, min = 1, max = 10, disabled }: { value: number; onChange: (n: number) => void; min?: number; max?: number; disabled?: boolean }) => (
  <div className="inline-flex h-11 items-center rounded-md border border-line-strong bg-surface" role="group" aria-label="Quantity">
    <button type="button" aria-label="Decrease quantity" disabled={disabled || value <= min} onClick={() => onChange(value - 1)} className="grid size-11 place-items-center text-lg text-ink-2 hover:bg-sunken disabled:opacity-40">−</button>
    <span className="w-8 text-center text-[15px] font-semibold tabular-nums" aria-live="polite">{value}</span>
    <button type="button" aria-label="Increase quantity" disabled={disabled || value >= max} onClick={() => onChange(value + 1)} className="grid size-11 place-items-center text-lg text-ink-2 hover:bg-sunken disabled:opacity-40">+</button>
  </div>
);

/* ----------------------------------- Surfaces --------------------------------- */
export const Card = ({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('rounded-lg border border-line bg-surface shadow-card', className)} {...rest}>{children}</div>
);
export const CardHeader = ({ title, subtitle, action, className }: { title: React.ReactNode; subtitle?: React.ReactNode; action?: React.ReactNode; className?: string }) => (
  <div className={cn('flex items-start justify-between gap-3 px-5 pb-0 pt-5', className)}>
    <div className="min-w-0">
      <h3 className="text-[15px] font-bold text-ink">{title}</h3>
      {subtitle && <p className="mt-0.5 text-sm text-ink-3">{subtitle}</p>}
    </div>
    {action}
  </div>
);
export const Skeleton = ({ className }: { className?: string }) => <div className={cn('relative overflow-hidden rounded-md bg-sunken before:absolute before:inset-0 before:-translate-x-full before:animate-[orvia-shimmer_1.4s_infinite] before:bg-gradient-to-r before:from-transparent before:via-white/40 before:to-transparent', className)} aria-hidden />;
export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn('size-5 animate-spin text-ink-3', className)} aria-label="Loading" />;
export const EmptyState = ({ icon, title, body, action }: { icon?: React.ReactNode; title: string; body?: string; action?: React.ReactNode }) => (
  <div className="flex flex-col items-center px-6 py-14 text-center">
    {icon && <div className="mb-4 grid size-14 place-items-center rounded-full bg-sunken text-ink-3">{icon}</div>}
    <p className="text-base font-bold">{title}</p>
    {body && <p className="mt-1 max-w-sm text-sm text-ink-3">{body}</p>}
    {action && <div className="mt-5">{action}</div>}
  </div>
);

/* ------------------------------------ Badges ---------------------------------- */
export type Tone = 'neutral' | 'pine' | 'saffron' | 'coral' | 'ok' | 'warn' | 'info';
const tones: Record<Tone, string> = {
  neutral: 'bg-sunken text-ink-2', pine: 'bg-pine-50 text-pine-700', saffron: 'bg-saffron-50 text-saffron-700', coral: 'bg-coral-50 text-coral-700', ok: 'bg-ok-50 text-ok-500', warn: 'bg-warn-50 text-warn-500', info: 'bg-info-50 text-info-500',
};
export const Badge = ({ tone = 'neutral', children, className, dot }: { tone?: Tone; children: React.ReactNode; className?: string; dot?: boolean }) => (
  <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold', tones[tone], className)}>
    {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
    {children}
  </span>
);

const STATUS_TONE: Record<string, Tone> = {
  PENDING_PAYMENT: 'warn', PAID: 'info', SUPPLIER_PROCESSING: 'info', SHIPPED: 'pine', IN_TRANSIT: 'pine', DELIVERED: 'ok', CANCELLED: 'neutral', REFUND_REQUESTED: 'warn', REFUNDED: 'neutral', EXCEPTION: 'coral',
  PUBLISHED: 'ok', TESTING: 'info', WINNER: 'ok', SCALING: 'ok', DECLINING: 'warn', PAUSED: 'neutral', OUT_OF_STOCK: 'coral', BANNED: 'coral', ARCHIVED: 'neutral', DRAFT: 'neutral', DISCOVERED: 'neutral', ANALYZING: 'info', APPROVED: 'info',
  IN_STOCK: 'ok', LOW_STOCK: 'warn', SUPPLIER_UNAVAILABLE: 'coral', PRICE_CHANGED: 'warn',
  ok: 'ok', degraded: 'warn', down: 'coral', unconfigured: 'neutral', connected: 'ok', error: 'coral', disconnected: 'neutral',
  open: 'coral', in_progress: 'warn', resolved: 'ok', dismissed: 'neutral', proposed: 'warn', executed: 'ok', auto_executed: 'ok', approved: 'info', rejected: 'neutral', failed: 'coral',
  succeeded: 'ok', pending: 'warn', refunded: 'neutral', partially_refunded: 'warn', pending_approval: 'warn', processing: 'info',
  active: 'ok', paused: 'neutral', draft: 'neutral', ended: 'neutral', low: 'ok', medium: 'warn', high: 'coral', critical: 'coral',
  requested: 'warn', received: 'info', published: 'ok', escalated: 'coral',
  OFF: 'neutral', ASSISTED: 'warn', AUTOMATIC: 'ok', SCALE: 'ok', MAINTAIN: 'neutral', REDUCE: 'warn', PAUSE: 'coral', TEST: 'ok', WATCH: 'warn', REJECT: 'coral', passed: 'ok', review: 'warn',
};
export const StatusBadge = ({ status, label }: { status: string; label?: string }) => (
  <Badge tone={STATUS_TONE[status] ?? 'neutral'} dot>{label ?? status.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</Badge>
);

/* --------------------------------- Navigation ---------------------------------- */
export const Breadcrumb = ({ items }: { items: { label: string; href?: string }[] }) => (
  <nav aria-label="Breadcrumb" className="min-w-0">
    <ol className="flex flex-wrap items-center gap-x-1.5 text-sm text-ink-3">
      {items.map((it, i) => (
        <li key={i} className="flex min-w-0 items-center gap-1.5">
          {i > 0 && <span aria-hidden>/</span>}
          {it.href && i < items.length - 1 ? <Link href={it.href} className="truncate hover:text-ink">{it.label}</Link> : <span aria-current={i === items.length - 1 ? 'page' : undefined} className="truncate text-ink-2">{it.label}</span>}
        </li>
      ))}
    </ol>
  </nav>
);

export function Tabs({ tabs, value, onChange, className }: { tabs: { id: string; label: string; count?: number }[]; value: string; onChange: (id: string) => void; className?: string }) {
  return (
    <div role="tablist" className={cn('no-scrollbar -mx-1 flex gap-1 overflow-x-auto border-b border-line px-1', className)}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)} className={cn('relative shrink-0 px-3.5 py-3 text-sm font-semibold transition-colors', value === t.id ? 'text-pine-700' : 'text-ink-3 hover:text-ink')}>
          {t.label}{t.count !== undefined && <span className="ml-1.5 rounded-full bg-sunken px-1.5 py-0.5 text-xs">{t.count}</span>}
          {value === t.id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-pine-600" />}
        </button>
      ))}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const list = Array.from(new Set([1, page - 1, page, page + 1, pages])).filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-3 py-3 text-sm">
      <span className="hidden text-ink-3 sm:block">{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}</span>
      <div className="flex items-center gap-1">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>Previous</Button>
        <div className="hidden items-center gap-1 sm:flex">
          {list.map((p, i) => (
            <React.Fragment key={p}>
              {i > 0 && list[i - 1]! < p - 1 && <span className="px-1 text-ink-3">…</span>}
              <button aria-current={p === page ? 'page' : undefined} onClick={() => onChange(p)} className={cn('size-9 rounded-md text-sm font-semibold', p === page ? 'bg-pine-600 text-white' : 'text-ink-2 hover:bg-sunken')}>{p}</button>
            </React.Fragment>
          ))}
        </div>
        <span className="px-2 text-ink-3 sm:hidden">{page} / {pages}</span>
        <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>Next</Button>
      </div>
    </nav>
  );
}

/* ------------------------------ Overlays: Modal, Drawer, Dropdown --------------- */
function useLockBodyScroll(on: boolean) {
  React.useEffect(() => {
    if (!on) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [on]);
}
function useEscape(on: boolean, fn: () => void) {
  React.useEffect(() => {
    if (!on) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && fn();
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [on, fn]);
}
function useFocusTrap(ref: React.RefObject<HTMLElement | null>, on: boolean) {
  React.useEffect(() => {
    if (!on || !ref.current) return;
    const el = ref.current;
    const prev = document.activeElement as HTMLElement | null;
    const focusables = () => el.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])');
    (focusables()[0] ?? el).focus();
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    el.addEventListener('keydown', h);
    return () => { el.removeEventListener('keydown', h); prev?.focus?.(); };
  }, [ref, on]);
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; footer?: React.ReactNode; size?: 'sm' | 'md' | 'lg' }) {
  const ref = React.useRef<HTMLDivElement>(null);
  useLockBodyScroll(open); useEscape(open, onClose); useFocusTrap(ref, open);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-4" role="presentation">
      <div className="absolute inset-0 animate-[orvia-fade_.15s] bg-ink/40 backdrop-blur-[2px]" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className={cn('relative flex max-h-[92dvh] w-full animate-[orvia-slide-up_.2s] flex-col rounded-t-xl bg-surface shadow-pop outline-none sm:rounded-xl', size === 'sm' ? 'sm:max-w-md' : size === 'lg' ? 'sm:max-w-3xl' : 'sm:max-w-xl')}>
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="grid size-9 place-items-center rounded-full text-ink-3 hover:bg-sunken">✕</button>
        </div>
        <div className="overflow-y-auto px-5 py-5">{children}</div>
        {footer && <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, children, side = 'right', footer, width = 'sm:max-w-md' }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; side?: 'right' | 'left' | 'bottom'; footer?: React.ReactNode; width?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  useLockBodyScroll(open); useEscape(open, onClose); useFocusTrap(ref, open);
  if (!open) return null;
  const pos = side === 'bottom' ? 'inset-x-0 bottom-0 max-h-[88dvh] rounded-t-xl animate-[orvia-slide-up_.2s]' : side === 'left' ? 'inset-y-0 left-0 w-[88%] animate-[orvia-slide-left_.2s]' : `inset-y-0 right-0 w-full ${width} animate-[orvia-slide-left_.2s]`;
  return (
    <div className="fixed inset-0 z-[80]" role="presentation">
      <div className="absolute inset-0 animate-[orvia-fade_.15s] bg-ink/40 backdrop-blur-[2px]" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className={cn('absolute flex flex-col bg-surface shadow-pop outline-none', pos)}>
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="grid size-9 place-items-center rounded-full text-ink-3 hover:bg-sunken">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="border-t border-line p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
  );
}

export function Dropdown({ trigger, children, align = 'right' }: { trigger: React.ReactNode; children: React.ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-block">
      <div onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>{trigger}</div>
      {open && <div role="menu" onClick={() => setOpen(false)} className={cn('absolute z-50 mt-2 min-w-48 animate-[orvia-fade_.1s] rounded-lg border border-line bg-surface p-1.5 shadow-pop', align === 'right' ? 'right-0' : 'left-0')}>{children}</div>}
    </div>
  );
}
export const DropdownItem = ({ className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button role="menuitem" className={cn('flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm text-ink-2 hover:bg-sunken hover:text-ink', className)} {...rest} />
);

export const Tooltip = ({ text, children }: { text: string; children: React.ReactNode }) => (
  <span className="group relative inline-flex">
    {children}
    <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-max max-w-64 -translate-x-1/2 rounded-md bg-ink px-2.5 py-1.5 text-xs font-medium text-paper shadow-pop group-hover:block group-focus-within:block">{text}</span>
  </span>
);

/* ------------------------------------ Toasts ------------------------------------ */
type ToastItem = { id: number; tone: 'ok' | 'error' | 'info'; text: string };
const ToastCtx = React.createContext<{ push: (t: Omit<ToastItem, 'id'>) => void }>({ push: () => undefined });
export const useToast = () => {
  const { push } = React.useContext(ToastCtx);
  return React.useMemo(() => ({ success: (text: string) => push({ tone: 'ok', text }), error: (text: string) => push({ tone: 'error', text }), info: (text: string) => push({ tone: 'info', text }) }), [push]);
};
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const push = React.useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s.slice(-3), { ...t, id }]);
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), t.tone === 'error' ? 7000 : 4000);
  }, []);
  const ctx = React.useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={ctx}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-20 z-[90] flex flex-col items-center gap-2 px-4 sm:bottom-6 sm:items-end sm:px-6 lg:bottom-6">
        {items.map((t) => (
          <div key={t.id} className={cn('pointer-events-auto flex max-w-sm animate-[orvia-slide-up_.2s] items-start gap-2.5 rounded-lg px-4 py-3 text-sm font-medium shadow-pop', t.tone === 'error' ? 'bg-coral-500 text-white' : t.tone === 'ok' ? 'bg-pine-700 text-white' : 'bg-ink text-paper')}>
            <span aria-hidden>{t.tone === 'error' ? '⚠' : t.tone === 'ok' ? '✓' : 'ℹ'}</span>
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
