import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/* WCAG 2.x contrast of the design tokens used for text/UI pairs, read from theme.css (pure; no DB). */
const css = readFileSync(join(__dirname, '../../packages/ui/src/theme.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`missing ${selector}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error('unbalanced');
}
function tokens(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]!] = m[2]!;
  return out;
}
const light = tokens(block(':root {'));
const dark = { ...light, ...tokens(block(":root[data-theme='dark']")) };

const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** [foreground, background, minimum ratio, where it is used]: 4.5 for text, 3 for large text / UI boundaries. */
const PAIRS: [string, string, number, string][] = [
  ['ink', 'paper', 4.5, 'body text'],
  ['ink', 'surface', 4.5, 'card text'],
  ['ink-2', 'paper', 4.5, 'secondary text'],
  ['ink-2', 'sunken', 4.5, 'secondary text on sunken'],
  ['ink-3', 'paper', 4.5, 'muted text'],
  ['ink-3', 'surface', 4.5, 'muted text on cards'],
  ['ink-3', 'sunken', 4.5, 'muted text on sunken'],
  ['paper', 'ink', 4.5, 'tooltip / accent button'],
  ['pine-700', 'paper', 4.5, 'link / active nav text'],
  ['pine-700', 'pine-50', 4.5, 'soft button / active nav'],
  ['pine-600', 'surface', 4.5, 'brand text on cards'],
  ['on-fill', 'pine-600', 4.5, 'primary button'],
  ['on-fill', 'pine-700', 4.5, 'Find pill, toast'],
  ['on-fill', 'coral-500', 4.5, 'danger button / error toast'],
  ['coral-500', 'surface', 4.5, 'error text'],
  ['coral-500', 'paper', 4.5, 'error text on canvas'],
  ['coral-700', 'coral-50', 4.5, 'error badge'],
  ['saffron-700', 'saffron-50', 4.5, 'offer badge'],
  ['ok-500', 'ok-50', 4.5, 'success badge'],
  ['warn-500', 'warn-50', 4.5, 'warning badge'],
  ['info-500', 'info-50', 4.5, 'info badge'],
  ['pine-100', 'pine-900', 4.5, 'announcement bar'],
  ['pine-500', 'paper', 3, 'focus ring (non-text)'],
];

const modes = { light, dark } as const;
describe.each(Object.entries(modes))('WCAG contrast (%s theme)', (_name, t) => {
  for (const [fg, bg, min, use] of PAIRS) {
    it(`${fg} on ${bg} >= ${min} (${use})`, () => {
      expect(t[fg], `token ${fg}`).toBeTruthy();
      expect(t[bg], `token ${bg}`).toBeTruthy();
      expect(ratio(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(min);
    });
  }
});
