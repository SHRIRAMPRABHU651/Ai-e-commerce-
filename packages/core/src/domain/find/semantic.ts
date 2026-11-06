/**
 * Semantic matching interface for ORVIA Find.
 *
 * `SemanticIndex` is the seam for embedding-based retrieval. Orvia ships exactly two implementations:
 *  - `NoopSemanticIndex` (the documented default for an embeddings provider: returns nothing, so ranking is lexical only), and
 *  - `TfIdfSemanticIndex`, a genuine in-process TF-IDF cosine similarity over product text. This is classical statistical
 *    text similarity, NOT neural embeddings: it understands shared vocabulary, not meaning. It is labelled as such in the
 *    API response (`engine.semantic`) and docs. A provider-backed embeddings index can implement the same interface
 *    (requires credentials and a vector store; not shipped).
 */
import { stem } from './intent';

export interface SemanticDoc {
  id: string;
  text: string;
}
export interface SemanticIndex {
  readonly name: string;
  readonly kind: 'none' | 'tfidf' | 'embedding';
  build(docs: SemanticDoc[]): void;
  /** Cosine similarity in [0,1] for documents with any overlap with the query. */
  query(text: string, limit?: number): Map<string, number>;
}

export class NoopSemanticIndex implements SemanticIndex {
  readonly name = 'none';
  readonly kind = 'none' as const;
  build(): void {}
  query(_text?: string, _limit?: number): Map<string, number> {
    return new Map();
  }
}

const SEM_STOP = new Set(['the', 'and', 'for', 'with', 'you', 'your', 'our', 'this', 'that', 'from', 'are', 'can', 'has', 'have', 'its', 'but', 'not', 'all', 'any', 'too']);
export function semanticTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !SEM_STOP.has(t))
    .map(stem);
}

export class TfIdfSemanticIndex implements SemanticIndex {
  readonly name = 'tfidf-cosine';
  readonly kind = 'tfidf' as const;
  private ids: string[] = [];
  private idf = new Map<string, number>();
  /** term -> postings of (doc index, normalised tf-idf weight) */
  private postings = new Map<string, [number, number][]>();

  build(docs: SemanticDoc[]): void {
    this.ids = docs.map((d) => d.id);
    const tfs = docs.map((d) => {
      const tf = new Map<string, number>();
      for (const t of semanticTokens(d.text)) tf.set(t, (tf.get(t) ?? 0) + 1);
      return tf;
    });
    const df = new Map<string, number>();
    for (const tf of tfs) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const n = docs.length;
    this.idf = new Map([...df].map(([t, c]) => [t, Math.log((n + 1) / (c + 1)) + 1]));
    this.postings = new Map();
    tfs.forEach((tf, i) => {
      let norm = 0;
      const w = new Map<string, number>();
      for (const [t, c] of tf) {
        const v = (1 + Math.log(c)) * (this.idf.get(t) ?? 1);
        w.set(t, v);
        norm += v * v;
      }
      norm = Math.sqrt(norm) || 1;
      for (const [t, v] of w) {
        const list = this.postings.get(t) ?? [];
        list.push([i, v / norm]);
        this.postings.set(t, list);
      }
    });
  }

  query(text: string, limit = 200): Map<string, number> {
    const q = new Map<string, number>();
    for (const t of semanticTokens(text)) q.set(t, (q.get(t) ?? 0) + 1);
    let qn = 0;
    const qw = new Map<string, number>();
    for (const [t, c] of q) {
      const idf = this.idf.get(t);
      if (idf === undefined) continue; // unknown terms cannot match anything
      const v = (1 + Math.log(c)) * idf;
      qw.set(t, v);
      qn += v * v;
    }
    qn = Math.sqrt(qn);
    if (!qn) return new Map();
    const scores = new Map<number, number>();
    for (const [t, v] of qw) for (const [i, w] of this.postings.get(t) ?? []) scores.set(i, (scores.get(i) ?? 0) + (v / qn) * w);
    return new Map([...scores].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([i, s]) => [this.ids[i]!, Math.min(1, s)]));
  }
}
