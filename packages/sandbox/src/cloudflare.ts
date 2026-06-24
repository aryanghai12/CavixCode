import type { ExecOptions, ExecResult, Sandbox, SandboxBackend, SandboxSpec } from "./sandbox.ts";

// CloudflareSandboxBackend: the managed-cloud alternate to Docker/Firecracker.
// It maps the Sandbox port onto the Cloudflare Sandbox SDK, loaded lazily through
// a non-literal specifier so the type checker and minimal/air-gapped installs do
// not require the SDK. If the SDK is absent it fails with a clear, actionable
// error rather than a build break. (Runtime-untested here — no SDK/network in this
// environment — but wired so the backend is a config switch.)

const SDK = "@cloudflare/sandbox";

interface CfSdk {
  getSandbox(env: unknown, id: string): CfSandboxHandle;
}
interface CfSandboxHandle {
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<{ content: string }>;
  exec(cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  destroy?(): Promise<void>;
}

export interface CloudflareSandboxOptions {
  /** The Workers env binding that exposes the Sandbox Durable Object. */
  env: unknown;
}

class CloudflareSandboxInstance implements Sandbox {
  readonly id: string;
  readonly backend = "cloudflare";
  readonly workdir = "/workspace";
  private readonly handle: CfSandboxHandle;

  constructor(id: string, handle: CfSandboxHandle) {
    this.id = id;
    this.handle = handle;
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    await this.handle.writeFile(`${this.workdir}/${relPath}`, content);
  }
  async readFile(relPath: string): Promise<string> {
    return (await this.handle.readFile(`${this.workdir}/${relPath}`)).content;
  }
  async exec(cmd: string, args: string[], _opts?: ExecOptions): Promise<ExecResult> {
    const start = Date.now();
    const r = await this.handle.exec([cmd, ...args].join(" "));
    return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: false, durationMs: Date.now() - start };
  }
  async destroy(): Promise<void> {
    await this.handle.destroy?.();
  }
}

export class CloudflareSandboxBackend implements SandboxBackend {
  readonly name = "cloudflare";
  private readonly env: unknown;
  private seq = 0;

  constructor(opts: CloudflareSandboxOptions) {
    this.env = opts.env;
  }

  async provision(_spec: SandboxSpec): Promise<Sandbox> {
    let sdk: CfSdk;
    try {
      sdk = (await import(SDK)) as unknown as CfSdk;
    } catch {
      throw new Error(
        "CloudflareSandboxBackend requires '@cloudflare/sandbox'. Install it, or use the Docker/local backend.",
      );
    }
    const id = `cf-${++this.seq}-${Date.now()}`;
    const handle = sdk.getSandbox(this.env, id);
    return new CloudflareSandboxInstance(id, handle);
  }
}
