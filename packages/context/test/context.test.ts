import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeIndex, HeuristicParser, FakeEmbedder } from "@cavix/analyzer";
import {
  ContextAssembler,
  renderContextPrompt,
  MapFileReader,
  FakePastDiscussions,
  FakeCompressor,
} from "@cavix/context";

const AUTH = `export function validateToken(token) {
  return verify(token);
}
export function verify(t) { return t.length > 0; }
`;
const ROUTES = `import { validateToken } from "./auth";
export function handleLogin(req, res) {
  if (!validateToken(req.token)) return res.status(401).send("no");
  return res.send("ok");
}
`;

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,3 @@
 export function validateToken(token) {
-  return verify(token);
+  return verify(token) && token.length < 500;
 }
`;

function buildAssembler(extra?: { files?: Record<string, string>; embedder?: boolean; compressor?: FakeCompressor }) {
  const files: Record<string, string> = { "src/auth.ts": AUTH, "src/routes.ts": ROUTES, ...(extra?.files ?? {}) };
  const idx = new CodeIndex(new HeuristicParser());
  idx.indexFiles(Object.entries(files).map(([path, content]) => ({ path, content })));
  return new ContextAssembler({
    index: idx,
    files: new MapFileReader(files),
    discussions: new FakePastDiscussions({
      "src/auth.ts": [{ path: "src/auth.ts", pr: 7, author: "alice", body: "We hardened token checks here last quarter." }],
    }),
    compressor: extra?.compressor,
    embedder: extra?.embedder ? new FakeEmbedder() : undefined,
    budgetTokens: 5000,
  });
}

test("assemble: pulls the cross-file caller into context (the recall win)", async () => {
  const ctx = await buildAssembler().assemble({ org: "acme", diff: DIFF });
  const caller = ctx.items.find((i) => i.kind === "caller");
  assert.ok(caller, "a caller item should be present");
  assert.equal(caller!.path, "src/routes.ts");
  assert.match(caller!.content, /handleLogin/);
  assert.ok(ctx.blastFiles.includes("src/routes.ts"));

  // Past discussion on the touched file is included.
  assert.ok(ctx.items.some((i) => i.kind === "discussion" && /hardened token/.test(i.content)));

  // The rendered prompt is one structured block.
  const prompt = renderContextPrompt(ctx);
  assert.match(prompt, /Change under review/);
  assert.match(prompt, /Caller of changed code/);
});

test("assemble: compresses oversized items with the cheap-model compressor", async () => {
  const big = "x".repeat(5000);
  // The huge content lives INSIDE a caller of validateToken, so its snippet is
  // oversized and must be compressed.
  const bigFile = `export function bigHandler(req) {\n  // ${big}\n  return validateToken(req.token);\n}\n`;
  const ctx = await buildAssembler({ files: { "src/big.ts": bigFile }, compressor: new FakeCompressor(120) }).assemble({
    org: "acme",
    diff: DIFF,
  });
  const compressed = ctx.items.find((i) => i.compressed);
  assert.ok(compressed, "an oversized caller item should be compressed");
  assert.match(compressed!.content, /\[compressed \d+ chars\]/);
});

test("assemble: respects the token budget and reports drops", async () => {
  // Tiny budget → only the highest-priority items survive.
  const idx = new CodeIndex(new HeuristicParser());
  const files = { "src/auth.ts": AUTH, "src/routes.ts": ROUTES };
  idx.indexFiles(Object.entries(files).map(([path, content]) => ({ path, content })));
  const tiny = new ContextAssembler({
    index: idx,
    files: new MapFileReader(files),
    discussions: new FakePastDiscussions({ "src/auth.ts": [{ path: "src/auth.ts", pr: 1, author: "x", body: "y".repeat(400) }] }),
    budgetTokens: 40, // ~160 chars
  });
  const ctx = await tiny.assemble({ org: "acme", diff: DIFF });
  assert.equal(ctx.items[0].kind, "diff", "diff is always kept first");
  assert.ok(ctx.droppedForBudget > 0, "lower-priority items dropped under tight budget");
  assert.ok(ctx.tokenEstimate <= 60, `token estimate within budget-ish, got ${ctx.tokenEstimate}`);
});

test("assemble: embeddings surface a semantically related off-graph file", async () => {
  // No call edge to the change (not a caller), but similar token vocabulary.
  const related = `export function checkSession(session){ const token = session.token; return token && token.length > 0; }`;
  const ctx = await buildAssembler({ files: { "src/session.ts": related }, embedder: true }).assemble({
    org: "acme",
    diff: DIFF,
  });
  assert.ok(ctx.items.some((i) => i.kind === "related"), "a semantic neighbor should appear");
});
