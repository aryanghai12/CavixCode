import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding, Severity } from "@cavix/core";
import { adjudicate } from "@cavix/adjudicator";

function mk(p: Partial<Finding> & { path: string; line: number }): Finding {
  return {
    severity: "medium" as Severity,
    category: "security",
    title: "issue",
    body: "b",
    source: "llm",
    confidence: 0.6,
    ...p,
  };
}

test("dedupe + vote: two agents on the same spot merge and gain confidence", () => {
  const res = adjudicate([
    mk({ path: "a.js", line: 10, agent: "security", title: "SQL injection", confidence: 0.4 }),
    mk({ path: "a.js", line: 11, agent: "correctness", title: "SQL injection risk", confidence: 0.45 }),
  ]);
  assert.equal(res.findings.length, 1, "two overlapping findings merge into one");
  assert.equal(res.clusters, 1);
  const v = res.votesByFinding[0];
  assert.equal(v.votes, 2);
  assert.ok(v.confidence > 0.45, `agreement should boost confidence, got ${v.confidence}`);
  assert.match(res.findings[0].body, /Corroborated by 2/);
});

test("threshold: a lone low-confidence LLM finding is dropped", () => {
  const res = adjudicate([mk({ path: "a.js", line: 5, confidence: 0.3, title: "maybe bug" })], { confidenceThreshold: 0.5 });
  assert.equal(res.findings.length, 0);
  assert.equal(res.dropped.length, 1);
  assert.match(res.dropped[0].reason, /below confidence/);
});

test("deterministic findings survive regardless of confidence", () => {
  const res = adjudicate([mk({ path: "a.js", line: 5, source: "sast", confidence: 0.2, title: "md5" })]);
  assert.equal(res.findings.length, 1, "sast finding is a fact; not dropped");
});

test("max severity wins within a merged cluster", () => {
  const res = adjudicate([
    mk({ path: "a.js", line: 10, agent: "x", severity: "low", title: "SQL injection" }),
    mk({ path: "a.js", line: 10, agent: "y", severity: "critical", title: "SQL injection" }),
  ]);
  assert.equal(res.findings[0].severity, "critical");
});

test("immutable policy finding survives untouched even when everything else is dropped", () => {
  const policy = mk({
    path: "routes.js", line: 3, source: "policy", immutable: true, confidence: 1,
    category: "governance", title: "Endpoint missing auth check", body: "ORIGINAL POLICY TEXT",
    severity: "high",
  });
  const weakLlm = mk({ path: "x.js", line: 9, confidence: 0.1, title: "speculative" });

  const res = adjudicate([policy, weakLlm], { confidenceThreshold: 0.9 });
  assert.equal(res.immutableKept, 1);
  const survived = res.findings.find((f) => f.source === "policy");
  assert.ok(survived, "policy finding must survive adjudication");
  assert.equal(survived!.body, "ORIGINAL POLICY TEXT", "immutable finding is not rewritten");
  assert.ok(!res.findings.some((f) => f.title === "speculative"), "the weak LLM finding is dropped");
});

test("immutable finding is not merged away by a colliding LLM finding", () => {
  const policy = mk({ path: "a.js", line: 10, source: "policy", immutable: true, title: "policy: missing auth", confidence: 1 });
  const llm = mk({ path: "a.js", line: 10, agent: "security", title: "policy missing auth", confidence: 0.9 });
  const res = adjudicate([policy, llm]);
  // Policy survives as its own finding; the LLM one is adjudicated separately.
  assert.ok(res.findings.some((f) => f.immutable === true));
  assert.equal(res.immutableKept, 1);
});

test("gate OFF (no immutable findings): nothing is force-passed", () => {
  const res = adjudicate([mk({ path: "a.js", line: 1, confidence: 0.2, title: "weak" })], { confidenceThreshold: 0.6 });
  assert.equal(res.findings.length, 0, "with no policy findings, weak findings are simply dropped");
  assert.equal(res.immutableKept, 0);
});

// ── Stage 12: the workspace's own learned bar, per category ───────────────────

test("a learned category threshold replaces the default for that category only", () => {
  const nit = mk({ path: "a.js", line: 1, category: "style", confidence: 0.55, title: "naming" });
  const bug = mk({ path: "b.js", line: 1, category: "correctness", confidence: 0.55, title: "off by one" });

  const res = adjudicate([nit, bug], { confidenceThreshold: 0.5, thresholdByCategory: { style: 0.7 } });

  assert.ok(!res.findings.some((f) => f.category === "style"), "style is held to the learned bar");
  assert.ok(res.findings.some((f) => f.category === "correctness"), "correctness keeps the default");
  assert.match(res.dropped[0].reason, /learned "style" threshold/);
});

test("a learned threshold can LOWER the bar for a category the team trusts", () => {
  const sec = mk({ path: "a.js", line: 1, category: "security", confidence: 0.4, title: "ssrf" });
  const strict = adjudicate([sec], { confidenceThreshold: 0.5 });
  assert.equal(strict.findings.length, 0);

  const learned = adjudicate([sec], { confidenceThreshold: 0.5, thresholdByCategory: { security: 0.35 } });
  assert.equal(learned.findings.length, 1, "the workspace's own bar surfaces it");
});

test("no learned threshold cannot silently mean zero", () => {
  // An empty map, or a category that is simply absent from it, must fall back to
  // the default. Reading a missing entry as 0 would post everything.
  const weak = mk({ path: "a.js", line: 1, category: "style", confidence: 0.1, title: "weak" });
  const res = adjudicate([weak], { confidenceThreshold: 0.5, thresholdByCategory: {} });
  assert.equal(res.findings.length, 0);
});

test("a learned threshold never touches deterministic facts or policy findings", () => {
  // The whole invariant, restated against the new input: Stage 12 tunes what the
  // MODELS are trusted to say, never what a scanner measured or a gate decided.
  const fact = mk({ path: "a.js", line: 1, source: "sast", category: "security", confidence: 0.05, title: "hardcoded key" });
  const policy = mk({ path: "b.js", line: 1, source: "policy", immutable: true, category: "security", confidence: 0.05, title: "no auth" });

  const res = adjudicate([fact, policy], { thresholdByCategory: { security: 0.9 } });
  assert.equal(res.findings.length, 2, "neither is subject to a learned bar");
  assert.equal(res.dropped.length, 0);
});

test("agreement cannot vote a phantom into existence", () => {
  // Two agents report the same invented finding. Independent agreement raises
  // confidence, and for models of one family it is not independent at all: this
  // is exactly how a hallucination used to clear the bar. The critic's screen
  // runs before clustering so the vote never happens.
  const a = mk({ path: "ghost.ts", line: 9, title: "null deref", confidence: 0.6, agent: "correctness" });
  const b = mk({ path: "ghost.ts", line: 9, title: "null deref", confidence: 0.6, agent: "security" });

  const withoutCritic = adjudicate([a, b], { confidenceThreshold: 0.7 });
  assert.equal(withoutCritic.findings.length, 1, "agreement alone clears the bar");
  assert.ok(withoutCritic.findings[0].confidence >= 0.7);

  const withCritic = adjudicate([a, b], {
    confidenceThreshold: 0.7,
    unsupported: (f) => (f.path === "ghost.ts" ? "critic: `ghost.ts` is not part of this change" : undefined),
  });
  assert.equal(withCritic.findings.length, 0);
  assert.equal(withCritic.dropped.length, 2, "both copies, not just the merged one");
  assert.match(withCritic.dropped[0].reason, /not part of this change/);
});

test("the critic never overrules a deterministic fact or a policy gate", () => {
  const fact = mk({ path: "ghost.ts", line: 1, source: "sast", title: "hardcoded key", confidence: 0.9 });
  const policy = mk({ path: "ghost.ts", line: 1, source: "policy", immutable: true, title: "no auth", confidence: 0.9 });
  const guess = mk({ path: "ghost.ts", line: 40, title: "invented", confidence: 0.9 });

  const res = adjudicate([fact, policy, guess], { unsupported: () => "critic: not part of this change" });
  assert.equal(res.dropped.length, 1, "only the LLM finding");
  assert.equal(res.dropped[0].finding.title, "invented");
  assert.equal(res.findings.length, 2);
});

test("no critic is not a failed critic", () => {
  const f = mk({ path: "a.js", line: 1, title: "real", confidence: 0.9 });
  const res = adjudicate([f], {});
  assert.equal(res.findings.length, 1);
  assert.equal(res.dropped.length, 0);
});
