import type { Finding, Severity } from "@cavix/core";
import { runDeterministic } from "@cavix/deterministic";
import { analyzeLegacy } from "@cavix/legacy";
import { adjudicate } from "@cavix/adjudicator";
import { AgentEnsemble } from "@cavix/agents";
import type { Gateway } from "@cavix/gateway";

// Pre-PR local review: the SAME engine the PR pipeline uses (deterministic +
// legacy + optional ensemble → adjudication), run over the editor's working tree.
// Default mode is fast and fully offline (no key, no network): deterministic SAST
// + secrets + legacy rules. The ensemble is opt-in for a deeper local pass.

export interface LocalFile {
  path: string;
  content: string;
}

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

export interface Diagnostic {
  path: string;
  line: number; // 1-based
  endLine?: number;
  severity: DiagnosticSeverity;
  source: string;
  ruleId?: string;
  message: string;
}

export interface LocalReviewOptions {
  /** Opt-in deeper pass through the agent ensemble (needs a configured gateway). */
  ensemble?: { gateway: Gateway; org: string };
  /** Include legacy-language rules (COBOL/PL-SQL/C/C++/IaC). Default true. */
  includeLegacy?: boolean;
}

export interface LocalReviewResult {
  diagnostics: Diagnostic[];
  summary: string;
  counts: Record<DiagnosticSeverity, number>;
}

const SEVERITY_MAP: Record<Severity, DiagnosticSeverity> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "information",
  info: "hint",
};

export async function localReview(files: LocalFile[], opts: LocalReviewOptions = {}): Promise<LocalReviewResult> {
  const includeLegacy = opts.includeLegacy ?? true;

  // Stage 3 (deterministic) + legacy rules run in parallel — both offline.
  const [deterministic, legacy] = await Promise.all([
    runDeterministic({ files }),
    Promise.resolve(includeLegacy ? analyzeLegacy(files).findings : []),
  ]);

  // Optional ensemble pass (synthesize an all-added diff for context).
  let ensembleFindings: Finding[] = [];
  if (opts.ensemble) {
    const diff = synthDiff(files);
    const ensemble = new AgentEnsemble({ gateway: opts.ensemble.gateway });
    const r = await ensemble.run({ org: opts.ensemble.org, title: "local working tree", diff, contextPrompt: "" });
    ensembleFindings = r.findings;
  }

  const adjudicated = adjudicate([...deterministic.findings, ...legacy, ...ensembleFindings]);
  const diagnostics = adjudicated.findings.map(toDiagnostic).sort(bySeverityThenLocation);

  const counts: Record<DiagnosticSeverity, number> = { error: 0, warning: 0, information: 0, hint: 0 };
  for (const d of diagnostics) counts[d.severity]++;
  const summary = diagnostics.length === 0
    ? "Cavix: no issues found in the working tree."
    : `Cavix: ${counts.error} error(s), ${counts.warning} warning(s) before you open a PR.`;

  return { diagnostics, summary, counts };
}

function toDiagnostic(f: Finding): Diagnostic {
  return {
    path: f.path,
    line: f.line,
    endLine: f.endLine,
    severity: SEVERITY_MAP[f.severity],
    source: f.immutable ? "cavix:policy" : `cavix:${f.source}`,
    ruleId: f.ruleId,
    message: f.title + (f.body ? ` — ${f.body}` : ""),
  };
}

function bySeverityThenLocation(a: Diagnostic, b: Diagnostic): number {
  const rank: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, information: 2, hint: 3 };
  return rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path) || a.line - b.line;
}

function synthDiff(files: LocalFile[]): string {
  return files
    .map((f) => {
      const lines = f.content.split("\n");
      return `diff --git a/${f.path} b/${f.path}\n--- /dev/null\n+++ b/${f.path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => "+" + l).join("\n")}`;
    })
    .join("\n");
}
