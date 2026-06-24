// Stage 6 — CI/CD telemetry. Ingest run data (build times, test durations, perf
// benchmarks, flaky tests) and answer historical questions (baselines, flakiness)
// the regression predictor needs. The TelemetryStore port is in-memory here; in
// production it is ClickHouse (append-only events; the same query surface).

export interface BenchmarkSample {
  repo: string;
  name: string;
  /** Lower is better by default (ms / latency); set higherIsBetter for ops/s. */
  value: number;
  commit: string;
  branch: string;
  at: string;
  higherIsBetter?: boolean;
}

export interface TestRun {
  repo: string;
  test: string;
  durationMs: number;
  passed: boolean;
  commit: string;
  at: string;
}

export interface BuildRun {
  repo: string;
  durationMs: number;
  commit: string;
  at: string;
}

export interface BaselineStats {
  name: string;
  n: number;
  mean: number;
  stddev: number;
  p95: number;
  higherIsBetter: boolean;
}

export interface TelemetryStore {
  recordBenchmark(s: BenchmarkSample): void;
  recordTestRun(t: TestRun): void;
  recordBuild(b: BuildRun): void;
  baselineFor(repo: string, name: string, branch?: string): BaselineStats | null;
  benchmarkNames(repo: string): string[];
  flakyTests(repo: string): string[];
}

export class InMemoryTelemetryStore implements TelemetryStore {
  private benches: BenchmarkSample[] = [];
  private tests: TestRun[] = [];
  private builds: BuildRun[] = [];

  recordBenchmark(s: BenchmarkSample): void {
    this.benches.push(s);
  }
  recordTestRun(t: TestRun): void {
    this.tests.push(t);
  }
  recordBuild(b: BuildRun): void {
    this.builds.push(b);
  }

  benchmarkNames(repo: string): string[] {
    return [...new Set(this.benches.filter((b) => b.repo === repo).map((b) => b.name))];
  }

  baselineFor(repo: string, name: string, branch = "main"): BaselineStats | null {
    const samples = this.benches.filter((b) => b.repo === repo && b.name === name && b.branch === branch);
    if (samples.length < 3) return null; // not enough history to trust a baseline
    const values = samples.map((s) => s.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];
    return { name, n: values.length, mean, stddev: Math.sqrt(variance), p95, higherIsBetter: samples[0].higherIsBetter ?? false };
  }

  // A test is flaky if its history on the same commit(s) contains both pass+fail.
  flakyTests(repo: string): string[] {
    const byTest = new Map<string, Set<boolean>>();
    for (const t of this.tests.filter((t) => t.repo === repo)) {
      if (!byTest.has(t.test)) byTest.set(t.test, new Set());
      byTest.get(t.test)!.add(t.passed);
    }
    return [...byTest.entries()].filter(([, s]) => s.has(true) && s.has(false)).map(([test]) => test);
  }
}
