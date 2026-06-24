import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeIndex, HeuristicParser, FakeEmbedder } from "@cavix/analyzer";
import { Gateway, FakeProvider, type GatewayConfigData } from "@cavix/gateway";
import { FakeCompressor, FakePastDiscussions } from "@cavix/context";
import { PolicyEngine, type OrgPolicyConfig } from "@cavix/policy";
import { runPhase1Review, type SourceFile } from "@cavix/pipeline";

const AUTH = `export function validateToken(token) {
  return token && token.length > 0;
}
`;
const ROUTES = `import { validateToken } from "./auth";
const app = require("express")();
app.get("/orders", (req, res) => {
  return res.json(db.orders.find());
});
export function handleLogin(req, res) {
  if (!validateToken(req.token)) return res.status(401).end();
  return res.send("ok");
}
`;

// Diff changes validateToken to require a second argument — only breaks because
// of how handleLogin (another file) calls it. A diff-only reviewer can't see that.
const DIFF = `diff --git a/auth.ts b/auth.ts
--- a/auth.ts
+++ b/auth.ts
@@ -1,3 +1,3 @@
-export function validateToken(token) {
-  return token && token.length > 0;
+export function validateToken(token, opts) {
+  return token && token.length > 0 && opts.strict;
 }
`;

const SOURCE: SourceFile[] = [
  { path: "auth.ts", content: AUTH },
  { path: "routes.ts", content: ROUTES },
];

// The "model": the api-breaking agent only raises the issue when the assembled
// context actually contains the cross-file caller — proving the catch required
// another file. Everyone else abstains.
function contextAwareResponder(req: { system?: string; messages: Array<{ content: string }> }): string {
  const id = /Cavix "([\w-]+)" review agent/.exec(req.system ?? "")?.[1] ?? "";
  const ctx = req.messages.map((m) => m.content).join("\n");
  if (id === "api-breaking" && /handleLogin/.test(ctx)) {
    return JSON.stringify({
      abstain: false,
      findings: [{
        path: "auth.ts", line: 1, severity: "high", category: "api-breaking",
        title: "validateToken now requires opts; existing caller breaks",
        body: "handleLogin calls validateToken(req.token) with one argument; opts.strict will throw.",
        confidence: 0.9,
        evidence: [{ path: "routes.ts", line: 7, note: "handleLogin calls validateToken with a single arg" }],
      }],
    });
  }
  return JSON.stringify({ abstain: true, findings: [] });
}

function buildDeps() {
  const index = new CodeIndex(new HeuristicParser());
  index.indexFiles(SOURCE);
  const config: GatewayConfigData = { orgs: { acme: { provider: "fake", apiKey: "k", model: "u" } } };
  const gateway = new Gateway({ providers: new Map([["fake", new FakeProvider(contextAwareResponder)]]), config });
  return {
    gateway,
    index,
    sourceFiles: SOURCE,
    policyEngine: new PolicyEngine(),
    discussions: new FakePastDiscussions(),
    embedder: new FakeEmbedder(),
    compressor: new FakeCompressor(),
  };
}

test("pipeline: produces a cross-file catch grounded in another file (gate OFF)", async () => {
  const res = await runPhase1Review({ org: "acme", title: "tighten validateToken" , diff: DIFF }, buildDeps());

  const xfile = res.findings.find((f) => f.agent === "api-breaking");
  assert.ok(xfile, "api-breaking finding present");
  assert.ok(xfile!.evidence?.some((e) => e.path === "routes.ts"), "cites the cross-file caller routes.ts");
  assert.equal(res.policyCount, 0, "gate OFF → no policy findings");
  assert.equal(res.immutableKept, 0, "nothing force-passed when gate off");
  assert.ok(res.context.blastFiles.includes("routes.ts"), "blast radius reached routes.ts");
});

test("pipeline: enabled policy gate emits an immutable finding that survives", async () => {
  const policyConfig: OrgPolicyConfig = { enabled: true, rules: { "endpoint-needs-auth": { enabled: true } } };
  const res = await runPhase1Review({ org: "acme", title: "tighten validateToken", diff: DIFF, policyConfig }, buildDeps());

  const policy = res.findings.find((f) => f.source === "policy");
  assert.ok(policy, "policy finding present");
  assert.equal(policy!.immutable, true);
  assert.equal(res.immutableKept, 1, "policy finding survived adjudication");
  assert.match(policy!.title, /auth/i);
  // The cross-file LLM catch is still there alongside the policy finding.
  assert.ok(res.findings.some((f) => f.agent === "api-breaking"));
});

test("pipeline: the SAME run with gate off vs on differs only by the policy finding", async () => {
  const off = await runPhase1Review({ org: "acme", title: "t", diff: DIFF }, buildDeps());
  const on = await runPhase1Review(
    { org: "acme", title: "t", diff: DIFF, policyConfig: { enabled: true, rules: { "endpoint-needs-auth": { enabled: true } } } },
    buildDeps(),
  );
  assert.equal(on.findings.length, off.findings.length + 1, "gate adds exactly its policy finding");
});
