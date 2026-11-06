'use client';
import * as React from 'react';
import { api } from '@/lib/api';

/** Same session id the storefront uses for tracking, so conversions from POST /events/track join the exposure. */
function visitorId(): string {
  try {
    let v = sessionStorage.getItem('orvia_sid');
    if (!v) { v = crypto.randomUUID(); sessionStorage.setItem('orvia_sid', v); }
    return v;
  } catch { return 'anon-' + Math.random().toString(36).slice(2, 14); }
}

/**
 * `const { variant, convert } = useExperiment('hero-copy')`
 * `variant` is null until assigned (render the control meanwhile) and stays null when the experiment is not running.
 * Bucketing is deterministic server-side (hash of visitor id + experiment key). The visitor id is the session id (no persistent identifier is stored), so a returning visitor in a new session may be re-bucketed. Exposure is recorded once the variant has rendered.
 * The hook never ships anything: it only reads a running experiment's assignment.
 */
export function useExperiment(key: string): { variant: string | null; convert: () => void } {
  const [variant, setVariant] = React.useState<string | null>(null);
  const vid = React.useRef<string>('');
  React.useEffect(() => {
    let live = true;
    vid.current = visitorId();
    api<{ variant: string | null }>(`/experiments/${encodeURIComponent(key)}/assign?visitorId=${encodeURIComponent(vid.current)}`)
      .then((r) => { if (!live || !r.variant) return; setVariant(r.variant); return api(`/experiments/${encodeURIComponent(key)}/expose`, { body: { visitorId: vid.current } }); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [key]);
  const convert = React.useCallback(() => { if (vid.current) void api(`/experiments/${encodeURIComponent(key)}/convert`, { body: { visitorId: vid.current } }).catch(() => undefined); }, [key]);
  return { variant, convert };
}
