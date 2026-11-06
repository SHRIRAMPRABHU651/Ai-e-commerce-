/** Small RFC-4180 CSV parser (quotes, escaped quotes, CRLF, BOM). Pure; bounded by `maxRows`. */
export function parseCsv(text: string, o: { delimiter?: string; maxRows?: number } = {}): { header: string[]; rows: Record<string, string>[]; errors: string[] } {
  const d = o.delimiter ?? ',';
  const maxRows = o.maxRows ?? 50_000;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = '';
  let rec: string[] = [];
  let inQ = false;
  const errors: string[] = [];
  const endField = () => { rec.push(field); field = ''; };
  const endRecord = () => { endField(); if (rec.length > 1 || rec[0] !== '') records.push(rec); rec = []; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQ) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c;
    } else if (c === '"' && field === '') inQ = true;
    else if (c === d) endField();
    else if (c === '\n') endRecord();
    else if (c === '\r') { if (src[i + 1] === '\n') i++; endRecord(); } else field += c;
    if (records.length > maxRows + 1) { errors.push(`More than ${maxRows} rows: the rest was ignored`); break; }
  }
  if (inQ) errors.push('Unterminated quoted field');
  if (field !== '' || rec.length) endRecord();
  const header = (records.shift() ?? []).map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (const r of records.slice(0, maxRows)) {
    const row: Record<string, string> = {};
    header.forEach((h, idx) => { if (h) row[h] = (r[idx] ?? '').trim(); });
    rows.push(row);
  }
  return { header, rows, errors };
}
