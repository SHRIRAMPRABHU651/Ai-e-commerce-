'use client';
/**
 * Consent-aware tracking: consent banner, pixel loader (Meta, GA4, TikTok), click-id/UTM capture and a tiny event bus.
 *
 * Nothing third-party loads and nothing is sent to the server for attribution until the visitor grants consent.
 * Event ids are generated once and handed to BOTH the browser pixel and POST /events/track, so Meta/TikTok deduplicate the
 * browser hit against the server (Conversions API / Events API) event. Purchases use `purchase:<orderId>` on both sides.
 *
 * Other components fire events with `trackEvent('add_to_cart', { productId, value, currency })` or
 * `window.dispatchEvent(new CustomEvent('orvia:track', { detail: { name, ... } }))`.
 */
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { api } from '@/lib/api';

export interface ConsentState { decided: boolean; analytics: boolean; marketing: boolean }
const COOKIE = 'orvia_consent';
const META_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID;
const GA_ID = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
const TT_ID = process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID;
export const trackingConfigured = (): boolean => !!(META_ID || GA_ID || TT_ID);

/** Current consent choice (first-party cookie). Safe on the server: returns "undecided, nothing granted". */
export function getConsentState(): ConsentState {
  try {
    const m = document.cookie.split('; ').find((c) => c.startsWith(`${COOKIE}=`));
    if (!m) return { decided: false, analytics: false, marketing: false };
    const v = JSON.parse(decodeURIComponent(m.split('=')[1] ?? '')) as { a?: number; m?: number };
    return { decided: true, analytics: v.a === 1, marketing: v.m === 1 };
  } catch {
    return { decided: false, analytics: false, marketing: false };
  }
}

function sessionId(): string {
  try {
    let s = sessionStorage.getItem('orvia_sid');
    if (!s) { s = crypto.randomUUID(); sessionStorage.setItem('orvia_sid', s); }
    return s;
  } catch { return 'anon-' + Math.random().toString(36).slice(2, 12); }
}

function persistConsent(a: boolean, m: boolean) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify({ v: 1, a: a ? 1 : 0, m: m ? 1 : 0, t: Date.now() }))}; Path=/; Max-Age=${60 * 60 * 24 * 180}; SameSite=Lax${secure}`;
  window.dispatchEvent(new CustomEvent('orvia:consent', { detail: getConsentState() }));
}
const syncConsent = (c: ConsentState) => api('/events/consent', { body: { sessionId: sessionId(), analytics: c.analytics, marketing: c.marketing } }).catch(() => undefined);

/* ------------------------------ pixels ------------------------------ */
type Fn = (...a: unknown[]) => void;
declare global {
  interface Window { fbq?: Fn & { queue?: unknown[]; loaded?: boolean; callMethod?: Fn }; _fbq?: unknown; gtag?: Fn; dataLayer?: unknown[]; ttq?: { track: Fn; page: Fn; load: Fn } & Record<string, unknown> }
}
const inject = (src: string) => { const s = document.createElement('script'); s.async = true; s.src = src; document.head.appendChild(s); };
const loaded = { meta: false, ga: false, tt: false };

function loadMeta() {
  if (!META_ID || loaded.meta) return;
  loaded.meta = true;
  const q: unknown[] = [];
  const fbq = ((...a: unknown[]) => { q.push(a); }) as unknown as NonNullable<Window['fbq']>;
  fbq.queue = q; fbq.loaded = true; window.fbq = fbq; window._fbq = fbq;
  inject('https://connect.facebook.net/en_US/fbevents.js');
  window.fbq('init', META_ID);
}
function loadGa() {
  if (!GA_ID || loaded.ga) return;
  loaded.ga = true;
  window.dataLayer = window.dataLayer ?? [];
  window.gtag = function gtag(...a: unknown[]) { (window.dataLayer as unknown[]).push(a); } as Fn;
  window.gtag('js', new Date());
  window.gtag('config', GA_ID, { send_page_view: false });
  inject(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`);
}
function loadTikTok() {
  if (!TT_ID || loaded.tt) return;
  loaded.tt = true;
  const calls: unknown[][] = [];
  const ttq = { track: (...a: unknown[]) => calls.push(['track', ...a]), page: (...a: unknown[]) => calls.push(['page', ...a]), load: (...a: unknown[]) => calls.push(['load', ...a]), _q: calls } as unknown as NonNullable<Window['ttq']>;
  window.ttq = ttq;
  inject(`https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${encodeURIComponent(TT_ID)}&lib=ttq`);
  ttq.load(TT_ID);
}

function applyConsent(c: ConsentState) {
  if (c.marketing) { loadMeta(); loadTikTok(); }
  if (c.analytics || c.marketing) loadGa();
}

/* ------------------------------ events ------------------------------ */
export interface TrackInput { name: 'page_view' | 'view_item' | 'search' | 'add_to_cart' | 'begin_checkout' | 'purchase'; productId?: string; value?: number; currency?: string; searchString?: string; orderId?: string; items?: { id: string; quantity: number; price?: number }[] }
const META_NAME: Record<TrackInput['name'], string> = { page_view: 'PageView', view_item: 'ViewContent', search: 'Search', add_to_cart: 'AddToCart', begin_checkout: 'InitiateCheckout', purchase: 'Purchase' };
const TT_NAME: Partial<Record<TrackInput['name'], string>> = { view_item: 'ViewContent', search: 'Search', add_to_cart: 'AddToCart', begin_checkout: 'InitiateCheckout', purchase: 'CompletePayment' };

/** Fire the browser pixels and the server event with one shared id. Returns the id. No-ops (returns null) without consent. */
export function trackEvent(t: TrackInput): string | null {
  const c = getConsentState();
  if (!c.analytics && !c.marketing) return null;
  const eventId = t.name === 'purchase' && t.orderId ? `purchase:${t.orderId}` : `${t.name}:${crypto.randomUUID()}`;
  const ids = t.items?.map((i) => i.id) ?? (t.productId ? [t.productId] : undefined);
  const common = { value: t.value, currency: t.currency };
  if (c.marketing && window.fbq) window.fbq('track', META_NAME[t.name], { ...common, content_ids: ids, content_type: ids ? 'product' : undefined, search_string: t.searchString }, { eventID: eventId });
  const tt = TT_NAME[t.name];
  if (c.marketing && window.ttq && tt) window.ttq.track(tt, { ...common, content_id: ids?.[0], content_type: ids ? 'product' : undefined, query: t.searchString }, { event_id: eventId });
  if (window.gtag && (c.analytics || c.marketing)) {
    const ev = t.name === 'purchase' ? 'purchase' : t.name;
    window.gtag('event', ev, { ...common, transaction_id: t.orderId, search_term: t.searchString, items: t.items?.map((i) => ({ item_id: i.id, quantity: i.quantity, price: i.price })) ?? (t.productId ? [{ item_id: t.productId }] : undefined) });
  }
  // Purchases are sent from paid orders by the server job; the browser only reports the funnel events.
  if (t.name !== 'purchase') void api('/events/track', { body: { eventId, name: t.name, sessionId: sessionId(), productId: t.productId, searchString: t.searchString, sourceUrl: window.location.href } }).catch(() => undefined);
  return eventId;
}

/** Place on the order confirmation page: fires the browser Purchase with the same id the server uses (`purchase:<orderId>`). Fires once per order. */
export function PurchasePixel({ orderId, value, currency, items }: { orderId: string; value: number; currency: string; items?: { id: string; quantity: number; price?: number }[] }) {
  React.useEffect(() => {
    const key = `orvia_purchase_${orderId}`;
    const fire = () => { try { if (localStorage.getItem(key)) return; } catch { /* ignore */ } if (trackEvent({ name: 'purchase', orderId, value, currency, items })) { try { localStorage.setItem(key, '1'); } catch { /* ignore */ } } };
    fire();
    window.addEventListener('orvia:consent', fire);
    return () => window.removeEventListener('orvia:consent', fire);
  }, [orderId, value, currency, items]);
  return null;
}

/* ------------------------------ attribution capture ------------------------------ */
const CLICK_KEYS = ['fbclid', 'gclid', 'ttclid', 'gbraid', 'wbraid'] as const;
const cookieVal = (n: string) => document.cookie.split('; ').find((c) => c.startsWith(`${n}=`))?.split('=')[1];

function readLanding() {
  const q = new URL(window.location.href).searchParams;
  const utm = { source: q.get('utm_source') ?? undefined, medium: q.get('utm_medium') ?? undefined, campaign: q.get('utm_campaign') ?? undefined, term: q.get('utm_term') ?? undefined, content: q.get('utm_content') ?? undefined };
  const clickIds = Object.fromEntries(CLICK_KEYS.map((k) => [k, q.get(k) ?? undefined]));
  let referrerHost: string | undefined;
  try { const r = document.referrer ? new URL(document.referrer).host : undefined; if (r && r !== window.location.host) referrerHost = r; } catch { /* ignore */ }
  return { utm, clickIds, referrerHost, landingPath: window.location.pathname };
}

async function sendAttribution(extra: ReturnType<typeof readLanding>) {
  const ga = cookieVal('_ga')?.split('.').slice(-2).join('.');
  await api('/events/attribution', { body: { sessionId: sessionId(), ...extra, browserIds: { fbp: cookieVal('_fbp'), fbc: cookieVal('_fbc'), ttp: cookieVal('_ttp'), gaClientId: ga } } }).catch(() => undefined);
}

/* ------------------------------ root component ------------------------------ */
export function Tracking() {
  const path = usePathname();
  const [consent, setConsent] = React.useState<ConsentState>({ decided: true, analytics: false, marketing: false }); // hidden until the cookie has been read
  const [open, setOpen] = React.useState(false);
  const [a, setA] = React.useState(true);
  const [m, setM] = React.useState(false);
  const pending = React.useRef<ReturnType<typeof readLanding> | null>(null);

  React.useEffect(() => {
    const c = getConsentState();
    setConsent(c);
    pending.current = readLanding();
    if (c.analytics || c.marketing) { applyConsent(c); void syncConsent(c).then(() => sendAttribution(pending.current!)); }
    const onConsent = (e: Event) => {
      const n = (e as CustomEvent<ConsentState>).detail;
      setConsent(n);
      applyConsent(n);
      void syncConsent(n).then(() => { if (n.analytics || n.marketing) void sendAttribution(pending.current ?? readLanding()); });
    };
    const onTrack = (e: Event) => trackEvent((e as CustomEvent<TrackInput>).detail);
    window.addEventListener('orvia:consent', onConsent);
    window.addEventListener('orvia:track', onTrack);
    return () => { window.removeEventListener('orvia:consent', onConsent); window.removeEventListener('orvia:track', onTrack); };
  }, []);

  React.useEffect(() => {
    const c = getConsentState();
    if (!c.analytics && !c.marketing) return;
    if (window.fbq && c.marketing) window.fbq('track', 'PageView');
    if (window.ttq && c.marketing) window.ttq.page();
    if (window.gtag) window.gtag('event', 'page_view', { page_path: path });
  }, [path]);

  if (consent.decided) return null;
  const decide = (an: boolean, mk: boolean) => { persistConsent(an, mk); setOpen(false); };
  return (
    <div role="dialog" aria-label="Cookie and tracking choices" className="fixed inset-x-0 bottom-0 z-[90] border-t border-line bg-paper p-4 shadow-lg sm:left-4 sm:right-auto sm:bottom-4 sm:max-w-md sm:rounded-lg sm:border">
      <p className="text-sm font-semibold text-ink">Your privacy choices</p>
      <p className="mt-1 text-sm text-ink-3">We use optional analytics and advertising measurement to understand what works. Nothing optional runs until you choose. Essential cookies (cart, sign-in) are always on.</p>
      {open && (
        <div className="mt-3 space-y-2 text-sm">
          <label className="flex items-start gap-2"><input type="checkbox" checked={a} onChange={(e) => setA(e.target.checked)} className="mt-1" /><span><b>Analytics</b> — anonymous usage measurement (GA4).</span></label>
          <label className="flex items-start gap-2"><input type="checkbox" checked={m} onChange={(e) => setM(e.target.checked)} className="mt-1" /><span><b>Advertising measurement</b> — lets ad platforms (Meta, TikTok, Google) measure results. Shares hashed contact details only if you check out.</span></label>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => decide(true, true)} className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-paper">Accept all</button>
        <button type="button" onClick={() => decide(false, false)} className="rounded-md border border-line-strong px-4 py-2 text-sm font-semibold">Reject optional</button>
        {open ? <button type="button" onClick={() => decide(a, m)} className="rounded-md border border-line-strong px-4 py-2 text-sm font-semibold">Save choices</button> : <button type="button" onClick={() => setOpen(true)} className="px-2 py-2 text-sm underline">Choose</button>}
      </div>
    </div>
  );
}

/** Footer link target: lets people change their mind later. */
export function reopenConsent() { document.cookie = `${COOKIE}=; Path=/; Max-Age=0`; window.dispatchEvent(new CustomEvent('orvia:consent', { detail: getConsentState() })); window.location.reload(); }
