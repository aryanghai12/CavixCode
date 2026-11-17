import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("the demo attaches execution proof only to the SQL injection finding", async () => {
  // Run the actual entry point, including its ensemble, generator and sandbox.
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../src/demo.ts", import.meta.url)),
  ], { timeout: 30_000 });

  assert.match(stdout, /inline: 2\s+verified: 1\s+suppressed: 0/);
  const inlines = stdout.split(/\n(?=\[inline\] |── cost accounting)/);
  const sql = inlines.find((block) => block.startsWith("[inline] src/auth.mjs:4\n"));
  const comment = inlines.find((block) => block.startsWith("[inline] src/auth.mjs:2\n"));
  assert.ok(sql, "the SQL injection finding is posted");
  assert.ok(comment, "the unrelated maintainability finding is still posted");

  assert.match(sql, /⬢ verified/);
  assert.match(sql, /\[repro\].*exit 0 +exploit succeeded/);
  assert.match(sql, /\[after-fix\].*exit 1 +suggested fix resolves it/);
  assert.match(sql, /\[suite\].*exit 0 +existing suite still green/);
  assert.doesNotMatch(comment, /⬢ verified|Execution proof|auth\.exploit\.test\.mjs|\[repro\]|\[after-fix\]/);
});
