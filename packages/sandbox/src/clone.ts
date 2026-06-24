import { spawn } from "node:child_process";

// Shallow-clone the exact commit under review into a sandbox-bound directory.
// For a PR we fetch the merge ref (refs/pull/N/merge) or a specific SHA at
// depth 1 — minimal data, no full history. This runs during PROVISIONING with
// controlled egress; once the workspace is populated the sandbox runs locked down
// (no egress). Keeping clone separate from exec is what lets the analysis step
// have zero network while still getting the code.

export interface ShallowCloneOptions {
  repoUrl: string;
  /** A SHA or a ref like "refs/pull/42/merge". */
  ref: string;
  /** Destination directory (must exist). */
  dir: string;
  depth?: number;
  timeoutMs?: number;
}

function git(args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("git", args, { cwd, shell: false });
    let stderr = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stderr?.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: String(e) });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

/** Fetch+checkout a single commit at depth 1 into `dir`. Throws on failure. */
export async function shallowClone(opts: ShallowCloneOptions): Promise<void> {
  const depth = opts.depth ?? 1;
  const timeout = opts.timeoutMs ?? 120_000;
  const steps: string[][] = [
    ["init", "-q"],
    ["remote", "add", "origin", opts.repoUrl],
    ["fetch", "-q", "--depth", String(depth), "origin", opts.ref],
    ["checkout", "-q", "FETCH_HEAD"],
  ];
  for (const args of steps) {
    const r = await git(args, opts.dir, timeout);
    if (r.code !== 0) {
      throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || "exit " + r.code}`);
    }
  }
}
