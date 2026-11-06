/** Redaction for verification evidence: request/response summaries are stored, secrets and customer PII are not. */
const SECRET_KEY = /(key|secret|token|password|passwd|authorization|cookie|credential|signature|iban|account.?number|card)/i;
const PII_KEY = /^(fullname|name|email|phone|line1|line2|address|street|postalcode|zip|city)$/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const LONG_DIGITS = /\b\d{9,}\b/g;

export function redactValue(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.replace(EMAIL, '[email]').replace(LONG_DIGITS, (m) => `${m.slice(0, 2)}***${m.slice(-2)}`).slice(0, 300);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(v)) return v.slice(0, 10).map((x) => redactValue(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 30)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : PII_KEY.test(k) ? '[pii]' : redactValue(val, depth + 1);
    }
    return out;
  }
  return String(v).slice(0, 100);
}
