import {
  parseUnifiedDiff,
  commentableLines,
  SEVERITY_RANK,
  type Finding,
  type ReviewResult,
  type Severity,
} from "@cavix/core";
import type { InlineComment, ReviewSubmission } from "../github/client.ts";

// The poster turns a ReviewResult into a GitHub ReviewSubmission. Two jobs:
//   1. Anchor each finding to a line that is actually in the diff. Findings on
//      added lines become inline comments; any finding off the diff is folded
//      into the summary instead of being dropped (we never silently lose one).
//   2. Render a readable summary with severity counts.
//
// Phase 0 always posts as event=COMMENT — Cavix does not block merges here. The
// optional, off-by-default policy gate (Stage 3/9) is the only thing that will
// ever escalate to REQUEST_CHANGES, and only when an org enables it.

const SEVERITY_BADGE: Record<Severity, string> = {
  critical: "🟥 critical",
  high: "🟧 high",
  medium: "🟨 medium",
  low: "🟦 low",
  info: "⬜ info",
};

export interface BuiltReview {
  submission: ReviewSubmission;
  inlineCount: number;
  offDiffCount: number;
}

export function buildReviewSubmission(result: ReviewResult, diff: string): BuiltReview {
  const files = parseUnifiedDiff(diff);
  const anchors = commentableLines(files);

  const inline: InlineComment[] = [];
  const offDiff: Finding[] = [];

  // Highest severity first so the most important comments lead.
  const ordered = [...result.findings].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );

  for (const f of ordered) {
    const lines = anchors.get(f.path);
    if (lines && lines.has(f.line)) {
      inline.push({ path: f.path, line: f.line, body: renderInlineBody(f) });
    } else {
      offDiff.push(f);
    }
  }

  const body = renderSummary(result, ordered, offDiff);
  return {
    submission: { body, event: "COMMENT", comments: inline },
    inlineCount: inline.length,
    offDiffCount: offDiff.length,
  };
}

function renderInlineBody(f: Finding): string {
  const parts = [`**${SEVERITY_BADGE[f.severity]} · ${f.category}** — ${f.title}`, "", f.body];
  if (f.suggestion && f.suggestion.trim() !== "") {
    // A GitHub ```suggestion block renders as a one-click "Apply" button.
    parts.push("", "```suggestion", f.suggestion.replace(/\n+$/, ""), "```");
  }
  parts.push("", `<sub>confidence ${Math.round(f.confidence * 100)}%</sub>`);
  return parts.join("\n");
}

function renderSummary(result: ReviewResult, all: Finding[], offDiff: Finding[]): string {
  const counts = countBySeverity(all);
  const countLine = (["critical", "high", "medium", "low", "info"] as Severity[])
    .filter((s) => counts[s] > 0)
    .map((s) => `${SEVERITY_BADGE[s]}: ${counts[s]}`)
    .join(" · ");

  const lines: string[] = [];
  lines.push("## 🔬 Cavix review");
  lines.push("");
  lines.push(result.summary || "_No summary provided._");
  lines.push("");
  if (all.length === 0) {
    lines.push("No issues found in the changed lines.");
  } else {
    lines.push(`**${all.length} finding${all.length === 1 ? "" : "s"}** — ${countLine}`);
  }

  if (offDiff.length > 0) {
    lines.push("");
    lines.push("<details><summary>Notes outside the diff</summary>");
    lines.push("");
    for (const f of offDiff) {
      lines.push(`- **${SEVERITY_BADGE[f.severity]}** \`${f.path}:${f.line}\` — ${f.title}`);
    }
    lines.push("");
    lines.push("</details>");
  }

  lines.push("");
  lines.push(
    `<sub>Cavix Phase 0 · single-pass review · ${result.model} · $${result.costUsd.toFixed(4)}. ` +
      `Execution-grounded verification (reproduce → fix → test) lands in a later stage.</sub>`,
  );
  return lines.join("\n");
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}
