import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeSandboxBackend } from "@cavix/sandbox";
import {
  InMemoryTelemetryStore,
  RegressionPredictor,
  runBenchmarkInSandbox,
  parseFirstNumber,
} from "@cavix/telemetry";

function storeWithHistory() {
  const s = new InMemoryTelemetryStore();
  for (const v of [100, 102, 98, 101, 99]) {
    s.recordBenchmark({ repo: "api", name: "orderQueryLatency", value: v, commit: "c", branch: "main", at: "t" });
  }
  return s;
}

const coverage = { orderQueryLatency: { functions: ["listOrders"], files: ["src/orders.js"] } };

test("baseline needs enough history", () => {
  const s = new InMemoryTelemetryStore();
  s.recordBenchmark({ repo: "api", name: "x", value: 10, commit: "c", branch: "main", at: "t" });
  assert.equal(s.baselineFor("api", "x"), null);
});

test("regression: a measured slowdown on a touched benchmark is flagged", () => {
  const p = new RegressionPredictor(storeWithHistory(), coverage);
  const warnings = p.predict({ repo: "api", touchedSymbols: ["listOrders"], touchedFiles: ["src/orders.js"], measurements: { orderQueryLatency: 200 } });
  const reg = warnings.find((w) => w.status === "regression");
  assert.ok(reg, "regression warning present");
  assert.equal(reg!.severity, "high");
  assert.ok(reg!.deltaPct! >= 50);
  assert.deepEqual(reg!.affected.sort(), ["listOrders", "src/orders.js"]);
});

test("predicted risk: touching the hot path without a measurement warns to run it", () => {
  const p = new RegressionPredictor(storeWithHistory(), coverage);
  const warnings = p.predict({ repo: "api", touchedSymbols: ["listOrders"], touchedFiles: [] });
  assert.ok(warnings.some((w) => w.status === "predicted-risk"));
});

test("name-overlap fallback correlates a benchmark with a touched function", () => {
  const p = new RegressionPredictor(storeWithHistory(), {}); // no explicit coverage
  const warnings = p.predict({ repo: "api", touchedSymbols: ["orderQueryHandler"], touchedFiles: [], measurements: { orderQueryLatency: 300 } });
  assert.ok(warnings.some((w) => w.status === "regression"), "correlated via name tokens (order/query)");
});

test("no warning when the PR touches nothing related", () => {
  const p = new RegressionPredictor(storeWithHistory(), coverage);
  const warnings = p.predict({ repo: "api", touchedSymbols: ["unrelatedThing"], touchedFiles: ["src/other.js"], measurements: { orderQueryLatency: 200 } });
  assert.equal(warnings.length, 0);
});

test("flaky tests touched by the PR are surfaced", () => {
  // Flaky means both outcomes AT THE SAME COMMIT. Same code, two answers.
  const s = storeWithHistory();
  s.recordTestRun({ repo: "api", test: "orders.spec", durationMs: 5, passed: true, commit: "a", at: "t" });
  s.recordTestRun({ repo: "api", test: "orders.spec", durationMs: 5, passed: false, commit: "a", at: "t" });
  const p = new RegressionPredictor(s, coverage);
  const warnings = p.predict({ repo: "api", touchedSymbols: [], touchedFiles: [], touchedTests: ["orders.spec"] });
  assert.ok(warnings.some((w) => w.status === "flaky"));
});

test("a test that broke and was fixed is NOT flaky", () => {
  // This used to be reported as flaky forever, because outcomes were grouped by
  // test name across all of history and the commit was ignored. Cavix tells a
  // reviewer to treat a flaky test's failures with caution, so saying it about a
  // test that had just caught a real regression is how a real failure gets
  // waved through.
  const s = storeWithHistory();
  for (const [commit, passed] of [["c1", true], ["c2", false], ["c3", false], ["c4", true]] as const) {
    s.recordTestRun({ repo: "api", test: "checkout.spec", durationMs: 5, passed, commit, at: "t" });
  }
  assert.deepEqual(s.flakyTests("api"), []);
});

test("p95 is a percentile, not the maximum", () => {
  // Indexing at floor(p * n) lands one past the mark and returned the MAX for
  // any sample count up to twenty. p95 exists precisely so one unlucky run does
  // not set the number.
  const s = new InMemoryTelemetryStore();
  for (let i = 1; i <= 20; i++) {
    s.recordBenchmark({ repo: "api", name: "boot", value: i, commit: `c${i}`, branch: "main", at: "t" });
  }
  assert.equal(s.baselineFor("api", "boot")!.p95, 19);
});

test("build history answers whether a pipeline is getting slower", () => {
  // recordBuild used to be write-only: runs went in and nothing could read them,
  // so the roadmap's headline example (a slow build that kills velocity) had no
  // implementation at all.
  const s = new InMemoryTelemetryStore();
  const from = Date.now() - 40 * 86_400_000;
  const add = (n: number, ms: number, offset: number, conclusion = "success") => {
    for (let i = 0; i < n; i++) {
      s.recordBuild({
        repo: "api", workflow: "ci", durationMs: ms, commit: `c${offset}-${i}`,
        conclusion, at: new Date(from + (offset + i) * 3600_000).toISOString(),
      });
    }
  };
  add(12, 200_000, 0);
  add(10, 340_000, 20);

  assert.deepEqual(s.workflows("api"), ["ci"]);
  const t = s.buildTrend("api", "ci")!;
  assert.equal(t.recentMeanMs, 340_000);
  assert.equal(t.baselineMeanMs, 200_000);
  assert.equal(t.changePct, 70);
  assert.equal(t.failureRate, 0);
});

test("a pipeline whose recent runs all failed still reports a trend", () => {
  // No successful run means no duration to compare, and it is also the pipeline
  // most worth warning about. Returning nothing there silenced the failure
  // warning in exactly the case it was written for.
  const s = new InMemoryTelemetryStore();
  const from = Date.now() - 40 * 86_400_000;
  for (let i = 0; i < 12; i++) {
    s.recordBuild({ repo: "api", workflow: "ci", durationMs: 200_000, commit: `a${i}`, conclusion: "success", at: new Date(from + i * 3600_000).toISOString() });
  }
  for (let i = 0; i < 10; i++) {
    s.recordBuild({ repo: "api", workflow: "ci", durationMs: 200_000, commit: `b${i}`, conclusion: "failure", at: new Date(from + (20 + i) * 3600_000).toISOString() });
  }

  const t = s.buildTrend("api", "ci")!;
  assert.equal(t.recentMeanMs, null, "no successful run to measure");
  assert.equal(t.changePct, null);
  assert.equal(t.failureRate, 1, "but the failure rate is exactly the point");
});

test("too little history reports no trend at all", () => {
  const s = new InMemoryTelemetryStore();
  for (let i = 0; i < 6; i++) {
    s.recordBuild({ repo: "api", workflow: "ci", durationMs: 1000, commit: `c${i}`, at: new Date(Date.now() - i * 3600_000).toISOString() });
  }
  assert.equal(s.buildTrend("api", "ci"), null);
});

test("toFindings: regression becomes a deterministic performance finding", () => {
  const p = new RegressionPredictor(storeWithHistory(), coverage);
  const warnings = p.predict({ repo: "api", touchedSymbols: ["listOrders"], touchedFiles: ["src/orders.js"], measurements: { orderQueryLatency: 200 } });
  const findings = p.toFindings(warnings);
  const reg = findings.find((f) => f.category === "performance")!;
  assert.equal(reg.source, "telemetry");
  assert.equal(reg.path, "src/orders.js");
});

test("sandbox benchmark run parses a metric and compares to baseline", async () => {
  const backend = new FakeSandboxBackend(() => ({ code: 0, stdout: "elapsed: 250 ms\n" }));
  const sbx = await backend.provision({ network: "none" });
  const { value } = await runBenchmarkInSandbox(sbx, "npm", ["run", "bench"], parseFirstNumber);
  assert.equal(value, 250);
  const p = new RegressionPredictor(storeWithHistory(), coverage);
  const warnings = p.predict({ repo: "api", touchedSymbols: ["listOrders"], touchedFiles: [], measurements: { orderQueryLatency: value } });
  assert.ok(warnings.some((w) => w.status === "regression"));
  await sbx.destroy();
});
