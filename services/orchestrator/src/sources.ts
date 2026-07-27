import { parseUnifiedDiff } from "@cavix/core";
import type { GitHubClient, PullRef } from "./github/client.ts";

// Reading real source out of GitHub.
//
// Two consumers need it and neither can work from the diff alone: the sandbox
// has to run the code, and the pre-merge gate has to scan the file as it will
// exist after merge. A diff has no imports, no enclosing functions and no
// manifest — it is a description of a change, not a program.

export interface SourceFile {
  path: string;
  content: string;
}

/** Manifests worth fetching so a toolchain can be recognised. */
export const MANIFESTS = ["package.json", "go.mod", "pyproject.toml", "requirements.txt"];

/** Hard cap on files pulled per review — a wide PR must not become a crawl. */
export const MAX_SOURCE_FILES = 12;

/**
 * Fetch the given paths at the reviewed commit, skipping whatever cannot be
 * read. Unreadable files are an ordinary outcome (deleted in this PR, renamed,
 * binary, too large) and must never fail a review, so this never throws.
 */
export async function fetchSources(
  github: GitHubClient,
  ref: PullRef,
  paths: string[],
  max = MAX_SOURCE_FILES,
): Promise<SourceFile[]> {
  const wanted = [...new Set(paths)].slice(0, max);
  const fetched = await Promise.all(
    wanted.map(async (path) => {
      try {
        const content = await github.fetchFile(ref, path);
        return content === null ? null : { path, content };
      } catch {
        // One unreadable file must not sink the others.
        return null;
      }
    }),
  );
  return fetched.filter((f): f is SourceFile => f !== null);
}

/** The files this PR touches, as they exist at the head commit. */
export function changedPaths(diff: string): string[] {
  return parseUnifiedDiff(diff)
    .filter((f) => !f.deleted && f.path !== "")
    .map((f) => f.path);
}
