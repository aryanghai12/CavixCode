import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeIndex, HeuristicParser } from "@cavix/analyzer";

// Persisting the graph, and the one rule that makes it safe to.
//
// Every review re-parses the repository from scratch, so the cost of building
// the graph scales with the size of the REPOSITORY rather than the size of the
// change, and it is paid again on every push of every pull request.
//
// Caching it is only acceptable under the spec's rule: the graph is a cache and
// never a source of truth, so a stale entry makes a review SLOWER, never WRONG.
// That rule is enforced here rather than merely intended.

const APP = [
  { path: "src/db.ts", content: "export function query(sql) { return sql; }\n" },
  {
    path: "src/refund.ts",
    content: 'import { query } from "./db";\nexport function refund(id) {\n  return query(id);\n}\n',
  },
];

const build = (files: Array<{ path: string; content: string }>) => {
  const ix = new CodeIndex(new HeuristicParser());
  ix.indexFiles(files);
  return ix;
};

test("a graph survives a round trip through storage", () => {
  const before = build(APP);
  const restored = CodeIndex.fromSnapshot(new HeuristicParser(), before.toSnapshot("abc123"));

  assert.deepEqual(restored.allFiles().sort(), before.allFiles().sort());
  assert.deepEqual(restored.stats(), before.stats());
  assert.equal(restored.callersOf("src/db.ts#query").length, 1, "edges are rebuilt, not just symbols");
});

test("a snapshot is plain JSON, because it goes to storage", () => {
  const snap = build(APP).toSnapshot("abc123");
  const roundTripped = JSON.parse(JSON.stringify(snap));
  const restored = CodeIndex.fromSnapshot(new HeuristicParser(), roundTripped);
  assert.equal(restored.allFiles().length, 2);
  // `importedNames` is a Set in memory and an array on the wire. If that
  // conversion were missed it would survive JSON as `{}` and silently stop
  // biasing call resolution.
  assert.equal(restored.callersOf("src/db.ts#query").length, 1);
});

// ---------- the rule ----------

test("nothing restored from storage counts as verified", () => {
  const restored = CodeIndex.fromSnapshot(new HeuristicParser(), build(APP).toSnapshot());
  assert.deepEqual(restored.verifiedPaths(), [], "a recollection is not a fact");
});

test("re-reading a file this review makes it verified", () => {
  const ix = CodeIndex.fromSnapshot(new HeuristicParser(), build(APP).toSnapshot());
  ix.updateFile("src/refund.ts", 'import { query } from "./db";\nexport function refund(id) {\n  return query(id);\n}\n');
  assert.deepEqual(ix.verifiedPaths(), ["src/refund.ts"]);
});

test("a caller drawn from a CACHED file can never support an exact claim", () => {
  // The whole safety story. That record describes a version of the file which
  // may since have been edited or deleted, so the caller may no longer exist.
  // It still earns its place as recall, and it may never support a claim on
  // somebody's pull request.
  const fresh = build(APP);
  assert.equal(fresh.blastRadius(["src/db.ts#query"]).resolution, "exact");

  const cached = CodeIndex.fromSnapshot(new HeuristicParser(), fresh.toSnapshot());
  const radius = cached.blastRadius(["src/db.ts#query"]);
  assert.equal(radius.callers.length, 1, "the caller is still offered, for recall");
  assert.equal(radius.resolution, "heuristic", "but the claim is weakened");
});

test("re-reading the caller restores the stronger claim", () => {
  const cached = CodeIndex.fromSnapshot(new HeuristicParser(), build(APP).toSnapshot());
  assert.equal(cached.blastRadius(["src/db.ts#query"]).resolution, "heuristic");

  cached.updateFile(
    "src/refund.ts",
    'import { query } from "./db";\nexport function refund(id) {\n  return query(id);\n}\n',
  );
  assert.equal(
    cached.blastRadius(["src/db.ts#query"]).resolution,
    "exact",
    "a file this review actually read is a fact again",
  );
});

test("an already-ambiguous edge is not upgraded by being verified", () => {
  // The cap only ever weakens. A guess among same-named symbols stays a guess
  // however freshly it was read.
  const ix = build([
    { path: "src/mail.ts", content: "export function send(x) { return x; }\n" },
    { path: "src/sms.ts", content: "export function send(x) { return x; }\n" },
    { path: "src/notify.ts", content: "export function notify() { return send(1); }\n" },
  ]);
  assert.equal(ix.blastRadius(["src/mail.ts#send", "src/sms.ts#send"]).resolution, "ambiguous");
});

test("a stale cache costs a weaker sentence, never a wrong one", () => {
  // The property stated end to end. The cached graph still believes `refund`
  // calls `query`; the file has since been rewritten so it no longer does.
  const cached = CodeIndex.fromSnapshot(new HeuristicParser(), build(APP).toSnapshot());

  // Nobody re-read refund.ts this review, so the graph reports the caller it
  // remembers, and reports it at reduced confidence rather than as a fact.
  const stale = cached.blastRadius(["src/db.ts#query"]);
  assert.equal(stale.resolution, "heuristic");

  // Once it IS re-read and the call is gone, the caller disappears entirely.
  cached.updateFile("src/refund.ts", "export function refund(id) {\n  return id;\n}\n");
  assert.deepEqual(cached.blastRadius(["src/db.ts#query"]).callers, []);
});

test("routes survive persistence, since they drive a security sentence", () => {
  const fresh = build([
    {
      path: "src/routes.ts",
      content: 'export function mount(app) {\n  app.post("/api/refunds/:id", refund);\n}\n',
    },
  ]);
  const restored = CodeIndex.fromSnapshot(new HeuristicParser(), JSON.parse(JSON.stringify(fresh.toSnapshot())));
  const routes = restored.allRoutes();
  assert.equal(routes.length, 1);
  assert.equal(routes[0].route, "/api/refunds/:id");
});

test("an empty snapshot restores to an empty index rather than throwing", () => {
  const ix = CodeIndex.fromSnapshot(new HeuristicParser(), { v: 1, files: [], symbols: [] });
  assert.deepEqual(ix.allFiles(), []);
  assert.deepEqual(ix.blastRadius(["nothing"]).callers, []);
});
