import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { Finding } from "@cavix/core";
import { LocalSandboxBackend, FakeSandboxBackend } from "@cavix/sandbox";
import { ZeroRetention, metadataOnly } from "@cavix/zero-retention";

test("zero-retention: customer code exists during the review and is GONE after", async () => {
  const audited: Array<Record<string, unknown>> = [];
  const zr = new ZeroRetention({
    backend: new LocalSandboxBackend(),
    audit: { append: (_a, _action, _t, meta) => audited.push(meta ?? {}) },
  });

  let workdir = "";
  const { attestation } = await zr.runReview({ reviewId: "rev_1", repo: "acme/widget" }, async (sbx) => {
    workdir = sbx.workdir;
    await sbx.writeFile("customer/secret.js", "const apiKey='shhh'; // proprietary");
    assert.equal(fs.existsSync(workdir), true, "code present during review");
    assert.equal(fs.existsSync(workdir + "/customer/secret.js"), true);
    return "reviewed";
  });

  assert.equal(fs.existsSync(workdir), false, "workspace purged after review");
  assert.equal(attestation.clean, true);
  assert.deepEqual(attestation.residualPaths, []);
  assert.equal(audited[0].clean, true, "purge attested in audit");
});

test("zero-retention: a failed purge is detected and fails loudly", async () => {
  const zr = new ZeroRetention({
    backend: new FakeSandboxBackend(),
    // Simulate a backend that left residue behind.
    residualCheck: async () => ["/var/lib/cavix/leftover"],
  });
  await assert.rejects(
    () => zr.runReview({ reviewId: "rev_2", repo: "acme/x" }, async () => "x"),
    /zero-retention violated/,
  );
});

test("zero-retention: teardown happens even if the review throws", async () => {
  const backend = new FakeSandboxBackend();
  const zr = new ZeroRetention({ backend });
  let destroyed = false;
  await assert.rejects(() =>
    zr.runReview({ reviewId: "r", repo: "x" }, async (sbx) => {
      const orig = sbx.destroy.bind(sbx);
      sbx.destroy = async () => { destroyed = true; return orig(); };
      throw new Error("review blew up");
    }),
  );
  assert.equal(destroyed, true, "sandbox destroyed despite the error");
});

test("metadataOnly: strips code (body/suggestion/evidence), keeps classification", () => {
  const f: Finding = {
    path: "a.js", line: 5, severity: "high", category: "security", title: "SQL injection",
    body: 'db.query("SELECT ... " + id)  // contains customer code',
    suggestion: "db.query('... ?', [id])",
    source: "llm", confidence: 0.9, agent: "security",
    evidence: [{ path: "b.js", line: 1, snippet: "const id = req.query.id // customer code" }],
  };
  const md = metadataOnly(f) as Record<string, unknown>;
  assert.equal(md.title, "SQL injection");
  assert.equal(md.path, "a.js");
  assert.equal("body" in md, false, "no code body persisted");
  assert.equal("suggestion" in md, false, "no code suggestion persisted");
  assert.equal("evidence" in md, false, "no code snippets persisted");
});
