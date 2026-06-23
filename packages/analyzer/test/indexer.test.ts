import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeIndex, HeuristicParser, symbolId } from "@cavix/analyzer";

const AUTH = `export function validateToken(token) {
  return verify(token);
}

export function verify(t) {
  return t.length > 0;
}
`;

const ROUTES = `import { validateToken } from "./auth";

export function handleLogin(req, res) {
  if (!validateToken(req.token)) {
    return res.status(401).send("no");
  }
  return res.send("ok");
}
`;

function freshIndex() {
  const idx = new CodeIndex(new HeuristicParser());
  idx.indexFiles([
    { path: "src/auth.ts", content: AUTH },
    { path: "src/routes.ts", content: ROUTES },
  ]);
  return idx;
}

test("index: extracts symbols across files", () => {
  const idx = freshIndex();
  const s = idx.stats();
  assert.equal(s.files, 2);
  assert.ok(s.symbols >= 3, `expected ≥3 symbols, got ${s.symbols}`);
  assert.ok(idx.getSymbol(symbolId("src/auth.ts", "validateToken")));
});

test("index: resolves a cross-file caller (routes → auth.validateToken)", () => {
  const idx = freshIndex();
  const callers = idx.callersOf(symbolId("src/auth.ts", "validateToken"));
  const callerNames = callers.map((c) => c.name);
  assert.ok(callerNames.includes("handleLogin"), `handleLogin should call validateToken; got ${callerNames}`);
});

test("blastRadiusFromDiff: a change to validateToken flags its cross-file caller", () => {
  const idx = freshIndex();
  // A diff editing the body of validateToken in auth.ts (new-file lines 1-3).
  const diff = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,3 @@
 export function validateToken(token) {
-  return verify(token);
+  return verify(token) && token.length < 500;
 }
`;
  const blast = idx.blastRadiusFromDiff(diff);
  const changedNames = blast.changed.map((s) => s.name);
  const callerNames = blast.callers.map((s) => s.name);
  assert.ok(changedNames.includes("validateToken"), `changed should include validateToken; got ${changedNames}`);
  assert.ok(callerNames.includes("handleLogin"), `blast radius should reach handleLogin; got ${callerNames}`);
  assert.ok(blast.files.includes("src/routes.ts"), "routes.ts is in the blast radius");
});

test("incremental: re-index updates the graph and is a no-op when unchanged", () => {
  const idx = freshIndex();
  assert.equal(idx.updateFile("src/auth.ts", AUTH), false, "identical content → no-op");

  // Add a new function in auth.ts that routes does not call yet.
  const AUTH2 = AUTH + `\nexport function refresh(t) { return validateToken(t); }\n`;
  assert.equal(idx.updateFile("src/auth.ts", AUTH2), true, "changed content → re-indexed");
  assert.ok(idx.getSymbol(symbolId("src/auth.ts", "refresh")), "new symbol present");

  // refresh() now also calls validateToken → it becomes an additional caller.
  const callers = idx.callersOf(symbolId("src/auth.ts", "validateToken")).map((c) => c.name);
  assert.ok(callers.includes("refresh"), `refresh should now call validateToken; got ${callers}`);
});

test("removeFile: drops symbols and their edges", () => {
  const idx = freshIndex();
  idx.removeFile("src/routes.ts");
  assert.equal(idx.callersOf(symbolId("src/auth.ts", "validateToken")).length, 0);
  assert.equal(idx.stats().files, 1);
});
