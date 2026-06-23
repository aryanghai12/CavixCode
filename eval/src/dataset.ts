import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GoldIssue, Prediction } from "./metrics.ts";

// Loads the seed dataset: one directory per PR, each containing a real unified
// diff (`change.diff`) and `labels.json` with the gold issues plus a deterministic
// "simulated_findings" list used by the hermetic (fixture) eval mode.

export interface SeedPR {
  id: string;
  title: string;
  language: string;
  diff: string;
  gold: GoldIssue[];
  /** Deterministic stand-in predictions for hermetic CI runs. */
  simulated: Prediction[];
}

interface LabelsFile {
  id: string;
  title: string;
  language: string;
  gold: GoldIssue[];
  simulated_findings: Prediction[];
}

export function seedDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "datasets", "seed");
}

export function loadSeed(dir: string = seedDir()): SeedPR[] {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const prs: SeedPR[] = [];
  for (const name of entries) {
    const base = path.join(dir, name);
    const labels = JSON.parse(fs.readFileSync(path.join(base, "labels.json"), "utf8")) as LabelsFile;
    const diff = fs.readFileSync(path.join(base, "change.diff"), "utf8");
    prs.push({
      id: labels.id,
      title: labels.title,
      language: labels.language,
      diff,
      gold: labels.gold,
      simulated: labels.simulated_findings,
    });
  }
  return prs;
}
