import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeSandboxBackend } from "@cavix/sandbox";
import { Verifier, FakeTestGenerator } from "@cavix/verifier";
import { analyzeLegacy, parseLegacy, proposeModernization, verifyModernization } from "@cavix/legacy";

const COBOL = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. PAYROLL.
       PROCEDURE DIVISION.
       MAIN-PARA.
           PERFORM CALC-PARA.
           GO TO END-PARA.
       CALC-PARA.
           COMPUTE TOTAL = HOURS * RATE.
       END-PARA.
           STOP RUN.
`;

const PLSQL = `CREATE OR REPLACE PROCEDURE get_user(p_id IN VARCHAR2) IS
BEGIN
  EXECUTE IMMEDIATE 'SELECT * FROM users WHERE id = ' || p_id;
EXCEPTION
  WHEN OTHERS THEN NULL;
END;
`;

const CFILE = `#include <string.h>
void copy_name(char *dst, char *src) {
    strcpy(dst, src);
}
`;

test("COBOL: located review names the enclosing paragraph", () => {
  const { symbols, findings } = analyzeLegacy([{ path: "payroll.cob", content: COBOL }]);
  assert.ok(symbols.some((s) => s.name === "MAIN-PARA" && s.kind === "paragraph"));
  assert.ok(symbols.some((s) => s.name === "CALC-PARA"));
  const goto = findings.find((f) => f.ruleId === "cobol/goto")!;
  assert.ok(goto, "GO TO flagged");
  assert.equal(goto.line, 6);
  assert.match(goto.body, /MAIN-PARA/, "names the enclosing paragraph");
  assert.ok(findings.some((f) => f.ruleId === "cobol/compute-no-size-error"));
});

test("PL/SQL: dynamic SQL injection + swallowed exception are located", () => {
  const { symbols, findings } = analyzeLegacy([{ path: "pkg.pls", content: PLSQL }]);
  assert.ok(symbols.some((s) => s.name === "get_user"));
  const sqli = findings.find((f) => f.ruleId === "plsql/dynamic-sql-concat")!;
  assert.equal(sqli.line, 3);
  assert.equal(sqli.severity, "critical");
  assert.match(sqli.body, /get_user/);
  assert.ok(findings.some((f) => f.ruleId === "plsql/when-others-null"));
});

test("C: unsafe strcpy is located in its function", () => {
  const { symbols, findings } = analyzeLegacy([{ path: "name.c", content: CFILE }]);
  assert.ok(symbols.some((s) => s.name === "copy_name" && s.kind === "function"));
  const f = findings.find((x) => x.ruleId === "cpp/unsafe-string")!;
  assert.equal(f.line, 3);
  assert.match(f.body, /copy_name/);
});

test("IaC: open security group and privileged container are flagged", () => {
  const tf = analyzeLegacy([{ path: "main.tf", content: 'resource "x" {\n  cidr_blocks = ["0.0.0.0/0"]\n}\n' }]);
  assert.ok(tf.findings.some((f) => f.ruleId === "tf/open-ingress"));
  const yaml = analyzeLegacy([{ path: "pod.yaml", content: "securityContext:\n  privileged: true\n" }]);
  assert.ok(yaml.findings.some((f) => f.ruleId === "yaml/privileged"));
});

test("modernization: a migration is proposed and verified through Stage 10 before suggesting", async () => {
  const { findings } = analyzeLegacy([{ path: "name.c", content: CFILE }]);
  const strcpy = findings.find((f) => f.ruleId === "cpp/unsafe-string")!;
  const proposal = proposeModernization(strcpy, CFILE)!;
  assert.ok(proposal, "migration proposed");
  assert.match(proposal.migration.after, /strncpy/);

  // Stage 10 confirms the migration preserves behavior → suggest.
  const verifier = new Verifier({
    sandbox: new FakeSandboxBackend((_c, a) => ({ code: a.includes("--test") ? 0 : 0 })),
    testGen: new FakeTestGenerator(() => ({ testPath: "equiv.repro.test.mjs", testCode: "x", semantics: "exploit-passes-on-vuln" })),
  });
  const ctx = { org: "acme", files: [{ path: "package.json", content: "{}" }, { path: "name.c", content: CFILE.replace("strcpy(dst, src)", "strncpy(dst, src, 255)") }] };
  const ok = await verifyModernization(proposal, verifier, ctx);
  assert.equal(ok.result.status, "VERIFIED");
  assert.equal(ok.suggest, true);

  // If the migration breaks behavior (test fails), it is NOT suggested.
  const breaking = new Verifier({
    sandbox: new FakeSandboxBackend((_c, a) => ({ code: a.includes("--test") ? 1 : 0 })),
    testGen: new FakeTestGenerator(() => ({ testPath: "equiv.repro.test.mjs", testCode: "x", semantics: "exploit-passes-on-vuln" })),
  });
  const bad = await verifyModernization(proposal, breaking, ctx);
  assert.equal(bad.suggest, false, "unverified migration is not suggested");
});

test("parseLegacy: detects language by extension", () => {
  assert.equal(parseLegacy("x.cbl", "").length, 0); // empty but no throw
  assert.ok(parseLegacy("p.pls", "PROCEDURE foo IS BEGIN END;").some((s) => s.name === "foo"));
});
