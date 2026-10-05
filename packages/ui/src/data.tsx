'use client';
import * as React from 'react';
import { cn, EmptyState, Pagination, Skeleton, Tabs } from './core';

/* -------------------------------- Table / DataTable ------------------------------- */
export const Table = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn('-mx-px overflow-x-auto', className)}><table className="w-full min-w-max text-left text-sm">{children}</table></div>
);
export const Th = ({ children, className, align }: { children?: React.ReactNode; className?: string; align?: 'right' }) => <th scope="col" className={cn('sticky top-0 whitespace-nowrap border-b border-line bg-surface px-4 py-3 text-xs font-bold uppercase tracking-wide text-ink-3', align === 'right' && 'text-right', className)}>{children}</th>;
export const Td = ({ children, className, align }: { children?: React.ReactNode; className?: string; align?: 'right' }) => <td className={cn('border-b border-line/70 px-4 py-3 align-middle', align === 'right' && 'text-right tabular-nums', className)}>{children}</td>;

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  align?: 'right';
  className?: string;
  /** Hide on small screens (the row detail shows everything). */
  hideBelow?: 'md' | 'lg';
}

export function DataTable<T>({ columns, rows, rowKey, onRowClick, loading, empty, page, pageSize, total, onPage, dense }: {
  columns: Column<T>[]; rows: T[] | undefined; rowKey: (r: T) => string; onRowClick?: (r: T) => void; loading?: boolean; empty?: { title: string; body?: string; action?: React.ReactNode };
  page?: number; pageSize?: number; total?: number; onPage?: (p: number) => void; dense?: boolean;
}) {
  const hide = (c: Column<T>) => (c.hideBelow === 'md' ? 'hidden md:table-cell' : c.hideBelow === 'lg' ? 'hidden lg:table-cell' : '');
  return (
    <div>
      <Table>
        <thead><tr>{columns.map((c) => <Th key={c.key} align={c.align} className={hide(c)}>{c.header}</Th>)}</tr></thead>
        <tbody>
          {loading && !rows && Array.from({ length: 6 }, (_, i) => <tr key={i}>{columns.map((c) => <Td key={c.key} className={hide(c)}><Skeleton className="h-5 w-full min-w-16" /></Td>)}</tr>)}
          {rows?.map((r) => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} onKeyDown={onRowClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onRowClick(r)) : undefined} tabIndex={onRowClick ? 0 : undefined} className={cn(onRowClick && 'cursor-pointer hover:bg-sunken/60 focus-visible:bg-sunken/60', dense && '[&>td]:py-2')}>
              {columns.map((c) => <Td key={c.key} align={c.align} className={cn(hide(c), c.className)}>{c.render(r)}</Td>)}
            </tr>
          ))}
        </tbody>
      </Table>
      {rows && rows.length === 0 && <EmptyState title={empty?.title ?? 'Nothing here yet'} body={empty?.body} action={empty?.action} />}
      {page !== undefined && pageSize !== undefined && total !== undefined && onPage && <div className="px-4"><Pagination page={page} pageSize={pageSize} total={total} onChange={onPage} /></div>}
    </div>
  );
}

/* -------------------------------------- Charts ------------------------------------- */
/* Rules applied (dataviz): one axis, thin marks, recessive grid, legend for >=2 series, hover crosshair + tooltip,
   text in ink tokens (never series colour), table view for accessibility. */
export interface Series { id: string; label: string; color: string; data: number[]; area?: boolean }

function useWidth() {
  const ref = React.useRef<HTMLDivElement>(null);
  const [w, setW] = React.useState(640);
  React.useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(Math.max(240, Math.floor(e[0]!.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
};

export function Legend({ series }: { series: { id: string; label: string; color: string }[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="mb-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-ink-2">
      {series.map((s) => (<li key={s.id} className="flex items-center gap-2"><span className="h-0.5 w-4 rounded-full" style={{ background: s.color }} aria-hidden /> {s.label}</li>))}
    </ul>
  );
}

export function LineChart({ labels, series, format = (n) => String(Math.round(n)), height = 240, title }: { labels: string[]; series: Series[]; format?: (n: number) => string; height?: number; title: string }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = React.useState<number | null>(null);
  const [table, setTable] = React.useState(false);
  const pad = { l: 8, r: 8, t: 10, b: 24 };
  const all = series.flatMap((s) => s.data);
  const lo = Math.min(0, ...all), hi = niceMax(Math.max(...all, 1));
  const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
  const x = (i: number) => pad.l + (labels.length <= 1 ? iw / 2 : (i / (labels.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const ticks = [0, 0.5, 1].map((t) => lo + (hi - lo) * t);
  const step = Math.ceil(labels.length / Math.max(2, Math.floor(width / 90)));
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - r.left - pad.l) / iw;
    setHover(Math.max(0, Math.min(labels.length - 1, Math.round(rel * (labels.length - 1)))));
  };
  return (
    <figure>
      <div className="mb-1 flex items-start justify-between gap-3">
        <Legend series={series} />
        <button onClick={() => setTable((t) => !t)} className="ml-auto shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-ink-3 hover:bg-sunken">{table ? 'Chart' : 'Table'}</button>
      </div>
      {table ? (
        <div className="max-h-64 overflow-auto rounded-md border border-line"><table className="w-full text-sm"><caption className="sr-only">{title}</caption><thead><tr><th className="px-3 py-2 text-left text-xs text-ink-3">Date</th>{series.map((s) => <th key={s.id} className="px-3 py-2 text-right text-xs text-ink-3">{s.label}</th>)}</tr></thead><tbody>{labels.map((l, i) => (<tr key={l} className="border-t border-line"><td className="px-3 py-1.5">{l}</td>{series.map((s) => <td key={s.id} className="px-3 py-1.5 text-right tabular-nums">{format(s.data[i] ?? 0)}</td>)}</tr>))}</tbody></table></div>
      ) : (
        <div ref={ref} className="relative" style={{ height }}>
          <svg width={width} height={height} role="img" aria-label={title} onPointerMove={onMove} onPointerLeave={() => setHover(null)} className="touch-pan-y">
            {ticks.map((t) => (<g key={t}><line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth="1" /><text x={pad.l} y={y(t) - 4} fontSize="11" fill="var(--ink-3)">{format(t)}</text></g>))}
            {labels.map((l, i) => i % step === 0 && <text key={l} x={x(i)} y={height - 6} fontSize="11" textAnchor={i === 0 ? 'start' : 'middle'} fill="var(--ink-3)">{l.slice(5)}</text>)}
            {series.map((s) => {
              const pts = s.data.map((v, i) => `${x(i)},${y(v)}`);
              return (
                <g key={s.id}>
                  {s.area && <polygon points={`${x(0)},${y(Math.max(lo, 0))} ${pts.join(' ')} ${x(s.data.length - 1)},${y(Math.max(lo, 0))}`} fill={s.color} opacity="0.1" />}
                  <polyline points={pts.join(' ')} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                </g>
              );
            })}
            {hover !== null && (<g><line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--line-strong)" />{series.map((s) => <circle key={s.id} cx={x(hover)} cy={y(s.data[hover] ?? 0)} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" />)}</g>)}
          </svg>
          {hover !== null && (
            <div className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-pop" style={{ left: Math.min(Math.max(x(hover) + 12, 0), width - 160) }}>
              <p className="mb-1 font-bold text-ink">{labels[hover]}</p>
              {series.map((s) => (<p key={s.id} className="flex items-center justify-between gap-4 text-ink-2"><span className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: s.color }} />{s.label}</span><span className="font-bold tabular-nums text-ink">{format(s.data[hover] ?? 0)}</span></p>))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

/** Horizontal bars: ranked magnitude with direct value labels. One hue, bars anchored to the baseline. */
export function BarList({ rows, format = (n) => String(Math.round(n)), color = 'var(--series-1)' }: { rows: { label: string; value: number; sub?: string }[]; format?: (n: number) => string; color?: string }) {
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  if (!rows.length) return <p className="py-6 text-center text-sm text-ink-3">No data in this period</p>;
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm"><span className="truncate font-medium">{r.label}{r.sub && <span className="ml-2 text-xs text-ink-3">{r.sub}</span>}</span><span className={cn('shrink-0 font-bold tabular-nums', r.value < 0 && 'text-coral-500')}>{format(r.value)}</span></div>
          <div className="h-2 rounded-full bg-sunken"><div className="h-full rounded-full" style={{ width: `${Math.max(2, (Math.abs(r.value) / max) * 100)}%`, background: r.value < 0 ? 'var(--coral-500)' : color }} /></div>
        </li>
      ))}
    </ul>
  );
}

export function FunnelChart({ steps }: { steps: { step: string; count: number }[] }) {
  const max = Math.max(...steps.map((s) => s.count), 1);
  return (
    <ol className="space-y-2.5">
      {steps.map((s, i) => (
        <li key={s.step} className="grid grid-cols-[8.5rem_1fr_auto] items-center gap-3 text-sm">
          <span className="text-ink-2">{s.step}</span>
          <div className="h-6 rounded-sm bg-sunken"><div className="h-full rounded-sm" style={{ width: `${Math.max(1.5, (s.count / max) * 100)}%`, background: 'var(--series-1)', opacity: 1 - i * 0.12 }} /></div>
          <span className="w-24 text-right tabular-nums"><b>{s.count.toLocaleString()}</b>{i > 0 && steps[i - 1]!.count > 0 && <span className="ml-1.5 text-xs text-ink-3">{((s.count / steps[i - 1]!.count) * 100).toFixed(0)}%</span>}</span>
        </li>
      ))}
    </ol>
  );
}

export function ChartTabs({ tabs, children }: { tabs: { id: string; label: string }[]; children: (id: string) => React.ReactNode }) {
  const [v, setV] = React.useState(tabs[0]!.id);
  return (<div><Tabs tabs={tabs} value={v} onChange={setV} />{<div className="pt-4">{children(v)}</div>}</div>);
}
