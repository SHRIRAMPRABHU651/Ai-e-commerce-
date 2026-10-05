import { NextResponse } from 'next/server';

/**
 * DEV/DEMO product illustrations. Real stores serve supplier-provided, licensed images instead; this route only
 * renders for the demo catalogue (ids prefixed pet-/kids-/fashion-/gad-/blocked-). Deterministic, cacheable SVG.
 */
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const PALETTES: Record<string, string[][]> = {
  pet: [['#f6e7d4', '#e9c9a0', '#7a4b21'], ['#e4efe4', '#bcd6bd', '#2f5d3a'], ['#f3e1e1', '#e2b4b4', '#8a3b3b']],
  kids: [['#e3eefc', '#b6d0f4', '#2a62b8'], ['#fdf0d3', '#f4d58d', '#a56a00'], ['#efe4f6', '#d3b8e8', '#6b3a94']],
  fashion: [['#efe6dc', '#d6c2ad', '#5b4631'], ['#e8e4f0', '#c8bfdc', '#4b3f72'], ['#f6e6e0', '#e8bfb0', '#8c4630']],
  gad: [['#e0ecee', '#b2cfd4', '#1f5560'], ['#e9e9ec', '#c4c4cc', '#363642'], ['#e6efe0', '#c3d9b3', '#3f6a2a']],
};

function motif(group: string, v: number, c: string, d: string): string {
  const rot = [-8, 6, -3][v % 3]!;
  if (group === 'pet') {
    return `<g transform="translate(256 262) rotate(${rot})"><ellipse cx="0" cy="38" rx="62" ry="50" fill="${c}"/><ellipse cx="-70" cy="-22" rx="22" ry="30" fill="${c}" transform="rotate(-25 -70 -22)"/><ellipse cx="-26" cy="-62" rx="22" ry="32" fill="${c}" transform="rotate(-8 -26 -62)"/><ellipse cx="26" cy="-62" rx="22" ry="32" fill="${c}" transform="rotate(8 26 -62)"/><ellipse cx="70" cy="-22" rx="22" ry="30" fill="${c}" transform="rotate(25 70 -22)"/></g><circle cx="150" cy="130" r="${14 + v * 3}" fill="${d}" opacity=".35"/>`;
  }
  if (group === 'kids') {
    return `<g transform="translate(256 270) rotate(${rot})"><rect x="-96" y="10" width="92" height="92" rx="16" fill="${c}"/><rect x="4" y="10" width="92" height="92" rx="16" fill="${d}" opacity=".85"/><rect x="-46" y="-86" width="92" height="92" rx="16" fill="#fff" opacity=".9"/><circle cx="0" cy="-40" r="22" fill="${c}"/></g>`;
  }
  if (group === 'fashion') {
    return `<g transform="translate(256 276) rotate(${rot})"><path d="M-70 -20 q70 -90 140 0" fill="none" stroke="${c}" stroke-width="16" stroke-linecap="round"/><rect x="-100" y="-26" width="200" height="150" rx="26" fill="${c}"/><rect x="-100" y="30" width="200" height="12" fill="${d}" opacity=".25"/><circle cx="0" cy="62" r="10" fill="#fff" opacity=".8"/></g>`;
  }
  return `<g transform="translate(256 262) rotate(${rot})"><rect x="-70" y="-120" width="140" height="240" rx="28" fill="${c}"/><rect x="-56" y="-104" width="112" height="170" rx="14" fill="#fff" opacity=".92"/><circle cx="0" cy="92" r="12" fill="#fff" opacity=".7"/><path d="M70 40 q60 0 60 50 t-60 50" fill="none" stroke="${d}" stroke-width="8" stroke-linecap="round" opacity=".5"/></g>`;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const v = Number(url.searchParams.get('v') ?? '1') - 1;
  const group = id.startsWith('pet') ? 'pet' : id.startsWith('kids') ? 'kids' : id.startsWith('fashion') || id.startsWith('blocked-replica') ? 'fashion' : 'gad';
  const pal = PALETTES[group]![hash(id) % 3]!;
  const [bg, mid, ink] = pal as [string, string, string];
  const shift = [0, 40, -40][((v % 3) + 3) % 3]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Product illustration"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${mid}"/></linearGradient><radialGradient id="r" cx=".5" cy=".4" r=".6"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect width="512" height="512" fill="url(#g)"/><circle cx="${300 + shift}" cy="${210 - shift / 2}" r="190" fill="url(#r)"/><circle cx="${90 - shift}" cy="440" r="70" fill="${ink}" opacity=".07"/><ellipse cx="256" cy="420" rx="130" ry="18" fill="${ink}" opacity=".16"/>${motif(group, hash(id + v) % 3, ink, mid)}</svg>`;
  return new NextResponse(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400, immutable' } });
}
