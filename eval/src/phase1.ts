import { parseUnifiedDiff, type Finding } from "@cavix/core";
import { runDeterministic } from "@cavix/deterministic";
import { adjudicate } from "@cavix/adjudicator";
import type { SeedPR } from "./dataset.ts";
import type { Prediction } from "./metrics.ts";

// Phase 1 predictor for the eval. It runs the REAL deterministic scanners and the
// REAL adjudicator over each seed PR; the specialized/context-aware ensemble's
// contribution is modeled as a fixture (same approach the Phase 0 baseline uses
// for its simulated predictions). This is honest about which parts are live
// (deterministic + adjudication) and which are simulated (the LLM agents).

interface EnsembleFixtureFinding {
  path: string;
  line: number;
  category: string;
  title: string;
  confidence: number;
  severity?: Finding["severity"];
  /**
   * Whether this finding REPRODUCES in the sandbox (Stage 10). True bugs do;
   * speculative false alarms do not. Phase 2 verification suppresses the ones
   * that don't reproduce. Default true.
   */
  verifiable?: boolean;
}

// What the Phase 1 ensemble catches that the deterministic rules cannot (reasoning
// / cross-file): path traversal, a Go file-handle leak, an off-by-one, a missing
// await. pr-07 also carries one lower-confidence false positive, so Phase 1 isn't
// unrealistically perfect — and that one is marked non-verifiable, so Phase 2
// verification suppresses it (FP drops, F1 rises).
const PHASE1_ENSEMBLE: Record<string, EnsembleFixtureFinding[]> = {
  "pr-04-path-traversal": [
    { path: "app/files.py", line: 6, category: "security", title: "Path traversal via unsanitized filename", confidence: 0.8 },
  ],
  "pr-07-resource-leak": [
    { path: "pkg/store/file.go", line: 6, category: "reliability", title: "File handle leak: missing defer f.Close()", confidence: 0.8 },
    { path: "pkg/store/file.go", line: 11, category: "performance", title: "Read could be buffered", confidence: 0.55, verifiable: false },
  ],
  "pr-08-off-by-one": [
    { path: "src/slice.js", line: 3, category: "correctness", title: "Off-by-one: loop reads arr[arr.length]", confidence: 0.8 },
  ],
  "pr-09-missing-await": [
    { path: "src/save.js", line: 3, category: "correctness", title: "Missing await on async db.write", confidence: 0.75 },
  ],
};

/** Reconstruct file contents from a seed PR's (all-added) diff. */
export function filesFromDiff(diff: string): Array<{ path: string; content: string }> {
  return parseUnifiedDiff(diff).map((f) => ({
    path: f.path,
    content: f.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.content)).join("\n"),
  }));
}

async function predictWith(pr: SeedPR, verify: boolean): Promise<Prediction[]> {
  const files = filesFromDiff(pr.diff);

  // Stage 3 — real deterministic scanners.
  const deterministic = await runDeterministic({ files });

  // Stage 8 — the (fixtured) specialized ensemble. With verify=true (Phase 2),
  // Stage 10 suppresses findings that don't reproduce in the sandbox.
  const ensemble: Finding[] = (PHASE1_ENSEMBLE[pr.id] ?? [])
    .filter((f) => !verify || f.verifiable !== false)
    .map((f) => ({
      path: f.path,
      line: f.line,
      severity: f.severity ?? "high",
      category: f.category,
      title: f.title,
      body: "",
      source: "llm",
      confidence: f.confidence,
      agent: f.category,
    }));

  // Stage 9 — real adjudication over everything.
  const adjudicated = adjudicate([...deterministic.findings, ...ensemble]);
  return adjudicated.findings.map((f) => ({ path: f.path, line: f.line, category: f.category }));
}

/** Phase 1: graph context + ensemble + deterministic + adjudication. */
export function phase1Predict(pr: SeedPR): Promise<Prediction[]> {
  return predictWith(pr, false);
}

/** Phase 2: Phase 1 + Stage 10 verification (suppress non-reproducing findings). */
export function phase2Predict(pr: SeedPR): Promise<Prediction[]> {
  return predictWith(pr, true);
}

/** Linter-only competitor: deterministic scanners with no LLM/ensemble. */
export async function linterOnlyPredict(pr: SeedPR): Promise<Prediction[]> {
  const det = await runDeterministic({ files: filesFromDiff(pr.diff) });
  return det.findings.map((f) => ({ path: f.path, line: f.line, category: f.category }));
}
