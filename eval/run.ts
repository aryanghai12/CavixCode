// Cavix eval harness. Runs the reviewer over gold-labeled PRs and reports
// precision / recall / F1 / false-positive-rate, so review QUALITY is a number we
// can regress against from day one.
//
// Modes:
//   fixture (default) — uses each PR's bundled deterministic predictions. Runs
//                       anywhere with no key; this is what CI gates on.
//   live              — runs the real Reviewer through the BYOK gateway against
//                       each diff. Enable with EVAL_MODE=live and a key
//                       (CAVIX_LLM_API_KEY / ANTHROPIC_API_KEY).
//
//   node eval/run.ts            # fixture mode
//   EVAL_MODE=live node eval/run.ts
//
// Exit code is non-zero if aggregate F1 < EVAL_MIN_F1 (default 0.6) — a CI gate.

import { Gateway, AnthropicProvider, type GatewayConfigData } from "@cavix/gateway";
import { Reviewer } from "@cavix/orchestrator";
import { loadSeed, type SeedPR } from "./src/dataset.ts";
import { scorePR, aggregate, type Aggregate, type PRScore, type Prediction } from "./src/metrics.ts";
import { phase1Predict } from "./src/phase1.ts";

type Predict = (pr: SeedPR) => Promise<Prediction[]>;

function fixturePredictor(): Predict {
  return async (pr) => pr.simulated;
}

function livePredictor(): Predict {
  const apiKey = process.env.CAVIX_LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) throw new Error("EVAL_MODE=live requires CAVIX_LLM_API_KEY or ANTHROPIC_API_KEY");
  const model = process.env.CAVIX_LLM_MODEL ?? "claude-sonnet-4-6";
  const config: GatewayConfigData = { orgs: { eval: { provider: "anthropic", apiKey, model } } };
  const gateway = new Gateway({ providers: new Map([["anthropic", new AnthropicProvider()]]), config });
  const reviewer = new Reviewer({ gateway });
  return async (pr) => {
    const result = await reviewer.review({ org: "eval", title: pr.title, diff: pr.diff });
    return result.findings.map((f) => ({ path: f.path, line: f.line, category: f.category }));
  };
}

function pct(n: number): string {
  return (n * 100).toFixed(1).padStart(5) + "%";
}

function renderTable(scores: PRScore[], prs: SeedPR[]): string {
  const titleById = new Map(prs.map((p) => [p.id, p.title]));
  const rows: string[][] = [["PR", "gold", "pred", "TP", "FP", "FN", "Prec", "Rec", "F1"]];
  for (const s of scores) {
    rows.push([
      s.id,
      String(s.goldCount),
      String(s.predCount),
      String(s.tp),
      String(s.fp),
      String(s.fn),
      pct(s.precision),
      pct(s.recall),
      pct(s.f1),
    ]);
  }
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  const fmt = (r: string[]) => r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join("  ");
  const sep = widths.map((w) => "─".repeat(w)).join("  ");
  const out = [fmt(rows[0]), sep, ...rows.slice(1).map(fmt)];
  // attach a short title under nothing; keep table compact. Titles printed separately.
  void titleById;
  return out.join("\n");
}

async function scoreAll(prs: SeedPR[], predict: Predict): Promise<{ scores: PRScore[]; agg: Aggregate }> {
  const scores: PRScore[] = [];
  for (const pr of prs) scores.push(scorePR(pr.id, pr.gold, await predict(pr)));
  return { scores, agg: aggregate(scores) };
}

function printAggregate(label: string, agg: Aggregate): void {
  console.log(`${label}`);
  console.log(`  Precision ${pct(agg.precision)}  Recall ${pct(agg.recall)}  F1 ${pct(agg.f1)}  FP-rate ${pct(agg.falsePositiveRate)}  (TP ${agg.tp} FP ${agg.fp} FN ${agg.fn})`);
}

async function main() {
  const minF1 = Number(process.env.EVAL_MIN_F1 ?? "0.6");
  const prs = loadSeed();
  if (prs.length === 0) throw new Error("no seed PRs found");

  // Live mode: run the real Phase-0 reviewer through the BYOK gateway.
  if ((process.env.EVAL_MODE ?? "").toLowerCase() === "live") {
    const { scores, agg } = await scoreAll(prs, livePredictor());
    console.log(`\nCavix eval — mode=live, ${prs.length} PRs\n`);
    console.log(renderTable(scores, prs));
    printAggregate("\nAggregate:", agg);
    return;
  }

  // Default: Phase 0 baseline vs Phase 1, before/after.
  const phase0 = await scoreAll(prs, fixturePredictor());
  const phase1 = await scoreAll(prs, phase1Predict);

  console.log(`\nCavix eval — Phase 1 (deterministic + adjudicated ensemble), ${prs.length} labeled PRs\n`);
  console.log(renderTable(phase1.scores, prs));
  console.log("");
  console.log("Before / after (micro-averaged F1):");
  printAggregate("  Phase 0 (single diff-only pass):", phase0.agg);
  printAggregate("  Phase 1 (graph context + ensemble + deterministic + adjudication):", phase1.agg);
  const delta = phase1.agg.f1 - phase0.agg.f1;
  console.log(`\n  ΔF1 = ${(delta >= 0 ? "+" : "")}${(delta * 100).toFixed(1)} pts  (recall ${pct(phase0.agg.recall)} → ${pct(phase1.agg.recall)})`);
  console.log("");

  if (phase1.agg.f1 < minF1) {
    console.error(`FAIL: Phase 1 F1 ${pct(phase1.agg.f1)} < gate ${pct(minF1)}`);
    process.exit(1);
  }
  if (phase1.agg.f1 < phase0.agg.f1) {
    console.error(`FAIL: Phase 1 F1 ${pct(phase1.agg.f1)} regressed below Phase 0 ${pct(phase0.agg.f1)}`);
    process.exit(1);
  }
  console.log(`PASS: Phase 1 F1 ${pct(phase1.agg.f1)} ≥ gate ${pct(minF1)} and ≥ Phase 0 ${pct(phase0.agg.f1)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
