import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_LIMITS,
  type ExecOptions,
  type ExecResult,
  type Sandbox,
  type SandboxBackend,
  type SandboxSpec,
} from "./sandbox.ts";

// LocalSandbox runs commands in an ephemeral temp directory on the host. It
// enforces the WALL-CLOCK cap (kills the process) but does NOT provide kernel
// isolation or true egress control — it is a developer/test backend only. Use the
// Docker/Firecracker backends for untrusted code. This is logged loudly so it can
// never be mistaken for an isolating backend in production.

class LocalSandboxInstance implements Sandbox {
  readonly id: string;
  readonly backend = "local";
  readonly workdir: string;
  private readonly defaultTimeout: number;
  private destroyed = false;

  constructor(id: string, workdir: string, timeoutMs: number) {
    this.id = id;
    this.workdir = workdir;
    this.defaultTimeout = timeoutMs;
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const abs = this.resolve(relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  async readFile(relPath: string): Promise<string> {
    return readFile(this.resolve(relPath), "utf8");
  }

  exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeout;
    const start = Date.now();
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd ? this.resolve(opts.cwd) : this.workdir,
        env: cleanEnv(opts.env),
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut, durationMs: Date.now() - start });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr, timedOut, durationMs: Date.now() - start });
      });
    });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await rm(this.workdir, { recursive: true, force: true });
  }

  private resolve(relPath: string): string {
    // Confine paths to the workdir (defense in depth against path traversal).
    const abs = path.resolve(this.workdir, relPath);
    if (abs !== this.workdir && !abs.startsWith(this.workdir + path.sep)) {
      throw new Error(`path escapes sandbox workdir: ${relPath}`);
    }
    return abs;
  }
}

// The sandbox must not leak the host's runtime context into the child. In
// particular NODE_TEST_CONTEXT / NODE_OPTIONS (set when Cavix itself runs under
// `node --test`) would make a nested `node --test` in the sandbox misreport its
// exit code. Strip those so sandboxed processes start from a clean context.
function cleanEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return env;
}

export class LocalSandboxBackend implements SandboxBackend {
  readonly name = "local";
  private readonly warn: (msg: string) => void;

  constructor(warn: (msg: string) => void = () => {}) {
    this.warn = warn;
  }

  async provision(spec: SandboxSpec): Promise<Sandbox> {
    this.warn(
      "LocalSandbox provides NO isolation or egress control — dev/test only. Use Docker/Firecracker for untrusted code.",
    );
    const id = `local-${randomUUID().slice(0, 8)}`;
    const dir = await mkdtemp(path.join(os.tmpdir(), "cavix-sbx-"));
    const timeoutMs = spec.limits?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs;
    return new LocalSandboxInstance(id, dir, timeoutMs);
  }
}
