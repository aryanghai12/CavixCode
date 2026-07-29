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
    const target = this.resolve(relPath);
    // The path is passed as an ARGUMENT to sh, never spliced into the script.
    //
    // It used to be interpolated between single quotes, and the paths reaching
    // here come from findings, which come from a model reading somebody else's
    // diff. One apostrophe in a filename closed the quote and the rest of the
    // path became shell. Inside a read-only, network-less container that is
    // contained, but it is contained by the container's configuration rather
    // than by this code, and what it could still corrupt is the verification
    // itself: a proof that can be steered is not a proof.
    const r = await runDocker(
      [
        "exec", "-i", this.id,
        "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"',
        "sh", target,
      ],
      { input: content },
    );
    if (r.code !== 0) throw new Error(`docker writeFile failed: ${r.stderr}`);
  }

  async readFile(relPath: string): Promise<string> {
    const r = await runDocker(["exec", this.id, "cat", this.resolve(relPath)]);
    if (r.code !== 0) throw new Error(`docker readFile failed: ${r.stderr}`);
    return r.stdout;
  }

  async removeFile(relPath: string): Promise<void> {
    // -f makes a missing file a success, matching the port's contract. Anything
    // else that fails must be reported: verification removes the generated test
    // before running the repo's suite, and a silent failure there means the suite
    // gets judged on a test Cavix wrote.
    const r = await runDocker(["exec", this.id, "rm", "-f", this.resolve(relPath)]);
    if (r.code !== 0) throw new Error(`docker removeFile failed: ${r.stderr}`);
  }

  /**
   * A path inside the sandbox, refused if it points outside it.
   *
   * The same contract the Local backend has enforced since it was written, and
   * it was missing here. `/work/../../etc/passwd` was handed to the container as
   * written; the read-only rootfs happened to refuse the write, so the two
   * backends disagreed about whether a traversal was an error or a silent
   * no-op. A port whose implementations disagree about that is a port that
   * cannot be swapped, which is the entire reason it exists.
   */
  private resolve(relPath: string): string {
    return containerPath(this.workdir, relPath);
  }

  exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(opts.env ?? {})) envArgs.push("-e", `${k}=${v}`);
    // The working directory is confined too. A `cwd` that climbed out would run
    // the repo's own test command somewhere else in the container, and its exit
    // code is what the review reports as a proof.
    const wd = opts.cwd ? containerPath(this.workdir, opts.cwd) : this.workdir;
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

/**
 * Resolve a path inside the container, refusing anything that leaves it.
 *
 * Exported so it can be tested without Docker, which is the point: a
 * confinement check that only runs where a daemon is installed is one nobody
 * ever watches fail. The Local backend has enforced the same contract since it
 * was written; this one did not, so the two implementations of one port
 * disagreed about whether a traversal was an error or a silent no-op.
 *
 * The arithmetic is textual on purpose. The target is a POSIX path inside a
 * Linux container, and the host's `path` module is Windows-flavoured on half the
 * machines this runs on: `path.resolve("/work", "a")` there is "C:\\work\\a".
 */
export function containerPath(workdir: string, relPath: string): string {
  const parts: string[] = [];
  for (const segment of posixJoin(workdir, relPath).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  const abs = `/${parts.join("/")}`;
  if (abs !== workdir && !abs.startsWith(`${workdir}/`)) {
    throw new Error(`path escapes sandbox workdir: ${relPath}`);
  }
  return abs;
}
