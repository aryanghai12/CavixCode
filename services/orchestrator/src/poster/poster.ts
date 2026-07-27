import {
  parseUnifiedDiff,
  commentableLines,
  SEVERITY_RANK,
  type DiffFile,
  type FileChange,
  type Finding,
  type ReviewResult,
  type Severity,
  type Verification,
} from "@cavix/core";
import type { InlineComment, ReviewEvent, ReviewSubmission } from "../github/client.ts";
import type { PreMergeResult } from "../policy/preMerge.ts";
import { ALL_SECTIONS, type ReviewSections } from "../byok/reviewConfig.ts";

// The poster renders everything a human sees on the pull request. Three surfaces,
// each with a different job:
//
//   1. The PR DESCRIPTION carries the verdict, the summary and the walkthrough:
//      what this change does, file by file. It belongs there because it describes
//      the PR itself, it is what a reviewer reads first, and it must not scroll
//      away under later comments. Cavix owns only the block between its markers.
//   2. The REVIEW COMMENT carries the findings, grouped by file, each with its
//      line, severity, and where the full detail lives.
//   3. INLINE COMMENTS carry that detail, anchored to the line at fault, with the
//      sandbox proof attached when Stage 10 verified the finding.
//
// House style for everything posted here:
//   • One H2 title per surface, H3 for sections, H4 for a file. Nothing larger,
//     so a review never shouts over the human conversation around it.
//   • The verdict is a GitHub alert callout, so its colour states the outcome
//     before a word is read.
//   • Dense facts go in tables; a table row is two lines at most, the second one
//     small and dim.
//   • Plain punctuation only. No em or en dashes anywhere, including in text the
//     model wrote: `plain()` rewrites them on the way out.
//
// Findings are anchored to lines that are actually in the diff; anything off the
// diff is folded into the review comment rather than dropped, so a finding is
// never silently lost.
//
// Phase 0 always posts as event=COMMENT. Cavix does not block merges here. The
// optional, off-by-default policy gate (Stage 3/9) is the only thing that will
// ever escalate to REQUEST_CHANGES, and only when an org enables it.

/** The colour chip for a severity. Carries the signal at a glance. */
const SEVERITY_CHIP: Record<Severity, string> = {
  critical: "🟥",
  high: "🟧",
  medium: "🟨",
  low: "🟦",
  info: "⬜",
};

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

/** Chip plus word, for places with room for both. */
function severityBadge(s: Severity): string {
  return `${SEVERITY_CHIP[s]} ${s}`;
}

/** Where a reader finds the full explanation for a finding. */
const DETAIL_INLINE = "💬 inline";
const DETAIL_BELOW = "📄 below";

/** Stamped on findings Cavix reproduced in a sandbox. The product's whole claim. */
const VERIFIED_BADGE = "✅ verified";

/**
 * The block Cavix owns inside the PR description. Everything outside these
 * markers belongs to the author and is never touched.
 */
export const SUMMARY_START = "<!-- cavix:summary:start -->";
export const SUMMARY_END = "<!-- cavix:summary:end -->";

/** The one H2 both surfaces open with, so they read as one review. */
const TITLE = "## 🔬 Cavix review";

/** GitHub rejects a review body over 65536 chars; stay clear of the edge. */
const MAX_BODY = 60000;

/** Beyond this the walkthrough stops being a summary. */
const MAX_FILE_ROWS = 30;

/**
 * What we need to deep-link a file and line. It is a subset of PullRef so the
 * workflow can pass the ref it already has. Optional throughout: without it the
 * output still names every path and line, just without hyperlinks (that is the
 * case in tests and the offline demo, where no such URL exists).
 */
export interface ReviewLinkRef {
  owner: string;
  repo: string;
  /** Head commit; blob permalinks are pinned to it so they never drift. */
  headSha: string;
}

export interface PosterOptions {
  ref?: ReviewLinkRef;
  /**
   * Put the summary and walkthrough in the review comment too.
   *
   * They normally live in the PR description. The workflow sets this when the
   * description could not be written (a fork PR, a revoked permission) so the
   * summary degrades into the comment rather than vanishing.
   */
  includeSummary?: boolean;
  /** How many findings the sandbox DISPROVED and Cavix therefore did not post. */
  suppressedCount?: number;
  /** The org's pre-merge gate results, when the owner enabled it. */
  preMerge?: PreMergeResult;
  /**
   * Escalate to REQUEST_CHANGES. Only ever set because the repo owner turned
   * blocking on in the dashboard: Cavix does not decide to block a team's
   * merges on its own.
   */
  requestChanges?: boolean;
  /**
   * Which parts of the review to include, as chosen on the dashboard. Omitted
   * means all of them.
   */
  sections?: ReviewSections;
}

export interface BuiltReview {
  submission: ReviewSubmission;
  inlineCount: number;
  offDiffCount: number;
  /** Findings backed by a sandbox reproduction. */
  verifiedCount: number;
}

export function buildReviewSubmission(
  result: ReviewResult,
  diff: string,
  opts: PosterOptions = {},
): BuiltReview {
  const files = parseUnifiedDiff(diff);
  const anchors = commentableLines(files);
  const sections = opts.sections ?? ALL_SECTIONS;

  const inline: InlineComment[] = [];
  // Identity set, not a list: the per-file tables need to ask "did this finding
  // get an inline comment?" while rendering, one lookup per row.
  const offDiff = new Set<Finding>();

  // Highest severity first so the most important comments lead.
  const ordered = [...result.findings].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.line - b.line,
  );

  for (const f of ordered) {
    const lines = anchors.get(f.path);
    const anchor = sections.inlineFindings && lines ? anchorFor(f, lines) : null;
    if (anchor) {
      inline.push({
        path: f.path,
        line: anchor.line,
        ...(anchor.startLine !== undefined ? { startLine: anchor.startLine } : {}),
        body: renderInlineBody(f, sections),
      });
    } else {
      // With inline comments switched off every finding's detail has to live in
      // the review comment instead: the explanation must not simply vanish.
      offDiff.add(f);
    }
  }

  const body = renderReviewComment(result, ordered, offDiff, files, opts);
  // Blocking is the owner's call, made in the dashboard. Cavix never escalates
  // on its own: an uninvited REQUEST_CHANGES is how a reviewer gets removed.
  const event: ReviewEvent = opts.requestChanges ? "REQUEST_CHANGES" : "COMMENT";
  return {
    submission: { body, event, comments: inline },
    inlineCount: inline.length,
    offDiffCount: offDiff.size,
    verifiedCount: ordered.filter(isVerified).length,
  };
}

/**
 * Splice Cavix's summary into the PR description, preserving what the author
 * wrote. A re-review replaces the block in place, so the description carries one
 * current summary instead of growing a stack of them.
 */
export function buildPullDescription(
  existing: string,
  result: ReviewResult,
  diff: string,
  ref?: ReviewLinkRef,
  sections: ReviewSections = ALL_SECTIONS,
): string {
  const files = parseUnifiedDiff(diff);
  // The blank line before the end marker matters: without it a trailing table
  // runs straight into the HTML comment and some renderers stop parsing it.
  const block = [
    SUMMARY_START,
    TITLE,
    "",
    ...renderSummarySection(result, files, ref, sections),
    "",
    SUMMARY_END,
  ].join("\n");

  const start = existing.indexOf(SUMMARY_START);
  const end = existing.indexOf(SUMMARY_END);
  if (start !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + SUMMARY_END.length);
  }
  const author = existing.trim();
  return author === "" ? block : `${author}\n\n---\n\n${block}`;
}

/**
 * Pick the line(s) to hang an inline comment on.
 *
 * A finding that spans lines becomes a multi-line comment (GitHub highlights the
 * whole range), but only when BOTH ends are added lines: sending a start_line
 * that is not in the diff is a 422 that would sink the entire review, so we fall
 * back to whichever single end is anchorable.
 */
function anchorFor(f: Finding, commentable: Set<number>): { line: number; startLine?: number } | null {
  const end = f.endLine !== undefined && f.endLine > f.line ? f.endLine : f.line;
  if (end !== f.line && commentable.has(f.line) && commentable.has(end)) {
    return { line: end, startLine: f.line };
  }
  if (commentable.has(f.line)) return { line: f.line };
  if (end !== f.line && commentable.has(end)) return { line: end };
  return null;
}

function isVerified(f: Finding): boolean {
  return f.verification?.status === "VERIFIED";
}

/**
 * One finding, as it reads on the line at fault: the headline first, then a dim
 * line of provenance, then the explanation. Inline comments are narrow, so
 * nothing here is wider than it has to be.
 */
function renderInlineBody(f: Finding, sections: ReviewSections = ALL_SECTIONS): string {
  const meta = [
    ...(isVerified(f) ? [VERIFIED_BADGE] : []),
    f.severity,
    plain(f.category),
    `confidence ${Math.round(f.confidence * 100)}%`,
  ].join(" · ");

  const parts = [
    `**${SEVERITY_CHIP[f.severity]} ${plain(f.title)}**`,
    "",
    `<sub>${meta}</sub>`,
  ];
  const body = plain(f.body).trim();
  if (body !== "") parts.push("", body);

  // The receipt. A reader should not have to take "verified" on faith: show the
  // commands, the exit codes, and what each one proved.
  if (sections.proof && f.verification?.status === "VERIFIED") {
    parts.push("", ...renderProof(f.verification));
  }

  if (f.suggestion && f.suggestion.trim() !== "") {
    // A GitHub ```suggestion block renders as a one-click "Apply" button.
    parts.push("", "```suggestion", f.suggestion.replace(/\n+$/, ""), "```");
  }
  // GitHub shows the file and line around an inline comment, but the same body
  // gets quoted into notifications and emails where that context is gone.
  parts.push("", `<sub>\`${f.path}\` ${lineLabel(f)}</sub>`);
  return parts.join("\n");
}

/** The sandbox transcript, as a fixed-width block: what ran, and what it said. */
function renderProof(v: Verification): string[] {
  const rows = v.steps.map((s) => ({
    label: `[${s.step}]`,
    cmd: prettyCmd(s.cmd),
    result: s.timedOut ? "timed out" : `exit ${s.code}`,
    note: stepNote(s.step, v),
  }));
  const labelW = Math.max(...rows.map((r) => r.label.length), 0);
  const cmdW = Math.min(Math.max(...rows.map((r) => r.cmd.length), 0), 52);

  const out = [
    v.exploit
      ? "**Proof.** The PoC exploit ran against this code in a sealed sandbox:"
      : "**Proof.** Reproduced in a sealed sandbox:",
    "",
    "```text",
  ];
  for (const r of rows) {
    out.push(
      `${r.label.padEnd(labelW)} ${truncate(r.cmd, cmdW).padEnd(cmdW)} → ${r.result.padEnd(9)}${r.note}`,
    );
  }
  out.push("```");
  if (v.testPath) out.push("", `<sub>Reproduction: \`${v.testPath}\` · ${plain(v.reason)}</sub>`);
  return out;
}

function stepNote(step: string, v: Verification): string {
  switch (step) {
    case "install":
      return "dependencies ready";
    case "repro":
      if (!v.reproduced) return "did not reproduce";
      return v.exploit ? "exploit succeeded" : "bug reproduced";
    case "after-fix":
      return v.fixWorks ? "suggested fix resolves it" : "fix did not resolve it";
    case "suite":
      return v.suitePasses ? "existing suite still green" : "existing suite broke";
    default:
      return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 3)}...`;
}

/**
 * The command as a human would type it. The verifier already records the
 * interpreter by name; this is a belt-and-braces strip for step logs that came
 * from somewhere else (an older run, another producer of Verification).
 */
function prettyCmd(cmd: string): string {
  return cmd.replace(/^.*?[\\/](node|python[\d.]*|go|npx)(?:\.exe)?(?=\s|$)/i, "$1");
}

/**
 * The review comment: findings, and only findings. The summary and walkthrough
 * live in the PR description unless the workflow tells us it could not write
 * there, in which case they are folded back in here.
 */
function renderReviewComment(
  result: ReviewResult,
  all: Finding[],
  offDiff: Set<Finding>,
  files: DiffFile[],
  opts: PosterOptions,
): string {
  const groups = groupByFile(all);
  const ref = opts.ref;
  const sections = opts.sections ?? ALL_SECTIONS;

  const head: string[] = [TITLE, ""];
  // With the summary folded in here (the description was unwritable) the whole
  // block leads and its callout is the verdict; otherwise the callout stands alone.
  head.push(
    ...(opts.includeSummary
      ? renderSummarySection(result, files, ref, sections, opts)
      : verdict(all, groups.length, files.length, opts)),
  );
  const provenance = provenanceLine(all, opts);
  if (provenance !== "") head.push("", provenance);

  // Each entry is one whole section, so truncation can drop them atomically.
  const findingSections: string[][] = [];
  const gate = renderPreMerge(opts.preMerge, opts.requestChanges === true);
  if (gate.length > 0) findingSections.push(["", "---", "", ...gate]);
  if (groups.length > 0) {
    findingSections.push(["", "---", "", "### Findings"]);
    for (const g of groups) findingSections.push(["", ...renderFileSection(g, offDiff, ref, sections)]);
  }

  const legend = all.length > 0 ? legendLine(offDiff.size, all.length - offDiff.size, all, sections) : "";
  return assemble(head, findingSections, legend, footer(result, all.some(isVerified)));
}

/**
 * The verdict, as a GitHub alert callout: colour first, counts second.
 *
 * TIP (green) for a clean review, CAUTION (red) when the owner's gate is
 * blocking the merge, WARNING (amber) when something at high or above was found,
 * NOTE (blue) for the rest. A reader knows the outcome before reading a word.
 */
function verdict(
  all: Finding[],
  fileCount: number,
  diffFileCount: number,
  opts: PosterOptions = {},
): string[] {
  if (all.length === 0) {
    const where = diffFileCount > 0 ? plural(diffFileCount, "changed file") : "the changed lines";
    return ["> [!TIP]", `> **No issues found** in ${where}.`];
  }

  const counts = countBySeverity(all);
  const worst = SEVERITY_ORDER.find((s) => counts[s] > 0) ?? "info";
  const kind = opts.requestChanges
    ? "CAUTION"
    : SEVERITY_RANK[worst] >= SEVERITY_RANK.high
      ? "WARNING"
      : "NOTE";

  const tally = SEVERITY_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${SEVERITY_CHIP[s]} ${s} ${counts[s]}`)
    .join(" · ");

  const out = [
    `> [!${kind}]`,
    `> **${plural(all.length, "finding")}** across **${plural(fileCount, "file")}**`,
    ">",
    `> ${tally}`,
  ];
  if (opts.requestChanges) {
    out.push(">", `> **Changes requested: ${blockingReason(opts)}.**`);
    out.push(
      ">",
      "> <sub>This workspace has pre-merge blocking switched on. An owner can change that under **Review settings**.</sub>",
    );
  }
  return out;
}

/**
 * Why the merge is blocked, in a few words. Someone who is blocked should never
 * have to scroll to find out by what.
 */
function blockingReason(opts: PosterOptions): string {
  const failed = opts.preMerge?.failed ?? 0;
  return failed > 0
    ? `${plural(failed, "pre-merge check")} failed`
    : "a finding at or above your blocking severity was posted";
}

/**
 * The pre-merge gate, rule by rule, in the owner's own words.
 *
 * A rule that could not be compiled is shown as skipped, never as a pass: the
 * whole value of a gate is that a green tick means the check actually ran.
 */
function renderPreMerge(pm: PreMergeResult | undefined, blocking: boolean): string[] {
  if (!pm || pm.checks.length === 0) return [];
  const icon = { pass: "✅", fail: "❌", skipped: "⚠️" } as const;

  const out: string[] = ["### Pre-merge checks", ""];
  // "All passing" must never be said when nothing actually ran: a skipped rule
  // proves nothing, and reporting it as green is the one thing a gate must not do.
  const state =
    pm.failed > 0
      ? `**${plural(pm.failed, "check")} failing**`
      : pm.passed === 0
        ? "**No checks ran**"
        : `**${plural(pm.passed, "check")} passing**${pm.skipped > 0 ? ` · ${pm.skipped} skipped` : ""}`;
  out.push(state);
  out.push("");
  out.push("| | Rule | Result |");
  out.push("| :--: | :--- | :--- |");
  for (const c of pm.checks) {
    out.push(`| ${icon[c.status]} | ${cell(c.rule)} | ${cell(c.detail)} |`);
  }
  out.push("");
  out.push(
    `<sub>Your org's rules, compiled into deterministic checks. No model gets a vote on whether they passed. ` +
      `${blocking ? "A failure blocks merge" : "Reporting only, blocking is off"} · edit under **Review settings**.</sub>`,
  );
  return out;
}

/**
 * The summary block: the verdict, what this PR does, how big it is, and a
 * walkthrough of every file. Rendered identically wherever it lands (description
 * or comment) so a reader never has to learn two layouts.
 *
 * The caller supplies the H2 title, because the two surfaces place it
 * differently.
 */
function renderSummarySection(
  result: ReviewResult,
  files: DiffFile[],
  ref?: ReviewLinkRef,
  sections: ReviewSections = ALL_SECTIONS,
  opts: PosterOptions = {},
): string[] {
  const groups = groupByFile(result.findings);
  const totals = diffTotals(files);
  const out: string[] = [...verdict(result.findings, groups.length, files.length, opts)];

  if (sections.summary) {
    out.push("", "### Summary", "");
    out.push(plain(result.summary).trim() || "_The model returned no summary for this change._");
  }
  if (sections.reviewEffort) out.push("", ...statsTable(result, files, totals));
  if (sections.changedFiles) {
    const changes = renderChanges(files, groups, result.walkthrough ?? [], ref);
    if (changes.length > 0) out.push("", ...changes);
  }
  return out;
}

/**
 * The receipt line. The sandbox sentence is only there when something was
 * actually proven: on a clean review it would be a claim about nothing.
 */
function footer(result: ReviewResult, anyVerified: boolean): string {
  const parts = [`Cavix · ${plain(result.model)} · $${result.costUsd.toFixed(4)}`];
  if (anyVerified) {
    parts.push(`findings marked ${VERIFIED_BADGE} were reproduced by running the code in a sealed sandbox`);
  }
  return `<sub>${parts.join(" · ")}</sub>`;
}

/**
 * One line stating how the findings below were established, and what Cavix
 * decided NOT to show. Suppression is a feature (it is why the tool does not get
 * muted) so it is stated out loud rather than hidden.
 */
function provenanceLine(all: Finding[], opts: PosterOptions): string {
  const parts: string[] = [];
  const verified = all.filter(isVerified).length;
  if (verified > 0) parts.push(`✅ ${verified} reproduced in a sandbox`);
  if (opts.suppressedCount && opts.suppressedCount > 0) {
    parts.push(
      `🔕 ${plural(opts.suppressedCount, "finding")} suppressed after the sandbox could not reproduce ${opts.suppressedCount === 1 ? "it" : "them"}`,
    );
  }
  if (!opts.includeSummary) parts.push("summary and walkthrough are in the PR description");
  return parts.length > 0 ? `<sub>${parts.join(" · ")}</sub>` : "";
}

/**
 * Join the sections, dropping the optional ones if the body would exceed what
 * GitHub accepts. A review with hundreds of findings must still post, so whole
 * finding sections are trimmed only as a last resort.
 */
function assemble(head: string[], findingSections: string[][], legend: string, foot: string): string {
  const tail = (extra: string[]) => [...extra, "", ...(legend ? [legend, ""] : []), foot].join("\n");
  const flat = (sections: string[][]) => sections.flat();

  let body = tail([...head, ...flat(findingSections)]);
  if (body.length <= MAX_BODY) return body;

  // Sections are dropped WHOLE. Trimming line by line would leave a heading with
  // no table, or a table header with no rows: mangled markdown that reads like a
  // bug rather than a truncation.
  const kept: string[][] = [];
  let dropped = 0;
  for (const section of findingSections) {
    if (tail([...head, ...flat([...kept, section])]).length + 140 > MAX_BODY) {
      dropped++;
      continue;
    }
    kept.push(section);
  }
  return tail([
    ...head,
    ...flat(kept),
    "",
    `_${dropped} further section${dropped === 1 ? "" : "s"} omitted. This review is too large for one GitHub comment._`,
  ]);
}

interface FileGroup {
  path: string;
  findings: Finding[];
  worst: Severity;
}

/** Group findings by file, worst-affected file first, then by count, then path. */
function groupByFile(all: Finding[]): FileGroup[] {
  const byPath = new Map<string, Finding[]>();
  for (const f of all) {
    const list = byPath.get(f.path);
    if (list) list.push(f);
    else byPath.set(f.path, [f]);
  }
  const groups: FileGroup[] = [];
  for (const [path, findings] of byPath) {
    const sorted = [...findings].sort((a, b) => a.line - b.line);
    let worst: Severity = "info";
    for (const f of sorted) if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
    groups.push({ path, findings: sorted, worst });
  }
  groups.sort(
    (a, b) =>
      SEVERITY_RANK[b.worst] - SEVERITY_RANK[a.worst] ||
      b.findings.length - a.findings.length ||
      a.path.localeCompare(b.path),
  );
  return groups;
}

/**
 * One file: a heading naming it, then a row per finding. Each row is the chip,
 * the line, the headline in bold with a dim line of detail under it, and where
 * the full explanation lives.
 */
function renderFileSection(
  g: FileGroup,
  offDiff: Set<Finding>,
  ref?: ReviewLinkRef,
  sections: ReviewSections = ALL_SECTIONS,
): string[] {
  const out: string[] = [];
  out.push(`#### ${SEVERITY_CHIP[g.worst]} ${fileLink(g.path, ref)} · ${plural(g.findings.length, "finding")}`);
  out.push("");
  out.push("| | Line | Finding | Detail |");
  out.push("| :--: | ---: | :--- | :--- |");
  for (const f of g.findings) {
    const title = `**${cell(f.title)}**${isVerified(f) ? " ✅" : ""}`;
    const meta = `${f.severity} · ${cell(f.category)} · confidence ${Math.round(f.confidence * 100)}%`;
    out.push(
      `| ${SEVERITY_CHIP[f.severity]} | ${lineLink(f, ref)} | ${title}<br><sub>${meta}</sub> | ${
        offDiff.has(f) ? DETAIL_BELOW : DETAIL_INLINE
      } |`,
    );
  }

  // Findings GitHub will not let us comment on (the line is not part of this
  // diff) have nowhere else to carry their explanation, so it goes here in full
  // rather than being reduced to a title.
  const notes = g.findings.filter((f) => offDiff.has(f));
  if (notes.length > 0) {
    // With inline comments off, "not on a changed line" would be a lie: these are
    // simply the findings whose detail has nowhere else to go.
    const label = sections.inlineFindings
      ? `Full detail for ${plural(notes.length, "finding")} not on a changed line`
      : `Full detail for ${plural(notes.length, "finding")}`;
    out.push("");
    out.push(`<details><summary>📄 <b>${label}</b></summary>`);
    out.push("");
    notes.forEach((f, i) => {
      if (i > 0) out.push("", "---", "");
      out.push(`**${severityBadge(f.severity)} · ${cell(f.category)}**`);
      out.push("");
      out.push(`**${plain(f.title)}**`);
      out.push("");
      out.push(`<sub>\`${f.path}\` ${lineLabel(f)} · confidence ${Math.round(f.confidence * 100)}%</sub>`);
      const body = plain(f.body).trim();
      if (body !== "") {
        out.push("");
        out.push(body);
      }
      if (sections.proof && f.verification?.status === "VERIFIED") {
        out.push("");
        out.push(...renderProof(f.verification));
      }
      if (f.suggestion && f.suggestion.trim() !== "") {
        out.push("");
        out.push("```");
        out.push(f.suggestion.replace(/\n+$/, ""));
        out.push("```");
      }
    });
    out.push("");
    out.push("</details>");
  }
  return out;
}

/**
 * The walkthrough: every changed file, what it now does, and which lines moved.
 *
 * The rows come from the DIFF and the descriptions from the model, joined on
 * path. Doing it that way (rather than rendering the model's list directly) means
 * a file is never missing from the map because the model forgot it: it just shows
 * up with a description derived from the diff instead.
 */
function renderChanges(
  files: DiffFile[],
  groups: FileGroup[],
  walkthrough: FileChange[],
  ref?: ReviewLinkRef,
): string[] {
  if (files.length === 0) return [];
  const findingCount = new Map(groups.map((g) => [g.path, g.findings.length]));
  const described = new Map(walkthrough.map((w) => [w.path, w.summary]));

  const out: string[] = [];
  out.push("### Changed files");
  out.push("");
  out.push("| File | What changed | Lines | Findings |");
  out.push("| :--- | :--- | :--- | :--: |");
  for (const f of files.slice(0, MAX_FILE_ROWS)) {
    const stats = fileStats(f);
    const lines = f.deleted
      ? "_deleted_"
      : `\`${sizeLabel(stats.added, stats.removed)}\`${stats.ranges ? `<br><sub>${stats.ranges}</sub>` : ""}`;
    const n = findingCount.get(f.path) ?? 0;
    out.push(
      `| ${fileLink(f.path, f.deleted ? undefined : ref)} | ${cell(described.get(f.path) ?? describeFromDiff(f))} | ${lines} | ${n} |`,
    );
  }
  if (files.length > MAX_FILE_ROWS) {
    out.push(`| _${files.length - MAX_FILE_ROWS} more files not shown_ | | | |`);
  }
  return out;
}

/**
 * Fallback description when the model gave none for a file. git puts the
 * enclosing function (or section) after the @@ marker, so the hunk headers are a
 * genuine, if terse, answer to "what part of this file changed?".
 */
function describeFromDiff(f: DiffFile): string {
  if (f.deleted) return "_File deleted._";
  const contexts = [...new Set(f.hunks.map((h) => h.header.trim()).filter((h) => h !== ""))];
  if (contexts.length === 0) return "_Not described by the model._";
  const shown = contexts.slice(0, 2).map((c) => `\`${c}\``).join(", ");
  return contexts.length > 2 ? `In ${shown} and ${contexts.length - 2} more` : `In ${shown}`;
}

interface FileStats {
  added: number;
  removed: number;
  /** Human-readable new-file line ranges, e.g. "L10-L14, L88". */
  ranges: string;
}

function fileStats(f: DiffFile): FileStats {
  let added = 0;
  let removed = 0;
  const addedLines: number[] = [];
  for (const h of f.hunks) {
    for (const l of h.lines) {
      if (l.kind === "add") {
        added++;
        if (l.newLineNo !== undefined) addedLines.push(l.newLineNo);
      } else if (l.kind === "del") {
        removed++;
      }
    }
  }
  return { added, removed, ranges: formatRanges(addedLines) };
}

/** "+18 / -6", in plain ASCII so it reads the same in every client. */
function sizeLabel(added: number, removed: number): string {
  return `+${added} / -${removed}`;
}

/** Collapse [10,11,12,88] into "L10-L12, L88": the lines where work happened. */
function formatRanges(lines: number[]): string {
  if (lines.length === 0) return "";
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const n of sorted.slice(1)) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    ranges.push(start === prev ? `L${start}` : `L${start}-L${prev}`);
    start = n;
    prev = n;
  }
  ranges.push(start === prev ? `L${start}` : `L${start}-L${prev}`);
  // Three ranges is enough to show where the change is; more is noise in a table.
  if (ranges.length > 3) return `${ranges.slice(0, 3).join(", ")} and ${ranges.length - 3} more`;
  return ranges.join(", ");
}

interface DiffTotals {
  added: number;
  removed: number;
}

function diffTotals(files: DiffFile[]): DiffTotals {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    const s = fileStats(f);
    added += s.added;
    removed += s.removed;
  }
  return { added, removed };
}

/**
 * The vital signs of the change: how big it is, and how much attention it wants.
 * Effort is the model's own 1 to 5 read where it gave one, and a size-derived
 * estimate where it did not. A reviewer glancing at the PR list should be able to
 * tell a rename from a rewrite without opening either.
 */
function statsTable(result: ReviewResult, files: DiffFile[], totals: DiffTotals): string[] {
  // Clamped: `effort` may come from any producer of a ReviewResult, and a value
  // outside 1..5 would make repeat() throw on a negative count.
  const raw = result.effort ?? estimateEffort(files.length, totals.added + totals.removed);
  const effort = Math.min(5, Math.max(1, Math.round(raw)));
  const dots = "●".repeat(effort) + "○".repeat(5 - effort);
  const scope =
    files.length > 0
      ? `**${plural(files.length, "file")}** changed · \`${sizeLabel(totals.added, totals.removed)}\``
      : "_no files in the diff_";
  return [
    "| Scope | Review effort |",
    "| :--- | :--- |",
    `| ${scope} | ${dots} **${effort} of 5** |`,
  ];
}

/** Size-only effort estimate, used when the model did not supply one. */
function estimateEffort(fileCount: number, changedLines: number): number {
  if (changedLines <= 20 && fileCount <= 2) return 1;
  if (changedLines <= 80) return 2;
  if (changedLines <= 250) return 3;
  if (changedLines <= 800) return 4;
  return 5;
}

function legendLine(
  offDiffCount: number,
  inlineCount: number,
  all: Finding[],
  sections: ReviewSections,
): string {
  const parts: string[] = [];
  if (all.some(isVerified)) parts.push(`${VERIFIED_BADGE}: Cavix reproduced this by running the code`);
  if (inlineCount > 0) parts.push(`${DETAIL_INLINE}: the full explanation is an inline comment on that line`);
  if (offDiffCount > 0) {
    parts.push(
      sections.inlineFindings
        ? `${DETAIL_BELOW}: the line is not part of this diff, so the detail is in the table's dropdown`
        : `${DETAIL_BELOW}: inline comments are off for this workspace, so the detail is in the table's dropdown`,
    );
  }
  return parts.length > 0 ? `<sub>${parts.join(" · ")}</sub>` : "";
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

/** "line 12" or "lines 12-18", matching how the finding is anchored. */
function lineLabel(f: Finding): string {
  return f.endLine !== undefined && f.endLine > f.line ? `lines ${f.line}-${f.endLine}` : `line ${f.line}`;
}

function lineLink(f: Finding, ref?: ReviewLinkRef): string {
  const label = f.endLine !== undefined && f.endLine > f.line ? `${f.line}-${f.endLine}` : String(f.line);
  const url = blobUrl(f.path, ref);
  if (!url) return label;
  const frag = f.endLine !== undefined && f.endLine > f.line ? `#L${f.line}-L${f.endLine}` : `#L${f.line}`;
  return `[${label}](${url}${frag})`;
}

function fileLink(path: string, ref?: ReviewLinkRef): string {
  const url = blobUrl(path, ref);
  return url ? `[\`${path}\`](${url})` : `\`${path}\``;
}

/**
 * A permalink to the file at the head commit. Pinned to the SHA rather than the
 * branch so the link keeps pointing at the code that was reviewed, even after
 * the PR moves on or merges.
 */
function blobUrl(path: string, ref?: ReviewLinkRef): string {
  if (!ref || !ref.owner || !ref.repo || !ref.headSha) return "";
  return `https://github.com/${ref.owner}/${ref.repo}/blob/${ref.headSha}/${encodeURI(path)}`;
}

/**
 * House punctuation, applied to every string Cavix posts that it did not write
 * itself.
 *
 * Models reach for em dashes constantly, and they read as machine-written the
 * moment a human skims the comment. The rewrite is deliberately dumb and
 * deterministic: a dash between two clauses becomes a comma, everything else
 * (ranges, compounds) becomes a hyphen. Smart quotes and ellipses go the same
 * way, so the posted text is plain ASCII a terminal, an email digest and a
 * screen reader all render identically.
 */
export function plain(text: string): string {
  return text
    .replace(/(\w)[—–](\w)/g, "$1-$2")   // ranges and compounds: "12–18", "well–known"
    .replace(/\s+[—–]\s+/g, ", ")        // clause break: "the flow — one issue" → "the flow, one issue"
    .replace(/\s*[—–]\s*/g, " ")         // anything left over: a dangling dash just closes up
    .replace(/−/g, "-")                  // unicode minus, as diff stats used to use
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, "...")
    .replace(/,\s*,/g, ",")
    .replace(/\s+,/g, ",");
}

/** Make free text safe inside a markdown table cell. */
function cell(text: string): string {
  return plain(text).replace(/\r?\n/g, " ").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
