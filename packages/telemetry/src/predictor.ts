import type { Finding, Severity } from "@cavix/core";
import type { TelemetryStore } from "./store.ts";

// Correlate a PR's touched functions/tests with historical benchmarks and warn on
// (a) measured regressions and (b) predicted risk (the PR touches code on a
// benchmark's hot path — run it before merge). This is what feeds the performance
// agent and the pre-merge warning.

export interface CoverageMap {
  /** benchmark name → the functions/files it exercises. */
  [benchmark: string]: { functions?: string[]; files?: string[] };
}

export interface PredictInput {
  repo: string;
  touchedSymbols: string[];
  touchedFiles: string[];
  /** Observed benchmark values measured on this PR (e.g. from a sandbox run). */
  measurements?: Record<string, number>;
  touchedTests?: string[];
  branch?: string;
  thresholdPct?: number;
  sigma?: number;
}

export interface RegressionWarning {
  benchmark: string;
  status: "regression" | "predicted-risk" | "flaky";
  baselineMean?: number;
  baselineP95?: number;
  observed?: number;
  deltaPct?: number;
  severity: Severity;
  affected: string[];
  reason: string;
}

export class RegressionPredictor {
  private readonly store: TelemetryStore;
  private readonly coverage: CoverageMap;
  constructor(store: TelemetryStore, coverage: CoverageMap = {}) {
    this.store = store;
    this.coverage = coverage;
  }

  predict(input: PredictInput): RegressionWarning[] {
    const thr = input.thresholdPct ?? 0.2;
    const sigma = input.sigma ?? 3;
    const out: RegressionWarning[] = [];

    for (const name of this.store.benchmarkNames(input.repo)) {
      const baseline = this.store.baselineFor(input.repo, name, input.branch ?? "main");
      if (!baseline) continue;
      const affected = this.affectedBy(name, input.touchedSymbols, input.touchedFiles);
      if (affected.length === 0) continue;

      const observed = input.measurements?.[name];
      if (observed !== undefined) {
        const worse = baseline.higherIsBetter ? observed < baseline.mean * (1 - thr) : observed > baseline.mean * (1 + thr);
        const significant = baseline.higherIsBetter ? observed < baseline.mean - sigma * baseline.stddev : observed > baseline.mean + sigma * baseline.stddev;
        if (worse && significant) {
          const deltaPct = ((observed - baseline.mean) / baseline.mean) * 100;
          out.push({
            benchmark: name,
            status: "regression",
            baselineMean: round(baseline.mean),
            baselineP95: round(baseline.p95),
            observed: round(observed),
            deltaPct: round(deltaPct),
            severity: Math.abs(deltaPct) >= 50 ? "high" : "medium",
            affected,
            reason: `Benchmark "${name}" measured ${round(observed)} vs baseline mean ${round(baseline.mean)} (${deltaPct > 0 ? "+" : ""}${round(deltaPct)}%, >${sigma}σ). Touched: ${affected.join(", ")}.`,
          });
        }
      } else {
        out.push({
          benchmark: name,
          status: "predicted-risk",
          baselineMean: round(baseline.mean),
          baselineP95: round(baseline.p95),
          severity: "low",
          affected,
          reason: `This PR touches code on the hot path of benchmark "${name}" (baseline p95 ${round(baseline.p95)}). Run it before merge.`,
        });
      }
    }

    // Flaky tests the PR touches — warn so a "failure" isn't misread.
    const flaky = new Set(this.store.flakyTests(input.repo));
    for (const t of input.touchedTests ?? []) {
      if (flaky.has(t)) {
        out.push({ benchmark: t, status: "flaky", severity: "low", affected: [t], reason: `Touched test "${t}" is historically flaky — treat failures with caution.` });
      }
    }
    return out;
  }

  /** Map warnings to deterministic performance findings (source=telemetry). */
  toFindings(warnings: RegressionWarning[]): Finding[] {
    return warnings.map((w) => ({
      path: w.affected.find((a) => a.includes("/")) ?? `benchmark:${w.benchmark}`,
      line: 1,
      severity: w.severity,
      category: "performance",
      title: w.status === "regression" ? `Performance regression: ${w.benchmark}` : w.status === "flaky" ? `Flaky test touched: ${w.benchmark}` : `Performance risk: ${w.benchmark}`,
      body: w.reason,
      source: "telemetry",
      confidence: w.status === "regression" ? 0.9 : 0.5,
    }));
  }

  private affectedBy(benchmark: string, symbols: string[], files: string[]): string[] {
    const cov = this.coverage[benchmark];
    const hits = new Set<string>();
    if (cov) {
      for (const fn of cov.functions ?? []) if (symbols.includes(fn)) hits.add(fn);
      for (const f of cov.files ?? []) if (files.includes(f)) hits.add(f);
    }
    // Name-overlap fallback: benchmark "orderListLatency" ↔ touched "listOrders".
    if (hits.size === 0) {
      const bt = tokens(benchmark);
      for (const s of symbols) if (overlap(bt, tokens(s))) hits.add(s);
    }
    return [...hits];
  }
}

function tokens(s: string): Set<string> {
  return new Set((s.match(/[a-z]+|[A-Z][a-z]*/g) ?? []).map((t) => t.toLowerCase()).filter((t) => t.length > 3));
}
function overlap(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
