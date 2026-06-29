import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "@cavix/core";
import { FakeSandboxBackend } from "@cavix/sandbox";
import { Verifier, FakeTestGenerator } from "@cavix/verifier";
import { runBatchModernization, verifiedChangesByRepo, type MigrationTarget } from "@cavix/batch";

const equivGen = new FakeTestGenerator(() => ({ testPath: "equiv.repro.test.mjs", testCode: "x", semantics: "exploit-passes-on-vuln" }));
const passVerifier = () => new Verifier({ sandbox: new FakeSandboxBackend((_c, a) => ({ code: a.includes("--test") ? 0 : 0 })), testGen: equivGen });
const failVerifier = () => new Verifier({ sandbox: new FakeSandboxBackend((_c, a) => ({ code: a.includes("--test") ? 1 : 0 })), testGen: equivGen });

function strcpyTarget(repo: string, path: string): MigrationTarget {
  const content = `#include <string.h>\nvoid f(char* d, char* s) { strcpy(d, s); }\n`;
  const finding: Finding = { path, line: 2, severity: "high", category: "security", title: "unsafe strcpy", body: "", source: "sast", confidence: 0.85, ruleId: "cpp/unsafe-string" };
  return { repo, file: { path, content }, finding };
}

function noTemplateTarget(repo: string, path: string): MigrationTarget {
  const finding: Finding = { path, line: 1, severity: "medium", category: "correctness", title: "compute no size error", body: "", source: "sast", confidence: 0.8, ruleId: "cobol/compute-no-size-error" };
  return { repo, file: { path, content: "       COMPUTE X = Y * Z.\n" }, finding };
}

test("batch: each verified migration is kept; ones with no template are skipped", async () => {
  const targets = [strcpyTarget("core", "a.c"), strcpyTarget("core", "b.c"), noTemplateTarget("core", "x.cob")];
  const progress: number[] = [];
  const res = await runBatchModernization(targets, { verifier: passVerifier(), concurrency: 2, onProgress: (d) => progress.push(d) });

  assert.equal(res.proposedCount, 2, "two strcpy migrations proposed");
  assert.equal(res.verifiedCount, 2, "both verified through Stage 10");
  assert.equal(res.excludedCount, 0);
  const skipped = res.results.find((r) => r.path === "x.cob")!;
  assert.equal(skipped.proposed, false);
  assert.equal(skipped.status, "SKIPPED");
  assert.equal(progress.at(-1), 3, "progress reported for all targets");

  const byRepo = verifiedChangesByRepo(res);
  assert.equal(byRepo.get("core")!.length, 2);
  assert.match(byRepo.get("core")![0].newContent!, /strncpy/);
});

test("batch: a migration that fails verification is EXCLUDED, not applied", async () => {
  const res = await runBatchModernization([strcpyTarget("core", "a.c")], { verifier: failVerifier() });
  assert.equal(res.proposedCount, 1);
  assert.equal(res.verifiedCount, 0, "did not verify → excluded");
  assert.equal(res.results[0].verified, false);
  assert.equal(res.results[0].newContent, undefined, "no content applied for an unverified migration");
  assert.match(res.results[0].reason, /excluded/);
});
