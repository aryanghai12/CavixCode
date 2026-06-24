import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_LIMITS,
  type ExecOptions,
  type ExecResult,
  type NetworkPolicy,
  type Sandbox,
  type SandboxBackend,
  type SandboxSpec,
} from "./sandbox.ts";

// DockerSandbox: the real isolating backend for the MVP. A long-lived container
// is provisioned with hard CPU/memory caps and NO network by default; per-exec
// wall-clock caps are enforced by killing the exec. The container is force-removed
// on destroy. (Firecracker/gVisor will implement this same port for self-host /
// air-gapped; Cloudflare Sandbox SDK is the managed alternate.)
//
// Egress: --network none is the default. An allowlist requires an egress-proxy
// sidecar (a later increment); until then an allowlist is honored as "none" with
// a warning rather than silently opening the network.

function dockerNetworkArgs(net: NetworkPolicy | undefined, warn: (m: string) => void): string[] {
  if (!net || net === "none") return ["--network", "none"];
  warn("Docker allowlist egress needs a proxy sidecar (not in this build) — defaulting to --network none");
  return ["--network", "none"];
}

interface RunOpts {
  input?: string;
  timeoutMs?: number;
}

function runDocker(args: string[], opts: RunOpts = {}): Promise<ExecResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn("docker", args, { shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut, durationMs: Date.now() - start });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut, durationMs: Date.now() - start });
    });
  });
}

export function dockerAvailable(): Promise<boolean> {
  return runDocker(["version", "--format", "{{.Server.Version}}"]).then((r) => r.code === 0);
}

class DockerSandboxInstance implements Sandbox {
  readonly id: string;
  readonly backend = "docker";
  readonly workdir = "/work";
  private readonly defaultTimeout: number;
  private destroyed = false;

  constructor(id: string, timeoutMs: number) {
    this.id = id;
    this.defaultTimeout = timeoutMs;
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const target = posixJoin(this.workdir, relPath);
    const r = await runDocker(
      ["exec", "-i", this.id, "sh", "-c", `mkdir -p "$(dirname '${target}')" && cat > '${target}'`],
      { input: content },
    );
    if (r.code !== 0) throw new Error(`docker writeFile failed: ${r.stderr}`);
  }

  async readFile(relPath: string): Promise<string> {
    const r = await runDocker(["exec", this.id, "cat", posixJoin(this.workdir, relPath)]);
    if (r.code !== 0) throw new Error(`docker readFile failed: ${r.stderr}`);
    return r.stdout;
  }

  exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(opts.env ?? {})) envArgs.push("-e", `${k}=${v}`);
    const wd = opts.cwd ? posixJoin(this.workdir, opts.cwd) : this.workdir;
    return runDocker(["exec", "-w", wd, ...envArgs, this.id, cmd, ...args], {
      timeoutMs: opts.timeoutMs ?? this.defaultTimeout,
    });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await runDocker(["rm", "-f", this.id]);
  }
}

export class DockerSandboxBackend implements SandboxBackend {
  readonly name = "docker";
  private readonly warn: (msg: string) => void;

  constructor(warn: (msg: string) => void = () => {}) {
    this.warn = warn;
  }

  async provision(spec: SandboxSpec): Promise<Sandbox> {
    const limits = { ...DEFAULT_LIMITS, ...spec.limits };
    const id = `cavix-${randomUUID().slice(0, 12)}`;
    const image = spec.image ?? "alpine:3.20";
    const args = [
      "run", "-d", "--rm", "--name", id,
      ...dockerNetworkArgs(spec.network, this.warn),
      "--cpus", String(limits.cpus),
      "--memory", `${limits.memoryMb}m`,
      "--pids-limit", "256",
      "--read-only", "--tmpfs", "/work:rw,exec",
      "-w", "/work",
      image, "sh", "-c", "tail -f /dev/null",
    ];
    const r = await runDocker(args);
    if (r.code !== 0) throw new Error(`docker provision failed: ${r.stderr}`);
    return new DockerSandboxInstance(id, limits.timeoutMs);
  }
}

function posixJoin(a: string, b: string): string {
  return `${a.replace(/\/$/, "")}/${b.replace(/^\//, "")}`;
}
