/** Minimal, standards-following robots.txt parser (longest-match Allow/Disallow, `*` and `$` wildcards, Crawl-delay). */
export interface RobotsRules {
  isAllowed(path: string): boolean;
  /** seconds, when the site asks for one */
  crawlDelay?: number;
  hasRules: boolean;
}

const toRegex = (pattern: string): RegExp => {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + (esc.endsWith('\\$') ? esc.slice(0, -2) + '$' : esc));
};

export function parseRobots(text: string, userAgentToken: string): RobotsRules {
  const token = userAgentToken.toLowerCase();
  type Group = { agents: string[]; rules: { allow: boolean; pattern: string }[]; delay?: number };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow') cur.rules.push({ allow: true, pattern: val });
    else if (key === 'disallow') cur.rules.push({ allow: false, pattern: val });
    else if (key === 'crawl-delay') { const n = Number(val); if (Number.isFinite(n) && n >= 0) cur.delay = n; }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules).filter((r) => r.pattern !== '');
  const delay = chosen.map((g) => g.delay).find((d) => d !== undefined);
  const compiled = rules.map((r) => ({ allow: r.allow, len: r.pattern.length, re: toRegex(r.pattern) }));
  return {
    hasRules: compiled.length > 0,
    crawlDelay: delay,
    isAllowed(path: string): boolean {
      let best: { allow: boolean; len: number } | null = null;
      for (const r of compiled) if (r.re.test(path) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
      return best ? best.allow : true;
    },
  };
}
