import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "@cavix/core";
import { LocalSandboxBackend, FakeSandboxBackend } from "@cavix/sandbox";
import { Verifier, FakeTestGenerator } from "@cavix/verifier";
import { FixPrAgent, FakeFixPrTarget } from "@cavix/fixpr";

const BUGGY = `export function lastN(arr, n) {
  const out = [];
  for (let i = arr.length - n; i <= arr.length; i++) out.push(arr[i]);
  return out;
}
`;
const FIXED = BUGGY.replace("i <= arr.length", "i < arr.length");
const REPRO = `import { test } from "node:test";
import assert from "node:assert/strict";
import { lastN } from "./calc.mjs";
test("lastN", () => { assert.deepEqual(lastN([1,2,3,4],2), [3,4]); });
`;

const finding: Finding = { path: "calc.mjs", line: 3, severity: "high", category: "correctness", title: "off-by-one in lastN", body: "loop uses <=", source: "llm", confidence: 0.7, ruleId: "demo/offbyone" };

test("verified fix → a DRAFT PR is opened with the proven fix and evidence", async () => {
  const verifier = new Verifier({
    sandbox: new LocalSandboxBackend(),
    testGen: new FakeTestGenerator(() => ({ testPath: "calc.repro.test.mjs", testCode: REPRO, fix: { path: "calc.mjs", content: FIXED }, semantics: "test-fails-on-bug" })),
  });
  const target = new FakeFixPrTarget();
  const agent = new FixPrAgent({ verifier, target });

  const res = await agent.propose({ finding, repo: "acme/widget", org: "acme", files: [{ path: "calc.mjs", content: BUGGY }] });

  assert.equal(res.proposed, true);
  assert.equal(res.verification.status, "VERIFIED");
  assert.equal(res.verification.fixWorks, true);
  assert.equal(res.verification.suitePasses, true);

  assert.equal(target.opened.length, 1, "exactly one PR opened");
  const pr = target.opened[0];
  assert.equal(pr.draft, true, "always a draft — human approval required");
  assert.ok(pr.labels?.includes("needs-human-approval"));
  assert.deepEqual(pr.files, [{ path: "calc.mjs", content: FIXED }], "PR carries the proven fix");
  assert.match(pr.body, /proven in an isolated sandbox/);
  assert.match(pr.body, /Requires human approval to merge/);
});

test("false alarm (no reproduction) → NO PR is proposed", async () => {
  const verifier = new Verifier({
    sandbox: new LocalSandboxBackend(),
    testGen: new FakeTestGenerator(() => ({ testPath: "calc.repro.test.mjs", testCode: REPRO, fix: { path: "calc.mjs", content: FIXED }, semantics: "test-fails-on-bug" })),
  });
  const target = new FakeFixPrTarget();
  const agent = new FixPrAgent({ verifier, target });

  // The code is already correct → the repro test passes → nothing to fix.
  const res = await agent.propose({ finding, repo: "acme/widget", org: "acme", files: [{ path: "calc.mjs", content: FIXED }] });

  assert.equal(res.proposed, false);
  assert.equal(target.opened.length, 0, "no PR opened for an unverifiable fix");
  assert.match(res.reason, /not proposed/);
});

test("candidate fix that does not resolve the bug → NO PR (fixWorks=false)", async () => {
  // Fake sandbox: the repro test fails before AND after the 'fix' → not resolved.
  const verifier = new Verifier({
    sandbox: new FakeSandboxBackend((_c, a) => ({ code: a.includes("--test") ? 1 : 0 })),
    testGen: new FakeTestGenerator(() => ({ testPath: "x.repro.test.mjs", testCode: REPRO, fix: { path: "calc.mjs", content: "still broken" }, semantics: "test-fails-on-bug" })),
  });
  const target = new FakeFixPrTarget();
  const res = await new FixPrAgent({ verifier, target }).propose({ finding, repo: "r", org: "o", files: [{ path: "calc.mjs", content: BUGGY }] });

  assert.equal(res.proposed, false);
  assert.match(res.reason, /did not resolve|stay green|not proposed/);
  assert.equal(target.opened.length, 0);
});
