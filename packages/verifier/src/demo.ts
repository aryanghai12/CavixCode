// Stage 10 demonstration — REAL sandbox execution (node in a LocalSandbox), no
// API key. Walks one verification end to end: a planted bug reproduced + fixed
// (VERIFIED), a false alarm that doesn't reproduce (UNVERIFIED → suppressed), and
// a planted vulnerability proven with a PoC exploit (VERIFIED).
//
//   node packages/verifier/src/demo.ts

import type { Finding } from "@cavix/core";
import { LocalSandboxBackend } from "@cavix/sandbox";
import { Verifier, FakeTestGenerator, SECURE_SPEC, verifyAndFilter } from "./index.ts";

const BUGGY = `export function lastN(arr, n) {\n  const out = [];\n  for (let i = arr.length - n; i <= arr.length; i++) out.push(arr[i]);\n  return out;\n}\n`;
const FIXED = BUGGY.replace("i <= arr.length", "i < arr.length");
const REPRO = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { lastN } from "./calc.mjs";\ntest("lastN returns the last n", () => { assert.deepEqual(lastN([1,2,3,4],2), [3,4]); });\n`;

const VULN = `export function login(user, pass) {\n  return pass.length >= 0; // BUG: accepts any password\n}\n`;
const EXPLOIT = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { login } from "./auth.mjs";\ntest("PoC: auth bypass with wrong password", () => { assert.equal(login("admin","wrong"), true); });\n`;

function f(p: Partial<Finding>): Finding {
  return { path: "calc.mjs", line: 3, severity: "high", category: "correctness", title: "off-by-one in lastN", body: "loop uses <= arr.length", source: "llm", confidence: 0.65, ...p };
}

function bar(title: string) {
  console.log("\n" + "─".repeat(70) + "\n" + title + "\n" + "─".repeat(70));
}

async function main() {
  console.log(`Sandbox security: network=${SECURE_SPEC.network}, caps=${JSON.stringify(SECURE_SPEC.limits)} (ephemeral, destroyed after).`);

  // 1) A real bug → reproduced and fixed → VERIFIED.
  bar("1. Borderline finding (conf 0.65) → verify a planted bug");
  const v = new Verifier({
    sandbox: new LocalSandboxBackend(),
    testGen: new FakeTestGenerator(() => ({ testPath: "calc.repro.test.mjs", testCode: REPRO, fix: { path: "calc.mjs", content: FIXED }, semantics: "test-fails-on-bug" })),
  });
  const r1 = await v.verify(f({}), { org: "acme", files: [{ path: "calc.mjs", content: BUGGY }] });
  console.log(`status: ${r1.status}  reproduced=${r1.reproduced} fixWorks=${r1.fixWorks} suitePasses=${r1.suitePasses}`);
  for (const l of r1.logs) console.log(`  [${l.step}] ${l.cmd} → exit ${l.code}`);
  console.log(`  → ${r1.reason}`);

  // 2) The same finding but the code is actually correct → false alarm → UNVERIFIED.
  bar("2. Same finding, but the code is correct → false alarm suppressed");
  const r2 = await v.verify(f({}), { org: "acme", files: [{ path: "calc.mjs", content: FIXED }] });
  console.log(`status: ${r2.status}  reproduced=${r2.reproduced}`);
  console.log(`  → ${r2.reason}`);

  // 3) A security finding → PoC exploit → VERIFIED.
  bar("3. Security finding → proof-of-concept exploit in the sandbox");
  const vs = new Verifier({
    sandbox: new LocalSandboxBackend(),
    testGen: new FakeTestGenerator(() => ({ testPath: "auth.exploit.test.mjs", testCode: EXPLOIT, semantics: "exploit-passes-on-vuln" })),
  });
  const r3 = await vs.verify(f({ path: "auth.mjs", category: "security", title: "auth bypass: any password accepted" }), { org: "acme", files: [{ path: "auth.mjs", content: VULN }] });
  console.log(`status: ${r3.status}  exploit=${r3.exploit} reproduced=${r3.reproduced}`);
  for (const l of r3.logs) console.log(`  [${l.step}] ${l.cmd} → exit ${l.code}`);
  console.log(`  → ${r3.reason}`);

  // 4) Surfacing: only VERIFIED + facts reach the PR.
  bar("4. Surfacing decision (default: VERIFIED + facts only)");
  const findings = [f({ title: "real off-by-one", severity: "high" }), f({ title: "secret in config", source: "secret" })];
  const filtered = await verifyAndFilter(findings, { org: "acme", files: [{ path: "calc.mjs", content: BUGGY }] }, v);
  console.log(`surfaced: ${filtered.surfaced.map((x) => x.title).join(", ")}`);
  console.log(`verified: ${filtered.verifiedCount}, suppressed: ${filtered.suppressed.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
