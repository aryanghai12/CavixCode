import { matchGlob } from "@cavix/repoconfig";
import { parseUnifiedDiff } from "@cavix/core";

// Path filters: which files in a pull request Cavix is allowed to review.
//
// The owner sets these on the dashboard under "Path filters" (and can also ship
// them in a .cavix.yaml). They were stored, served to the orchestrator, and then
// ignored, so a team that excluded `vendor/**` still got reviews of vendored
// code, still paid for the tokens, and had no way to tell the setting was inert.
//
// Filtering happens on the DIFF, before the model sees anything. Doing it later,
// on the findings, would be cheaper to write and wrong in two ways: the excluded
// file would still be sent to the provider (so an org excluding a directory for
// confidentiality reasons would not actually get that), and it would still be
// billed for.

export interface PathFilters {
  /** Empty means "everything not excluded". */
  include: string[];
  exclude: string[];
}

export const NO_FILTERS: PathFilters = { include: [], exclude: [] };

/** Should this path be reviewed? Exclude wins over include. */
export function allowsPath(path: string, filters: PathFilters): boolean {
  if (filters.exclude.some((g) => matchGlob(path, g))) return false;
  if (filters.include.length > 0 && !filters.include.some((g) => matchGlob(path, g))) return false;
  return true;
}

export interface FilteredDiff {
  diff: string;
  /** Paths that survived the filter. */
  kept: string[];
  /** Paths the owner's filters excluded. */
  dropped: string[];
}

/**
 * Cut the excluded files out of a unified diff, keeping the rest byte-identical.
 *
 * It splits on `diff --git` headers rather than re-serialising the parsed diff,
 * because everything downstream (the poster's line anchors, the verifier's file
 * reads, GitHub's own comment coordinates) depends on the hunk text being exactly
 * what git produced. A re-serialised diff that is one space different is a class
 * of bug that only shows up as a 422 on someone else's pull request.
 */
export function filterDiff(diff: string, filters: PathFilters): FilteredDiff {
  if (filters.include.length === 0 && filters.exclude.length === 0) {
    return { diff, kept: parseUnifiedDiff(diff).map((f) => f.path), dropped: [] };
  }

  const kept: string[] = [];
  const dropped: string[] = [];
  const out: string[] = [];

  // Each chunk is one file's section of the diff, header included.
  for (const chunk of splitByFile(diff)) {
    const path = pathOf(chunk);
    // A chunk we cannot name a path for is kept: dropping something we failed to
    // parse would silently shrink the review, which is the worse failure.
    if (path === "" || allowsPath(path, filters)) {
      if (path !== "") kept.push(path);
      out.push(chunk);
    } else {
      dropped.push(path);
    }
  }
  return { diff: out.join(""), kept, dropped };
}

/** Split a unified diff into per-file chunks, each starting at `diff --git`. */
function splitByFile(diff: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of diff.split(/(?<=\n)/)) {
    if (line.startsWith("diff --git") && current !== "") {
      chunks.push(current);
      current = "";
    }
    current += line;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

/**
 * The new-tree path of one diff chunk.
 *
 * Prefers the `+++ b/...` line, which is what every consumer downstream uses.
 * Falls back to the `diff --git a/x b/y` header for a pure deletion, where the
 * new side is /dev/null and the old path is the only name the file has.
 */
function pathOf(chunk: string): string {
  const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(chunk);
  if (plus && plus[1].trim() !== "/dev/null") return plus[1].trim().split("\t")[0];
  const header = /^diff --git a\/(\S+) b\/(\S+)/m.exec(chunk);
  return header ? header[2] : "";
}
