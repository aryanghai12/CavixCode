import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SignalModelRouter,
  ConfigModelRouter,
  signalsFor,
  NO_SIGNALS,
  type AgentSpec,
  type ModelTierConfig,
} from "@cavix/agents";

const CFG: ModelTierConfig = { cheap: "cheap-model", frontier: "frontier-model" };

const cheapAgent: AgentSpec = { id: "standards", category: "style", tier: "cheap", mission: "house style" };
const frontierAgent: AgentSpec = { id: "security", category: "security", tier: "frontier", mission: "exploits" };

const diff = (path: string, body: string) =>
  `diff --git a/${path} b/${path}
index 1111111..2222222 100644
--- a/${path}
+++ b/${path}
@@ -1,2 +1,3 @@
 const x = 1;
${body
  .split("\n")
  .map((l) => `+${l}`)
  .join("\n")}
`;

test("with no signals, routing is exactly what the tier map says", () => {
  const router = new SignalModelRouter(CFG, NO_SIGNALS);
  assert.equal(router.modelFor(cheapAgent), "cheap-model");
  assert.equal(router.modelFor(frontierAgent), "frontier-model");
  assert.equal(router.decide(cheapAgent).escalated, false);
});

test("a wide blast radius escalates a cheap agent, and the reason names the number", () => {
  const router = new SignalModelRouter(CFG, { ...NO_SIGNALS, callerCount: 40 });
  const d = router.decide(cheapAgent);
  assert.equal(d.tier, "frontier");
  assert.equal(d.escalated, true);
  assert.match(d.reason, /40 call sites/);
});

test("a sensitive path escalates", () => {
  const router = new SignalModelRouter(CFG, { ...NO_SIGNALS, sensitivePath: true });
  assert.equal(router.modelFor(cheapAgent), "frontier-model");
});

test("concurrency escalates", () => {
  const router = new SignalModelRouter(CFG, { ...NO_SIGNALS, concurrency: true });
  assert.match(router.decide(cheapAgent).reason, /locks or transactions/);
});

test("a signature change with callers outranks a bare signature change", () => {
  const withCallers = new SignalModelRouter(CFG, { ...NO_SIGNALS, apiSurfaceChange: true, callerCount: 3 });
  assert.match(withCallers.decide(cheapAgent).reason, /3 call sites can reach it/);
  const bare = new SignalModelRouter(CFG, { ...NO_SIGNALS, apiSurfaceChange: true });
  assert.equal(bare.decide(cheapAgent).reason, "an exported signature changed");
});

test("a small local change is never escalated", () => {
  const router = new SignalModelRouter(CFG, { ...NO_SIGNALS, crossFile: true, changedLines: 12, fileCount: 2 });
  assert.equal(router.modelFor(cheapAgent), "cheap-model");
});

test("signals never DEMOTE a frontier agent", () => {
  // One-directional on purpose. Quietly demoting a security agent on a quiet
  // diff to save a fraction of a cent is how a security review comes back clean
  // because nobody good read it.
  const router = new SignalModelRouter(CFG, NO_SIGNALS);
  const d = router.decide(frontierAgent);
  assert.equal(d.tier, "frontier");
  assert.equal(d.escalated, false);
});

test("a per-agent override still wins over the agent's default", () => {
  const router = new SignalModelRouter({ ...CFG, perAgent: { security: "cheap" } }, NO_SIGNALS);
  assert.equal(router.modelFor(frontierAgent), "cheap-model");
});

test("a per-agent override can still be escalated by the work", () => {
  const router = new SignalModelRouter({ ...CFG, perAgent: { security: "cheap" } }, { ...NO_SIGNALS, sensitivePath: true });
  assert.equal(router.modelFor(frontierAgent), "frontier-model");
});

test("decisions are stable within one change", () => {
  const router = new SignalModelRouter(CFG, { ...NO_SIGNALS, sensitivePath: true });
  assert.deepEqual(router.decide(cheapAgent), router.decide(cheapAgent));
});

test("pointing the router at a new change re-decides", () => {
  const router = new SignalModelRouter(CFG, { ...NO_SIGNALS, sensitivePath: true });
  assert.equal(router.modelFor(cheapAgent), "frontier-model");
  router.withSignals(NO_SIGNALS);
  assert.equal(router.modelFor(cheapAgent), "cheap-model");
});

test("the old router is untouched", () => {
  const router = new ConfigModelRouter(CFG);
  assert.equal(router.modelFor(cheapAgent), "cheap-model");
  assert.equal(router.modelFor(frontierAgent), "frontier-model");
});

// ---------- reading signals off a real diff ----------

test("signalsFor spots a security-sensitive path", () => {
  const s = signalsFor({ diff: diff("src/auth/session.ts", "const t = 1;") });
  assert.equal(s.sensitivePath, true);
});

test("signalsFor does not call an ordinary path sensitive", () => {
  const s = signalsFor({ diff: diff("src/ui/button.tsx", "const t = 1;") });
  assert.equal(s.sensitivePath, false);
});

test("signalsFor spots coordination in the changed lines only", () => {
  assert.equal(signalsFor({ diff: diff("src/a.ts", "await Promise.all(tasks);") }).concurrency, true);
  assert.equal(signalsFor({ diff: diff("src/a.ts", "const total = 1 + 2;") }).concurrency, false);
});

test("signalsFor spots an exported signature change", () => {
  assert.equal(signalsFor({ diff: diff("src/a.ts", "export function refund(id: string) {") }).apiSurfaceChange, true);
  assert.equal(signalsFor({ diff: diff("src/a.ts", "  const local = 1;") }).apiSurfaceChange, false);
});

test("signalsFor counts changed lines and files, not context", () => {
  const s = signalsFor({ diff: diff("src/a.ts", "one\ntwo\nthree") });
  assert.equal(s.changedLines, 3);
  assert.equal(s.fileCount, 1);
  assert.equal(s.crossFile, false);
});

test("signalsFor honours a workspace's own sensitive globs", () => {
  const plain = signalsFor({ diff: diff("src/ledger/post.ts", "const t = 1;") });
  assert.equal(plain.sensitivePath, false);
  const marked = signalsFor({
    diff: diff("src/ledger/post.ts", "const t = 1;"),
    sensitiveGlobs: ["src/ledger/**"],
  });
  assert.equal(marked.sensitivePath, true);
});

test("signalsFor carries through what other stages measured", () => {
  const s = signalsFor({ diff: diff("src/a.ts", "x"), callerCount: 12, toolHits: 3 });
  assert.equal(s.callerCount, 12);
  assert.equal(s.toolHits, 3);
});
