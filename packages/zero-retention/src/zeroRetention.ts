import type { Finding } from "@cavix/core";
import type { Sandbox, SandboxBackend, SandboxSpec } from "@cavix/sandbox";
import { checkPurged, type PurgeCheck } from "./purge.ts";
import { buildAttestation, type RetentionAttestation } from "./attestation.ts";

// Stage 13 — zero-retention. In this mode no customer code persists after a
// review: the work happens in an ephemeral sandbox that is destroyed, and we
// VERIFY no residual remains on disk. Only metadata (counts, locations, rule ids
// — never code) may be stored. An attestation is written to the audit trail.

export interface AuditSink {
  append(actor: string, action: string, target: string, meta?: Record<string, unknown>): unknown;
}

export interface ZeroRetentionOptions {
  backend: SandboxBackend;
  spec?: SandboxSpec;
  audit?: AuditSink;
  /**
   * Override the per-backend purge check. Used by tests to simulate a backend
   * that left something behind, which is otherwise very hard to arrange.
   */
  purgeCheck?: (sandbox: Sandbox) => Promise<PurgeCheck>;
  logger?: { error(msg: string, meta?: Record<string, unknown>): void };
}

const EPHEMERAL: SandboxSpec = { network: "none", limits: { cpus: 1, memoryMb: 1024, timeoutMs: 60_000 }, label: "cavix-zero-retention" };

export class ZeroRetention {
  private readonly backend: SandboxBackend;
  private readonly spec: SandboxSpec;
  private readonly audit?: AuditSink;
  private readonly purgeCheck: NonNullable<ZeroRetentionOptions["purgeCheck"]>;

  constructor(opts: ZeroRetentionOptions) {
    this.backend = opts.backend;
    this.spec = opts.spec ?? EPHEMERAL;
    this.audit = opts.audit;
    this.purgeCheck = opts.purgeCheck ?? ((s) => checkPurged(s, opts.logger ? { logger: opts.logger } : {}));
  }

  /**
   * Run `work` in a fresh sandbox, guarantee teardown, and verify it is gone.
   *
   * Throws on a violation. That is right HERE and wrong in the live review path:
   * this entry point is for a caller whose whole purpose is the retention
   * guarantee (the air-gapped demo, a compliance harness), and such a caller
   * wants to fail loudly. The orchestrator uses `checkPurged` directly and
   * records the result instead, because losing a customer's review over a
   * failed cleanup helps nobody.
   */
  async runReview<T>(
    meta: { reviewId: string; org: string },
    work: (sandbox: Sandbox) => Promise<T>,
  ): Promise<{ result: T; attestation: RetentionAttestation }> {
    const sandbox = await this.backend.provision(this.spec);

    let result: T;
    try {
      result = await work(sandbox);
    } finally {
      await sandbox.destroy(); // ephemeral: always torn down, even on error
    }

    const check = await this.purgeCheck(sandbox);
    const attestation = buildAttestation({ reviewId: meta.reviewId, org: meta.org, checks: [check] });
    this.audit?.append("system", "review.purged", meta.reviewId, {
      org: meta.org,
      verdict: attestation.verdict,
      backend: check.backend,
    });

    if (attestation.verdict === "violated") {
      // The message names no path, for the same reason the attestation carries
      // none: this string ends up in logs and error trackers.
      throw new Error(
        `zero-retention violated: a ${check.backend} sandbox survived teardown for review ${meta.reviewId}`,
      );
    }
    return { result, attestation };
  }
}

// Strip all customer code from a finding so only METADATA may be persisted in
// zero-retention mode. Body/suggestion/evidence snippets (which can contain code)
// are removed; location + classification remain.
export function metadataOnly(finding: Finding): Pick<Finding, "path" | "line" | "severity" | "category" | "title" | "source" | "ruleId" | "agent" | "confidence" | "immutable"> {
  return {
    path: finding.path,
    line: finding.line,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    source: finding.source,
    ruleId: finding.ruleId,
    agent: finding.agent,
    confidence: finding.confidence,
    immutable: finding.immutable,
  };
}
