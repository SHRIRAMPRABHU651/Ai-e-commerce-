/** Minimal Prometheus-text metrics registry (no external dependency). */
type Labels = Record<string, string>;
const key = (name: string, labels: Labels) =>
  `${name}{${Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/"/g, '')}"`)
    .join(',')}}`;

const BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

class Registry {
  private counters = new Map<string, number>();
  private hist = new Map<string, { buckets: number[]; sum: number; count: number; name: string; labels: Labels }>();
  private gauges = new Map<string, number>();

  inc(name: string, labels: Labels = {}, by = 1): void {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }
  setGauge(name: string, value: number, labels: Labels = {}): void {
    this.gauges.set(key(name, labels), value);
  }
  observe(name: string, seconds: number, labels: Labels = {}): void {
    const k = key(name, labels);
    let h = this.hist.get(k);
    if (!h) {
      h = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0, name, labels };
      this.hist.set(k, h);
    }
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) h!.buckets[i]!++;
    });
    h.sum += seconds;
    h.count++;
  }
  counter(name: string, labels: Labels = {}): number {
    return this.counters.get(key(name, labels)) ?? 0;
  }
  render(): string {
    const lines: string[] = [];
    for (const [k, v] of this.counters) lines.push(`${k} ${v}`);
    for (const [k, v] of this.gauges) lines.push(`${k} ${v}`);
    for (const h of this.hist.values()) {
      const base = Object.entries(h.labels).map(([k, v]) => `${k}="${v}"`);
      BUCKETS.forEach((b, i) => lines.push(`${h.name}_bucket{${[...base, `le="${b}"`].join(',')}} ${h.buckets[i]}`));
      lines.push(`${h.name}_bucket{${[...base, 'le="+Inf"'].join(',')}} ${h.count}`);
      lines.push(`${h.name}_sum{${base.join(',')}} ${h.sum}`);
      lines.push(`${h.name}_count{${base.join(',')}} ${h.count}`);
    }
    return lines.join('\n') + '\n';
  }
  reset(): void {
    this.counters.clear();
    this.hist.clear();
    this.gauges.clear();
  }
}

export const metrics = new Registry();
