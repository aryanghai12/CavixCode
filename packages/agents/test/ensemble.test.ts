import { test } from "node:test";
import assert from "node:assert/strict";
import { Gateway, FakeProvider, type GatewayConfigData } from "@cavix/gateway";
import { AgentEnsemble, parseAgentReply, AGENTS } from "@cavix/agents";

// A fake "model" that detects which agent is calling (from its system prompt) and
// returns a scripted reply: security + api-breaking find issues (api-breaking
// cites a cross-file caller); everyone else abstains.
function agentAwareResponder(req: { system?: string }): string {
  const id = /Cavix "([\w-]+)" review agent/.exec(req.system ?? "")?.[1] ?? "";
  if (id === "security") {
    return JSON.stringify({
      abstain: false,
      findings: [{ path: "src/users.js", line: 5, severity: "critical", category: "security", title: "SQL injection", body: "concat into query", confidence: 0.9 }],
    });
  }
  if (id === "api-breaking") {
    return JSON.stringify({
      abstain: false,
      findings: [{
        path: "src/auth.ts", line: 2, severity: "high", category: "api-breaking",
        title: "validateToken signature change breaks caller",
        body: "Adding a required arg breaks handleLogin in routes.ts.",
        confidence: 0.85,
        evidence: [{ path: "src/routes.ts", line: 3, note: "handleLogin calls validateToken with one arg" }],
      }],
    });
  }
  return JSON.stringify({ abstain: true, findings: [] });
}

function makeEnsemble() {
  const config: GatewayConfigData = { orgs: { acme: { provider: "fake", apiKey: "k", model: "unused" } } };
  const gateway = new Gateway({ providers: new Map([["fake", new FakeProvider(agentAwareResponder)]]), config });
  return { gateway, ensemble: new AgentEnsemble({ gateway }) };
}

const INPUT = { org: "acme", title: "change", diff: "diff --git a/x b/x", contextPrompt: "ctx" };

test("ensemble: runs all 7 agents; security + api-breaking report, others abstain", async () => {
  const { ensemble } = makeEnsemble();
  const res = await ensemble.run(INPUT);
  assert.equal(res.perAgent.length, 7);
  assert.equal(res.findings.length, 2);
  const agents = new Set(res.findings.map((f) => f.agent));
  assert.ok(agents.has("security") && agents.has("api-breaking"));
  assert.ok(res.abstainedAgents.includes("performance"));
  assert.ok(res.abstainedAgents.includes("correctness"));
  assert.equal(res.abstainedAgents.length, 5);
});

test("ensemble: findings carry agent attribution and cross-file evidence", async () => {
  const { ensemble } = makeEnsemble();
  const res = await ensemble.run(INPUT);
  const apiFinding = res.findings.find((f) => f.agent === "api-breaking")!;
  assert.equal(apiFinding.source, "llm");
  assert.ok(apiFinding.evidence && apiFinding.evidence.length === 1);
  assert.equal(apiFinding.evidence![0].path, "src/routes.ts", "evidence cites the cross-file caller");
});

test("ensemble: model routing sends frontier agents to the frontier model", async () => {
  const { ensemble } = makeEnsemble();
  const res = await ensemble.run(INPUT);
  const security = res.perAgent.find((a) => a.agentId === "security")!;
  const performance = res.perAgent.find((a) => a.agentId === "performance")!;
  assert.equal(security.model, "claude-opus-4-8", "security routes to frontier");
  assert.equal(performance.model, "claude-sonnet-4-6", "performance routes to cheap");
  assert.ok(res.totalCostUsd > 0, "ensemble accrues cost");
});

test("ensemble: per-agent tier override is honored", async () => {
  const config: GatewayConfigData = { orgs: { acme: { provider: "fake", apiKey: "k", model: "u" } } };
  const gateway = new Gateway({ providers: new Map([["fake", new FakeProvider(agentAwareResponder)]]), config });
  const ensemble = new AgentEnsemble({ gateway, tierConfig: { cheap: "claude-sonnet-4-6", frontier: "claude-opus-4-8", perAgent: { performance: "frontier" } } });
  const res = await ensemble.run(INPUT);
  assert.equal(res.perAgent.find((a) => a.agentId === "performance")!.model, "claude-opus-4-8");
});

test("parseAgentReply: malformed reply abstains rather than throwing", () => {
  const spec = AGENTS[0];
  assert.equal(parseAgentReply("not json", spec).abstained, true);
  assert.equal(parseAgentReply('{"abstain":true,"findings":[]}', spec).abstained, true);
});
