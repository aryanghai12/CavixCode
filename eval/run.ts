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
import { scorePR, aggregate, type PRScore, type Prediction } from "./src/metrics.ts";

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

async function main() {
  const mode = (process.env.EVAL_MODE ?? "fixture").toLowerCase();
  const predict = mode === "live" ? livePredictor() : fixturePredictor();
  const minF1 = Number(process.env.EVAL_MIN_F1 ?? "0.6");

  const prs = loadSeed();
  if (prs.length === 0) throw new Error("no seed PRs found");

  const scores: PRScore[] = [];
  for (const pr of prs) {
    const preds = await predict(pr);
    scores.push(scorePR(pr.id, pr.gold, preds));
  }

  const agg = aggregate(scores);

  console.log(`\nCavix eval — mode=${mode}, ${prs.length} labeled PRs\n`);
  console.log(renderTable(scores, prs));
  console.log("");
  console.log("Aggregate (micro-averaged):");
  console.log(`  Precision           ${pct(agg.precision)}   (TP ${agg.tp} / TP+FP ${agg.tp + agg.fp})`);
  console.log(`  Recall              ${pct(agg.recall)}   (TP ${agg.tp} / TP+FN ${agg.tp + agg.fn})`);
  console.log(`  F1                  ${pct(agg.f1)}`);
  console.log(`  False-positive rate ${pct(agg.falsePositiveRate)}   (FP ${agg.fp} / emitted ${agg.tp + agg.fp})`);
  console.log("");

  if (agg.f1 < minF1) {
    console.error(`FAIL: F1 ${pct(agg.f1)} < gate ${pct(minF1)} (EVAL_MIN_F1)`);
    process.exit(1);
  }
  console.log(`PASS: F1 ${pct(agg.f1)} ≥ gate ${pct(minF1)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
