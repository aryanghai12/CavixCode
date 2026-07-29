import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "@cavix/core";
import { LocalSandboxBackend, FakeSandboxBackend } from "@cavix/sandbox";
import { Verifier, FakeTestGenerator, verifyAndFilter, SECURE_SPEC } from "@cavix/verifier";

function finding(p: Partial<Finding>): Finding {
  return { path: "calc.mjs", line: 1, severity: "high", category: "correctness", title: "bug", body: "b", source: "llm", confidence: 0.7, ...p };
}

// ── REAL end-to-end: reproduce a planted bug, apply fix, re-run (node in sandbox)

const BUGGY = `export function lastN(arr, n) {
  const out = [];
  for (let i = arr.length - n; i <= arr.length; i++) out.push(arr[i]);
  return out;
}
`;
const FIXED = BUGGY.replace("i <= arr.length", "i < arr.length");
const REPRO_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { lastN } from "./calc.mjs";
test("lastN returns the last n elements", () => {
  assert.deepEqual(lastN([1,2,3,4], 2), [3,4]);
});
`;

test("VERIFIED: a planted bug is reproduced in the sandbox and the fix resolves it", async () => {
  const verifier = new Verifier({
    sandbox: new LocalSandboxBackend(),
    testGen: new FakeTestGenerator(() => ({ testPath: "calc.repro.test.mjs", testCode: REPRO_TEST, fix: { path: "calc.mjs", content: FIXED }, semantics: "test-fails-on-bug" })),
  });
  const res = await verifier.verify(finding({ category: "correctness", suggestion: "use i < arr.length" }), {
    org: "acme",
    files: [{ path: "calc.mjs", content: BUGGY }],
  });
  assert.equal(res.status, "VERIFIED");
  assert.equal(res.reproduced, true);
  assert.equal(res.fixWorks, true);
  assert.equal(res.suitePasses, true);
  // The repro step actually failed (red) before the fix.
  assert.equal(res.logs.find((l) => l.step === "repro")!.code !== 0, true);
});

test("UNVERIFIED: a false alarm does not reproduce and is suppressed", async () => {
  const verifier = new Verifier({
    sandbox: new LocalSandboxBackend(),
    testGen: new FakeTestGenerator(() => ({ testPath: "calc.repro.test.mjs", testCode: REPRO_TEST, semantics: "test-fails-on-bug" })),
  });
  // Ship the CORRECT code — the repro test passes → the bug doesn't manifest.
  const res = await verifier.verify(finding({}), { org: "acme", files: [{ path: "calc.mjs", content: FIXED }] });
  assert.equal(res.status, "UNVERIFIED");
  assert.equal(res.reproduced, false);
});

// ── REAL security PoC: an exploit test that PASSES against vulnerable code ──────

const VULN_AUTH = `export function login(user, pass) {
  // BUG: accepts any password
  return pass.length >= 0;
}
`;
const EXPLOIT_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { login } from "./auth.mjs";
test("PoC: authentication bypass with a wrong password", () => {
  assert.equal(login("admin", "definitely-wrong"), true);
});
`;

test("VERIFIED (exploit): a planted vulnerability gets a working PoC in the sandbox", async () => {
  const verifier = new Verifier({
    sandbox: new LocalSandboxBackend(),
    testGen: new FakeTestGenerator(() => ({ testPath: "auth.exploit.test.mjs", testCode: EXPLOIT_TEST, semantics: "exploit-passes-on-vuln" })),
  });
  const res = await verifier.verify(finding({ path: "auth.mjs", category: "security", title: "auth bypass" }), {
    org: "acme",
    files: [{ path: "auth.mjs", content: VULN_AUTH }],
  });
  assert.equal(res.status, "VERIFIED");
  assert.equal(res.exploit, true);
  assert.equal(res.reproduced, true);
});

// ── Gating + secure spec + surface filter (fast, fake sandbox) ─────────────────

test("gate: deterministic/policy facts and trivial nits are not verified", () => {
  const v = new Verifier({ sandbox: new FakeSandboxBackend(), testGen: new FakeTestGenerator(() => ({ testPath: "x", testCode: "x", semantics: "test-fails-on-bug" })) });
  assert.equal(v.shouldVerify(finding({ source: "sast" })), false);
  assert.equal(v.shouldVerify(finding({ immutable: true, source: "policy" })), false);
  assert.equal(v.shouldVerify(finding({ severity: "low", category: "standards", confidence: 0.3 })), false);
  assert.equal(v.shouldVerify(finding({ severity: "high" })), true);
  assert.equal(v.shouldVerify(finding({ severity: "low", category: "security", confidence: 0.4 })), true);
});

// ── Stage 12's other half: where a workspace's history moves the sandbox ──────

test("gate: a category the workspace's history says to prove is verified past the confidence bar", () => {
  // The case that earns this: their accepts and rejects overlap at every
  // confidence level, so no threshold separates them and execution is the only
  // instrument left. A 0.3-confidence nit here is exactly what has to be run.
  const v = new Verifier({
    sandbox: new FakeSandboxBackend(),
    testGen: new FakeTestGenerator(() => ({ testPath: "x", testCode: "x", semantics: "test-fails-on-bug" })),
  });
  const nit = finding({ severity: "low", category: "correctness", confidence: 0.3 });
  assert.equal(v.shouldVerify(nit), false, "the default gate skips it");
  assert.equal(v.shouldVerify(nit, { correctness: "always" }), true, "their history says prove it");
});

test("gate: a category they accept outright stops paying for proof", () => {
  const v = new Verifier({
    sandbox: new FakeSandboxBackend(),
    testGen: new FakeTestGenerator(() => ({ testPath: "x", testCode: "x", semantics: "test-fails-on-bug" })),
  });
  const ordinary = finding({ severity: "medium", category: "style", confidence: 0.9 });
  assert.equal(v.shouldVerify(ordinary), true, "the default gate would run it");
  assert.equal(v.shouldVerify(ordinary, { style: "never" }), false);
});

test("gate: no learned policy can stop Cavix proving a critical, a high, or a security finding", () => {
  // The line that keeps the product's own claim intact. Those three are checked
  // BEFORE the policy is consulted, so no volume of accepts is a reason to stop
  // proving the findings whose proof is the entire pitch.
  const v = new Verifier({
    sandbox: new FakeSandboxBackend(),
    testGen: new FakeTestGenerator(() => ({ testPath: "x", testCode: "x", semantics: "test-fails-on-bug" })),
  });
  const never = { security: "never", correctness: "never" } as const;
  assert.equal(v.shouldVerify(finding({ severity: "critical", category: "correctness" }), never), true);
  assert.equal(v.shouldVerify(finding({ severity: "high", category: "correctness" }), never), true);
  assert.equal(v.shouldVerify(finding({ severity: "low", category: "security", confidence: 0.1 }), never), true);
});

test("gate: a learned policy still cannot make Cavix verify a deterministic fact", () => {
  // It decides where proof is SPENT, never what reaches the pull request. A
  // secret scanner's finding is already proven and a sandbox adds nothing.
  const v = new Verifier({
    sandbox: new FakeSandboxBackend(),
    testGen: new FakeTestGenerator(() => ({ testPath: "x", testCode: "x", semantics: "test-fails-on-bug" })),
  });
  assert.equal(v.shouldVerify(finding({ source: "sast", category: "correctness" }), { correctness: "always" }), false);
  assert.equal(
    v.shouldVerify(finding({ immutable: true, source: "policy", category: "correctness" }), { correctness: "always" }),
    false,
  );
});

test("secure spec: verification sandbox has no egress and hard caps", () => {
  assert.equal(SECURE_SPEC.network, "none");
  assert.ok((SECURE_SPEC.limits?.memoryMb ?? 0) > 0 && (SECURE_SPEC.limits?.timeoutMs ?? 0) > 0);
});

test("verifyAndFilter: surfaces VERIFIED, suppresses proven false alarms, keeps facts", async () => {
  // Fake sandbox: the repro test 'fails' first time (reproduces), then passes.
  let runs = 0;
  const backend = new FakeSandboxBackend((_cmd, args) => {
    const isTest = args.includes("--test");
    if (!isTest) return { code: 0 };
    runs++;
    return { code: runs === 1 ? 1 : 0 };
  });
  const verifier = new Verifier({
    sandbox: backend,
    testGen: new FakeTestGenerator(() => ({ testPath: "x.repro.test.mjs", testCode: "x", fix: { path: "calc.mjs", content: "x" }, semantics: "test-fails-on-bug" })),
  });

  const real = finding({ title: "real bug", severity: "high" });
  const fact = finding({ title: "secret", source: "secret", immutable: false });
  const policy = finding({ title: "policy", source: "policy", immutable: true });

  const out = await verifyAndFilter([real, fact, policy], { org: "acme", files: [{ path: "calc.mjs", content: "x" }] }, verifier);
  const titles = out.surfaced.map((f) => f.title);
  assert.ok(titles.includes("real bug"), "verified bug surfaces");
  assert.ok(titles.includes("secret") && titles.includes("policy"), "facts surface without verification");
  assert.equal(out.verifiedCount, 1);
  // The proof rides on the finding as structured data, ready to render.
  const proven = out.surfaced.find((f) => f.title === "real bug")!;
  assert.equal(proven.verification?.status, "VERIFIED");
  assert.equal(proven.verification?.reproduced, true);
  assert.equal(proven.verification?.fixWorks, true);
  assert.deepEqual(
    proven.verification?.steps.map((s) => s.step),
    ["repro", "after-fix", "suite"],
  );
  assert.equal(proven.body, "b", "the model's explanation is left alone");
});
