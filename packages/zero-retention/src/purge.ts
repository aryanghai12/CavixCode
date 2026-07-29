import fs from "node:fs";
import { spawn } from "node:child_process";
import type { Sandbox } from "@cavix/sandbox";

// Stage 13 — proving a sandbox is gone.
//
// THE PROBLEM WITH THE FIRST VERSION, and the reason this file exists:
//
// The original residual check asked whether `sandbox.workdir` still existed on
// the host filesystem. That is a real question for the LOCAL backend, whose
// workdir is a host temp directory. It is a meaningless one for Docker, where
// the workdir is `/work` inside a container and no such host path was ever
// created: the check saw nothing, found nothing, and reported clean. So on the
// only backend a customer actually runs, the zero-retention proof verified
// precisely nothing and said so to nobody.
//
// A proof that cannot fail is not a proof. Each backend now gets a check that
// can actually come back false, and a backend with no checkable claim reports
// `unverifiable` rather than `clean`. That distinction is the whole point: a
// buyer's auditor is entitled to know which of our claims were measured and
// which were merely architectural.

/** What was checked, and what came back. */
export type PurgeStatus =
  /** A check ran and the sandbox is gone. */
  | "purged"
  /** A check ran and something is still there. This is a violation. */
  | "residual"
  /**
   * No check could run here. NOT the same as clean: it means the backend
   * exposes nothing this process can inspect, so the claim rests on the
   * backend's contract rather than on a measurement.
   */
  | "unverifiable";

export interface PurgeCheck {
  /** Sandbox backend name, e.g. "local", "docker". */
  backend: string;
  /** Which check ran, in words a reader can evaluate. */
  check: string;
  status: PurgeStatus;
  /**
   * How many residual artefacts were found. Present only on "residual".
   *
   * A COUNT and never a path. This record is retained and shown to the
   * customer, and a filesystem path from the machine that reviewed their code
   * is exactly the kind of detail a retention proof should not itself retain.
   * The path goes to the operator's log, where it is needed to fix the problem.
   */
  residualCount?: number;
}

export interface PurgeCheckOptions {
  /** Injectable process runner, so the Docker check is testable with no Docker. */
  run?: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;
  /** Injectable existence probe, for the same reason. */
  exists?: (path: string) => boolean;
  /** Where a residual path is reported. Never the attestation. */
  logger?: { error(msg: string, meta?: Record<string, unknown>): void };
}

/**
 * Ask, after `destroy()`, whether this sandbox is really gone.
 *
 * Never throws. A check that cannot run is `unverifiable`, because the purpose
 * of this call is to describe reality and a thrown error describes nothing.
 */
export async function checkPurged(sandbox: Sandbox, opts: PurgeCheckOptions = {}): Promise<PurgeCheck> {
  const exists = opts.exists ?? safeExists;
  const run = opts.run ?? runProcess;

  switch (sandbox.backend) {
    case "local": {
      // The workdir IS a host temp directory, so its absence is a real fact
      // about the host filesystem.
      const left = exists(sandbox.workdir);
      if (left) {
        opts.logger?.error("zero-retention: a sandbox workspace survived teardown", {
          backend: sandbox.backend,
          // The operator needs the path to fix it. It never reaches the record.
          workdir: sandbox.workdir,
        });
      }
      return {
        backend: sandbox.backend,
        check: "the workspace directory is absent from the host filesystem",
        status: left ? "residual" : "purged",
        ...(left ? { residualCount: 1 } : {}),
      };
    }

    case "docker": {
      // The workdir is a tmpfs inside the container, so there is no host path to
      // look for. What CAN be measured is that the container itself is gone, and
      // a tmpfs cannot outlive the container that owns it.
      try {
        const r = await run("docker", ["ps", "-a", "--filter", `name=^${sandbox.id}$`, "--format", "{{.ID}}"]);
        if (r.code !== 0) {
          // Docker is unreachable from here. We cannot say the container is
          // gone, and we must not say it is.
          return {
            backend: sandbox.backend,
            check: "the container is absent from the Docker daemon",
            status: "unverifiable",
          };
        }
        const still = r.stdout.trim() !== "";
        if (still) {
          opts.logger?.error("zero-retention: a sandbox container survived teardown", {
            backend: sandbox.backend,
            sandbox: sandbox.id,
          });
        }
        return {
          backend: sandbox.backend,
          check: "the container is absent from the Docker daemon, and its workspace was a tmpfs that cannot outlive it",
          status: still ? "residual" : "purged",
          ...(still ? { residualCount: 1 } : {}),
        };
      } catch {
        return {
          backend: sandbox.backend,
          check: "the container is absent from the Docker daemon",
          status: "unverifiable",
        };
      }
    }

    default:
      // Cloudflare, Firecracker, the in-process fake: the workspace lives
      // somewhere this process cannot inspect. Saying "clean" here would be
      // asserting the backend's contract and calling it a measurement.
      return {
        backend: sandbox.backend,
        check: "none available: this backend exposes nothing this process can inspect after teardown",
        status: "unverifiable",
      };
  }
}

function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Minimal process runner. Resolves rather than rejects, like the check itself. */
function runProcess(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    try {
      const child = spawn(cmd, args, { shell: false });
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.on("error", () => resolve({ code: -1, stdout }));
      child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
    } catch {
      resolve({ code: -1, stdout });
    }
  });
}
