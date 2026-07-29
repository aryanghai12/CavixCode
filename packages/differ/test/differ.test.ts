import { test } from "node:test";
import assert from "node:assert/strict";
import { commentableLines, parseUnifiedDiff } from "@cavix/core";
import { buildUnifiedDiff, diffLines, splitLines, looksBinary } from "@cavix/differ";

// Every expected diff below was checked against `git diff --no-index -U3` before
// it was written down. That is the only standard that means anything here: this
// differ exists because Azure DevOps does not hand over a diff, and everything
// downstream (inline anchors, finding line numbers, the sandbox's coordinates)
// treats what comes out of it as exact. A differ that is right most of the time
// does not fail, it silently moves findings onto lines they do not belong to.

const lines = (...xs: string[]) => `${xs.join("\n")}\n`;

test("one inserted line: leading and trailing context, and the git hunk header", () => {
  const before = lines("const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", "const e = 5;", "const f = 6;");
  const after = lines(
    "const a = 1;", "const b = 2;", "const c = 3;", "const NEW = 0;", "const d = 4;", "const e = 5;", "const f = 6;",
  );
  const { diff } = buildUnifiedDiff([{ path: "src/a.ts", before, after }]);
  assert.equal(
    diff,
    lines(
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,6 +1,7 @@",
      " const a = 1;",
      " const b = 2;",
      " const c = 3;",
      "+const NEW = 0;",
      " const d = 4;",
      " const e = 5;",
      " const f = 6;",
    ),
  );
});

test("two edits far apart become two hunks; two close together become one", () => {
  const base = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const far = [...base];
  far[2] = "line 2 CHANGED";
  far[35] = "line 35 CHANGED";
  const farDiff = buildUnifiedDiff([{ path: "f.ts", before: lines(...base), after: lines(...far) }]).diff;
  assert.equal(farDiff.match(/^@@ /gm)?.length, 2, "34 unchanged lines apart is two hunks");
  assert.match(farDiff, /^@@ -1,6 \+1,6 @@$/m);
  assert.match(farDiff, /^@@ -33,7 \+33,7 @@$/m);

  const near = [...base];
  near[10] = "line 10 CHANGED";
  near[14] = "line 14 CHANGED";
  const nearDiff = buildUnifiedDiff([{ path: "f.ts", before: lines(...base), after: lines(...near) }]).diff;
  assert.equal(nearDiff.match(/^@@ /gm)?.length, 1, "context windows that overlap merge");
  assert.match(nearDiff, /^@@ -8,11 \+8,11 @@$/m);
});

test("an added file starts at old line 0, a deleted file at new line 0", () => {
  const body = lines("export function f() {", "  return 1;", "}");

  const added = buildUnifiedDiff([{ path: "src/new.ts", before: null, after: body }]).diff;
  assert.match(added, /^--- \/dev\/null$/m);
  assert.match(added, /^@@ -0,0 \+1,3 @@$/m, "git writes -0,0, not -1,0; off by one here shifts every line");

  const deleted = buildUnifiedDiff([{ path: "src/gone.ts", before: body, after: null }]).diff;
  assert.match(deleted, /^\+\+\+ \/dev\/null$/m);
  assert.match(deleted, /^@@ -1,3 \+0,0 @@$/m);
});

test("repeated lines: the script is minimal, which a greedy scan gets wrong", () => {
  // Six closing braces around one distinct line. A differ that matches the first
  // brace it sees produces a longer script that still "looks" plausible.
  const a = ["}", "}", "}", "a", "}", "}", "}"];
  const b = ["}", "}", "a", "}", "}", "}", "}"];
  const out = diffLines(a, b);
  assert.ok(out.ok);
  const edits = out.ops.filter((o) => o.kind !== "equal");
  assert.equal(edits.length, 2, "one delete and one insert is the minimum");
  assert.deepEqual(
    edits.map((e) => e.kind),
    ["delete", "insert"],
  );
});

test("the line numbers survive the round trip into an inline-comment anchor", () => {
  // The one property the whole platform rests on: a line number that comes out
  // of this differ points at the text a reviewer will actually be shown.
  const before = lines(
    'import { db } from "./db";',
    "",
    "export async function login(user) {",
    "  const token = sign(user);",
    "  cache.set(user.id, token);",
    "  return token;",
    "}",
  );
  const after = lines(
    'import { db } from "./db";',
    'import { audit } from "./audit";',
    "",
    "export async function login(user) {",
    "  const token = sign(user, { ttl: 3600 });",
    '  await db.query("SELECT * FROM u WHERE id = " + user.id);',
    "  cache.set(user.id, token);",
    '  audit("login", user.id);',
    "  return token;",
    "}",
  );

  const { diff } = buildUnifiedDiff([{ path: "src/auth.ts", before, after }]);
  const parsed = parseUnifiedDiff(diff);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].path, "src/auth.ts");

  const anchors = [...(commentableLines(parsed).get("src/auth.ts") ?? [])].sort((x, y) => x - y);
  assert.deepEqual(anchors, [2, 5, 6, 8]);

  // And each of those numbers indexes the line it claims to, in the NEW file.
  const newFile = splitLines(after);
  assert.equal(newFile[1], 'import { audit } from "./audit";');
  assert.equal(newFile[4], "  const token = sign(user, { ttl: 3600 });");
  assert.equal(newFile[5], '  await db.query("SELECT * FROM u WHERE id = " + user.id);');
  assert.equal(newFile[7], '  audit("login", user.id);');
});

test("a file whose two sides are identical produces nothing", () => {
  const same = lines("a", "b", "c");
  const { diff, unrendered } = buildUnifiedDiff([{ path: "same.ts", before: same, after: same }]);
  assert.equal(diff, "", "Azure lists a path as changed when only its mode moved");
  assert.deepEqual(unrendered, []);
});

test("a rename names both sides", () => {
  const { diff } = buildUnifiedDiff([
    { path: "src/new.ts", oldPath: "src/old.ts", before: lines("a", "b"), after: lines("a", "c") },
  ]);
  assert.match(diff, /^diff --git a\/src\/old\.ts b\/src\/new\.ts$/m);
  assert.match(diff, /^--- a\/src\/old\.ts$/m);
  assert.match(diff, /^\+\+\+ b\/src\/new\.ts$/m);
});

// ── the refusals ─────────────────────────────────────────────────────────────
//
// The whole reason this is defensible. Producing an approximate diff quietly is
// not an option, because everything downstream treats it as exact, so a file
// this cannot diff is reported and left out rather than guessed at.

test("a file over the line budget is refused by name, not silently skipped", () => {
  const huge = lines(...Array.from({ length: 300 }, (_, i) => `line ${i}`));
  const { diff, unrendered } = buildUnifiedDiff([{ path: "vendor/big.js", before: huge, after: `${huge}extra\n` }], {
    maxLines: 100,
  });
  assert.equal(diff, "");
  assert.equal(unrendered.length, 1);
  assert.equal(unrendered[0].path, "vendor/big.js");
  assert.match(unrendered[0].reason, /301 lines, over the 100 Cavix diffs in one file/);
});

test("a rewrite past the edit budget is refused rather than approximated", () => {
  const a = Array.from({ length: 200 }, (_, i) => `old ${i}`);
  const b = Array.from({ length: 200 }, (_, i) => `new ${i}`);
  const out = diffLines(a, b, { maxEdits: 50 });
  assert.equal(out.ok, false);
  assert.deepEqual(out.ok === false ? out.refusal : null, { reason: "too-many-edits", limit: 50 });

  const { diff, unrendered } = buildUnifiedDiff([{ path: "src/rewritten.ts", before: lines(...a), after: lines(...b) }], {
    maxEdits: 50,
  });
  assert.equal(diff, "");
  assert.match(unrendered[0].reason, /rewritten past the 50-line edit budget/);
});

test("binary content is detected by its bytes, not by its file extension", () => {
  // A real PNG magic number: it carries NUL bytes, which is the same test
  // git uses to decide a blob is not text.
  const NUL = String.fromCharCode(0);
  const binary = ["PNG", NUL, NUL, NUL, "IHDR", NUL, "sRGB"].join("").repeat(20);
  assert.equal(looksBinary(binary), true);
  assert.equal(looksBinary('const png = "PNG";\n'), false, "a .ts file that mentions PNG is still text");

  const { diff, unrendered } = buildUnifiedDiff([{ path: "logo.txt", before: binary, after: `${binary}more` }]);
  assert.equal(diff, "");
  assert.match(unrendered[0].reason, /binary file/);
});

test("neither side readable is reported, never treated as an empty file", () => {
  // Treating an unreadable file as "" would render it as a whole-file deletion,
  // which is a change the pull request does not contain.
  const { diff, unrendered } = buildUnifiedDiff([{ path: "src/gone.ts", before: null, after: null }]);
  assert.equal(diff, "");
  assert.match(unrendered[0].reason, /neither version of this file could be read/);
});

test("splitLines: a trailing newline terminates the last line, it does not start a new one", () => {
  assert.deepEqual(splitLines("a\nb\nc\n"), ["a", "b", "c"]);
  assert.deepEqual(splitLines("a\nb\nc"), ["a", "b", "c"]);
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("\n"), [""]);
  assert.deepEqual(splitLines("a\r\nb\r\n"), ["a", "b"], "CRLF must not read as every line having changed");
});
