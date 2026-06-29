import fs from "node:fs";
import type { Finding } from "@cavix/core";
import type { Sandbox, SandboxBackend, SandboxSpec } from "@cavix/sandbox";

// Stage 13 — zero-retention. In this mode no customer code persists after a
// review: the work happens in an ephemeral sandbox that is destroyed, and we
// VERIFY no residual remains on disk. Only metadata (counts, locations, rule ids
// — never code) may be stored. An attestation is written to the audit trail.

export interface AuditSink {
  append(actor: string, action: string, target: string, meta?: Record<string, unknown>): unknown;
}

export interface RetentionAttestation {
  reviewId: string;
  repo: string;
  startedAt: string;
  purgedAt: string;
  residualPaths: string[];
  clean: boolean;
}

export interface ZeroRetentionOptions {
  backend: SandboxBackend;
  spec?: SandboxSpec;
  audit?: AuditSink;
  /** Custom residual check (e.g. for managed backends). Default: host-fs check. */
  residualCheck?: (sandbox: Sandbox, workdirExistedOnHost: boolean) => Promise<string[]>;
}

const EPHEMERAL: SandboxSpec = { network: "none", limits: { cpus: 1, memoryMb: 1024, timeoutMs: 60_000 }, label: "cavix-zero-retention" };

export class ZeroRetention {
  private readonly backend: SandboxBackend;
  private readonly spec: SandboxSpec;
  private readonly audit?: AuditSink;
  private readonly residualCheck: NonNullable<ZeroRetentionOptions["residualCheck"]>;

  constructor(opts: ZeroRetentionOptions) {
    this.backend = opts.backend;
    this.spec = opts.spec ?? EPHEMERAL;
    this.audit = opts.audit;
    this.residualCheck = opts.residualCheck ?? defaultResidualCheck;
  }

  // Run `work` against a freshly-provisioned sandbox, then GUARANTEE teardown and
  // verify no customer code remains. Throws if any residual is found.
  async runReview<T>(meta: { reviewId: string; repo: string }, work: (sandbox: Sandbox) => Promise<T>): Promise<{ result: T; attestation: RetentionAttestation }> {
    const startedAt = new Date().toISOString();
    const sandbox = await this.backend.provision(this.spec);
    const workdir = sandbox.workdir;
    const existedOnHost = safeExists(workdir);

    let result: T;
    try {
      result = await work(sandbox);
    } finally {
      await sandbox.destroy(); // ephemeral: always torn down, even on error
    }

    const residualPaths = await this.residualCheck(sandbox, existedOnHost);
    const attestation: RetentionAttestation = {
      reviewId: meta.reviewId,
      repo: meta.repo,
      startedAt,
      purgedAt: new Date().toISOString(),
      residualPaths,
      clean: residualPaths.length === 0,
    };
    this.audit?.append("system", "review.purged", meta.reviewId, { repo: meta.repo, clean: attestation.clean, residual: residualPaths.length });

    if (!attestation.clean) {
      throw new Error(`zero-retention violated: residual customer code at ${residualPaths.join(", ")}`);
    }
    return { result, attestation };
  }
}

async function defaultResidualCheck(sandbox: Sandbox, existedOnHost: boolean): Promise<string[]> {
  // For host-backed sandboxes (local dev), the workdir must be gone after destroy.
  // For container/managed backends the workdir isn't a host path; teardown is the
  // backend's contract (container removed), so there's nothing to check on host.
  if (existedOnHost && safeExists(sandbox.workdir)) return [sandbox.workdir];
  return [];
}

function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
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
