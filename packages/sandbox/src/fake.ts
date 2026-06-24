import type { ExecOptions, ExecResult, Sandbox, SandboxBackend, SandboxSpec } from "./sandbox.ts";

// FakeSandbox: in-memory workspace with scripted exec results. Lets the
// verification pipeline be tested deterministically without any runtime.

export type ExecResponder = (cmd: string, args: string[]) => Partial<ExecResult>;

class FakeSandboxInstance implements Sandbox {
  readonly id: string;
  readonly backend = "fake";
  readonly workdir = "/sandbox";
  readonly files = new Map<string, string>();
  readonly execLog: Array<{ cmd: string; args: string[] }> = [];
  destroyed = false;
  private readonly responder: ExecResponder;

  constructor(id: string, responder: ExecResponder) {
    this.id = id;
    this.responder = responder;
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    this.files.set(relPath, content);
  }
  async readFile(relPath: string): Promise<string> {
    const v = this.files.get(relPath);
    if (v === undefined) throw new Error(`no such file: ${relPath}`);
    return v;
  }
  async exec(cmd: string, args: string[], _opts?: ExecOptions): Promise<ExecResult> {
    this.execLog.push({ cmd, args });
    const r = this.responder(cmd, args);
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: r.timedOut ?? false, durationMs: r.durationMs ?? 1 };
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

export class FakeSandboxBackend implements SandboxBackend {
  readonly name = "fake";
  private readonly responder: ExecResponder;
  private seq = 0;

  constructor(responder: ExecResponder = () => ({ code: 0 })) {
    this.responder = responder;
  }

  async provision(_spec: SandboxSpec): Promise<Sandbox> {
    return new FakeSandboxInstance(`fake-${++this.seq}`, this.responder);
  }
}
