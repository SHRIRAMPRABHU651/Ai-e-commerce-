'use client';
import { ArrowLeft, ArrowRight, Crop, ImageOff, RotateCw, Star, Trash2, Upload } from 'lucide-react';
import * as React from 'react';
import { Badge, Button, Card, Input, Modal } from '@orvia/ui';
import { ErrorBox, Loading, useAction, useFetch } from '@/components/admin/kit';
import { api, ApiError } from '@/lib/api';

interface Asset { id: string; status: 'ready' | 'failed'; error?: string; source: 'supplier' | 'admin'; sourceUrl?: string; license: string; alt?: string; isPrimary: boolean; width?: number; height?: number; bytes?: number; hasAlpha?: boolean; countries: string[]; url?: string; pageUrl?: string }
interface Data { imageStatus: string; state: string; limits: { maxBytes: number; minDimension: number; formats: string[] }; items: Asset[] }
const COUNTRIES = ['US', 'CA', 'IN'];

async function upload(productId: string, file: File): Promise<void> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('alt', file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '));
  const res = await fetch(`/api/v1/admin/products/${productId}/images`, { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'x-requested-with': 'orvia' } });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
    throw new ApiError(j.error?.message ?? `Upload failed (${res.status})`, res.status, j.error?.code ?? 'ERROR');
  }
}

export function ProductImages({ productId, canWrite, onChange }: { productId: string; canWrite: boolean; onChange: () => void }) {
  const { data, error, reload } = useFetch<Data>(`/admin/products/${productId}/images`);
  const { run, busy } = useAction();
  const [drag, setDrag] = React.useState(false);
  const [errors, setErrors] = React.useState<string[]>([]);
  const [preview, setPreview] = React.useState<Asset | null>(null);
  const [alts, setAlts] = React.useState<Record<string, string>>({});
  const input = React.useRef<HTMLInputElement>(null);
  const after = async () => { await reload(); onChange(); };

  const send = async (files: FileList | File[]) => {
    setErrors([]);
    const errs: string[] = [];
    for (const f of Array.from(files)) {
      try { await upload(productId, f); } catch (e) { errs.push(`${f.name}: ${(e as Error).message}`); }
    }
    setErrors(errs);
    await after();
  };
  if (error && !data) return <ErrorBox message={error} retry={reload} />;
  if (!data) return <Loading rows={2} />;
  const ready = data.items.filter((i) => i.status === 'ready');
  const failed = data.items.filter((i) => i.status === 'failed');
  const patch = (key: string, body: unknown, ok?: string) => run(key, async () => { await api(`/admin/products/${productId}/images`, { method: 'PATCH', body }); await after(); }, ok);
  const move = (i: number, d: -1 | 1) => { const ids = ready.map((a) => a.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j]!, ids[i]!]; void patch('order', { order: ids }); };

  return (
    <div className="space-y-4">
      {data.imageStatus !== 'READY' && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-coral-500/40 bg-coral-50 p-4 text-sm text-coral-700">
          <ImageOff className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div><b>IMAGE REQUIRED.</b> This product has no usable photo, so it cannot be published or bought. Upload at least one image ({data.limits.formats.join(', ')}, up to {Math.round(data.limits.maxBytes / 1_000_000)} MB, shorter side ≥ {data.limits.minDimension}px).{failed.length > 0 && ` ${failed.length} supplier image(s) failed to import.`}</div>
        </div>
      )}
      {canWrite && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void send(e.dataTransfer.files); }}
          className={`rounded-xl border-2 border-dashed p-6 text-center text-sm transition ${drag ? 'border-pine-600 bg-pine-50' : 'border-line-strong bg-surface'}`}
        >
          <Upload className="mx-auto mb-2 size-6 text-ink-3" aria-hidden />
          <p className="font-semibold">Drag images here or</p>
          <Button className="mt-2" variant="secondary" size="sm" onClick={() => input.current?.click()}>Choose files</Button>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple hidden aria-label="Upload product images" onChange={(e) => { if (e.target.files?.length) void send(e.target.files); e.target.value = ''; }} />
          <p className="mt-2 text-xs text-ink-3">Files are validated (real format, size, corruption, duplicates), resized to WebP and stored on Orvia’s storage/CDN.</p>
        </div>
      )}
      {errors.length > 0 && <ul role="alert" className="space-y-1 rounded-lg bg-coral-50 p-3 text-sm text-coral-700">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {ready.map((a, i) => (
          <Card key={a.id} className="overflow-hidden">
            <button type="button" onClick={() => setPreview(a)} className="block w-full bg-sunken" aria-label={`Preview ${a.alt ?? 'image'}`}><img src={a.url} alt={a.alt ?? ''} className="aspect-square w-full object-cover" /></button>
            <div className="space-y-2 p-3">
              <div className="flex flex-wrap gap-1.5">
                {a.isPrimary && <Badge tone="pine"><Star className="size-3" aria-hidden /> Primary</Badge>}
                <Badge tone={a.source === 'admin' ? 'ok' : 'neutral'}>{a.source === 'admin' ? 'Uploaded by admin' : 'Provided by supplier'}</Badge>
                {a.license === 'unknown' && <Badge tone="warn">License unknown</Badge>}
                {a.hasAlpha && <Badge tone="warn">Transparent (flattened)</Badge>}
              </div>
              <p className="text-xs text-ink-3">{a.width}×{a.height} · {Math.round((a.bytes ?? 0) / 1000)} KB{a.sourceUrl ? ' · source recorded' : ''}</p>
              {canWrite && (
                <>
                  <Input aria-label="Alt text" value={alts[a.id] ?? a.alt ?? ''} onChange={(e) => setAlts({ ...alts, [a.id]: e.target.value })} onBlur={() => alts[a.id] !== undefined && alts[a.id] !== a.alt && void patch('alt' + a.id, { alt: { id: a.id, alt: alts[a.id] } })} placeholder="Describe the image" />
                  <div className="flex flex-wrap gap-1">
                    {COUNTRIES.map((c) => <button key={c} type="button" aria-pressed={a.countries.includes(c)} onClick={() => void patch('c' + a.id, { assign: { id: a.id, countries: a.countries.includes(c) ? a.countries.filter((x) => x !== c) : [...a.countries, c] } })} className={`rounded-full border px-2 py-0.5 text-xs ${a.countries.includes(c) ? 'border-pine-600 bg-pine-50 text-pine-700' : 'border-line-strong text-ink-3'}`}>{c}</button>)}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {!a.isPrimary && <Button size="sm" variant="secondary" onClick={() => void patch('p' + a.id, { primaryId: a.id }, 'Primary image set')}>Set primary</Button>}
                    <Button size="sm" variant="ghost" aria-label="Move earlier" disabled={i === 0} onClick={() => move(i, -1)}><ArrowLeft className="size-4" /></Button>
                    <Button size="sm" variant="ghost" aria-label="Move later" disabled={i === ready.length - 1} onClick={() => move(i, 1)}><ArrowRight className="size-4" /></Button>
                    <Button size="sm" variant="ghost" aria-label="Rotate 90°" loading={busy === 'r' + a.id} onClick={() => void run('r' + a.id, async () => { await api(`/admin/products/${productId}/images/${a.id}/transform`, { body: { rotate: 90 } }); await after(); })}><RotateCw className="size-4" /></Button>
                    <Button size="sm" variant="ghost" aria-label="Crop to square" loading={busy === 'q' + a.id} onClick={() => void run('q' + a.id, async () => { await api(`/admin/products/${productId}/images/${a.id}/transform`, { body: { squareCrop: true } }); await after(); })}><Crop className="size-4" /></Button>
                    <Button size="sm" variant="ghost" aria-label="Delete image" loading={busy === 'd' + a.id} onClick={() => { if (window.confirm('Delete this image?')) void run('d' + a.id, async () => { await api(`/admin/products/${productId}/images/${a.id}`, { method: 'DELETE' }); await after(); }, 'Image deleted'); }}><Trash2 className="size-4 text-coral-500" /></Button>
                  </div>
                </>
              )}
            </div>
          </Card>
        ))}
      </div>
      {failed.length > 0 && (
        <Card className="p-4 text-sm">
          <p className="font-bold">Supplier images that could not be imported</p>
          <ul className="mt-2 space-y-1 text-ink-2">{failed.map((f) => <li key={f.id} className="break-all"><code className="text-xs">{f.sourceUrl}</code> — {f.error}</li>)}</ul>
          {canWrite && <Button className="mt-3" size="sm" variant="secondary" loading={busy === 'ingest'} onClick={() => void run('ingest', async () => { await api(`/admin/products/${productId}/images/ingest`, { body: {} }); await after(); }, 'Re-import queued')}>Retry import</Button>}
        </Card>
      )}
      <Modal open={!!preview} onClose={() => setPreview(null)} title="Preview" size="lg">
        {preview && (
          <div className="grid gap-4 md:grid-cols-[auto_1fr] md:items-start">
            <div><p className="mb-1 text-xs font-semibold text-ink-3">Mobile (390px)</p><div className="w-[220px] overflow-hidden rounded-xl border border-line"><img src={preview.pageUrl ?? preview.url} alt={preview.alt ?? ''} className="aspect-square w-full object-cover" /></div></div>
            <div><p className="mb-1 text-xs font-semibold text-ink-3">Desktop product page</p><div className="overflow-hidden rounded-xl border border-line"><img src={preview.pageUrl ?? preview.url} alt={preview.alt ?? ''} className="aspect-square w-full max-w-md object-cover" /></div></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
