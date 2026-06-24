import type { Finding } from "@cavix/core";
import type { SandboxBackend, SandboxSpec } from "@cavix/sandbox";
import { detectSetup } from "./setup.ts";
import type { TestGenerator } from "./testgen.ts";
import {
  type StepLog,
  type VerificationResult,
  type VerifyContext,
} from "./types.ts";

export interface VerifierOptions {
  sandbox: SandboxBackend;
  testGen: TestGenerator;
  /** Sandbox hardening — no egress + caps. Defaults are secure. */
  sandboxSpec?: SandboxSpec;
  /** Only verify findings at/above this confidence (unless high severity). */
  confidenceGate?: number;
}

// The secure default spec: NO network, hard caps, ephemeral. Verification runs
// untrusted repo code + model-written tests, so isolation is non-negotiable.
export const SECURE_SPEC: SandboxSpec = {
  network: "none",
  limits: { cpus: 1, memoryMb: 1024, timeoutMs: 30_000 },
  label: "cavix-verify",
};

export class Verifier {
  private readonly sandbox: SandboxBackend;
  private readonly testGen: TestGenerator;
  private readonly spec: SandboxSpec;
  private readonly gate: number;

  constructor(opts: VerifierOptions) {
    this.sandbox = opts.sandbox;
    this.testGen = opts.testGen;
    this.spec = opts.sandboxSpec ?? SECURE_SPEC;
    this.gate = opts.confidenceGate ?? 0.5;
  }

  // Gate: deterministic facts (secret/sast/linter) and immutable policy findings
  // are already proven — don't pay sandbox cost. Verify LLM findings that are
  // high-impact or confident; skip trivial nits.
  shouldVerify(f: Finding): boolean {
    if (f.immutable) return false;
    if (f.source !== "llm") return false;
    if (f.severity === "critical" || f.severity === "high") return true;
    if (f.category === "security") return true;
    return f.confidence >= this.gate;
  }

  async verify(finding: Finding, ctx: VerifyContext): Promise<VerificationResult> {
    const setup = detectSetup(ctx.files);
    const exploit = finding.category === "security";
    const logs: StepLog[] = [];
    if (!setup) {
      return inconclusive(exploit, "no recognized build/test setup", logs, 0);
    }

    const sbx = await this.sandbox.provision(this.spec);
    try {
      for (const f of ctx.files) await sbx.writeFile(f.path, f.content);

      const { generated, costUsd } = await this.testGen.generate(finding, ctx, setup);
      if (!generated.testCode.trim()) return inconclusive(exploit, "no test generated", logs, costUsd);
      await sbx.writeFile(generated.testPath, generated.testCode);

      if (setup.install) {
        const r = await sbx.exec(setup.install.cmd, setup.install.args);
        logs.push(step("install", setup.install, r));
      }

      // Pre-fix reproduction.
      const tcmd = setup.runTest(generated.testPath);
      const r1 = await sbx.exec(tcmd.cmd, tcmd.args);
      logs.push(step("repro", tcmd, r1));
      const reproduced =
        generated.semantics === "test-fails-on-bug" ? r1.code !== 0 : r1.code === 0;

      if (!reproduced) {
        const reason = exploit
          ? "exploit did not succeed against the code — likely a false alarm"
          : "reproduction test passed against current code — the bug does not manifest";
        return { status: "UNVERIFIED", reproduced: false, exploit, logs, reason, costUsd, testPath: generated.testPath, testCode: generated.testCode };
      }

      // Reproduced. Optionally apply the fix and re-run, then the suite.
      let fixWorks: boolean | undefined;
      let suitePasses: boolean | undefined;
      if (generated.fix) {
        await sbx.writeFile(generated.fix.path, generated.fix.content);
        const r2 = await sbx.exec(tcmd.cmd, tcmd.args);
        logs.push(step("after-fix", tcmd, r2));
        fixWorks = generated.semantics === "test-fails-on-bug" ? r2.code === 0 : r2.code !== 0;
        const scmd = setup.runSuite();
        const r3 = await sbx.exec(scmd.cmd, scmd.args);
        logs.push(step("suite", scmd, r3));
        suitePasses = r3.code === 0;
      }

      const reason = exploit
        ? "PoC exploit demonstrated the vulnerability in the sandbox"
        : "bug reproduced by a failing test in the sandbox" + (fixWorks ? "; suggested fix resolves it" : "");
      return { status: "VERIFIED", reproduced: true, fixWorks, suitePasses, exploit, logs, reason, costUsd, testPath: generated.testPath, testCode: generated.testCode };
    } catch (err) {
      return inconclusive(exploit, `sandbox error: ${(err as Error).message}`, logs, 0);
    } finally {
      await sbx.destroy(); // ephemeral, no residual code
    }
  }
}

function step(name: string, c: { cmd: string; args: string[] }, r: { code: number; stdout: string; stderr: string; timedOut: boolean }): StepLog {
  return { step: name, cmd: `${c.cmd} ${c.args.join(" ")}`, code: r.code, timedOut: r.timedOut, output: (r.stdout + r.stderr).slice(0, 2000) };
}

function inconclusive(exploit: boolean, reason: string, logs: StepLog[], costUsd: number): VerificationResult {
  return { status: "INCONCLUSIVE", reproduced: false, exploit, logs, reason, costUsd };
}
