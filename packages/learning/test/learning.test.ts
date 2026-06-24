import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "@cavix/core";
import { calibrate, Calibration, type DecisionRecord } from "@cavix/learning";

function decisions(): DecisionRecord[] {
  const out: DecisionRecord[] = [];
  for (let i = 0; i < 10; i++) out.push({ category: "standards", agent: "standards", source: "llm", confidence: 0.6, accepted: false }); // org hates nits
  for (let i = 0; i < 10; i++) out.push({ category: "security", agent: "security", source: "llm", confidence: 0.7, accepted: true }); // org trusts security
  for (let i = 0; i < 5; i++) out.push({ category: "correctness", agent: "correctness", source: "llm", confidence: 0.6, accepted: true });
  for (let i = 0; i < 5; i++) out.push({ category: "correctness", agent: "correctness", source: "llm", confidence: 0.6, accepted: false });
  return out;
}

function finding(p: Partial<Finding>): Finding {
  return { path: "a.js", line: 1, severity: "medium", category: "standards", title: "t", body: "b", source: "llm", confidence: 0.55, ...p };
}

test("calibrate: learns per-category accept rates", () => {
  const cal = calibrate(decisions());
  assert.ok(cal.categoryAcceptRate.standards < 0.2, "standards mostly rejected");
  assert.ok(cal.categoryAcceptRate.security > 0.8, "security mostly accepted");
  assert.ok(Math.abs(cal.categoryAcceptRate.correctness - 0.5) < 0.1, "correctness mixed");
});

test("Stage 9 feedback: thresholds rise for rejected categories, fall for accepted", () => {
  const cal = new Calibration(calibrate(decisions()));
  assert.ok(cal.thresholdFor("standards") > 0.6, "raise the bar on nits");
  assert.ok(cal.thresholdFor("security") < 0.4, "relax for trusted security");
});

test("Stage 10 feedback: verify mixed categories more than extreme ones", () => {
  const cal = new Calibration(calibrate(decisions()));
  assert.ok(cal.verifyGateFor("correctness") < cal.verifyGateFor("security"), "prove the uncertain category");
});

test("filterFindings: a nit that Phase 1 would keep is now dropped (FP reduction)", () => {
  const cal = new Calibration(calibrate(decisions()));
  const nit = finding({ category: "standards", agent: "standards", confidence: 0.55 });
  const sec = finding({ category: "security", agent: "security", confidence: 0.4 });
  const { kept, dropped } = cal.filterFindings([nit, sec]);
  assert.ok(dropped.some((d) => d.finding.category === "standards"), "rejected-category nit dropped");
  assert.ok(kept.some((f) => f.category === "security"), "trusted-category finding kept even at low raw confidence");
});

test("filterFindings: deterministic facts and policy are never dropped by learning", () => {
  const cal = new Calibration(calibrate(decisions()));
  const fact = finding({ source: "sast", category: "security", confidence: 0.1 });
  const policy = finding({ source: "policy", immutable: true, confidence: 0.1 });
  const { kept } = cal.filterFindings([fact, policy]);
  assert.equal(kept.length, 2);
});

test("calibratedConfidence down-weights an agent the org rejects", () => {
  const cal = new Calibration(calibrate(decisions()));
  const f = finding({ agent: "standards", category: "standards", confidence: 0.8 });
  assert.ok(cal.calibratedConfidence(f) < 0.8, "low-trust agent confidence is discounted");
});
