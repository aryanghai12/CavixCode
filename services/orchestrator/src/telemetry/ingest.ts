import type { BuildRun } from "@cavix/telemetry";
import type { ReviewPlatform, PullRef } from "../github/client.ts";

// Stage 6, half one: getting CI history in.
//
// ── pull, not push, and why ──────────────────────────────────────────────────
//
// GitHub can push `workflow_run` events at a webhook, and that is the obvious
// design. It is the wrong one to start with:
//
//   • It needs the Go edge to learn a second event type, a second job shape on
//     the queue, and a second worker path, none of which exist.
//   • It only ever sees runs that happen AFTER the App is installed, so a new
//     customer's first weeks of reviews have no history to compare against and
//     the stage silently says nothing.
//   • A pull gets backfill free: one call returns the last sixty completed runs,
//     so the very first review already has a baseline.
//
// So: pull, on the same schedule as the contract indexer, after the review is
// posted. If volume ever makes the pull expensive, a webhook becomes an
// optimisation on top of a working stage rather than a prerequisite for one.

/** Runs fetched per refresh. Sixty covers roughly a fortnight on a busy repo. */
const RUNS_PER_FETCH = 60;

/** How long a repository's CI history stays fresh enough to reuse. */
export const DEFAULT_CI_STALE_MS = 6 * 3600_000;

export interface CiIngestResult {
  repo: string;
  runsFetched: number;
  runsStored: number;
  workflows: string[];
}

export type CiIngestStep = (ref: PullRef, org: string, branch: string) => Promise<CiIngestResult | null>;

export interface CiStore {
  /** Stored runs for a repository, plus when it was last refreshed. */
  load(org: string): Promise<{ runs: BuildRun[]; fetchedAt: Record<string, string> }>;
  save(org: string, repo: string, runs: BuildRun[]): Promise<void>;
}

export interface CiIngestOptions {
  github: ReviewPlatform;
  store: CiStore;
  staleMs?: number;
  logger?: { info(msg: string, meta?: Record<string, unknown>): void };
}

export function makeCiIngestStep(opts: CiIngestOptions): CiIngestStep {
  const staleMs = opts.staleMs ?? DEFAULT_CI_STALE_MS;

  return async (ref, org, branch) => {
    const repo = `${ref.owner}/${ref.repo}`;
    const stored = await opts.store.load(org);

    const last = stored.fetchedAt[repo];
    if (last && Date.now() - Date.parse(last) < staleMs) return null;

    const runs = await opts.github.listWorkflowRuns(ref, branch, RUNS_PER_FETCH);
    if (runs.length === 0) {
      // No CI, Actions disabled, or the App has no `actions: read`. All three are
      // ordinary and none of them is worth a word on a pull request.
      opts.logger?.info("no CI runs available for this repository", { repo, branch });
      return null;
    }

    const existing = stored.runs.filter((r) => r.repo === repo);
    // Merge on (workflow, commit, finish time): a refresh overlaps the previous
    // one by design, and appending blind would count the same run five times and
    // then report a trend built out of duplicates.
    const seen = new Set(existing.map(keyOf));
    const fresh: BuildRun[] = [];
    for (const r of runs) {
      const row: BuildRun = {
        repo,
        workflow: r.workflow,
        durationMs: r.durationMs,
        commit: r.commit,
        conclusion: r.conclusion,
        branch: r.branch,
        at: r.at,
      };
      if (seen.has(keyOf(row))) continue;
      seen.add(keyOf(row));
      fresh.push(row);
    }

    const merged = [...existing, ...fresh].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    await opts.store.save(org, repo, merged);

    const result: CiIngestResult = {
      repo,
      runsFetched: runs.length,
      runsStored: merged.length,
      workflows: [...new Set(merged.map((r) => r.workflow ?? "workflow"))],
    };
    opts.logger?.info("ingested CI history", { ...result, org, new_runs: fresh.length });
    return result;
  };
}

function keyOf(r: BuildRun): string {
  return `${r.workflow ?? ""}|${r.commit}|${r.at}`;
}
