// Stage 2 — the ONE sandbox interface. Cavix runs untrusted repo code to verify
// findings, so provisioning must stay behind this port with interchangeable
// backends: Docker / Cloudflare Sandbox SDK now, Firecracker/gVisor (self-host,
// air-gapped) later. The verification logic upstream must NEVER couple to one
// backend — it only ever sees this interface.

export interface SandboxLimits {
  /** CPU cores (fractional allowed where the backend supports it). */
  cpus?: number;
  memoryMb?: number;
  /** Wall-clock cap per exec; the backend kills the process past this. */
  timeoutMs?: number;
}

// Network policy. Default is total isolation; an org/job may allowlist hosts
// (implemented by an egress proxy on isolating backends). NEVER default-open.
export type NetworkPolicy = "none" | { allowlist: string[] };

export interface SandboxSpec {
  /** Container image (Docker/Cloudflare). Ignored by the local dev backend. */
  image?: string;
  limits?: SandboxLimits;
  network?: NetworkPolicy;
  /** Optional label for logs/metrics. */
  label?: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

// A provisioned, ephemeral workspace. Created per job, destroyed after.
export interface Sandbox {
  readonly id: string;
  readonly backend: string;
  /** Absolute path to the workspace root inside the sandbox. */
  readonly workdir: string;
  writeFile(relPath: string, content: string): Promise<void>;
  readFile(relPath: string): Promise<string>;
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** Tear down: kill processes, delete the workspace, release the backend. */
  destroy(): Promise<void>;
}

export interface SandboxBackend {
  readonly name: string;
  provision(spec: SandboxSpec): Promise<Sandbox>;
}

export const DEFAULT_LIMITS: Required<SandboxLimits> = {
  cpus: 1,
  memoryMb: 1024,
  timeoutMs: 60_000,
};
