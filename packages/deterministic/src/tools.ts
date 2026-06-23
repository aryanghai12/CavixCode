import { spawn } from "node:child_process";
import type { Finding, Severity } from "@cavix/core";

// Registry of external linters/SAST tools Cavix knows how to drive. The runner
// selects the ones applicable to the languages present and runs whichever are
// installed (air-gapped/minimal installs simply run fewer). Output is normalized
// from SARIF or semgrep-JSON — two formats that cover the large majority of
// modern tools — into the common Finding schema (source="linter").

export type ToolFormat = "sarif" | "semgrep";

export interface ToolSpec {
  id: string;
  bin: string;
  languages: string[]; // "js" | "ts" | "py" | "go" | "rb" | "php" | "rust" | "c" | "sh" | "docker" | "tf" | "kotlin" | "java" | "any"
  format: ToolFormat;
  /** Args to produce machine-readable output over the workspace dir. */
  args: (dir: string) => string[];
}

// 24 tools across 12+ ecosystems. Commands reflect each tool's standard
// machine-readable invocation; they are configurable per deployment.
export const TOOL_REGISTRY: ToolSpec[] = [
  { id: "semgrep", bin: "semgrep", languages: ["any"], format: "semgrep", args: (d) => ["--quiet", "--json", "--config", "auto", d] },
  { id: "eslint", bin: "eslint", languages: ["js", "ts"], format: "sarif", args: (d) => ["-f", "@microsoft/eslint-formatter-sarif", d] },
  { id: "bandit", bin: "bandit", languages: ["py"], format: "sarif", args: (d) => ["-r", d, "-f", "sarif"] },
  { id: "ruff", bin: "ruff", languages: ["py"], format: "sarif", args: (d) => ["check", "--output-format", "sarif", d] },
  { id: "gosec", bin: "gosec", languages: ["go"], format: "sarif", args: () => ["-fmt", "sarif", "./..."] },
  { id: "staticcheck", bin: "staticcheck", languages: ["go"], format: "sarif", args: () => ["-f", "sarif", "./..."] },
  { id: "gitleaks", bin: "gitleaks", languages: ["any"], format: "sarif", args: (d) => ["detect", "--report-format", "sarif", "--source", d] },
  { id: "trivy", bin: "trivy", languages: ["any"], format: "sarif", args: (d) => ["fs", "--format", "sarif", d] },
  { id: "checkov", bin: "checkov", languages: ["tf"], format: "sarif", args: (d) => ["-d", d, "-o", "sarif"] },
  { id: "tflint", bin: "tflint", languages: ["tf"], format: "sarif", args: (d) => ["--format", "sarif", d] },
  { id: "rubocop", bin: "rubocop", languages: ["rb"], format: "sarif", args: (d) => ["--format", "sarif", d] },
  { id: "brakeman", bin: "brakeman", languages: ["rb"], format: "sarif", args: (d) => ["-f", "sarif", d] },
  { id: "phpstan", bin: "phpstan", languages: ["php"], format: "sarif", args: (d) => ["analyse", "--error-format=sarif", d] },
  { id: "psalm", bin: "psalm", languages: ["php"], format: "sarif", args: () => ["--output-format=sarif"] },
  { id: "clippy", bin: "cargo-clippy", languages: ["rust"], format: "sarif", args: () => ["--message-format=json"] },
  { id: "cppcheck", bin: "cppcheck", languages: ["c"], format: "sarif", args: (d) => ["--output-format=sarif", d] },
  { id: "shellcheck", bin: "shellcheck", languages: ["sh"], format: "sarif", args: (d) => ["-f", "sarif", d] },
  { id: "hadolint", bin: "hadolint", languages: ["docker"], format: "sarif", args: (d) => ["-f", "sarif", d] },
  { id: "detekt", bin: "detekt", languages: ["kotlin"], format: "sarif", args: (d) => ["-i", d, "-r", "sarif:out.sarif"] },
  { id: "spotbugs", bin: "spotbugs", languages: ["java"], format: "sarif", args: (d) => ["-sarif", d] },
  { id: "pmd", bin: "pmd", languages: ["java"], format: "sarif", args: (d) => ["check", "-d", d, "-f", "sarif"] },
  { id: "mypy", bin: "mypy", languages: ["py"], format: "sarif", args: (d) => ["--output", "sarif", d] },
  { id: "njsscan", bin: "njsscan", languages: ["js", "ts"], format: "sarif", args: (d) => ["--sarif", d] },
  { id: "tfsec", bin: "tfsec", languages: ["tf"], format: "sarif", args: (d) => ["--format", "sarif", d] },
];

export function toolsForLanguages(langs: Set<string>): ToolSpec[] {
  return TOOL_REGISTRY.filter((t) => t.languages.includes("any") || t.languages.some((l) => langs.has(l)));
}

/** Detect whether a binary is on PATH (cross-platform). */
export function isAvailable(bin: string): Promise<boolean> {
  const probe = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    const p = spawn(probe, [bin], { stdio: "ignore", shell: false });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

const SARIF_LEVEL: Record<string, Severity> = { error: "high", warning: "medium", note: "low", none: "info" };
const SEMGREP_SEV: Record<string, Severity> = { ERROR: "high", WARNING: "medium", INFO: "low" };

export function parseSarif(json: string, toolId: string): Finding[] {
  const data = JSON.parse(json) as { runs?: Array<{ results?: SarifResult[] }> };
  const out: Finding[] = [];
  for (const run of data.runs ?? []) {
    for (const r of run.results ?? []) {
      const loc = r.locations?.[0]?.physicalLocation;
      const path = loc?.artifactLocation?.uri ?? "";
      const line = loc?.region?.startLine ?? 1;
      if (!path) continue;
      out.push({
        path: normalizePath(path),
        line,
        severity: SARIF_LEVEL[r.level ?? "warning"] ?? "medium",
        category: "lint",
        title: r.ruleId ? `${toolId}: ${r.ruleId}` : `${toolId} finding`,
        body: typeof r.message?.text === "string" ? r.message.text : "",
        source: "linter",
        ruleId: `${toolId}/${r.ruleId ?? "rule"}`,
        confidence: 0.8,
      });
    }
  }
  return out;
}

export function parseSemgrep(json: string): Finding[] {
  const data = JSON.parse(json) as { results?: SemgrepResult[] };
  const out: Finding[] = [];
  for (const r of data.results ?? []) {
    out.push({
      path: normalizePath(r.path),
      line: r.start?.line ?? 1,
      severity: SEMGREP_SEV[r.extra?.severity ?? "WARNING"] ?? "medium",
      category: "security",
      title: `semgrep: ${r.check_id}`,
      body: r.extra?.message ?? "",
      source: "linter",
      ruleId: `semgrep/${r.check_id}`,
      confidence: 0.82,
    });
  }
  return out;
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/");
}

interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } } }>;
}
interface SemgrepResult {
  check_id: string;
  path: string;
  start?: { line?: number };
  extra?: { message?: string; severity?: string };
}
