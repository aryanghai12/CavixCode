import type { Finding } from "@cavix/core";
import { compileEnglishRule } from "@cavix/policy";

// Stage 3c — the optional pre-merge gate, as the repo owner wrote it.
//
// The owner types rules in plain English on the dashboard ("Every new endpoint
// must have an authentication check"). Each one compiles to a DETERMINISTIC
// check: no model is involved in deciding whether it passed, which is the whole
// point — a gate an LLM can talk itself out of is not a gate.
//
// Three outcomes per rule, and the difference matters to the person who wrote it:
//   pass    the check ran and found nothing
//   fail    the check ran and found violations (these become immutable findings)
//   skipped the sentence did not compile into anything runnable — reported
//           honestly rather than shown as a green tick, because a rule that
//           silently never runs is worse than no rule at all.

export type CheckStatus = "pass" | "fail" | "skipped";

export interface PreMergeCheck {
  /** The owner's sentence, verbatim — it is what they will recognise. */
  rule: string;
  status: CheckStatus;
  /** One line under the rule: what ran, or why nothing did. */
  detail: string;
  /** Violations, already shaped as immutable policy findings. */
  findings: Finding[];
}

export interface PreMergeResult {
  checks: PreMergeCheck[];
  /** Every violation across every rule, ready to post. */
  findings: Finding[];
  failed: number;
  passed: number;
  skipped: number;
}

export interface SourceFile {
  path: string;
  content: string;
}

/**
 * Rules that judge a file as a whole rather than a line in it. Their violations
 * survive the changed-lines filter, because "this file is 900 lines" is true of
 * the file the PR is shipping regardless of which line the author touched.
 *
 * Keyed by the compiler's matcher name, which is the only stable label for what
 * kind of check a sentence became.
 */
const FILE_SCOPED = new Set(["max-file-length", "require-license-header"]);

/** A fresh empty result. Never share one instance — the arrays are mutable. */
function emptyResult(): PreMergeResult {
  return { checks: [], findings: [], failed: 0, passed: 0, skipped: 0 };
}

/**
 * The gate could not run at all (the repo's files were unreadable, say).
 *
 * Every rule is reported as skipped rather than the section being omitted: a
 * gate that silently does not run looks exactly like a gate that passed, and
 * the whole point of the feature is that the reader can tell the difference.
 */
export function preMergeUnavailable(rules: string[], reason: string): PreMergeResult {
  const checks: PreMergeCheck[] = rules.map((rule) => ({
    rule,
    status: "skipped",
    detail: `Cavix could not run this check: ${reason}`,
    findings: [],
  }));
  return { checks, findings: [], failed: 0, passed: 0, skipped: checks.length };
}

/**
 * Run the org's rules over what this PR changed.
 *
 * A pre-merge check answers "is this change allowed to merge", not "is the whole
 * repo compliant". So the rules are evaluated against the full file — they need
 * the surrounding code to be accurate — but violations are then filtered to the
 * lines the PR actually ADDED. Blaming an author for fifty pre-existing
 * console.log calls because they touched line 200 is how a gate gets switched
 * back off within a week.
 *
 * `addedLines` maps path → the new-file line numbers the diff adds. Omit it to
 * scan whole files (used by direct callers that have no diff).
 */
export function runPreMergeChecks(
  rules: string[],
  files: SourceFile[],
  addedLines?: Map<string, Set<number>>,
): PreMergeResult {
  if (rules.length === 0) return emptyResult();
  // Rules the owner is relying on, but nothing to scan: that is a gate that did
  // not run, not a gate that passed.
  if (files.length === 0) return preMergeUnavailable(rules, "no readable files in this change");

  const checks: PreMergeCheck[] = [];
  const allFindings: Finding[] = [];

  for (const rule of rules) {
    const compiled = compileEnglishRule(rule);
    if (!compiled.ok) {
      checks.push({
        rule,
        status: "skipped",
        detail: "Cavix could not turn this sentence into a deterministic check, so it did not run.",
        findings: [],
      });
      continue;
    }

    const raw = compiled.rule.evaluate({ files, options: {} });
    const violations =
      addedLines && !FILE_SCOPED.has(compiled.matcher)
        ? raw.filter((v) => addedLines.get(v.path)?.has(v.line) === true)
        : raw;

    const findings: Finding[] = violations.map((v) => ({
      path: v.path,
      line: v.line,
      severity: compiled.rule.severity,
      category: compiled.rule.category,
      title: compiled.rule.title,
      body: `${v.message}\n\nOrg pre-merge rule: _"${rule}"_`,
      source: "policy",
      ruleId: `policy/${compiled.rule.id}`,
      confidence: 1,
      // The structural basis of non-bypassability: adjudication may not drop it,
      // and no model gets a vote on whether it counts.
      immutable: true,
    }));
    allFindings.push(...findings);

    checks.push({
      rule,
      status: violations.length > 0 ? "fail" : "pass",
      detail:
        violations.length > 0
          ? `${violations.length} violation${violations.length === 1 ? "" : "s"} in this change`
          : preExisting(raw.length - violations.length),
      findings,
    });
  }

  return {
    checks,
    findings: allFindings,
    failed: checks.filter((c) => c.status === "fail").length,
    passed: checks.filter((c) => c.status === "pass").length,
    skipped: checks.filter((c) => c.status === "skipped").length,
  };
}

/**
 * A pass line that stays honest when the file already violates the rule outside
 * this change. Saying a flat "pass" there would imply the file is clean.
 */
function preExisting(ignored: number): string {
  return ignored > 0
    ? `pass — this change adds none (${ignored} pre-existing, not attributed to this PR)`
    : "pass — nothing in the added lines";
}
