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
  assert.match(out.surfaced.find((f) => f.title === "real bug")!.body, /Verified/);
});
