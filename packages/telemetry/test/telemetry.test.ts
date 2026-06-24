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
  const s = storeWithHistory();
  s.recordTestRun({ repo: "api", test: "orders.spec", durationMs: 5, passed: true, commit: "a", at: "t" });
  s.recordTestRun({ repo: "api", test: "orders.spec", durationMs: 5, passed: false, commit: "b", at: "t" });
  const p = new RegressionPredictor(s, coverage);
  const warnings = p.predict({ repo: "api", touchedSymbols: [], touchedFiles: [], touchedTests: ["orders.spec"] });
  assert.ok(warnings.some((w) => w.status === "flaky"));
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
