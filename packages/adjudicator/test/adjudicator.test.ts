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
