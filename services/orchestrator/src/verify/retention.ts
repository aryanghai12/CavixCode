import { buildAttestation, checkPurged, type PurgeCheck, type RetentionAttestation } from "@cavix/zero-retention";
import type { Sandbox } from "@cavix/sandbox";

// Stage 13, live — collecting the retention proof for one review.
//
// The awkward shape here is not accidental, and it is worth stating because the
// obvious alternative looks better and does not work. `ZeroRetention.runReview`
// wraps a whole review in ONE sandbox, which is how the air-gapped demo uses it.
// The real verifier provisions a sandbox PER FINDING, so a review with four
// verifiable findings creates and destroys four of them. Wrapping the review
// would mean restructuring the verifier around a shape that suits the proof
// rather than the work, and the proof is not the thing customers are paying for.
//
// So the verifier reports each teardown as it happens, this collects them, and
// the workflow turns the collection into one attestation at the end.
//
// CONCURRENCY. One collector per review, created by the workflow and thrown
// away with it. A single shared collector across the orchestrator's concurrent
// jobs would attribute one customer's sandboxes to another customer's
// attestation, which is a worse failure than having no attestation at all.

export interface RetentionCollector {
  /** Hand to `Verifier.onTeardown`. */
  onTeardown(sandbox: Sandbox): Promise<void>;
  /**
   * The attestation for this review, once every sandbox is gone.
   *
   * No review id: the control-plane assigns one when it stores the record, and
   * the orchestrator's only candidate ("owner/repo#12@sha") would put a
   * repository name inside the artefact whose entire purpose is to carry nothing
   * about the customer's code.
   */
  finish(input: { org: string }): RetentionAttestation;
  /** True when a check found something still there. The workflow logs it loudly. */
  violated(): boolean;
}

export interface RetentionCollectorOptions {
  logger?: { error(msg: string, meta?: Record<string, unknown>): void };
  /** Injectable check, so a test can simulate a backend that leaked. */
  check?: (sandbox: Sandbox) => Promise<PurgeCheck>;
}

/**
 * A collector for ONE review.
 *
 * Never throws. Every entry point swallows, because this exists to describe what
 * happened and a proof that can fail a review is a proof that costs a customer
 * the thing they actually bought. A check that blows up simply does not appear
 * in the attestation, and an attestation with fewer checks than sandboxes is
 * `partial`, which is the truth.
 */
export function makeRetentionCollector(opts: RetentionCollectorOptions = {}): RetentionCollector {
  const checks: PurgeCheck[] = [];
  const check = opts.check ?? ((s: Sandbox) => checkPurged(s, opts.logger ? { logger: opts.logger } : {}));

  return {
    async onTeardown(sandbox) {
      try {
        checks.push(await check(sandbox));
      } catch (err) {
        opts.logger?.error("could not verify a sandbox was destroyed", {
          backend: sandbox.backend,
          err: (err as Error).message,
        });
      }
    },
    finish(input) {
      return buildAttestation({ org: input.org, checks });
    },
    violated() {
      return checks.some((c) => c.status === "residual");
    },
  };
}
