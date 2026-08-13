// A small, dependency-free unified-diff parser. Two consumers need it:
//   - the orchestrator, to know which (path,line) pairs are valid inline-comment
//     targets (GitHub only accepts comments on lines that appear in the diff);
//   - the eval harness, to map gold-labeled issues onto diff lines for scoring.
//
// It tracks the NEW-file line number for every added/context line, which is the
// coordinate GitHub uses for review comments on the head commit.

export type DiffLineKind = "add" | "del" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  content: string;
  /** New-file line number for "add" and "context" lines; undefined for "del". */
  newLineNo?: number;
}

export interface DiffHunk {
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Path in the new tree (b/...), or the old path for pure deletions. */
  path: string;
  /** True if the new side is /dev/null (file deleted). */
  deleted: boolean;
  hunks: DiffHunk[];
  /**
   * The path this file had before, when git detected a rename.
   *
   * Absent on every ordinary change, which is why it is optional: reading it
   * costs nothing and every existing consumer is unaffected. It exists because
   * a rename that is not recognised as one is a catastrophe for anything
   * tracking findings across reviews. The old path vanishes from the diff and
   * the new path has never been seen, so every finding in the file is
   * simultaneously reported as fixed and re-raised as new, and the review
   * claims credit for four fixes that did not happen.
   */
  renamedFrom?: string;
  /**
   * git's rename similarity, 0-100, when it reported one.
   *
   * Below git's own 50% threshold git does not call it a rename at all, so
   * anything here is at least that. Consumers may set a higher bar: a file at
   * 55% similarity was effectively rewritten, and carrying findings across a
   * rewrite is worse than losing them.
   */
  similarity?: number;
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)$/;
const RENAME_FROM_RE = /^rename from (.+)$/;
const RENAME_TO_RE = /^rename to (.+)$/;
const SIMILARITY_RE = /^similarity index (\d+)%$/;

/** parseUnifiedDiff parses `git diff` unified output into structured files. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diff.split("\n");
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let newLineNo = 0;
  /**
   * The `--- a/...` side of the file currently being parsed.
   *
   * Kept because a DELETED file has no new side to take a path from: git writes
   * `+++ /dev/null`, so reading only the `+++` line left `path` empty. Everything
   * downstream that names a file then had nothing to print, and `subsystem("")`
   * counted every deletion as a change at the repository root.
   */
  let oldPath = "";

  const flushFile = () => {
    if (current) files.push(current);
  };

  for (const raw of lines) {
    if (raw.startsWith("diff --git")) {
      flushFile();
      current = { path: "", deleted: false, hunks: [] };
      hunk = null;
      oldPath = "";
      continue;
    }
    // Rename metadata sits between the `diff --git` line and the `---`/`+++`
    // pair, and for a PURE rename (no content change) those two lines are the
    // only record of the file: git emits no `---`, no `+++` and no hunks at all.
    // Reading them here is what makes such a file visible downstream instead of
    // being filtered out as a nameless entry.
    if (current) {
      const sim = SIMILARITY_RE.exec(raw);
      if (sim) {
        current.similarity = parseInt(sim[1], 10);
        continue;
      }
      const from = RENAME_FROM_RE.exec(raw);
      if (from) {
        current.renamedFrom = from[1].trim();
        oldPath = current.renamedFrom;
        continue;
      }
      const to = RENAME_TO_RE.exec(raw);
      if (to) {
        current.path = to[1].trim();
        continue;
      }
    }
    if (raw.startsWith("--- ")) {
      if (!current) current = { path: "", deleted: false, hunks: [] };
      const p = raw.slice(4).trim().split("\t")[0];
      oldPath = p === "/dev/null" ? "" : stripPrefix(p);
      continue;
    }
    if (raw.startsWith("+++ ")) {
      if (!current) current = { path: "", deleted: false, hunks: [] };
      const p = raw.slice(4).trim().split("\t")[0];
      if (p === "/dev/null") {
        current.deleted = true;
        // A deletion is still a change to a named file, and the name is the only
        // one it has left.
        current.path = oldPath;
      } else {
        current.path = stripPrefix(p);
      }
      continue;
    }
    const m = HUNK_RE.exec(raw);
    if (m && current) {
      newLineNo = parseInt(m[1], 10);
      hunk = {
        newStart: newLineNo,
        newLines: m[2] ? parseInt(m[2], 10) : 1,
        header: m[3] ?? "",
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk || !current) continue;

    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "add", content: raw.slice(1), newLineNo });
      newLineNo++;
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "del", content: raw.slice(1) });
      // deletions do not advance the new-file line counter
    } else if (raw.startsWith(" ")) {
      hunk.lines.push({ kind: "context", content: raw.slice(1), newLineNo });
      newLineNo++;
    } else if (raw === "\\ No newline at end of file") {
      // ignore the "no newline" marker
    }
    // any other line (e.g. "index ..", "similarity ..") is metadata → ignore
  }
  flushFile();
  return files.filter((f) => f.path !== "" || f.deleted);
}

function stripPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/**
 * git's own rename threshold is 50%. This one is higher on purpose.
 *
 * A file at 55% similarity was effectively rewritten, and carrying a finding
 * across a rewrite anchors it to code that no longer exists. Below this bar a
 * rename is treated as a delete plus an add, which is what it actually was.
 */
export const RENAME_SIMILARITY_FLOOR = 60;

/**
 * Old path → new path for every file git reported as a rename, above the
 * similarity floor.
 *
 * Empty on the overwhelming majority of diffs, which is why every consumer can
 * treat a non-empty map as the exceptional path and skip the work otherwise.
 */
export function renameMap(files: DiffFile[], minSimilarity = RENAME_SIMILARITY_FLOOR): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    if (!f.renamedFrom || f.renamedFrom === f.path) continue;
    // No similarity reported means git called it a rename without printing a
    // number (it does this for an exact rename, which is 100%).
    if (f.similarity !== undefined && f.similarity < minSimilarity) continue;
    out.set(f.renamedFrom, f.path);
  }
  return out;
}

/**
 * commentableLines returns, per file path, the set of new-file line numbers that
 * are ADDED in the diff — the safe set of inline-comment anchor points. We anchor
 * comments to added lines so we never comment on code the PR didn't touch.
 */
export function commentableLines(files: DiffFile[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const f of files) {
    if (f.deleted) continue;
    const set = new Set<number>();
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.kind === "add" && l.newLineNo !== undefined) set.add(l.newLineNo);
      }
    }
    out.set(f.path, set);
  }
  return out;
}
