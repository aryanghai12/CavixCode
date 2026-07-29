import type { Finding } from "@cavix/core";
import type { Sandbox } from "@cavix/sandbox";
import { verifyAndFilter, type Verifier } from "@cavix/verifier";
import type { ReviewPlatform, PullRef } from "../github/client.ts";
import { fetchSources, MANIFESTS, MAX_SOURCE_FILES } from "../sources.ts";

// Stage 10 wiring — the step that turns "the model says this is a bug" into
// "Cavix ran the code and watched it happen".
//
// The verifier package owns the sandbox mechanics (generate a repro, run it,
// apply the fix, re-run, run the suite). This module owns the part only the
// orchestrator can do: getting the real source out of GitHub so there is
// something to run. A diff is not runnable code — it has no imports, no
// surrounding functions, no package manifest — so we fetch each file a finding
// points at, at the reviewed commit, plus whatever manifest identifies the
// project's toolchain.
//
// Everything here is best-effort by construction. If the sandbox is down, the
// files can't be read, or the project's language isn't recognized, the review
// still posts — it just posts unproven findings, which is exactly what Cavix
// did before this step existed.

export interface VerifyStepResult {
  /** Findings that survived: proven, or unproven but worth saying anyway. */
  surfaced: Finding[];
  /** Findings the sandbox DISPROVED, with the reason. Never posted. */
  suppressed: Array<{ finding: Finding; reason: string }>;
  verifiedCount: number;
  costUsd: number;
}

/**
 * Run findings through the sandbox. Returns everything unchanged (and
 * verifiedCount 0) when there is nothing verifiable, so callers never need a
 * separate "verification is off" branch.
 */
export type VerifyStep = (
  findings: Finding[],
  ref: PullRef,
  org: string,
  /**
   * Stage 13. Called after each sandbox this step tears down, so the workflow
   * can assemble one retention attestation for the whole review. Optional: a
   * caller that does not want the proof simply does not pass one.
   */
  onTeardown?: (sandbox: Sandbox) => Promise<void>,
  /**
   * Stage 12's other half: category -> where this workspace's own accept and
   * reject history says proof is worth spending. Rides in per review, like the
   * teardown hook and for the same reason, and absent means the default gate.
   */
  verifyByCategory?: Record<string, "always" | "never">,
) => Promise<VerifyStepResult>;

export interface VerifyStepOptions {
  verifier: Verifier;
  github: ReviewPlatform;
  /** Confidence at/above which an unproven finding still posts. */
  highConfidence?: number;
  maxFiles?: number;
  logger?: { info(msg: string, meta?: Record<string, unknown>): void };
}

export function makeVerifyStep(opts: VerifyStepOptions): VerifyStep {
  const maxFiles = opts.maxFiles ?? MAX_SOURCE_FILES;

  return async (findings, ref, org, onTeardown, verifyByCategory) => {
    const untouched: VerifyStepResult = {
      surfaced: findings,
      suppressed: [],
      verifiedCount: 0,
      costUsd: 0,
    };
    if (findings.length === 0) return untouched;

    // Only fetch sources if something is actually going to be verified. A PR
    // whose findings are all low-severity nits costs zero API calls here. The
    // learned policy is passed HERE too, or a workspace that taught Cavix to
    // prove a whole category would have the sources skipped out from under it.
    if (!findings.some((f) => opts.verifier.shouldVerify(f, verifyByCategory))) return untouched;

    const files = await collectSources(opts.github, ref, findings, maxFiles);
    if (files.length === 0) {
      opts.logger?.info("verification skipped: no source files could be read", {
        repo: `${ref.owner}/${ref.repo}`,
        pr: ref.number,
      });
      return untouched;
    }

    const out = await verifyAndFilter(
      findings,
      {
        org,
        files,
        ...(onTeardown ? { onTeardown } : {}),
        ...(verifyByCategory && Object.keys(verifyByCategory).length > 0 ? { verifyByCategory } : {}),
      },
      opts.verifier,
      { highConfidence: opts.highConfidence },
    );
    opts.logger?.info("verification complete", {
      repo: `${ref.owner}/${ref.repo}`,
      pr: ref.number,
      considered: findings.length,
      verified: out.verifiedCount,
      suppressed: out.suppressed.length,
      files: files.length,
      // Stage 12's other half, so an operator can see the loop is closed on
      // both ends rather than only on the threshold.
      calibrated_categories: Object.keys(verifyByCategory ?? {}).length,
      cost_usd: out.costUsd,
    });
    return {
      surfaced: out.surfaced,
      suppressed: out.suppressed,
      verifiedCount: out.verifiedCount,
      costUsd: out.costUsd,
    };
  };
}

/**
 * Fetch the files the sandbox needs: every file a to-be-verified finding lives
 * in, then manifests to fill the remaining budget. Findings come first because a
 * repro test that cannot import the code under test proves nothing.
 */
async function collectSources(
  github: ReviewPlatform,
  ref: PullRef,
  findings: Finding[],
  maxFiles: number,
): Promise<Array<{ path: string; content: string }>> {
  const wanted = [...new Set(findings.map((f) => f.path))].slice(0, maxFiles);
  const paths = [...wanted, ...MANIFESTS.filter((m) => !wanted.includes(m))];
  return fetchSources(github, ref, paths, maxFiles + MANIFESTS.length);
}
