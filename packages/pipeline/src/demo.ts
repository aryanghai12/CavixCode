// Phase 1 runnable demonstration (no infra, no API key — fakes at the LLM seam).
//   node packages/pipeline/src/demo.ts
//
// It proves the Phase 1 acceptance items end to end:
//   A) index a real medium repo (this one) and re-index incrementally;
//   B) a review catch that REQUIRED another file (cross-file);
//   C) the optional policy gate: OFF → nothing forced; ON → an immutable finding
//      the LLM never produced, surviving adjudication.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodeIndex, HeuristicParser, FakeEmbedder } from "@cavix/analyzer";
import { Gateway, FakeProvider, type GatewayConfigData } from "@cavix/gateway";
import { FakeCompressor, FakePastDiscussions } from "@cavix/context";
import { PolicyEngine, type OrgPolicyConfig } from "@cavix/policy";
import { runPhase1Review, type SourceFile } from "./pipeline.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|js|go|py)$/.test(name) && !name.endsWith(".test.ts")) acc.push(full);
  }
  return acc;
}

function section(title: string) {
  console.log("\n" + "─".repeat(70) + "\n" + title + "\n" + "─".repeat(70));
}

async function main() {
  // ── A) Index a real medium repo (this monorepo) ────────────────────────────
  section("A. Stage 4 — index a real repo (this monorepo) + incremental re-index");
  const paths = walk(path.join(repoRoot, "packages")).concat(walk(path.join(repoRoot, "services")));
  const files = paths.map((p) => ({ path: path.relative(repoRoot, p).replace(/\\/g, "/"), content: safeRead(p) }));

  const index = new CodeIndex(new HeuristicParser());
  let t = Date.now();
  index.indexFiles(files);
  const full = index.stats();
  console.log(`indexed ${full.files} files, ${full.symbols} symbols, ${full.edges} call edges in ${Date.now() - t}ms`);

  // Simulate a push that edits one file → incremental re-index.
  const target = files.find((f) => f.path.endsWith("packages/analyzer/src/indexer.ts"))!;
  t = Date.now();
  const changed = index.updateFile(target.path, target.content + "\nexport function __demoProbe(){ return 1; }\n");
  console.log(`incremental re-index of 1 file: changed=${changed} in ${Date.now() - t}ms (vs full index above)`);
  index.updateFile(target.path, target.content); // restore

  // ── B) Cross-file catch + C) policy gate ───────────────────────────────────
  const AUTH = `export function validateToken(token) {\n  return token && token.length > 0;\n}\n`;
  const ROUTES = `import { validateToken } from "./auth";\nconst app = require("express")();\napp.get("/orders", (req, res) => {\n  return res.json(db.orders.find());\n});\nexport function handleLogin(req, res) {\n  if (!validateToken(req.token)) return res.status(401).end();\n  return res.send("ok");\n}\n`;
  const DIFF = `diff --git a/auth.ts b/auth.ts\n--- a/auth.ts\n+++ b/auth.ts\n@@ -1,3 +1,3 @@\n-export function validateToken(token) {\n+export function validateToken(token, opts) {\n   return token && token.length > 0;\n }\n`;
  const SOURCE: SourceFile[] = [{ path: "auth.ts", content: AUTH }, { path: "routes.ts", content: ROUTES }];

  const prIndex = new CodeIndex(new HeuristicParser());
  prIndex.indexFiles(SOURCE);

  // A context-aware "model": api-breaking only fires when the cross-file caller
  // is actually present in the assembled context.
  const responder = (req: { system?: string; messages: Array<{ content: string }> }) => {
    const id = /Cavix "([\w-]+)" review agent/.exec(req.system ?? "")?.[1] ?? "";
    const ctx = req.messages.map((m) => m.content).join("\n");
    if (id === "api-breaking" && /handleLogin/.test(ctx)) {
      return JSON.stringify({
        abstain: false,
        findings: [{
          path: "auth.ts", line: 1, severity: "high", category: "api-breaking",
          title: "validateToken now requires `opts`; existing caller breaks",
          body: "handleLogin calls validateToken(req.token) with one argument.",
          confidence: 0.9,
          evidence: [{ path: "routes.ts", line: 7, note: "handleLogin calls validateToken with one arg" }],
        }],
      });
    }
    return JSON.stringify({ abstain: true, findings: [] });
  };
  const config: GatewayConfigData = { orgs: { acme: { provider: "fake", apiKey: "byok-acme", model: "u" } } };
  const gateway = new Gateway({ providers: new Map([["fake", new FakeProvider(responder)]]), config });
  const deps = {
    gateway, index: prIndex, sourceFiles: SOURCE,
    policyEngine: new PolicyEngine(), discussions: new FakePastDiscussions(),
    embedder: new FakeEmbedder(), compressor: new FakeCompressor(),
  };

  section("B. Cross-file catch — a finding that required another file");
  const off = await runPhase1Review({ org: "acme", title: "tighten validateToken", diff: DIFF }, deps);
  const xfile = off.findings.find((f) => f.agent === "api-breaking")!;
  console.log(`blast radius files: ${off.context.blastFiles.join(", ")}`);
  console.log(`FINDING (${xfile.severity}/${xfile.category}) @ ${xfile.path}:${xfile.line} — ${xfile.title}`);
  console.log(`  evidence: ${xfile.evidence?.map((e) => `${e.path}:${e.line} (${e.note})`).join("; ")}`);
  console.log(`  → the break is only visible because routes.ts was pulled into context by the graph.`);
  console.log(`policy findings with gate OFF: ${off.policyCount}; immutable kept: ${off.immutableKept}`);

  section("C. Optional policy gate — OFF (default) vs ON");
  const policyConfig: OrgPolicyConfig = { enabled: true, rules: { "endpoint-needs-auth": { enabled: true } } };
  const on = await runPhase1Review({ org: "acme", title: "tighten validateToken", diff: DIFF, policyConfig }, deps);
  const policy = on.findings.find((f) => f.source === "policy")!;
  console.log(`gate OFF → ${off.findings.length} findings, 0 policy.`);
  console.log(`gate ON  → ${on.findings.length} findings, ${on.policyCount} policy (immutable, survived adjudication: ${on.immutableKept}).`);
  console.log(`POLICY FINDING (immutable=${policy.immutable}) @ ${policy.path}:${policy.line} — ${policy.title}`);
  console.log(`  source=${policy.source}; produced deterministically, never seen by the LLM, cannot be dropped.`);
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
