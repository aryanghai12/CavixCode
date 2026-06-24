// External-benchmark eval: score Cavix's deterministic layer over Defects4J /
// SWE-bench-style / CVEfixes sample cases (hermetic). Logic-heavy benches need
// the LLM ensemble (run with EVAL_MODE=live + a key); the pattern-y / security
// cases are caught by the always-on deterministic layer shown here.
//
//   node eval/bench.ts

import { ADAPTERS, caseToDiff, type BenchmarkCase } from "./src/benchmarks.ts";
import { phase2Predict } from "./src/phase1.ts";
import { scorePR, aggregate } from "./src/metrics.ts";
import type { SeedPR } from "./src/dataset.ts";

function toSeed(c: BenchmarkCase): SeedPR {
  return { id: c.id, title: c.id, language: c.language, diff: caseToDiff(c), gold: c.gold, simulated: [] };
}

function pct(n: number): string {
  return (n * 100).toFixed(1).padStart(5) + "%";
}

async function main() {
  console.log("\nCavix external benchmarks — deterministic layer (hermetic)\n");
  const rows = [["benchmark", "cases", "Prec", "Rec", "F1", "FP-rate"]];
  for (const adapter of ADAPTERS) {
    const cases = adapter.load();
    if (cases.length === 0) continue;
    const scores = [];
    for (const c of cases) scores.push(scorePR(c.id, c.gold, await phase2Predict(toSeed(c))));
    const agg = aggregate(scores);
    rows.push([adapter.name, String(cases.length), pct(agg.precision), pct(agg.recall), pct(agg.f1), pct(agg.falsePositiveRate)]);
  }
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  const fmt = (r: string[]) => r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join("  ");
  console.log(fmt(rows[0]));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const r of rows.slice(1)) console.log(fmt(r));
  console.log("\n(Defects4J logic bugs need the LLM ensemble — EVAL_MODE=live with a key.)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
