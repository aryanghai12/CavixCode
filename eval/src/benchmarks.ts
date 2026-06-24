import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GoldIssue } from "./metrics.ts";

// External benchmark adapters. Each maps a public dataset's shape into Cavix's
// BenchmarkCase so the same scorer runs over Defects4J (logic bugs), a
// SWE-bench-style set (issue→patch), and CVEfixes (real vulnerabilities). The
// sample data bundled here is small and illustrative; a deployment points the
// adapter at the full dataset directory. The case shape and scoring are real.

export interface BenchmarkCase {
  id: string;
  language: string;
  files: Array<{ path: string; content: string }>;
  gold: GoldIssue[];
}

export interface BenchmarkAdapter {
  readonly name: string;
  load(): BenchmarkCase[];
}

function externalDir(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "datasets", "external", name);
}

function loadCases(name: string): BenchmarkCase[] {
  const file = path.join(externalDir(name), "cases.json");
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")) as BenchmarkCase[];
}

// CVEfixes — real-world vulnerabilities (the deterministic SAST/secret layer's
// strong suit). Maps {cve_id, file, code, vulnerable_lines} → BenchmarkCase.
export class CveFixesAdapter implements BenchmarkAdapter {
  readonly name = "CVEfixes";
  load(): BenchmarkCase[] {
    return loadCases("cvefixes");
  }
}

// Defects4J — Java/logic defects. (Logic bugs need the LLM ensemble + a build, so
// these score best in `live` mode against a real model; the deterministic layer
// catches only the pattern-y ones.)
export class Defects4JAdapter implements BenchmarkAdapter {
  readonly name = "Defects4J";
  load(): BenchmarkCase[] {
    return loadCases("defects4j");
  }
}

// SWE-bench-style — issue→patch tasks.
export class SweBenchAdapter implements BenchmarkAdapter {
  readonly name = "SWE-bench";
  load(): BenchmarkCase[] {
    return loadCases("swebench");
  }
}

export const ADAPTERS: BenchmarkAdapter[] = [new CveFixesAdapter(), new Defects4JAdapter(), new SweBenchAdapter()];

/** Synthesize an all-added unified diff from a case's files (line N = file line N). */
export function caseToDiff(c: BenchmarkCase): string {
  return c.files
    .map((f) => {
      const lines = f.content.split("\n");
      const body = lines.map((l) => "+" + l).join("\n");
      return `diff --git a/${f.path} b/${f.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${f.path}\n@@ -0,0 +1,${lines.length} @@\n${body}`;
    })
    .join("\n");
}
