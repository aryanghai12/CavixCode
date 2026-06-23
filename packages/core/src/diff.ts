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
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** parseUnifiedDiff parses `git diff` unified output into structured files. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diff.split("\n");
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let newLineNo = 0;

  const flushFile = () => {
    if (current) files.push(current);
  };

  for (const raw of lines) {
    if (raw.startsWith("diff --git")) {
      flushFile();
      current = { path: "", deleted: false, hunks: [] };
      hunk = null;
      continue;
    }
    if (raw.startsWith("--- ")) {
      // old path line; ignored except to ensure we're inside a file block
      if (!current) current = { path: "", deleted: false, hunks: [] };
      continue;
    }
    if (raw.startsWith("+++ ")) {
      if (!current) current = { path: "", deleted: false, hunks: [] };
      const p = raw.slice(4).trim().split("\t")[0];
      if (p === "/dev/null") {
        current.deleted = true;
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
