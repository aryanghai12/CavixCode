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
  /** Which pipeline this was, so two workflows are not averaged together. */
  workflow?: string;
  /** "success" | "failure" | "cancelled" | "timed_out". */
  conclusion?: string;
  branch?: string;
}

/**
 * A build pipeline getting slower.
 *
 * The comparison is recent runs against the ones before them, which is the
 * question a reviewer can act on. A single duration says nothing: CI machines
 * vary, caches miss, a runner is busy. A sustained shift across many runs is the
 * thing that actually costs a team its afternoons.
 */
export interface BuildTrend {
  workflow: string;
  /**
   * Mean duration of the recent window and of everything before it, in ms, or
   * null when there were no SUCCESSFUL runs on one side to measure.
   *
   * Null is a real answer, not a missing one. A pipeline where every recent run
   * failed has no meaningful duration, and it is also the pipeline most worth
   * warning about, so the trend still exists and carries the failure rate. An
   * earlier version returned nothing at all in that case, which silenced the
   * warning in precisely the situation it was written for.
   */
  recentMeanMs: number | null;
  baselineMeanMs: number | null;
  /** Null whenever either mean is. */
  changePct: number | null;
  recentRuns: number;
  baselineRuns: number;
  /** Share of recent runs that did not succeed, 0 to 1. */
  failureRate: number;
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
  /** Pipelines with enough history to say anything about. */
  workflows(repo: string): string[];
  /** Is this pipeline getting slower? Null until there is enough history. */
  buildTrend(repo: string, workflow: string, recentWindow?: number): BuildTrend | null;
}

/**
 * How many runs of a pipeline to treat as "recent".
 *
 * Small enough to notice a change that landed this week, large enough that one
 * slow runner does not move it.
 */
const RECENT_RUNS = 10;

/** Runs needed on each side of the comparison before it means anything. */
const MIN_RUNS_PER_SIDE = 5;

/**
 * Rows kept per repository, per kind.
 *
 * The store is append-only and was unbounded, so a busy repository would grow it
 * until the process died. Oldest out first: a build time from four months ago is
 * not evidence about a pipeline that has been rewritten twice since.
 */
const MAX_ROWS_PER_REPO = 2000;

export class InMemoryTelemetryStore implements TelemetryStore {
  private benches: BenchmarkSample[] = [];
  private tests: TestRun[] = [];
  private builds: BuildRun[] = [];

  recordBenchmark(s: BenchmarkSample): void {
    this.benches.push(s);
    this.benches = trim(this.benches, s.repo);
  }
  recordTestRun(t: TestRun): void {
    this.tests.push(t);
    this.tests = trim(this.tests, t.repo);
  }
  recordBuild(b: BuildRun): void {
    this.builds.push(b);
    this.builds = trim(this.builds, b.repo);
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
    return {
      name,
      n: values.length,
      mean,
      stddev: Math.sqrt(variance),
      p95: percentile(values, 0.95),
      higherIsBetter: samples[0].higherIsBetter ?? false,
    };
  }

  /**
   * Tests that both passed and failed AT THE SAME COMMIT.
   *
   * The commit is the whole point and it used to be ignored: outcomes were
   * grouped by test name across all of history, so a test that correctly caught
   * a regression and then went green when it was fixed was marked flaky forever.
   * That is worse than useless. Cavix tells a reviewer to treat a flaky test's
   * failures with caution, and saying that about a test which had just done its
   * job is how a real failure gets waved through.
   */
  flakyTests(repo: string): string[] {
    const outcomes = new Map<string, Set<boolean>>();
    for (const t of this.tests) {
      if (t.repo !== repo) continue;
      const key = `${t.test}@${t.commit}`;
      const seen = outcomes.get(key) ?? new Set<boolean>();
      seen.add(t.passed);
      outcomes.set(key, seen);
    }
    const flaky = new Set<string>();
    for (const [key, seen] of outcomes) {
      if (seen.has(true) && seen.has(false)) flaky.add(key.slice(0, key.lastIndexOf("@")));
    }
    return [...flaky];
  }

  workflows(repo: string): string[] {
    return [...new Set(this.builds.filter((b) => b.repo === repo).map((b) => b.workflow ?? "build"))];
  }

  buildTrend(repo: string, workflow: string, recentWindow = RECENT_RUNS): BuildTrend | null {
    // Oldest first, so "recent" is the tail.
    const runs = this.builds
      .filter((b) => b.repo === repo && (b.workflow ?? "build") === workflow)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (runs.length < MIN_RUNS_PER_SIDE * 2) return null;

    const split = Math.max(MIN_RUNS_PER_SIDE, runs.length - recentWindow);
    const baseline = runs.slice(0, split);
    const recent = runs.slice(split);
    if (recent.length < MIN_RUNS_PER_SIDE) return null;

    // Only successful runs carry a meaningful duration. A cancelled run is fast
    // for a reason that has nothing to do with the code, and a timed-out one is
    // slow for the same kind of reason; averaging either in reports a trend the
    // pipeline does not have.
    const durations = (list: BuildRun[]) =>
      list.filter((b) => (b.conclusion ?? "success") === "success").map((b) => b.durationMs);
    const recentOk = durations(recent);
    const baseOk = durations(baseline);
    const recentMean = recentOk.length > 0 ? Math.round(mean(recentOk)) : null;
    const baselineMean = baseOk.length > 0 ? Math.round(mean(baseOk)) : null;

    return {
      workflow,
      recentMeanMs: recentMean,
      baselineMeanMs: baselineMean,
      changePct:
        recentMean === null || baselineMean === null || baselineMean === 0
          ? null
          : Math.round(((recentMean - baselineMean) / baselineMean) * 1000) / 10,
      recentRuns: recent.length,
      baselineRuns: baseline.length,
      failureRate:
        Math.round((recent.filter((b) => (b.conclusion ?? "success") !== "success").length / recent.length) * 100) / 100,
    };
  }
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Nearest-rank percentile.
 *
 * The old form indexed at `floor(p * n)`, which lands one past the mark for most
 * sample counts and returned the MAXIMUM for anything up to twenty samples. p95
 * exists precisely so a single unlucky run does not set the number; reporting
 * the max instead defeated the reason for using it.
 */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Keep the newest MAX_ROWS_PER_REPO rows for a repository, drop the rest. */
function trim<T extends { repo: string }>(rows: T[], repo: string): T[] {
  const forRepo = rows.filter((r) => r.repo === repo);
  if (forRepo.length <= MAX_ROWS_PER_REPO) return rows;
  const keep = new Set(forRepo.slice(forRepo.length - MAX_ROWS_PER_REPO));
  return rows.filter((r) => r.repo !== repo || keep.has(r));
}
