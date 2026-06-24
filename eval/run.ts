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
import { phase1Predict, phase2Predict, linterOnlyPredict } from "./src/phase1.ts";

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

  // Default: side-by-side scoring across reviewers (competitors + Cavix phases).
  const reviewers: Array<{ name: string; predict: Predict }> = [
    { name: "linter-only (competitor)", predict: linterOnlyPredict },
    { name: "diff-only LLM (Cavix Phase 0)", predict: fixturePredictor() },
    { name: "context+ensemble (Cavix Phase 1)", predict: phase1Predict },
    { name: "+ verification (Cavix Phase 2)", predict: phase2Predict },
  ];
  const scored = [];
  for (const r of reviewers) scored.push({ name: r.name, agg: (await scoreAll(prs, r.predict)).agg });

  console.log(`\nCavix eval — side-by-side, ${prs.length} labeled PRs\n`);
  const rows = [["reviewer", "Prec", "Rec", "F1", "FP-rate", "TP", "FP", "FN"]];
  for (const s of scored) {
    rows.push([s.name, pct(s.agg.precision), pct(s.agg.recall), pct(s.agg.f1), pct(s.agg.falsePositiveRate), String(s.agg.tp), String(s.agg.fp), String(s.agg.fn)]);
  }
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  const fmt = (r: string[]) => r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join("  ");
  console.log(fmt(rows[0]));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const r of rows.slice(1)) console.log(fmt(r));

  const phase1 = scored[2].agg;
  const phase2 = scored[3].agg;
  console.log(`\nPhase 1 → Phase 2 (verification):  F1 ${pct(phase1.f1)} → ${pct(phase2.f1)}   FP-rate ${pct(phase1.falsePositiveRate)} → ${pct(phase2.falsePositiveRate)}`);
  console.log("");

  if (phase2.f1 < minF1) {
    console.error(`FAIL: Phase 2 F1 ${pct(phase2.f1)} < gate ${pct(minF1)}`);
    process.exit(1);
  }
  if (phase2.f1 < phase1.f1 || phase2.falsePositiveRate > phase1.falsePositiveRate) {
    console.error(`FAIL: Phase 2 must not regress F1 or FP-rate vs Phase 1`);
    process.exit(1);
  }
  console.log(`PASS: Phase 2 F1 ${pct(phase2.f1)} ≥ Phase 1 ${pct(phase1.f1)} and FP-rate ${pct(phase2.falsePositiveRate)} ≤ Phase 1 ${pct(phase1.falsePositiveRate)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
