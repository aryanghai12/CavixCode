import type { Finding } from "@cavix/core";
import type { Gateway } from "@cavix/gateway";
import type { ProjectSetup } from "./setup.ts";
import { semanticsFor, type GeneratedTest, type VerifyContext } from "./types.ts";

// Generates the minimal reproduction (or PoC exploit) test for a finding. The
// model is asked for a SELF-CONTAINED test plus, when possible, a full-file fix —
// so the verifier can run repro → fix → re-run entirely in the sandbox.

export interface TestGenerator {
  generate(finding: Finding, ctx: VerifyContext, setup: ProjectSetup): Promise<{ generated: GeneratedTest; costUsd: number }>;
}

export class GatewayTestGenerator implements TestGenerator {
  private readonly gateway: Gateway;
  private readonly model?: string;
  constructor(opts: { gateway: Gateway; model?: string }) {
    this.gateway = opts.gateway;
    this.model = opts.model;
  }

  async generate(finding: Finding, ctx: VerifyContext, setup: ProjectSetup) {
    const semantics = semanticsFor(finding);
    const kind = semantics === "exploit-passes-on-vuln" ? "a proof-of-concept exploit test that PASSES while the vulnerability exists" : "a minimal failing test that FAILS because of the bug";
    const base = (finding.path.split("/").pop() ?? "case").replace(/\.[^.]+$/, "");
    const system = `You write ${setup.framework} tests for ${setup.language}. Produce ${kind}. Also produce a full-file fix when you can. Respond ONLY with JSON: {"testCode":"...","testPath":"...","fix":{"path":"...","content":"..."}|null}.`;
    const filesBlock = ctx.files.map((f) => `// ${f.path}\n${f.content}`).join("\n\n");
    const user = `Finding: [${finding.severity}/${finding.category}] ${finding.title}\n${finding.body}\nLocation: ${finding.path}:${finding.line}\nSuggested fix: ${finding.suggestion ?? "(none)"}\n\nRepo files:\n${filesBlock}`;

    const { response, cost } = await this.gateway.complete(ctx.org, {
      model: this.model,
      maxTokens: 1500,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }],
    });
    const parsed = JSON.parse(extractJson(response.text));
    return {
      generated: {
        testPath: parsed.testPath || setup.testPathFor(base),
        testCode: String(parsed.testCode ?? ""),
        fix: parsed.fix ? { path: String(parsed.fix.path), content: String(parsed.fix.content) } : undefined,
        semantics,
      },
      costUsd: cost.costUsd,
    };
  }
}

// FakeTestGenerator: canned tests keyed by finding ruleId/title — used by the
// real-sandbox demo and hermetic tests (stands in for the model's output).
export class FakeTestGenerator implements TestGenerator {
  private readonly fn: (finding: Finding, setup: ProjectSetup) => GeneratedTest;
  constructor(fn: (finding: Finding, setup: ProjectSetup) => GeneratedTest) {
    this.fn = fn;
  }
  async generate(finding: Finding, _ctx: VerifyContext, setup: ProjectSetup) {
    return { generated: this.fn(finding, setup), costUsd: 0 };
  }
}

function extractJson(text: string): string {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("test generator returned no JSON");
  return text.slice(s, e + 1);
}
