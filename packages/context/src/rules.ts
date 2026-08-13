// Repository rules: the law a review is judged against, written by the team.
//
// Cavix knew a great deal about the CODE and nothing about the TEAM. It could
// see that a handler builds a SQL string; it could not know that this repository
// decided in 2025 that handlers never touch SQL, wrote it down, and has been
// enforcing it by hand in every review since. So every reviewer had to say it
// again, by hand, forever.
//
// The shape is deliberately the one MultiCA validated for its Skills and that
// Claude Code uses for its own: frontmatter plus a Markdown body, in a file. Not
// a database row and not an embedding. Three reasons, and the first is the one
// that matters:
//
//   1. DETERMINISM. The same change loads the same rules. Retrieve law by
//      similarity search and a team's own standard applies on Tuesday and not on
//      Wednesday, with nothing in the trace to explain the difference.
//   2. AUDITABILITY. "Which rules were in force for this review" is a glob
//      match, not a threshold.
//   3. AUTHORSHIP. A rule is a file somebody wrote and somebody else reviewed.
//      It lives in git, it diffs, it reverts.
//
// Semantic retrieval still has a job in this pipeline. It is in `assembler.ts`,
// finding CODE the call graph missed, and it is labelled as such. It is not
// allowed anywhere near the rules.

import { estimateTokens, type ContextItem } from "./types.ts";

/** Where a rule came from. Later sources win a conflict. */
export type RuleSource = "builtin" | "repo" | "convention-file" | "dashboard" | "learned";

export interface RepoRule {
  /** Stable id, used in findings so a rule can be traced back to its file. */
  id: string;
  /** One line: what this rule requires. Shown to the model verbatim. */
  description: string;
  /** Globs this applies to. Empty means the whole repository. */
  appliesTo: string[];
  severity: string;
  category: string;
  /**
   * `blocking` rules may fail the pre-merge gate; `advisory` ones never can.
   *
   * Default advisory, and that default is load-bearing: a rule file dropped into
   * a repository must not be able to start blocking merges the moment it lands.
   */
  enforcement: "advisory" | "blocking";
  /** The rule's prose. Everything after the frontmatter. */
  body: string;
  source: RuleSource;
  /** Where it was read from, for the audit trail. */
  path?: string;
}

/** A file that might contain rules. */
export interface RuleFile {
  path: string;
  content: string;
}

/**
 * Files Cavix reads for rules even though they were not written for Cavix.
 *
 * Teams have been writing these for years. Ignoring them and asking for a
 * `.cavix/` directory instead means every customer writes their standards twice,
 * and the second copy drifts.
 */
export const CONVENTION_FILES = ["CLAUDE.md", "AGENTS.md", "CONVENTIONS.md", "CONTRIBUTING.md", ".cursorrules"];

/** Rule files proper, which carry frontmatter. */
export const RULE_DIR = ".cavix/rules/";

/**
 * Parse one rule file.
 *
 * Frontmatter is optional. A file without it is still a rule: its whole content
 * becomes the body and it applies repository-wide, which is exactly right for a
 * CONTRIBUTING.md somebody wrote years before Cavix existed.
 */
export function parseRuleFile(file: RuleFile, source: RuleSource): RepoRule | null {
  const { meta, body } = splitFrontmatter(file.content);
  const trimmed = body.trim();
  if (trimmed === "") return null;

  const id = str(meta.name) || slugOf(file.path);
  const globs = list(meta.applies_to ?? meta.appliesTo);
  return {
    id,
    description: str(meta.description) || firstSentence(trimmed),
    appliesTo: globs,
    severity: str(meta.severity) || "medium",
    category: str(meta.category) || "standards",
    // Anything other than an explicit "blocking" is advisory. A rule file that
    // lands in a repository must not be able to start holding merges on arrival.
    enforcement: str(meta.enforcement) === "blocking" ? "blocking" : "advisory",
    body: trimmed,
    source,
    path: file.path,
  };
}

/**
 * Read every rule out of a set of files.
 *
 * Order is precedence: builtins first, then repository rule files, then
 * convention files, so a `.cavix/rules` entry wins over a line in CONTRIBUTING.
 * Later duplicates of an id replace earlier ones.
 */
export function collectRules(files: readonly RuleFile[], builtins: readonly RepoRule[] = []): RepoRule[] {
  const byId = new Map<string, RepoRule>();
  for (const b of builtins) byId.set(b.id, b);

  const ruleFiles = files.filter((f) => normalise(f.path).includes(RULE_DIR));
  const conventionFiles = files.filter((f) => isConventionFile(f.path));

  for (const f of ruleFiles) {
    const rule = parseRuleFile(f, "repo");
    if (rule) byId.set(rule.id, rule);
  }
  for (const f of conventionFiles) {
    const rule = parseRuleFile(f, "convention-file");
    if (rule) byId.set(rule.id, rule);
  }
  return [...byId.values()];
}

function isConventionFile(path: string): boolean {
  const name = normalise(path).split("/").pop() ?? "";
  return CONVENTION_FILES.some((c) => c.toLowerCase() === name.toLowerCase());
}

/**
 * The rules that apply to a set of changed paths.
 *
 * A glob match, and nothing else. No embedding, no relevance model, no silent
 * omission: given the same change, the same rules, every time.
 */
export function rulesFor(rules: readonly RepoRule[], changedPaths: readonly string[]): RepoRule[] {
  const paths = changedPaths.map(normalise);
  return rules.filter((r) => {
    if (r.appliesTo.length === 0) return true; // repository-wide
    const patterns = r.appliesTo.map(globToRegExp);
    return paths.some((p) => patterns.some((re) => re.test(p)));
  });
}

/**
 * Render rules as context items.
 *
 * Priority 95: above every piece of code context and below only the diff itself.
 * Law outranks evidence about the code, because a change that is correct and
 * against the rules is still against the rules, and a reviewer that has to
 * choose between mentioning a caller and mentioning the standard should mention
 * the standard.
 */
export function ruleItems(rules: readonly RepoRule[], changedPaths: readonly string[]): ContextItem[] {
  return rulesFor(rules, changedPaths).map((r) => {
    const matched = r.appliesTo.length > 0 ? ` [applies to ${r.appliesTo.join(", ")}]` : " [repository-wide]";
    const content =
      `Rule \`${r.id}\` (${r.enforcement}, ${r.severity}, from ${r.path ?? r.source})${matched}\n` +
      `${r.description}\n\n${r.body}`;
    return {
      kind: "rule" as const,
      title: `Repository rule: ${r.id}`,
      content,
      priority: 95,
      tokens: estimateTokens(content),
      compressed: false,
      ...(r.path ? { path: r.path } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------

type Meta = Record<string, string | string[]>;

/**
 * Split `---` frontmatter from the body.
 *
 * A deliberately small parser: scalars and inline `[a, b]` lists, which is
 * everything a rule needs. Anything it cannot read is skipped rather than
 * guessed at, and a file whose frontmatter is malformed still contributes its
 * body as a repository-wide rule instead of vanishing.
 */
export function splitFrontmatter(content: string): { meta: Meta; body: string } {
  const text = content.replace(/^﻿/, "");
  if (!/^---\r?\n/.test(text)) return { meta: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: text };

  const head = text.slice(text.indexOf("\n") + 1, end);
  const body = text.slice(text.indexOf("\n", end + 1) + 1);
  const meta: Meta = {};
  for (const line of head.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1];
    const raw = m[2].trim();
    if (raw.startsWith("[") && raw.endsWith("]")) {
      meta[key] = raw
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else {
      meta[key] = unquote(raw);
    }
  }
  return { meta, body };
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = str(v);
  return s ? [s] : [];
}

function slugOf(path: string): string {
  const name = normalise(path).split("/").pop() ?? path;
  return name.replace(/\.[^.]+$/, "").toLowerCase();
}

function firstSentence(body: string): string {
  const line = body.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return line.replace(/^#+\s*/, "").trim().slice(0, 160);
}

function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Minimal glob support: `*` within a path segment, `**` across segments.
 *
 * The subtle case is `a/**' + '/b`, which must match `a/b` as well as `a/x/y/b`:
 * `**` means "zero or more directories", not "one or more". Getting that wrong
 * makes `services/**' + '/handler/**' + '/*.ts` silently fail to match
 * `services/api/handler/refund.ts`, and a rule that matches nothing is
 * indistinguishable from a rule nobody wrote.
 */
function globToRegExp(glob: string): RegExp {
  const DIRS = "\u0001"; // placeholders no path can contain
  const ANY = "\u0002";
  const escaped = normalise(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped
    .replace(/\*\*\//g, DIRS)
    .replace(/\*\*/g, ANY)
    .replace(/\*/g, "[^/]*")
    .split(DIRS)
    .join("(?:[^/]*/)*")
    .split(ANY)
    .join(".*");
  return new RegExp(`^${body}$`, "i");
}
