export function LogoMark({ className = 'size-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <rect width="64" height="64" rx="16" fill="var(--pine-700)" />
      <circle cx="32" cy="32" r="14" fill="none" stroke="var(--paper)" strokeWidth="6" />
      <path d="M45 17a21 21 0 0 1 4 12" fill="none" stroke="#e5a043" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}
export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark />
      <span className="font-display text-[26px] font-semibold leading-none tracking-tight text-ink" aria-label="Orvia">orvia</span>
    </span>
  );
}
