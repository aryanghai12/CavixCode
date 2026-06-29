import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { localReview, createLocalReviewServer } from "@cavix/ide";

test("localReview: a useful pre-PR review (deterministic + legacy), no key needed", async () => {
  const result = await localReview([
    { path: "src/db.js", content: 'function get(id){ return db.query("SELECT * FROM t WHERE id=" + id); }' },
    { path: "app/auth.py", content: "import hashlib\nhashlib.md5(pw).hexdigest()" },
    { path: "payroll.cob", content: "       PROCEDURE DIVISION.\n       MAIN-PARA.\n           GO TO END-PARA.\n" },
  ]);

  const rules = new Set(result.diagnostics.map((d) => d.ruleId));
  assert.ok(rules.has("builtin/sql-injection"), "JS SQL injection caught");
  assert.ok(rules.has("builtin/weak-hash"), "Python md5 caught");
  assert.ok(rules.has("cobol/goto"), "COBOL GO TO caught (legacy)");

  const sqli = result.diagnostics.find((d) => d.ruleId === "builtin/sql-injection")!;
  assert.equal(sqli.severity, "error", "critical → error");
  assert.equal(sqli.path, "src/db.js");
  assert.ok(sqli.line >= 1);
  assert.match(result.summary, /error\(s\)/);
});

test("localReview: a clean file yields no diagnostics", async () => {
  const result = await localReview([{ path: "ok.js", content: "export const add = (a, b) => a + b;\n" }]);
  assert.equal(result.diagnostics.length, 0);
  assert.match(result.summary, /no issues/);
});

test("local review server: POST /review returns diagnostics", async () => {
  const server = createLocalReviewServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ path: "x.py", content: "import os\nos.system('ping ' + h)" }] }),
    });
    const body = (await res.json()) as { diagnostics: Array<{ ruleId?: string }> };
    assert.ok(body.diagnostics.some((d) => d.ruleId === "builtin/command-injection-os-system"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
