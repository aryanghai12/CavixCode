// Stage 13 — the observability half. A dependency-free Prometheus registry.
//
// WHY NOT prom-client. Cavix ships into air-gapped clusters where every
// dependency is a supply-chain question somebody has to answer, and the whole
// of what we need is three metric types and a text serialiser. The rest of the
// repo already refuses dependencies for the same reason (the control-plane
// serves HTTP on node:http, the edge speaks RESP by hand), and this is smaller
// than either.
//
// THE TRAP THIS IS BUILT AROUND: cardinality. A label whose values are not
// bounded creates one time series per value, forever, in a store that keeps
// them for a year. `repo="acme/widget"` is the obvious one and it is two
// separate disasters at once: it puts customer repository names into a scraped
// endpoint that is usually less protected than the database, and on a
// deployment with ten thousand repositories it is an outage in the monitoring
// system rather than in Cavix.
//
// So series count is CAPPED per metric. Past the cap, further label
// combinations fold into a single `overflow="true"` series instead of being
// created. A mistake therefore shows up as one visible, obviously-wrong series
// that an operator can act on, rather than as a slow memory leak here and a
// slow ingestion failure over there. This is the one design decision in the
// file that matters.

/** Label values must be bounded sets. See the cardinality note above. */
export type Labels = Record<string, string>;

/**
 * Series per metric before overflow folding kicks in.
 *
 * Deliberately small. Every metric in Cavix labels by stage or outcome, both of
 * which are closed sets of under a dozen values, so anything approaching this
 * number is a bug rather than growth.
 */
const MAX_SERIES = 64;

const OVERFLOW: Labels = { overflow: "true" };

abstract class Metric {
  readonly name: string;
  readonly help: string;
  protected readonly series = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  /**
   * The storage key for a label set, or the overflow key once the cap is hit.
   *
   * Labels are sorted so `{a,b}` and `{b,a}` are one series rather than two,
   * which is the kind of thing that silently doubles a dashboard.
   */
  protected key(labels: Labels): { key: string; labels: Labels } {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    const key = entries.map(([k, v]) => `${k}=${v}`).join(",");
    if (this.series.has(key) || this.series.size < MAX_SERIES) {
      return { key, labels: Object.fromEntries(entries) };
    }
    return { key: "overflow=true", labels: OVERFLOW };
  }

  abstract render(): string[];

  /** Series currently held. Exposed so a test can assert the cap holds. */
  get seriesCount(): number {
    return this.series.size;
  }
}

export class Counter extends Metric {
  inc(labels: Labels = {}, by = 1): void {
    if (!Number.isFinite(by) || by < 0) return; // a counter never goes backwards
    const { key, labels: l } = this.key(labels);
    const cur = this.series.get(key);
    if (cur) cur.value += by;
    else this.series.set(key, { labels: l, value: by });
  }

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.series.values()) {
      out.push(`${this.name}${renderLabels(labels)} ${num(value)}`);
    }
    return out;
  }
}

export class Gauge extends Metric {
  set(value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) return;
    const { key, labels: l } = this.key(labels);
    this.series.set(key, { labels: l, value });
  }

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.series.values()) {
      out.push(`${this.name}${renderLabels(labels)} ${num(value)}`);
    }
    return out;
  }
}

/**
 * Seconds buckets, chosen for what Cavix actually does.
 *
 * A review is tens of seconds (model calls plus a sandbox), so the interesting
 * range is 1s to 5m and the buckets are dense there. Sub-second buckets exist
 * for the cheap stages (the diff fetch, the config fetch) whose regression would
 * otherwise be invisible inside a 1-second floor.
 */
export const DEFAULT_BUCKETS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

interface HistogramSeries {
  labels: Labels;
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram {
  readonly name: string;
  readonly help: string;
  private readonly buckets: number[];
  private readonly series = new Map<string, HistogramSeries>();

  constructor(name: string, help: string, buckets: number[] = DEFAULT_BUCKETS) {
    this.name = name;
    this.help = help;
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    let key = entries.map(([k, v]) => `${k}=${v}`).join(",");
    let l = Object.fromEntries(entries);
    if (!this.series.has(key) && this.series.size >= MAX_SERIES) {
      key = "overflow=true";
      l = OVERFLOW;
    }
    let s = this.series.get(key);
    if (!s) {
      s = { labels: l, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.sum += value;
    s.count++;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) s.counts[i]++;
    }
  }

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      // Prometheus histogram buckets are CUMULATIVE, and `observe` already
      // counts a value into every bucket at or above it, so these are emitted
      // as-is. Emitting per-bucket counts here would make every quantile wrong
      // in a way no dashboard would flag.
      for (let i = 0; i < this.buckets.length; i++) {
        out.push(`${this.name}_bucket${renderLabels({ ...s.labels, le: String(this.buckets[i]) })} ${num(s.counts[i])}`);
      }
      out.push(`${this.name}_bucket${renderLabels({ ...s.labels, le: "+Inf" })} ${num(s.count)}`);
      out.push(`${this.name}_sum${renderLabels(s.labels)} ${num(s.sum)}`);
      out.push(`${this.name}_count${renderLabels(s.labels)} ${num(s.count)}`);
    }
    return out;
  }

  get seriesCount(): number {
    return this.series.size;
  }
}

export class Registry {
  private readonly metrics: Array<Metric | Histogram> = [];

  counter(name: string, help: string): Counter {
    const c = new Counter(name, help);
    this.metrics.push(c);
    return c;
  }
  gauge(name: string, help: string): Gauge {
    const g = new Gauge(name, help);
    this.metrics.push(g);
    return g;
  }
  histogram(name: string, help: string, buckets?: number[]): Histogram {
    const h = new Histogram(name, help, buckets);
    this.metrics.push(h);
    return h;
  }

  /**
   * The Prometheus text exposition format.
   *
   * Built only when something scrapes. Nothing in this file does any work on the
   * review path beyond an integer increment, which is the other half of the
   * brief: metrics must cost nothing when nobody is looking.
   */
  render(): string {
    const lines: string[] = [];
    for (const m of this.metrics) lines.push(...m.render());
    return `${lines.join("\n")}\n`;
  }
}

/** Prometheus label escaping: backslash, quote, newline. Nothing else. */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}`;
}

/** Integers stay integers; everything else gets enough precision to be useful. */
function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
