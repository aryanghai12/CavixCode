import type { Finding } from "@cavix/core";
import type { Verifier } from "./verifier.ts";
import type { VerificationResult, VerifyContext } from "./types.ts";

// Decide what reaches the PR. Default policy: surface VERIFIED findings and
// deterministic/policy facts; suppress findings PROVEN to be false alarms
// (UNVERIFIED); keep unverified-but-confident findings, drop unverified nits.

export interface SurfaceOptions {
  /** Confidence at/above which an unverified or inconclusive finding still posts. */
  highConfidence?: number;
}

export interface VerifyAndFilterResult {
  surfaced: Finding[];
  suppressed: Array<{ finding: Finding; reason: string }>;
  results: Map<Finding, VerificationResult>;
  verifiedCount: number;
  costUsd: number;
}

export async function verifyAndFilter(
  findings: Finding[],
  ctx: VerifyContext,
  verifier: Verifier,
  opts: SurfaceOptions = {},
): Promise<VerifyAndFilterResult> {
  const highConf = opts.highConfidence ?? 0.8;
  const surfaced: Finding[] = [];
  const suppressed: Array<{ finding: Finding; reason: string }> = [];
  const results = new Map<Finding, VerificationResult>();
  let verifiedCount = 0;
  let costUsd = 0;

  for (const f of findings) {
    // Facts (deterministic + policy) bypass verification and always surface.
    if (f.immutable || f.source !== "llm") {
      surfaced.push(f);
      continue;
    }
    if (!verifier.shouldVerify(f)) {
      // Not worth proving (trivial nit): keep only if confident.
      if (f.confidence >= highConf) surfaced.push(f);
      else suppressed.push({ finding: f, reason: "below verification gate and low confidence" });
      continue;
    }

    const result = await verifier.verify(f, ctx);
    results.set(f, result);
    costUsd += result.costUsd;

    if (result.status === "VERIFIED") {
      verifiedCount++;
      surfaced.push(annotate(f, result));
    } else if (result.status === "UNVERIFIED") {
      suppressed.push({ finding: f, reason: `verification: ${result.reason}` });
    } else {
      // INCONCLUSIVE → keep only if confident.
      if (f.confidence >= highConf) surfaced.push(f);
      else suppressed.push({ finding: f, reason: `inconclusive and low confidence: ${result.reason}` });
    }
  }

  return { surfaced, suppressed, results, verifiedCount, costUsd };
}

/**
 * Stamp the proof onto a verified finding.
 *
 * Structured, not prose: the badge and the step log are rendered by whoever
 * shows the finding (PR comment, dashboard, IDE), so the receipt survives in a
 * form they can each present properly instead of being glued into the body as
 * markdown that only GitHub understands.
 */
function annotate(f: Finding, r: VerificationResult): Finding {
  return {
    ...f,
    // It ran. It happened. Confidence is no longer an estimate.
    confidence: Math.max(f.confidence, 0.99),
    verification: {
      status: r.status,
      exploit: r.exploit,
      reproduced: r.reproduced,
      fixWorks: r.fixWorks,
      suitePasses: r.suitePasses,
      reason: r.reason,
      testPath: r.testPath,
      steps: r.logs.map((l) => ({ step: l.step, cmd: l.cmd, code: l.code, timedOut: l.timedOut })),
    },
  };
}
