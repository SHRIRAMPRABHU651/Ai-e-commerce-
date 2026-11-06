/**
 * Prompt-injection hardening and redaction (pure). Rule: user text, supplier text and tool output are DATA.
 * They are sanitised, fenced and flagged here, and nothing they say can change what code allows (tools are re-validated
 * and re-authorised in the executor regardless of what the model outputs).
 */

const CONTROL_RANGES: [number, number][] = [[0, 8], [0xb, 0xc], [0xe, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2060], [0xfeff, 0xfeff]];
const CONTROL = new RegExp(`[${CONTROL_RANGES.map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join('')}]`, 'gu');

const INJECTION_PATTERNS: { id: string; re: RegExp }[] = [
  { id: 'ignore_instructions', re: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?|polic(?:y|ies)|restrictions?)\b/i },
  { id: 'role_override', re: /\b(you are now|act as|pretend (?:to be|you are)|from now on you|new instructions?|developer mode|jailbreak|DAN mode)\b/i },
  { id: 'role_marker', re: /(^|\n)\s*(system|assistant|developer|tool)\s*[:>]/i },
  { id: 'chat_tokens', re: /<\|?\s*(im_start|im_end|system|assistant|endoftext)\s*\|?>|\[\/?(INST|SYS)\]|<<\s*SYS\s*>>/i },
  { id: 'reveal_prompt', re: /\b(reveal|show|print|repeat|leak|output)\b[^.\n]{0,30}\b(system prompt|hidden prompt|your instructions|initial prompt|api key|secret|password|token)\b/i },
  { id: 'authority_claim', re: /\b(i am|this is|message from)\b[^.\n]{0,20}\b(the )?(admin(?:istrator)?|developer|owner|ceo|staff|support agent|system)\b/i },
  { id: 'tool_forcing', re: /\b(call|invoke|run|execute|use)\b[^.\n]{0,20}\b(tool|function)\b[^.\n]{0,40}\b(refund|approve|grant|delete|transfer|payout|permission|role)\b/i },
  { id: 'auto_approve', re: /\b(approve|authori[sz]e|issue|process)\b[^.\n]{0,25}\b(refund|payment|payout|chargeback|credit)\b[^.\n]{0,25}\b(without|no need|skip|automatically|immediately)\b/i },
  { id: 'markup_injection', re: /<\/?\s*(untrusted|untrusted_data|tool_results?|user_request|instructions?)\b[^>]*>/i },
  { id: 'exfil_other_user', re: /\b(other|another|someone else'?s?|all)\s+(customers?|users?|accounts?)\b[^.\n]{0,40}\b(orders?|emails?|addresses|data|details)\b/i },
];

export interface InjectionScan {
  suspected: boolean;
  matches: string[];
}

export function detectInjection(text: string): InjectionScan {
  const norm = text.normalize('NFKC').replace(CONTROL, ' ');
  const matches = INJECTION_PATTERNS.filter((p) => p.re.test(norm)).map((p) => p.id);
  return { suspected: matches.length > 0, matches };
}

/** Remove control/zero-width characters, markup that imitates our fences, and bound the length. */
export function sanitizeUntrusted(text: string, maxLen = 600): string {
  return text
    .normalize('NFKC')
    .replace(CONTROL, ' ')
    .replace(/<\/?\s*(untrusted|untrusted_data|tool_results?|user_request|instructions?|system)\b[^>]*>/gi, ' ')
    .replace(/<\|?\s*[a-z_]+\s*\|?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/** Neutralise instruction-like phrases inside third-party strings (supplier titles, reviews, product text). */
export function neutraliseText(text: string, maxLen = 600): string {
  let t = sanitizeUntrusted(text, maxLen);
  for (const p of INJECTION_PATTERNS) {
    if (['role_marker', 'chat_tokens', 'markup_injection'].includes(p.id)) t = t.replace(new RegExp(p.re.source, 'gi'), ' [removed] ');
    else t = t.replace(new RegExp(p.re.source, 'gi'), '[removed]');
  }
  return t.replace(/\s+/g, ' ').trim();
}

/** Deeply neutralise every string in a tool output before a model may see it. Also reports whether anything was removed. */
export function neutraliseDeep<T>(value: T, flags?: { hit: boolean }, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === 'string') {
    if (flags && detectInjection(value).suspected) flags.hit = true;
    return neutraliseText(value, 800) as unknown as T;
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => neutraliseDeep(v, flags, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) o[k] = neutraliseDeep(v, flags, depth + 1);
    return o as T;
  }
  return value;
}

/** Wrap data so the model is told it is data. Closing-tag lookalikes inside are already stripped by sanitize/neutralise. */
export function fenceData(label: string, data: unknown): string {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return `<untrusted_data source="${label.replace(/[^a-z0-9_.-]/gi, '')}">\n${body.replace(/<\/?untrusted_data[^>]*>/gi, '')}\n</untrusted_data>`;
}

/* ---------------------------------- redaction ---------------------------------- */
const EMAIL = /([a-z0-9._%+-])[a-z0-9._%+-]*@([a-z0-9.-]+\.[a-z]{2,})/gi;
const LONG_DIGITS = /\b(?:\d[ -]?){12,19}\b/g;
const PHONE = /\+?\d[\d\s().-]{8,}\d/g;
const TOKENISH = /\b[a-f0-9]{32,}\b/gi;

/** Redact PII/secrets for logs and stored transcripts. Emails keep the first letter and the domain. */
export function redact(text: string, maxLen = 500): string {
  return text.replace(EMAIL, '$1***@$2').replace(TOKENISH, '[token]').replace(LONG_DIGITS, '[number]').replace(PHONE, '[phone]').slice(0, maxLen);
}

const SENSITIVE_KEYS = /^(token|password|secret|authorization|cookie|apikey|api_key|signature)$/i;
/** Short, redacted, secret-free summary of tool arguments for the audit log. */
export function summariseArgs(args: unknown, maxLen = 240): string {
  const scrub = (v: unknown, d = 0): unknown => {
    if (d > 4) return '…';
    if (typeof v === 'string') return redact(v, 80);
    if (Array.isArray(v)) return v.slice(0, 5).map((x) => scrub(x, d + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 12).map(([k, x]) => [k, SENSITIVE_KEYS.test(k) ? '[redacted]' : scrub(x, d + 1)]));
    return v;
  };
  try {
    return JSON.stringify(scrub(args)).slice(0, maxLen);
  } catch {
    return '[unserialisable]';
  }
}
