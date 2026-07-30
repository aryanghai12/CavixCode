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
import type { CallTrace } from "@cavix/analyzer";
import type { LedgerEntry } from "@cavix/review-session";
import {
  CHECK_NAME,
  INLINE_MARKER,
  REVIEW_MARKER,
  type DiffLimitation,
  type InlineComment,
  type PlatformName,
  type ReviewEvent,
  type ReviewSubmission,
} from "../github/client.ts";
import type { PreMergeResult } from "../policy/preMerge.ts";
import { ALL_SECTIONS, type ReviewSections } from "../byok/reviewConfig.ts";
import { renderSequenceDiagram } from "./mermaid.ts";

// The poster renders everything a human sees on the pull request. Three surfaces,
// each with a different job, and the split between the first two is deliberate:
//
//   1. The PR DESCRIPTION carries the executive summary and the change
//      walkthrough, and NOTHING about what is wrong with the code. What a change
//      does is durable: it stays true from the first push to the merge. Findings
//      are not. They get fixed within the hour, and a description that still says
//      "1 critical" after the critical was fixed is worse than no description at
//      all, because the author cannot see it to correct it and every later reader
//      believes it. So no verdict, no counts, no severities here. Cavix owns only
//      the block between its markers; everything the author wrote is untouched.
//   2. The REVIEW COMMENT carries the whole review: the Review Scope & Effort
//      module, the verdict, and the findings grouped by file. A comment is a
//      point in time. It is dated, it can be superseded by a fresh review, and
//      GitHub marks it outdated on its own once the lines move. That is exactly
//      the right home for a claim with a shelf life.
//   3. INLINE COMMENTS carry the detail, anchored to the line at fault, with the
//      sandbox proof attached when Stage 10 verified the finding.
//
// House style for everything posted here:
//
//   • NO EMOJI. Not one. A review is a technical document that a staff engineer
//     forwards to their VP, and a comment sprinkled with robots and rockets reads
//     like a toy. The visual language is geometric instead: a severity scale that
//     runs solid to hollow, diamond to square (◆ ◈ ◇ ▪ ▫), a filled hexagon (⬢)
//     for anything Cavix proved by execution, and a triangle (▲) for attention.
//   • COLOUR comes from things GitHub renders natively: alert callouts carry a
//     coloured vertical border, ```diff fences colour a suggested fix, and <kbd>
//     draws a bordered chip. Colour is never carried by an emoji.
//   • Section headings are distinct without shouting: one H2 per surface, H3 for
//     a section, H4 for a file. Nothing larger.
//   • Generous vertical spacing. Sections are separated by a rule and a blank
//     line on each side, so the post is scannable rather than a wall.
//   • Dense facts go in tables; a table row is two lines at most, the second one
//     small and dim.
//   • Plain punctuation only. No em or en dashes anywhere, including in text the
//     model wrote: `plain()` rewrites them on the way out.
//   • Every number stated is one Cavix actually measured. The Scope module omits
//     a row it has no data for rather than inventing a plausible metric, because
//     the first fabricated statistic a customer catches costs us all the others.
//   • No raw git stats. Files changed, lines added and lines removed are already
//     on the page, rendered by GitHub, directly above this comment. Repeating
//     them wastes the most valuable space in the review.
//
// Findings are anchored to lines that are actually in the diff; anything off the
// diff is folded into the review comment rather than dropped, so a finding is
// never silently lost.
//
// Phase 0 always posts as event=COMMENT. Cavix does not block merges here. The
// optional, off-by-default policy gate (Stage 3/9) is the only thing that will
// ever escalate to REQUEST_CHANGES, and only when an org enables it.

// ── the visual language ───────────────────────────────────────────────────────

/**
 * Severity as a geometric mark. The scale is legible before it is read: solid
 * fills at the top, hollow outlines at the bottom, diamonds for "this is a
 * defect" and squares for "this is a note".
 */
const SEVERITY_MARK: Record<Severity, string> = {
  critical: "◆",
  high: "◈",
  medium: "◇",
  low: "▪",
  info: "▫",
};

/**
 * The GitHub alert flavour that introduces a finding of this severity. This is
 * where the colour comes from: CAUTION is red, WARNING amber, IMPORTANT purple,
 * NOTE blue, each with a coloured vertical border down the left edge.
 */
const SEVERITY_ALERT: Record<Severity, string> = {
  critical: "CAUTION",
  high: "WARNING",
  medium: "IMPORTANT",
  low: "NOTE",
  info: "NOTE",
};

/**
 * Muted, professional hex for the badge strip. Crimson, burnt amber, amber gold,
 * then two greys. Nothing saturated: this has to sit on a white and a dark theme
 * without glowing.
 */
const SEVERITY_HEX: Record<Severity, string> = {
  critical: "B42318", // crimson
  high: "C2410C",     // burnt amber
  medium: "A16207",   // amber gold
  low: "475569",      // slate
  info: "64748B",     // light slate
};

/** Emerald, for anything Cavix proved rather than claimed. */
const HEX_PROVEN = "047857";
/** Slate, the neutral. */
const HEX_NEUTRAL = "475569";
/** The dark left half of every badge, so the strip reads as one object. */
const HEX_LABEL = "1F2937";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

/** Row marks inside the Scope module. */
const MARK_NEUTRAL = "◇";
const MARK_PROVEN = "⬢";
const MARK_ATTENTION = "▲";

/** Pre-merge check states. Text glyphs, not emoji: these render everywhere. */
const CHECK_MARK = { pass: "✓", fail: "✕", skipped: "◇" } as const;

/** Where a reader finds the full explanation for a finding. */
const DETAIL_INLINE = "▸ inline";
const DETAIL_BELOW = "▾ below";

/** Stamped on findings Cavix reproduced in a sandbox. The product's whole claim. */
const VERIFIED_BADGE = "⬢ verified";

/**
 * The block Cavix owns inside the PR description. Everything outside these
 * markers belongs to the author and is never touched.
 */
export const SUMMARY_START = "<!-- cavix:summary:start -->";
export const SUMMARY_END = "<!-- cavix:summary:end -->";

/**
 * The H2 the review comment opens with, preceded by the hidden marker that lets
 * a later run find this review again to clean it up. GitHub renders an HTML
 * comment as nothing, so the reader sees only the heading.
 */
const TITLE = `${REVIEW_MARKER}\n## ◈ Cavix Review`;

/**
 * The H2 the description block opens with. Named for what is under it rather
 * than for the product: there is no review in the description, only a summary of
 * the change, and calling it a review would promise a verdict that is not there.
 */
const DESCRIPTION_TITLE = "## ◈ Cavix Summary";

/** GitHub rejects a review body over 65536 chars; stay clear of the edge. */
const MAX_BODY = 60000;

/** Beyond this the walkthrough stops being a summary. */
const MAX_FILE_ROWS = 30;

/** How many must-fix items the priority callout names before it summarises. */
const MAX_PRIORITY_ROWS = 5;

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
  /**
   * The browser root of the host this review is going to, no trailing slash.
   * Comes from `ReviewPlatform.webUrl`.
   *
   * Optional and defaulting to github.com only because that is where this
   * started; the workflow always supplies it. Every permalink used to be built
   * against a hardcoded github.com, so a GitLab or Bitbucket review linked every
   * file and every line at a github.com repository that does not exist, and a
   * GitHub Enterprise review linked out of the customer's network entirely.
   */
  host?: string;
  /**
   * Which host's permalink SHAPE to use. The three differ and none of them is
   * derivable from the others: GitHub puts the commit under /blob/, GitLab under
   * /-/blob/, Bitbucket under /src/, and Azure DevOps passes the path and the
   * commit as query parameters. Defaults to GitHub.
   */
  platform?: PlatformName;
}

/**
 * Measurements from the pipeline stages that ran ahead of the poster, for the
 * Review Scope module.
 *
 * Every field is optional and every one of them is a real count taken from a
 * stage that actually executed. A row whose data is absent is NOT rendered: an
 * "AST Verification" line on a deployment where Stage 4 never ran would be a
 * fabricated metric, and one of those is enough to make a buyer distrust the
 * proof claims that are the entire product.
 */
export interface ScopeSignals {
  /** Stage 4: symbols the AST and semantic graph pass resolved for this change. */
  astSymbols?: number;
  /** Stage 3: deterministic tools that ran (linters, SAST, secret scanners). */
  tools?: number;
  /** Stage 8: agents in the ensemble that read this diff. */
  agents?: number;
  /** Stage 5: downstream call sites checked in other repositories. */
  consumers?: number;
  /** Stage 6: completed CI runs the regression check was computed over. */
  ciRuns?: number;
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
  /** Real measurements from earlier pipeline stages. See ScopeSignals. */
  signals?: ScopeSignals;
  /**
   * Stage 4's traced call path for this change, when the deep review ran and the
   * graph had something to draw. Absent means no diagram, which is the usual
   * case and not an error: see `traceSequence`.
   */
  trace?: CallTrace;
  /**
   * The owner asked Cavix to block this merge and the platform cannot.
   *
   * Set only where `capabilities.blockingReview` is false. The review then posts
   * as an ordinary comment, and says so: an owner who turned blocking on and is
   * never told it did not happen believes there is a gate in front of their main
   * branch that does not exist. That is a worse failure than the missing feature.
   */
  blockUnavailable?: boolean;
  /** Which host this is going to, for the footer. */
  platform?: PlatformName;
  /**
   * Render the coloured badge strip at the top of the review (shields.io images).
   *
   * On by default, and deliberately small: at most five badges per review, only
   * in the Scope module, never one per finding. Set false for GitHub Enterprise
   * behind an air gap, where GitHub's image proxy cannot reach shields.io and
   * the badges would render as broken images. With it off the same facts are
   * still in the Scope table underneath, so nothing is lost but the colour.
   */
  badges?: boolean;
  /**
   * Files the platform could not produce an exact diff for, from
   * `ReviewPlatform.diffLimitations`.
   *
   * Empty on every host that hands over a real diff. On Azure DevOps, where the
   * diff is computed from the two versions of each file, a file can be too
   * large, too rewritten or binary. Those files are NOT reviewed, and a review
   * that did not say so would be claiming coverage it does not have, which is
   * the same failure as a Scope row with no measurement behind it.
   */
  diffLimitations?: DiffLimitation[];
  /**
   * Findings raised by EARLIER reviews that are still open, and that this review
   * did not re-report.
   *
   * Each one has been checked against the code: the file it points at has not
   * changed since it was raised. That is why it is still here, and why it counts
   * towards the verdict exactly as a fresh finding does. They are rendered as a
   * list rather than as inline comments because their line numbers belong to an
   * older head and anchoring them there would put a comment on the wrong line.
   */
  carried?: LedgerEntry[];
  /**
   * Findings from earlier reviews that this one CLEARED: the code moved and the
   * reviewer no longer raises them.
   *
   * Rendered as prominently as the carried ones, and that is deliberate. Someone
   * who pushed a fix needs to see it land. Showing only what is still open makes
   * a review that noticed the fix look identical to one that ignored it, which
   * is how a reviewer stops being trusted.
   */
  resolved?: LedgerEntry[];
  /**
   * Did the ledger actually answer this review?
   *
   * False when the control-plane could not be reached, and it changes what may
   * be SAID rather than what is computed: with no answer, the review cannot
   * claim a clean pass on the pull request as a whole, because it does not know
   * what earlier reviews left open. The Scope module states measurements, and an
   * unanswered question is not one.
   */
  ledgerKnown?: boolean;
  /**
   * How many of THIS review's findings sit at or above the owner's blocking
   * severity.
   *
   * Passed in rather than derived here, because the bar is `failOn` and only the
   * workflow reads the org's config. It exists so the blocking sentence can name
   * where the block came from: on the run where every blocking finding is a
   * carried one, "a finding was posted" sends the reader hunting through a
   * review that does not contain it.
   */
  blockingFindings?: number;
}

export interface BuiltReview {
  submission: ReviewSubmission;
  inlineCount: number;
  offDiffCount: number;
  /** Findings backed by a sandbox reproduction. */
  verifiedCount: number;
}

/** What the Checks box shows once the review has landed. */
export interface CheckOutput {
  title: string;
  summary: string;
}

/**
 * The finished Cavix row in the pull request's Checks box.
 *
 * The title is the one line a reader sees without expanding anything, so it says
 * the outcome and nothing else. The summary is the same Review Scope module the
 * comment opens with, built from the same rows, so the two surfaces can never
 * disagree about what was scanned or what was proven.
 */
export function buildCheckOutput(
  result: ReviewResult,
  diff: string,
  opts: PosterOptions = {},
): CheckOutput {
  const files = parseUnifiedDiff(diff);
  const all = [...result.findings].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.line - b.line,
  );
  const counts = countBySeverity(all);
  const worst = SEVERITY_ORDER.find((s) => counts[s] > 0);
  const verified = all.filter(isVerified).length;
  const carried = opts.carried ?? [];

  // The title is the one line a reader sees without expanding anything, and on a
  // required check it is the line they read before clicking merge. "No issues
  // found" while two findings from earlier reviews are still open is the exact
  // sentence this feature was built to stop printing.
  const title = opts.requestChanges
    ? `Changes requested: ${blockingReason(opts)}`
    : all.length === 0 && carried.length > 0
      ? `Nothing new. ${plural(carried.length, "finding")} still open from earlier reviews`
      : all.length === 0
        ? "Review complete. No issues found"
        : `Review complete. ${plural(all.length, "finding")}, highest ${worst}` +
          (carried.length > 0 ? `, plus ${carried.length} still open from earlier reviews` : "") +
          (verified > 0 ? `, ${verified} verified by execution` : "");

  const lines: string[] = [];
  const rows = scopeRows(result, all, files, opts);
  if (rows.length > 0) {
    lines.push("| | Signal | Reading |", "| :--: | :--- | :--- |");
    for (const r of rows) lines.push(`| ${r.mark} | **${r.signal}** | ${r.reading} |`);
    lines.push("");
  }
  if (all.length > 0) {
    lines.push(
      SEVERITY_ORDER.filter((s) => counts[s] > 0)
        .map((s) => `${SEVERITY_MARK[s]} ${counts[s]} ${s}`)
        .join(" · "),
      "",
    );
  }
  // Named in the check summary as well as the title. A required check is often
  // read from the Checks box alone, and a reader who never opens the review
  // comment still has to be told what is holding the pull request.
  if (carried.length > 0) {
    lines.push(
      `**${plural(carried.length, "finding")} still open from earlier reviews of this pull ` +
        "request.** Cavix did not raise them again in this review, and it checked why: the files " +
        "they point at have not changed since. They are listed in the review comment.",
      "",
    );
  }
  // The check row is a summary, not the review. Say where the review is, because
  // a reader who opened this from the Checks box has not seen the comment yet.
  lines.push(
    all.length === 0 && carried.length === 0
      ? "<sub>Cavix read every changed line and had nothing to raise. The full review is in the pull request conversation.</sub>"
      : "<sub>Every finding is listed in the Cavix review comment on the pull request, with the detail on the line at fault.</sub>",
  );
  return { title, summary: lines.join("\n") };
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
 *
 * Only the summary and the walkthrough go here. Findings, counts and the verdict
 * belong in the review comment: see the note at the top of this file for why.
 */
export function buildPullDescription(
  existing: string,
  result: ReviewResult,
  diff: string,
  ref?: ReviewLinkRef,
  sections: ReviewSections = ALL_SECTIONS,
  /** Stage 4's traced call path, when the deep review produced one. */
  trace?: CallTrace,
): string {
  const files = parseUnifiedDiff(diff);
  // The blank line before the end marker matters: without it a trailing table
  // runs straight into the HTML comment and some renderers stop parsing it.
  const block = [
    SUMMARY_START,
    DESCRIPTION_TITLE,
    "",
    ...renderNarrative(result, files, ref, sections, false, trace),
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
 * One finding, as it reads on the line at fault.
 *
 * The headline sits inside a GitHub alert whose colour is the severity: a
 * critical finding arrives behind a red border, a note behind a blue one, so the
 * weight of the comment lands before the first word is read. Under it, a row of
 * <kbd> chips carries the provenance without a single emoji.
 */
function renderInlineBody(f: Finding, sections: ReviewSections = ALL_SECTIONS): string {
  const chips = [
    ...(isVerified(f) ? [VERIFIED_BADGE] : []),
    f.severity,
    plain(f.category),
    `confidence ${Math.round(f.confidence * 100)}%`,
  ]
    .map((c) => `<kbd>${c}</kbd>`)
    .join(" ");

  const parts = [
    // How a later run recognises its own inline comments on a platform with no
    // review object to ask. GitHub finds them through the review they belong to
    // and does not need this; GitLab's anchored notes are just notes. Renders as
    // nothing everywhere, so no reader ever sees it.
    INLINE_MARKER,
    `> [!${SEVERITY_ALERT[f.severity]}]`,
    `> **${SEVERITY_MARK[f.severity]} ${plain(f.title)}**`,
    ">",
    `> ${chips}`,
  ];
  const body = plain(f.body).trim();
  if (body !== "") parts.push("", body);

  // The receipt. A reader should not have to take "verified" on faith: show the
  // commands, the exit codes, and what each one proved.
  if (sections.proof && f.verification?.status === "VERIFIED") {
    parts.push("", ...renderProof(f.verification));
  }

  if (f.suggestion && f.suggestion.trim() !== "") {
    // A GitHub ```suggestion block renders as a one-click "Apply" button. It is
    // the one fence that cannot take a language tag, and the button is worth far
    // more than the highlighting.
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
      ? `**${MARK_PROVEN} Execution proof.** The PoC exploit ran against this code in a sealed sandbox:`
      : `**${MARK_PROVEN} Execution proof.** Reproduced in a sealed sandbox:`,
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
 * The review comment.
 *
 * Order is deliberate. The Review Scope & Effort module leads, because it is the
 * one part of the post that shows work no other tool shows: what Cavix traversed,
 * what it proved by execution, and how much human attention is left to spend. The
 * verdict callout follows and colours the outcome. Then the findings.
 *
 * The summary and walkthrough live in the PR description unless the workflow
 * tells us it could not write there, in which case they are folded back in here.
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
  if (sections.reviewEffort) head.push(...renderScope(result, all, files, opts), "", "---", "");

  head.push(...verdict(all, groups.length, opts));
  const provenance = provenanceLine(all, opts);
  if (provenance !== "") head.push("", provenance);

  // The description could not be written (a fork PR, a revoked permission), so
  // the summary and walkthrough degrade into the comment rather than vanishing.
  if (opts.includeSummary) {
    const narrative = renderNarrative(result, files, ref, sections, true, opts.trace);
    if (narrative.length > 0) head.push("", "---", "", ...narrative);
  }

  // Each entry is one whole section, so truncation can drop them atomically.
  const findingSections: string[][] = [];
  const notDiffed = renderDiffLimitations(opts.diffLimitations ?? []);
  if (notDiffed.length > 0) findingSections.push(["", "---", "", ...notDiffed]);
  const gate = renderPreMerge(opts.preMerge, opts.requestChanges === true);
  if (gate.length > 0) findingSections.push(["", "---", "", ...gate]);
  // Before this review's own findings, and before the pre-merge gate would have
  // been a mistake: what is STILL OPEN outranks what is new. A reader scrolling
  // a long review must not have to reach the bottom to learn that the thing
  // holding their merge was raised three pushes ago.
  //
  // `assemble` drops whole sections from the end when the body is too long for
  // the host, so position is also what guarantees these survive truncation.
  const stillOpen = renderCarried(opts.carried ?? [], ref);
  if (stillOpen.length > 0) findingSections.push(["", "---", "", ...stillOpen]);
  const cleared = renderResolved(opts.resolved ?? []);
  if (cleared.length > 0) findingSections.push(["", "---", "", ...cleared]);
  if (groups.length > 0) {
    findingSections.push(["", "---", "", "### Findings", "", ...renderPriority(all, ref)]);
    for (const g of groups) findingSections.push(["", ...renderFileSection(g, offDiff, ref, sections)]);
  }

  const legend = all.length > 0 ? legendLine(offDiff.size, all.length - offDiff.size, all, sections) : "";
  return assemble(head, findingSections, legend, footer(result, all.some(isVerified)));
}

// ── the Review Scope & Effort module ──────────────────────────────────────────

interface ScopeRow {
  mark: string;
  signal: string;
  reading: string;
}

/**
 * The module that opens the review.
 *
 * Everything in it is measured, and every row that has nothing to measure is
 * left out. Note what is NOT here: files changed, lines added, lines removed.
 * GitHub renders all three a few pixels above this comment, so restating them
 * spends the best space on the page saying something the reader already knows.
 * These rows answer the question GitHub cannot: how far did the review reach,
 * and how much of it stands on evidence.
 */
function renderScope(
  result: ReviewResult,
  all: Finding[],
  files: DiffFile[],
  opts: PosterOptions,
): string[] {
  const rows = scopeRows(result, all, files, opts);
  if (rows.length === 0) return [];

  const out: string[] = [];
  if (opts.badges !== false) {
    const strip = badgeStrip(result, all, files, opts);
    if (strip !== "") out.push(strip, "");
  }
  out.push("### ◈ Review Scope & Effort", "");
  out.push("| | Signal | Reading |");
  out.push("| :--: | :--- | :--- |");
  for (const r of rows) out.push(`| ${r.mark} | **${r.signal}** | ${r.reading} |`);
  return out;
}

function scopeRows(
  result: ReviewResult,
  all: Finding[],
  files: DiffFile[],
  opts: PosterOptions,
): ScopeRow[] {
  const rows: ScopeRow[] = [];
  const signals = opts.signals ?? {};

  // 1. Reach. How wide the change is in terms Cavix derived, not line counts.
  const reach = reachReading(files);
  if (reach !== "") rows.push({ mark: MARK_NEUTRAL, signal: "Deep Scan", reading: reach });

  // 2. Which named parts of the codebase the change lands inside. git records the
  // enclosing symbol after each @@ marker, so this is read off the diff itself.
  const symbols = symbolScope(files);
  if (symbols !== "") rows.push({ mark: MARK_NEUTRAL, signal: "Symbol Scope", reading: symbols });

  // 3. Rows that exist only when the stage behind them actually ran.
  if (signals.astSymbols !== undefined && signals.astSymbols > 0) {
    rows.push({
      mark: MARK_PROVEN,
      signal: "AST Verification",
      reading: `${plural(signals.astSymbols, "symbol")} resolved, cross-file impact mapped`,
    });
  }
  if (signals.tools !== undefined && signals.tools > 0) {
    rows.push({
      mark: MARK_PROVEN,
      signal: "Deterministic Pass",
      reading: `${plural(signals.tools, "linter, SAST and secret tool")} run over the change`,
    });
  }
  if (signals.agents !== undefined && signals.agents > 0) {
    rows.push({
      mark: MARK_NEUTRAL,
      signal: "Ensemble",
      reading: `${plural(signals.agents, "specialist agent")} read this diff independently`,
    });
  }
  if (signals.consumers !== undefined && signals.consumers > 0) {
    rows.push({
      mark: MARK_NEUTRAL,
      signal: "Blast Radius",
      reading: `${plural(signals.consumers, "downstream call site")} checked in other repositories`,
    });
  }
  if (signals.ciRuns !== undefined && signals.ciRuns > 0) {
    rows.push({
      mark: MARK_NEUTRAL,
      signal: "CI Telemetry",
      reading: `${plural(signals.ciRuns, "completed pipeline run")} analysed for regression`,
    });
  }

  // 3a2. What earlier reviews of this pull request left open.
  //
  // A measurement like every other row here, and stated in those terms: not
  // "the model stayed quiet", but "the file has not changed since". That is the
  // fact the row stands on, and it is the one a reader needs in order to trust
  // a finding nothing in this review re-raised.
  //
  // No row when nothing is carried, and no row when the ledger could not be
  // read. "Nothing open from earlier reviews" is a claim, and this module does
  // not make claims it did not measure.
  const carried = opts.carried ?? [];
  if (carried.length > 0) {
    rows.push({
      mark: MARK_ATTENTION,
      signal: "Still Open",
      reading:
        `${plural(carried.length, "finding")} from earlier reviews, in ` +
        `${plural(new Set(carried.map((e) => e.path)).size, "file")} unchanged since ${carried.length === 1 ? "it was" : "they were"} raised`,
    });
  }

  // 3b. What Cavix could NOT read. Stated before the security row, because it
  // qualifies everything under it: a clean security gate over a change Cavix
  // only partly saw is a weaker claim than a clean one over all of it.
  const skipped = opts.diffLimitations ?? [];
  if (skipped.length > 0) {
    rows.push({
      mark: MARK_ATTENTION,
      signal: "Diff Coverage",
      reading: `${plural(skipped.length, "file")} could not be diffed exactly and ${skipped.length === 1 ? "was" : "were"} not reviewed`,
    });
  }

  // 4. The security read, always stated, including when it is clean. "No security
  // finding" is information a reviewer wants on the record.
  rows.push(securityRow(all));

  // 5. The proof. This is the row the product is sold on.
  const proof = proofRow(all, opts.suppressedCount ?? 0);
  if (proof) rows.push(proof);

  const policy = policyRow(opts.preMerge);
  if (policy) rows.push(policy);

  const confidence = confidenceRow(all);
  if (confidence) rows.push(confidence);

  rows.push(effortRow(result, files));
  return rows;
}

/** "2 subsystems traversed · 7 changed regions · TypeScript, Markdown". */
function reachReading(files: DiffFile[]): string {
  if (files.length === 0) return "";
  const subsystems = new Set(files.map((f) => subsystem(f.path)));
  const regions = files.reduce((n, f) => n + f.hunks.length, 0);
  const langs = [...new Set(files.map((f) => languageName(f.path)).filter((l) => l !== ""))];

  const parts = [`${plural(subsystems.size, "subsystem")} traversed`];
  if (regions > 0) parts.push(`${plural(regions, "changed region")}`);
  if (langs.length > 0) {
    parts.push(langs.length > 3 ? `${langs.slice(0, 3).join(", ")} and ${langs.length - 3} more` : langs.join(", "));
  }
  return parts.join(" · ");
}

/**
 * The named symbols this change lands inside, read off the hunk headers git
 * writes after each @@ marker. It is the difference between "this PR touches
 * three files" and "this PR reaches into refund() and issueCredit()".
 */
function symbolScope(files: DiffFile[]): string {
  const names: string[] = [];
  for (const f of files) {
    for (const h of f.hunks) {
      const s = symbolFrom(h.header);
      if (s !== "" && !names.includes(s)) names.push(s);
    }
  }
  if (names.length === 0) return "";
  const shown = names.slice(0, 4).map((n) => `\`${n}\``).join(", ");
  return names.length > 4 ? `${shown} and ${names.length - 4} more` : shown;
}

/**
 * Pull a symbol name out of a git hunk header. git's own funcname heuristic put
 * it there, so this only has to recognise the common shapes; anything it cannot
 * read is skipped rather than guessed at.
 */
function symbolFrom(header: string): string {
  const h = plain(header).trim();
  if (h === "") return "";
  if (h.startsWith("#")) return h.replace(/^#+\s*/, "").slice(0, 40); // markdown heading
  const declared =
    /(?:function|func|class|struct|interface|type|def|fn|impl|trait|module|namespace|enum)\s+([A-Za-z_$][\w$]*)/.exec(h);
  if (declared) return declared[1];
  const called = /([A-Za-z_$][\w$]*)\s*\(/.exec(h);
  if (called) return called[1];
  const bare = /([A-Za-z_$][\w$]{2,})/.exec(h);
  return bare ? bare[1] : "";
}

function securityRow(all: Finding[]): ScopeRow {
  const sec = all.filter(
    (f) => /security|secret|vuln|injection|auth/i.test(f.category) || f.source === "secret" || f.source === "sast",
  );
  if (sec.length === 0) {
    return { mark: MARK_PROVEN, signal: "Security Gate", reading: "Clear, nothing raised on the changed lines" };
  }
  const worst = worstOf(sec);
  const serious = SEVERITY_RANK[worst] >= SEVERITY_RANK.high;
  return {
    mark: serious ? MARK_ATTENTION : MARK_NEUTRAL,
    signal: "Security Gate",
    reading: serious
      ? `${SEVERITY_MARK[worst]} ${plural(sec.length, "exposure")}, highest **${worst}**`
      : `${plural(sec.length, "security finding")}, highest ${worst}`,
  };
}

function proofRow(all: Finding[], suppressed: number): ScopeRow | null {
  const verified = all.filter(isVerified).length;
  if (verified > 0) {
    // Wording that reads the same on the review comment and on the check row:
    // neither says "below", because on the check there is nothing below it.
    const extra =
      suppressed > 0 ? `, ${plural(suppressed, "other")} discarded as unreproducible` : "";
    const scope =
      verified === all.length
        ? "Every posted finding was reproduced in a sealed sandbox"
        : `${verified} of ${plural(all.length, "finding")} reproduced in a sealed sandbox`;
    return { mark: MARK_PROVEN, signal: "Execution Proof", reading: `${scope}${extra}` };
  }
  if (suppressed > 0) {
    return {
      mark: MARK_NEUTRAL,
      signal: "Execution Proof",
      reading: `${plural(suppressed, "finding")} discarded, the sandbox could not reproduce ${suppressed === 1 ? "it" : "them"}`,
    };
  }
  // Nothing was proven and nothing was disproven. Say nothing rather than
  // dressing an absent measurement up as a result.
  return null;
}

function policyRow(pm: PreMergeResult | undefined): ScopeRow | null {
  if (!pm || pm.checks.length === 0) return null;
  const total = pm.checks.length;
  if (pm.failed > 0) {
    return {
      mark: MARK_ATTENTION,
      signal: "Policy Gate",
      reading: `${pm.failed} of ${plural(total, "org rule")} failing`,
    };
  }
  if (pm.passed === 0) {
    return {
      mark: MARK_ATTENTION,
      signal: "Policy Gate",
      reading: "No rule compiled into a check, nothing was verified",
    };
  }
  const skipped = pm.skipped > 0 ? `, ${pm.skipped} skipped` : "";
  return {
    mark: MARK_PROVEN,
    signal: "Policy Gate",
    reading: `${pm.passed} of ${plural(total, "org rule")} passed${skipped}`,
  };
}

function confidenceRow(all: Finding[]): ScopeRow | null {
  if (all.length === 0) return null;
  const mean = all.reduce((n, f) => n + f.confidence, 0) / all.length;
  const pct = Math.round(mean * 100);
  return {
    mark: MARK_NEUTRAL,
    signal: "Confidence Score",
    reading: `${meter(Math.round(mean * 5), 5, "●", "○")} ${pct}% mean across the findings raised`,
  };
}

/** Effort labels, in the words a reviewer would use to plan their afternoon. */
const EFFORT_LABEL = ["", "a glance", "a light read", "a focused read", "a careful read", "a deep review"];

function effortRow(result: ReviewResult, files: DiffFile[]): ScopeRow {
  const effort = effortOf(result, files);
  return {
    mark: effort >= 4 ? MARK_ATTENTION : MARK_NEUTRAL,
    signal: "Review Effort",
    reading: `${meter(effort, 5, "◆", "◇")} **${effort} of 5**, ${EFFORT_LABEL[effort]}`,
  };
}

/**
 * The model's own 1 to 5 read where it gave one, a size-derived estimate where it
 * did not. Clamped, because `effort` may come from any producer of a ReviewResult
 * and a value outside 1..5 would make repeat() throw on a negative count.
 */
function effortOf(result: ReviewResult, files: DiffFile[]): number {
  const totals = diffTotals(files);
  const raw = result.effort ?? estimateEffort(files.length, totals.added + totals.removed);
  return Math.min(5, Math.max(1, Math.round(raw)));
}

/** "●●●●○": a filled-to-hollow meter, n of max. */
function meter(n: number, max: number, on: string, off: string): string {
  const filled = Math.min(max, Math.max(0, n));
  return on.repeat(filled) + off.repeat(max - filled);
}

// ── the badge strip ───────────────────────────────────────────────────────────

/**
 * Four or five shields.io badges above the Scope table: the same facts, in
 * colour, in the first thing a reader's eye lands on.
 *
 * Bounded on purpose. A badge is an HTTP request through GitHub's image proxy,
 * so they belong to the header and nowhere else: one per finding would make a
 * hundred-finding review load like a web page from 2008. Everything here is also
 * in the table below in plain text, so an air-gapped deployment that turns the
 * strip off (PosterOptions.badges) loses colour and loses nothing else.
 */
function badgeStrip(
  result: ReviewResult,
  all: Finding[],
  files: DiffFile[],
  opts: PosterOptions,
): string {
  const out: string[] = [];

  const sec = all.filter(
    (f) => /security|secret|vuln|injection|auth/i.test(f.category) || f.source === "secret" || f.source === "sast",
  );
  out.push(
    sec.length === 0
      ? badge("Security", "clear", HEX_PROVEN)
      : badge("Security", `${sec.length} ${worstOf(sec)}`, SEVERITY_HEX[worstOf(sec)]),
  );

  const verified = all.filter(isVerified).length;
  const suppressed = opts.suppressedCount ?? 0;
  if (verified > 0) out.push(badge("Execution Proof", `${verified} verified`, HEX_PROVEN));
  else if (suppressed > 0) out.push(badge("Execution Proof", `${suppressed} discarded`, HEX_NEUTRAL));

  if (opts.preMerge && opts.preMerge.checks.length > 0) {
    const pm = opts.preMerge;
    out.push(
      pm.failed > 0
        ? badge("Policy Gate", `${pm.failed} failing`, SEVERITY_HEX.critical)
        : badge("Policy Gate", `${pm.passed} of ${pm.checks.length} passed`, HEX_PROVEN),
    );
  }

  if (all.length > 0) {
    const pct = Math.round((all.reduce((n, f) => n + f.confidence, 0) / all.length) * 100);
    out.push(badge("Confidence", `${pct}%`, pct >= 85 ? HEX_PROVEN : pct >= 65 ? SEVERITY_HEX.medium : HEX_NEUTRAL));
  }

  out.push(badge("Review Effort", `${effortOf(result, files)} of 5`, HEX_NEUTRAL));
  return out.join(" ");
}

function badge(label: string, message: string, hex: string): string {
  const url =
    `https://img.shields.io/badge/${badgeSegment(label)}-${badgeSegment(message)}-${hex}` +
    `?style=flat-square&labelColor=${HEX_LABEL}`;
  // The alt text is the air-gap fallback: when the proxy cannot fetch the image,
  // GitHub renders this string, and it has to still read as a fact.
  return `![${plain(label)}: ${plain(message)}](${url})`;
}

/**
 * shields.io path encoding: a literal dash doubles, a literal underscore doubles,
 * and a space becomes an underscore. Get this wrong and the badge silently loses
 * half its text.
 */
function badgeSegment(s: string): string {
  return encodeURIComponent(s.replace(/-/g, "--").replace(/_/g, "__")).replace(/%20/g, "_");
}

// ── the verdict, the priority callout, the gate ───────────────────────────────

/**
 * The verdict, as a GitHub alert callout: colour first, counts second.
 *
 * TIP (green) for a clean review, CAUTION (red) when the owner's gate is
 * blocking the merge, WARNING (amber) when something at high or above was found,
 * NOTE (blue) for the rest. A reader knows the outcome before reading a word.
 */
function verdict(all: Finding[], fileCount: number, opts: PosterOptions = {}): string[] {
  const carried = opts.carried ?? [];

  if (all.length === 0) {
    // "Clean pass" is a claim about the pull request, not about this run, and it
    // is the sentence a reader acts on. Making it while findings from earlier
    // reviews are still open is the single most misleading thing this file can
    // print, and it is what happened every time somebody fixed one of three
    // findings and pushed.
    if (carried.length > 0) {
      const isAre = carried.length === 1 ? "is" : "are";
      return [
        SEVERITY_RANK[worstOfEntries(carried)] >= SEVERITY_RANK.high ? "> [!WARNING]" : "> [!NOTE]",
        `> **Nothing new on this push.** ${plural(carried.length, "finding")} from earlier ` +
          `reviews of this pull request ${isAre} still open, listed below.`,
      ];
    }
    if (opts.ledgerKnown === false) {
      // Cavix could not read what earlier reviews left open, so it cannot say
      // the pull request is clean. It can only say what it did on this push.
      return [
        "> [!NOTE]",
        "> **Nothing to raise on the changed lines in this review.** Cavix could not reach its " +
          "record of earlier reviews on this pull request, so this is not a statement about " +
          "findings raised before now.",
      ];
    }
    return ["> [!TIP]", "> **Clean pass.** Nothing to raise on the changed lines."];
  }

  const counts = countBySeverity(all);
  const worst = SEVERITY_ORDER.find((s) => counts[s] > 0) ?? "info";
  const kind = opts.requestChanges
    ? "CAUTION"
    : SEVERITY_RANK[worst] >= SEVERITY_RANK.high
      ? "WARNING"
      : "NOTE";

  const tally = SEVERITY_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${SEVERITY_MARK[s]} ${counts[s]} ${s}`)
    .join(" · ");

  const out = [
    `> [!${kind}]`,
    `> **${plural(all.length, "finding")}** across **${plural(fileCount, "file")}**`,
    ">",
    `> ${tally}`,
  ];
  // Named in the headline callout, not left for the reader to find further down.
  // Someone deciding whether to merge reads this box and stops, so the count it
  // shows has to be the count the check run gated on.
  if (carried.length > 0) {
    out.push(">", `> plus ${plural(carried.length, "finding")} still open from earlier reviews`);
  }
  if (opts.requestChanges) {
    out.push(">", `> **Changes requested: ${blockingReason(opts)}.**`);
    out.push(
      ">",
      "> <sub>This workspace has pre-merge blocking switched on. An owner can change that under **Review settings**.</sub>",
    );
  } else if (opts.blockUnavailable) {
    // The owner turned blocking on and this host has no way to honour it. Say so
    // where they will read it, and name the thing that CAN gate a merge here, so
    // the sentence is useful rather than only apologetic.
    out.push(">", `> **${blockingReason(opts)}, and this workspace asked Cavix to block on that.**`);
    out.push(
      ">",
      `> <sub>${PLATFORM_LABEL[opts.platform ?? "github"]} has no review a bot can hold a merge with, so this is posted as an ordinary comment and nothing is gated. The \`${CHECK_NAME}\` status on the commit reports the same outcome and CAN be made required.</sub>`,
    );
  }
  return out;
}

/**
 * A severity off a stored ledger entry, or the quietest one.
 *
 * Entries are restored from a payload rather than produced in this process, so
 * the severity is a plain string. An unrecognised value must land on "info" and
 * never on undefined: `SEVERITY_RANK[undefined]` is NaN, every comparison
 * against it is false, and a carried critical would quietly render as a note.
 */
function entrySeverity(e: LedgerEntry): Severity {
  const s = e.severity;
  return s === "critical" || s === "high" || s === "medium" || s === "low" || s === "info" ? s : "info";
}

/** The worst severity among carried entries, for colouring the callout. */
function worstOfEntries(entries: LedgerEntry[]): Severity {
  return entries
    .map(entrySeverity)
    .reduce((worst, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[worst] ? s : worst), "info" as Severity);
}

/**
 * The findings earlier reviews raised that are still open.
 *
 * Rendered as a list and never as inline comments, on purpose. Their line
 * numbers belong to the head they were raised against; anchoring them to the
 * current one would put a comment on whatever code has since moved into that
 * position, which is worse than not anchoring it at all.
 *
 * Every row states something measured: which review raised it, how many reviews
 * have raised it since, and the fact the file has not changed since. That last
 * one is the answer to the question the reader is about to ask, which is "why is
 * this still here when the model did not mention it".
 */
function renderCarried(carried: LedgerEntry[], ref?: ReviewLinkRef): string[] {
  if (carried.length === 0) return [];

  const sorted = [...carried].sort(
    (a, b) => SEVERITY_RANK[entrySeverity(b)] - SEVERITY_RANK[entrySeverity(a)] || a.path.localeCompare(b.path),
  );
  const out = [
    "### ▲ Still open from earlier reviews",
    "",
    "These were raised on this pull request and have not been dealt with. Cavix did not raise " +
      "them again in this review, and it checked why: **the files they point at have not changed " +
      "since.** They count towards the result above.",
    "",
    "| | Finding | Where | Raised |",
    "| :--: | :--- | :--- | :--- |",
  ];
  for (const e of sorted.slice(0, MAX_CARRIED_ROWS)) {
    const where = fileLink(e.path, ref) + (e.line > 0 ? ` line ${e.line}` : "");
    const raised = e.timesReported > 1 ? `${e.timesReported} reviews ago` : "an earlier review";
    out.push(`| ${SEVERITY_MARK[entrySeverity(e)]} | ${cell(e.title)} | ${where} | ${raised} |`);
  }
  if (sorted.length > MAX_CARRIED_ROWS) {
    out.push("", `<sub>and ${sorted.length - MAX_CARRIED_ROWS} more still open.</sub>`);
  }
  out.push(
    "",
    "<sub>Fix one and push, and it clears itself on the next review. Disagree with one? " +
      "`@cavixcode resolve` closes them all, and the dashboard can dismiss them one at a time.</sub>",
  );
  return out;
}

/**
 * What this review CLEARED.
 *
 * As important as the list above and easy to leave out. Someone who pushed a fix
 * and sees only what is still open cannot tell whether Cavix noticed, and a
 * reviewer who appears not to notice fixes is one people stop reading.
 */
function renderResolved(resolved: LedgerEntry[]): string[] {
  const fixed = resolved.filter((e) => e.resolution === "fixed");
  if (fixed.length === 0) return [];
  const out = [`### ✓ Cleared by this push`, ""];
  for (const e of fixed.slice(0, MAX_CARRIED_ROWS)) {
    out.push(`- ${cell(e.title)} <sub>${plain(e.path)}</sub>`);
  }
  if (fixed.length > MAX_CARRIED_ROWS) {
    out.push("", `<sub>and ${fixed.length - MAX_CARRIED_ROWS} more.</sub>`);
  }
  return out;
}

/** Carried rows rendered before the list is summarised. */
const MAX_CARRIED_ROWS = 15;

/** How each host is named in prose. */
const PLATFORM_LABEL: Record<PlatformName, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  "bitbucket-server": "Bitbucket Data Center",
  "azure-devops": "Azure DevOps",
};

/**
 * The must-fix list, in a callout coloured by the worst thing in it.
 *
 * A reviewer opening a PR with thirty findings needs to know which two matter
 * before they start scrolling. Only critical and high qualify, capped, because a
 * priority list that names everything prioritises nothing.
 */
function renderPriority(all: Finding[], ref?: ReviewLinkRef): string[] {
  const urgent = all.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.high);
  if (urgent.length === 0) return [];

  const kind = urgent.some((f) => f.severity === "critical") ? "CAUTION" : "WARNING";
  const out = [`> [!${kind}]`, "> **Fix these first**", ">"];
  for (const f of urgent.slice(0, MAX_PRIORITY_ROWS)) {
    out.push(`> ${SEVERITY_MARK[f.severity]} **${cell(f.title)}** · ${locationLink(f, ref)}`);
  }
  if (urgent.length > MAX_PRIORITY_ROWS) {
    out.push(">", `> <sub>and ${urgent.length - MAX_PRIORITY_ROWS} more at high or above, listed below.</sub>`);
  }
  return out;
}

/**
 * Why the merge is blocked, in a few words. Someone who is blocked should never
 * have to scroll to find out by what.
 */
function blockingReason(opts: PosterOptions): string {
  const failed = opts.preMerge?.failed ?? 0;
  if (failed > 0) return `${plural(failed, "pre-merge check")} failed`;
  // Which findings are holding it. Someone who just pushed a fix and sees
  // "a finding was posted" will go looking through THIS review for it, and on
  // the run where the block comes entirely from earlier ones there is nothing
  // there to find. Naming the source is the difference between a gate a person
  // can act on and one that looks broken.
  const carried = (opts.carried ?? []).filter(
    (e) => SEVERITY_RANK[entrySeverity(e)] >= SEVERITY_RANK.high,
  ).length;
  const fresh = opts.blockingFindings ?? 0;
  if (carried > 0 && fresh === 0) {
    return `${plural(carried, "finding")} from earlier reviews ${carried === 1 ? "is" : "are"} still open`;
  }
  if (carried > 0) return "findings from this and earlier reviews are open";
  return "a finding at or above your blocking severity was posted";
}

/** At most this many skipped files are named before the list is summarised. */
const MAX_LIMITATION_ROWS = 12;

/**
 * The files Cavix did not review, and why, in a reader's words.
 *
 * This section exists because of Azure DevOps, which returns a list of changed
 * PATHS and no content, so the diff is computed locally and a file can be too
 * large, too rewritten, or binary. Those files are left out of the review, and
 * the one thing that must not happen is leaving them out quietly: a reviewer who
 * believes Cavix read the whole change has been told something untrue, and it is
 * the same failure as printing a number nothing measured.
 */
function renderDiffLimitations(limits: DiffLimitation[]): string[] {
  if (limits.length === 0) return [];
  const out = [
    "### Not Reviewed",
    "",
    `${plural(limits.length, "file")} in this pull request could not be diffed exactly, so ${limits.length === 1 ? "it was" : "they were"} left out of the review below. Nothing here is a finding; it is what Cavix did not look at.`,
    "",
    "| File | Why |",
    "| :--- | :--- |",
  ];
  for (const l of limits.slice(0, MAX_LIMITATION_ROWS)) {
    out.push(`| \`${cell(l.path)}\` | ${cell(l.reason)} |`);
  }
  if (limits.length > MAX_LIMITATION_ROWS) {
    out.push(`| <sub>and ${limits.length - MAX_LIMITATION_ROWS} more</sub> | |`);
  }
  return out;
}

/**
 * The pre-merge gate, rule by rule, in the owner's own words.
 *
 * A rule that could not be compiled is shown as skipped, never as a pass: the
 * whole value of a gate is that a green tick means the check actually ran.
 */
function renderPreMerge(pm: PreMergeResult | undefined, blocking: boolean): string[] {
  if (!pm || pm.checks.length === 0) return [];

  const out: string[] = ["### Pre-merge Checks", ""];
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
    out.push(`| ${CHECK_MARK[c.status]} | ${cell(c.rule)} | ${cell(c.detail)} |`);
  }
  out.push("");
  out.push(
    `<sub>Your org's rules, compiled into deterministic checks. No model gets a vote on whether they passed. ` +
      `${blocking ? "A failure blocks merge" : "Reporting only, blocking is off"} · edit under **Review settings**.</sub>`,
  );
  return out;
}

/**
 * What this change does, and nothing about what is wrong with it: the executive
 * summary, then one bullet per changed file.
 *
 * This is the whole of the PR description block. It carries no verdict, no
 * severity marks and no finding counts, because everything in here has to still
 * be true after the author fixes the findings, and a count does not survive that.
 *
 * The same two sections are folded into the review comment when the description
 * could not be written (a fork PR, a revoked permission), so a reader never has
 * to learn two layouts for the same content.
 */
function renderNarrative(
  result: ReviewResult,
  files: DiffFile[],
  ref?: ReviewLinkRef,
  sections: ReviewSections = ALL_SECTIONS,
  /**
   * Put a "Summary" heading over the paragraph. The review comment needs it,
   * because the summary is one section among several under the review's own H2.
   * The description does not: the block's H2 already says Cavix Summary, and
   * stacking a second heading that says the same word is noise.
   */
  summaryHeading = true,
  /**
   * Stage 4's traced call path, when the deep review produced one.
   *
   * It belongs in the narrative, next to the walkthrough, and not with the
   * findings: what a change DOES is durable and is still true after the author
   * fixes everything Cavix raised, which is the rule the description block is
   * built on. It also means the diagram falls back into the review comment on a
   * fork PR by exactly the same path as the summary, with no second code path.
   */
  trace?: CallTrace,
): string[] {
  const out: string[] = [];
  if (sections.summary) {
    if (summaryHeading) out.push("### Summary", "");
    out.push(plain(result.summary).trim() || "_The model returned no summary for this change._");
  }
  if (sections.changedFiles) {
    const changes = renderWalkthrough(files, result.walkthrough ?? [], ref);
    if (changes.length > 0) {
      if (out.length > 0) out.push("", "---", "");
      out.push(...changes);
    }
  }
  if (sections.sequenceDiagram) {
    // Renders nothing at all when the graph had nothing to draw, which is the
    // usual case: most pull requests change one file, and a sequence diagram of
    // one file is a list. An empty section reads as a broken feature; an absent
    // one reads as "not relevant here", which is what is true.
    const diagram = renderSequenceDiagram(trace);
    if (diagram.length > 0) {
      if (out.length > 0) out.push("", "---", "");
      out.push(...diagram);
    }
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
  if (verified > 0) parts.push(`${MARK_PROVEN} ${verified} reproduced in a sandbox`);
  if (opts.suppressedCount && opts.suppressedCount > 0) {
    parts.push(
      `${MARK_NEUTRAL} ${plural(opts.suppressedCount, "finding")} suppressed after the sandbox could not reproduce ${opts.suppressedCount === 1 ? "it" : "them"}`,
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
    groups.push({ path, findings: sorted, worst: worstOf(sorted) });
  }
  groups.sort(
    (a, b) =>
      SEVERITY_RANK[b.worst] - SEVERITY_RANK[a.worst] ||
      b.findings.length - a.findings.length ||
      a.path.localeCompare(b.path),
  );
  return groups;
}

function worstOf(findings: Finding[]): Severity {
  let worst: Severity = "info";
  for (const f of findings) if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
  return worst;
}

/**
 * One file: a heading naming it, then a row per finding. Each row is the mark,
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
  out.push(`#### ${SEVERITY_MARK[g.worst]} ${fileLink(g.path, ref)} · ${plural(g.findings.length, "finding")}`);
  out.push("");
  out.push("| | Line | Finding | Detail |");
  out.push("| :--: | ---: | :--- | :--- |");
  for (const f of g.findings) {
    const title = `**${cell(f.title)}**${isVerified(f) ? ` ${MARK_PROVEN}` : ""}`;
    const meta = `${f.severity} · ${cell(f.category)} · confidence ${Math.round(f.confidence * 100)}%`;
    out.push(
      `| ${SEVERITY_MARK[f.severity]} | ${lineLink(f, ref)} | ${title}<br><sub>${meta}</sub> | ${
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
    out.push(`<details><summary>${DETAIL_BELOW} <b>${label}</b></summary>`);
    out.push("");
    notes.forEach((f, i) => {
      if (i > 0) out.push("", "---", "");
      // Same colour language as an inline comment: the callout carries the
      // severity so the dropdown does not flatten into undifferentiated text.
      out.push(`> [!${SEVERITY_ALERT[f.severity]}]`);
      out.push(`> **${SEVERITY_MARK[f.severity]} ${plain(f.title)}**`);
      out.push(">");
      out.push(
        `> <kbd>${f.severity}</kbd> <kbd>${cell(f.category)}</kbd> <kbd>confidence ${Math.round(f.confidence * 100)}%</kbd>`,
      );
      out.push("");
      out.push(`<sub>\`${f.path}\` ${lineLabel(f)}</sub>`);
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
        // No one-click Apply button off the diff, so this fence gets a real
        // language and the syntax highlighting that comes with it.
        out.push("");
        out.push("**Suggested fix**");
        out.push("");
        out.push("```" + fenceLang(f.path));
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
 * The walkthrough: every changed file and what it now does, as bullets.
 *
 * Bullets rather than a table, and intent rather than mechanics. The rows come
 * from the DIFF and the descriptions from the model, joined on path. Doing it
 * that way (rather than rendering the model's list directly) means a file is
 * never missing from the map because the model forgot it: it just shows up with
 * a description derived from the diff instead.
 *
 * Deliberately no lines-added column and no per-file finding count. GitHub
 * prints the first above, and the second stops being true as soon as somebody
 * pushes a fix, which is the one thing a description must never do.
 */
function renderWalkthrough(files: DiffFile[], walkthrough: FileChange[], ref?: ReviewLinkRef): string[] {
  if (files.length === 0) return [];
  const described = new Map(walkthrough.map((w) => [w.path, w.summary]));

  const out: string[] = ["### What Changed", ""];
  for (const f of files.slice(0, MAX_FILE_ROWS)) {
    const what = f.deleted ? "File removed" : cell(described.get(f.path) ?? describeFromDiff(f));
    out.push(`- ${fileLink(f.path, f.deleted ? undefined : ref)} · ${what}`);
  }
  if (files.length > MAX_FILE_ROWS) {
    out.push(`- <sub>and ${files.length - MAX_FILE_ROWS} more files in this change</sub>`);
  }
  return out;
}

/**
 * Fallback description when the model gave none for a file. git puts the
 * enclosing function (or section) after the @@ marker, so the hunk headers are a
 * genuine, if terse, answer to "what part of this file changed?".
 */
function describeFromDiff(f: DiffFile): string {
  if (f.deleted) return "File removed";
  const contexts = [...new Set(f.hunks.map((h) => h.header.trim()).filter((h) => h !== ""))];
  if (contexts.length === 0) return "_Not described by the model._";
  const shown = contexts.slice(0, 2).map((c) => `\`${c}\``).join(", ");
  return contexts.length > 2 ? `In ${shown} and ${contexts.length - 2} more` : `In ${shown}`;
}

interface DiffTotals {
  added: number;
  removed: number;
}

/**
 * Added and removed line counts. Used ONLY to estimate review effort when the
 * model did not supply one. Nothing here is ever printed: GitHub already shows
 * these numbers, and the whole point of the Scope module is to say something it
 * does not.
 */
function diffTotals(files: DiffFile[]): DiffTotals {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.kind === "add") added++;
        else if (l.kind === "del") removed++;
      }
    }
  }
  return { added, removed };
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
  return `[${label}](${url}${lineFragment(f, ref?.platform)})`;
}

/** "`src/auth.js` line 12", linked when we know where the file lives. */
function locationLink(f: Finding, ref?: ReviewLinkRef): string {
  const label = `\`${f.path}\` ${lineLabel(f)}`;
  const url = blobUrl(f.path, ref);
  return url ? `[${label}](${url}${lineFragment(f, ref?.platform)})` : label;
}

/**
 * The line anchor for a permalink, in the host's own syntax.
 *
 * Four hosts, four grammars, and a wrong one is silently harmless-looking: the
 * page still loads, it just does not scroll to the line the reviewer was sent
 * to, which is the entire reason the link exists.
 */
function lineFragment(f: Finding, platform: PlatformName = "github"): string {
  const end = f.endLine !== undefined && f.endLine > f.line ? f.endLine : undefined;
  switch (platform) {
    case "gitlab":
      return end ? `#L${f.line}-${end}` : `#L${f.line}`;
    case "bitbucket":
      return end ? `#lines-${f.line}:${end}` : `#lines-${f.line}`;
    case "azure-devops":
      // Azure carries the line in the query string, which `blobUrl` has already
      // opened, so this is appended rather than being a fragment.
      return end ? `&line=${f.line}&lineEnd=${end}&lineStartColumn=1&lineEndColumn=1` : `&line=${f.line}`;
    default:
      return end ? `#L${f.line}-L${end}` : `#L${f.line}`;
  }
}

function fileLink(path: string, ref?: ReviewLinkRef): string {
  const url = blobUrl(path, ref);
  return url ? `[\`${path}\`](${url})` : `\`${path}\``;
}

/**
 * A permalink to the file at the head commit, on the host the review is going
 * to. Pinned to the SHA rather than the branch so the link keeps pointing at the
 * code that was reviewed, even after the PR moves on or merges.
 *
 * Returns "" when there is not enough to build one, and every caller renders the
 * path as plain text in that case. That is deliberate: a review that names a
 * file without linking it is complete, and a review that links it to the wrong
 * repository is worse than one that does not link it at all.
 */
function blobUrl(path: string, ref?: ReviewLinkRef): string {
  if (!ref || !ref.owner || !ref.repo || !ref.headSha) return "";
  const host = (ref.host ?? "https://github.com").replace(/\/+$/, "");
  if (host === "") return "";
  const repo = `${host}/${ref.owner}/${ref.repo}`;
  const file = encodeURI(path);
  switch (ref.platform ?? "github") {
    case "gitlab":
      return `${repo}/-/blob/${ref.headSha}/${file}`;
    case "bitbucket":
      return `${repo}/src/${ref.headSha}/${file}`;
    case "azure-devops":
      // `owner` is "organization/project" and the repository hangs off _git.
      // GC is Azure's prefix for "this version string is a commit", as against
      // GB for a branch: without it the link resolves against a branch name that
      // does not exist and the page opens empty.
      return `${host}/${ref.owner}/_git/${ref.repo}?path=/${file}&version=GC${ref.headSha}`;
    default:
      return `${repo}/blob/${ref.headSha}/${file}`;
  }
}

/**
 * Which part of the system a path belongs to. Two segments in a monorepo
 * (`services/orchestrator`), one otherwise, because in a monorepo every path
 * starts with `services/` and a count of one subsystem would say nothing.
 */
function subsystem(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return "(repository root)";
  if (parts.length === 2) return parts[0];
  return `${parts[0]}/${parts[1]}`;
}

/**
 * Extension to (fence language, display name). The fence drives GitHub's syntax
 * highlighting on a suggested fix; the name is what the Scope module calls the
 * language out loud.
 */
const LANGUAGES: Record<string, [fence: string, name: string]> = {
  ts: ["ts", "TypeScript"],
  tsx: ["tsx", "TypeScript"],
  mts: ["ts", "TypeScript"],
  cts: ["ts", "TypeScript"],
  js: ["js", "JavaScript"],
  jsx: ["jsx", "JavaScript"],
  mjs: ["js", "JavaScript"],
  cjs: ["js", "JavaScript"],
  go: ["go", "Go"],
  py: ["python", "Python"],
  rb: ["ruby", "Ruby"],
  java: ["java", "Java"],
  kt: ["kotlin", "Kotlin"],
  rs: ["rust", "Rust"],
  c: ["c", "C"],
  h: ["c", "C"],
  cc: ["cpp", "C++"],
  cpp: ["cpp", "C++"],
  hpp: ["cpp", "C++"],
  cs: ["csharp", "C#"],
  php: ["php", "PHP"],
  swift: ["swift", "Swift"],
  scala: ["scala", "Scala"],
  ex: ["elixir", "Elixir"],
  exs: ["elixir", "Elixir"],
  dart: ["dart", "Dart"],
  lua: ["lua", "Lua"],
  sh: ["bash", "Shell"],
  bash: ["bash", "Shell"],
  zsh: ["bash", "Shell"],
  ps1: ["powershell", "PowerShell"],
  sql: ["sql", "SQL"],
  yaml: ["yaml", "YAML"],
  yml: ["yaml", "YAML"],
  json: ["json", "JSON"],
  toml: ["toml", "TOML"],
  tf: ["hcl", "Terraform"],
  proto: ["protobuf", "Protobuf"],
  graphql: ["graphql", "GraphQL"],
  html: ["html", "HTML"],
  css: ["css", "CSS"],
  scss: ["scss", "SCSS"],
  vue: ["vue", "Vue"],
  svelte: ["svelte", "Svelte"],
  md: ["markdown", "Markdown"],
};

function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  if (/^dockerfile$/i.test(base)) return "dockerfile";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** The fence tag for a suggested fix in this file, or "" for an unknown type. */
function fenceLang(path: string): string {
  if (extensionOf(path) === "dockerfile") return "dockerfile";
  return LANGUAGES[extensionOf(path)]?.[0] ?? "";
}

/** The language's display name, or "" when we do not recognise the extension. */
function languageName(path: string): string {
  if (extensionOf(path) === "dockerfile") return "Dockerfile";
  return LANGUAGES[extensionOf(path)]?.[1] ?? "";
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
