import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff, commentableLines } from "@cavix/core";

const SAMPLE = `diff --git a/src/auth.js b/src/auth.js
index 1111111..2222222 100644
--- a/src/auth.js
+++ b/src/auth.js
@@ -10,6 +10,8 @@ function login(user) {
   const token = sign(user);
   cache.set(user.id, token);
+  // BUG: SQL built by string concatenation
+  db.query("SELECT * FROM u WHERE id = " + user.id);
   return token;
 }
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 # Title
+added doc line
 text
`;

test("parseUnifiedDiff: tracks new-file line numbers for added lines", () => {
  const files = parseUnifiedDiff(SAMPLE);
  assert.equal(files.length, 2);

  const auth = files.find((f) => f.path === "src/auth.js");
  assert.ok(auth, "auth.js parsed");
  const adds = auth!.hunks[0].lines.filter((l) => l.kind === "add");
  assert.equal(adds.length, 2);
  // Hunk starts at new line 10; two context lines (10,11), then the two adds at 12,13.
  assert.deepEqual(
    adds.map((l) => l.newLineNo),
    [12, 13],
  );
});

test("commentableLines: only added lines are valid anchors", () => {
  const files = parseUnifiedDiff(SAMPLE);
  const c = commentableLines(files);
  assert.deepEqual([...(c.get("src/auth.js") ?? [])].sort((a, b) => a - b), [12, 13]);
  assert.deepEqual([...(c.get("README.md") ?? [])], [2]);
});

test("parseUnifiedDiff: marks deletions and skips /dev/null new side", () => {
  const del = `diff --git a/gone.txt b/gone.txt
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`;
  const files = parseUnifiedDiff(del);
  assert.equal(files.length, 1);
  assert.equal(files[0].deleted, true);
});

test("parseUnifiedDiff: a deleted file keeps the name it had", () => {
  // git writes `+++ /dev/null` for a deletion, so the only place the path
  // survives is the `---` line. Reading just the `+++` left `path` empty, and
  // everything that names a file then had nothing to print: the walkthrough
  // rendered an empty code span, and `subsystem("")` filed every deletion under
  // the repository root and inflated the traversed-subsystem count with it.
  const del = `diff --git a/src/legacy/old.ts b/src/legacy/old.ts
deleted file mode 100644
index 1234567..0000000
--- a/src/legacy/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export function old() {}
-
`;
  const [file] = parseUnifiedDiff(del);
  assert.equal(file.deleted, true);
  assert.equal(file.path, "src/legacy/old.ts");
});

test("parseUnifiedDiff: an added file takes its path from the new side, not the old one", () => {
  const added = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,1 @@
+export const x = 1;
`;
  const [file] = parseUnifiedDiff(added);
  assert.equal(file.deleted, false);
  assert.equal(file.path, "src/new.ts");
  assert.deepEqual([...(commentableLines([file]).get("src/new.ts") ?? [])], [1]);
});
