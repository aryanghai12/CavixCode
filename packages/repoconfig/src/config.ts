import { parseSimpleYaml } from "./yaml.ts";

// Repo-level configuration: a `.cavix.yaml` (or `.cavix.json`) checked into the
// repo lets teams tune Cavix without a dashboard — auto-review on/off, which
// paths to review, which agents to run, whether @-commands are allowed, tone, and
// which severities block the merge (the required Check Run). Same idea as
// `.coderabbit.yaml` etc., but our defaults are safe and everything is optional.

export interface RepoConfig {
  autoReview: boolean;
  reviewDraftPRs: boolean;
  pathFilters: { include: string[]; exclude: string[] };
  agents: { disabled: string[] };
  commands: { enabled: boolean };
  policy: { enabled: boolean };
  tone: "concise" | "detailed";
  /** Severities that make the Cavix Check Run fail (blocks merge if required). */
  failOn: string[];
}

export const DEFAULT_CONFIG: RepoConfig = {
  autoReview: true,
  reviewDraftPRs: false,
  pathFilters: { include: [], exclude: ["**/node_modules/**", "**/dist/**", "**/*.min.js", "**/vendor/**", "**/*.lock"] },
  agents: { disabled: [] },
  commands: { enabled: true },
  policy: { enabled: false }, // the policy gate is opt-in
  tone: "concise",
  failOn: ["critical"],
};

const CONFIG_FILES = [".cavix.yaml", ".cavix.yml", ".cavix.json"];

export interface LoadResult {
  config: RepoConfig;
  source: string | null;
  warnings: string[];
}

/** Find and parse a repo config file; merge onto defaults. Missing → defaults. */
export function loadRepoConfig(files: Array<{ path: string; content: string }>): LoadResult {
  const warnings: string[] = [];
  const file = files.find((f) => CONFIG_FILES.includes(basename(f.path)));
  if (!file) return { config: DEFAULT_CONFIG, source: null, warnings };

  let raw: unknown;
  try {
    raw = basename(file.path).endsWith(".json") ? JSON.parse(file.content) : parseSimpleYaml(file.content);
  } catch (err) {
    warnings.push(`failed to parse ${file.path}: ${(err as Error).message}; using defaults`);
    return { config: DEFAULT_CONFIG, source: file.path, warnings };
  }
  return { config: merge(DEFAULT_CONFIG, raw as Partial<RepoConfig>), source: file.path, warnings };
}

function merge(base: RepoConfig, o: Partial<RepoConfig> | null): RepoConfig {
  if (!o || typeof o !== "object") return base;
  const p = o as Record<string, unknown>;
  const pf = (p.pathFilters ?? {}) as Record<string, unknown>;
  return {
    autoReview: bool(p.autoReview, base.autoReview),
    reviewDraftPRs: bool(p.reviewDraftPRs, base.reviewDraftPRs),
    pathFilters: {
      include: strArr(pf.include, base.pathFilters.include),
      exclude: strArr(pf.exclude, base.pathFilters.exclude),
    },
    agents: { disabled: strArr((p.agents as Record<string, unknown>)?.disabled, base.agents.disabled) },
    commands: { enabled: bool((p.commands as Record<string, unknown>)?.enabled, base.commands.enabled) },
    policy: { enabled: bool((p.policy as Record<string, unknown>)?.enabled, base.policy.enabled) },
    tone: p.tone === "detailed" ? "detailed" : base.tone,
    failOn: strArr(p.failOn, base.failOn),
  };
}

/** Whether a changed file should be reviewed, per include/exclude globs. */
export function shouldReviewPath(path: string, config: RepoConfig): boolean {
  const { include, exclude } = config.pathFilters;
  if (exclude.some((g) => matchGlob(path, g))) return false;
  if (include.length > 0 && !include.some((g) => matchGlob(path, g))) return false;
  return true;
}

export function isAgentEnabled(agentId: string, config: RepoConfig): boolean {
  return !config.agents.disabled.includes(agentId);
}

// ── helpers ──────────────────────────────────────────────────────────────────

const REGEX_SPECIAL = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

export function matchGlob(path: string, glob: string): boolean {
  return globToRegex(glob).test(path);
}

// Character scanner → regex. "**/" and "/**" may match zero path segments; "*"
// stays within a segment; "?" matches one non-slash char.
function globToRegex(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (REGEX_SPECIAL.has(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(re + "$");
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.slice(i + 1);
}

function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}

function strArr(v: unknown, d: string[]): string[] {
  return Array.isArray(v) ? v.map(String) : d;
}
