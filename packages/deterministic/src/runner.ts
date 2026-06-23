import type { Finding } from "@cavix/core";
import type { SourceFile } from "./types.ts";
import { SecretScanner } from "./secrets.ts";
import { BuiltinRuleScanner } from "./builtins.ts";
import {
  isAvailable,
  parseSarif,
  parseSemgrep,
  toolsForLanguages,
  type ToolSpec,
} from "./tools.ts";

const EXT_TAG: Record<string, string> = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "ts", tsx: "ts",
  py: "py", go: "go", rb: "rb", php: "php", rs: "rust", c: "c", cc: "c", cpp: "c",
  sh: "sh", tf: "tf", kt: "kotlin", java: "java",
};

export function detectLanguages(files: SourceFile[]): Set<string> {
  const langs = new Set<string>();
  for (const f of files) {
    const ext = f.path.slice(f.path.lastIndexOf(".") + 1).toLowerCase();
    const tag = EXT_TAG[ext];
    if (tag) langs.add(tag);
  }
  return langs;
}

export interface DeterministicOptions {
  files: SourceFile[];
  /** Cloned workspace dir for external tools (from the Stage 2 sandbox). */
  workspaceDir?: string;
  /** Run external linters/SAST if installed. Default false (hermetic). */
  enableExternalTools?: boolean;
  /** Injectable tool runner for tests; default spawns the real binary. */
  spawnTool?: (spec: ToolSpec, dir: string) => Promise<string>;
}

export interface DeterministicResult {
  findings: Finding[];
  toolsRun: string[];
  toolsSkipped: string[];
}

// Run the deterministic stage: always-on in-process scanners over file contents,
// plus any installed external tools over the workspace, all in parallel.
export async function runDeterministic(opts: DeterministicOptions): Promise<DeterministicResult> {
  const inProcess = [new SecretScanner(), new BuiltinRuleScanner()];
  const builtinFindings = (await Promise.all(inProcess.map((s) => s.run(opts.files)))).flat();

  const toolsRun: string[] = [];
  const toolsSkipped: string[] = [];
  let toolFindings: Finding[] = [];

  if (opts.enableExternalTools && opts.workspaceDir) {
    const langs = detectLanguages(opts.files);
    const candidates = toolsForLanguages(langs);
    const runner = opts.spawnTool ?? defaultSpawn;
    const results = await Promise.all(
      candidates.map(async (spec) => {
        const available = opts.spawnTool ? true : await isAvailable(spec.bin);
        if (!available) {
          toolsSkipped.push(spec.id);
          return [] as Finding[];
        }
        try {
          const raw = await runner(spec, opts.workspaceDir!);
          toolsRun.push(spec.id);
          return spec.format === "semgrep" ? parseSemgrep(raw) : parseSarif(raw, spec.id);
        } catch {
          toolsSkipped.push(spec.id);
          return [] as Finding[];
        }
      }),
    );
    toolFindings = results.flat();
  }

  const findings = dedupe([...builtinFindings, ...toolFindings]);
  return { findings, toolsRun, toolsSkipped };
}

// Collapse exact duplicates (same path/line/ruleId) that multiple tools may emit.
function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.path}:${f.line}:${f.ruleId ?? f.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function defaultSpawn(spec: ToolSpec, dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    import("node:child_process").then(({ spawn }) => {
      const p = spawn(spec.bin, spec.args(dir), { cwd: dir });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      // Many linters exit non-zero when they find issues; rely on parseable output.
      p.on("close", () => (out.trim() ? resolve(out) : reject(new Error(err || "no output"))));
    });
  });
}
