import type { Finding } from "@cavix/core";
import type { Sandbox } from "@cavix/sandbox";

// Stage 10 — execution-grounded verification. Cavix's defining claim is that it
// PROVES findings: it reproduces the bug (or demonstrates the exploit) in an
// isolated sandbox before it speaks. The result is a fact, not a guess.

export type VerificationStatus = "VERIFIED" | "UNVERIFIED" | "INCONCLUSIVE";

export interface StepLog {
  step: string;
  cmd: string;
  code: number;
  timedOut: boolean;
  output: string;
}

export interface VerificationResult {
  status: VerificationStatus;
  /** Did the bug/vuln actually manifest in the sandbox? */
  reproduced: boolean;
  /** If a fix was applied, did it resolve the reproduction? */
  fixWorks?: boolean;
  /** Did the existing suite still pass after the fix? */
  suitePasses?: boolean;
  /** True for security PoC (exploit) verifications. */
  exploit: boolean;
  /** The generated reproduction/exploit test that was run. */
  testPath?: string;
  testCode?: string;
  /** The fix files that were applied and re-verified (drives the fix-PR agent). */
  appliedFix?: Array<{ path: string; content: string }>;
  logs: StepLog[];
  reason: string;
  costUsd: number;
}

// A repro test either FAILS on a buggy code path (correctness) or an exploit test
// PASSES against a vulnerable one (security). This flips how we read the exit code.
export type ReproSemantics = "test-fails-on-bug" | "exploit-passes-on-vuln";

export interface GeneratedTest {
  testPath: string;
  testCode: string;
  /** Optional full-file fix to apply and re-test (the "fix-and-run" step). */
  fix?: { path: string; content: string };
  semantics: ReproSemantics;
}

export interface VerifyContext {
  /** The repo files needed to build/run (source under test + scaffolding). */
  files: Array<{ path: string; content: string }>;
  org: string;
  /**
   * Stage 13. Called immediately after each sandbox is destroyed.
   *
   * It lives on the per-review CONTEXT and not on the Verifier, and that is the
   * whole point. A `Verifier` is constructed once at boot and shared by every
   * review this orchestrator runs concurrently, so a hook held there would
   * attribute one customer's sandboxes to another customer's retention proof.
   * The context is created per review and thrown away with it.
   *
   * Awaited so a check cannot outlive the review it describes, and swallowed by
   * the caller so it can never cost one.
   */
  onTeardown?: (sandbox: Sandbox) => Promise<void>;
}

export const semanticsFor = (finding: Finding): ReproSemantics =>
  finding.category === "security" ? "exploit-passes-on-vuln" : "test-fails-on-bug";
