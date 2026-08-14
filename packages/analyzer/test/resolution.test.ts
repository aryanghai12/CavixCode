import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeIndex, HeuristicParser, DEFAULT_FANOUT_CAP } from "@cavix/analyzer";

// The graph decides what a review CLAIMS about reach. Three things it used to
// get wrong, each of which produced a confident wrong answer rather than a
// visible failure.

const index = (files: Array<{ path: string; content: string }>) => {
  const ix = new CodeIndex(new HeuristicParser());
  ix.indexFiles(files);
  return ix;
};

// ---------- identity ----------

test("two symbols with the same name in one file do not merge", () => {
  // `path#name` was the same string for both, so the second overwrote the first
  // in the symbol map and their CALLERS MERGED. The blast radius for one
  // silently included the other's: a wrong answer that looks exactly like a
  // right one.
  //
  // A TypeScript overload set, a re-declaration, or a `function` and a `const`
  // arrow of the same name all produce this shape.
  const ix = index([
    {
      path: "src/jobs.ts",
      content: `export function run(n) { return n; }
export function run(n, opts) { return opts; }
`,
    },
  ]);
  const runs = ix.findByName("run");
  assert.equal(runs.length, 2, "both survive indexing");
  assert.notEqual(runs[0].id, runs[1].id, "and they have different identities");
  assert.equal(ix.symbolsInFile("src/jobs.ts").length, 2);
});

test("the first occurrence keeps the plain id, so existing ids are unchanged", () => {
  const ix = index([{ path: "a.ts", content: "export function once() {}\n" }]);
  assert.equal(ix.findByName("once")[0].id, "a.ts#once");
});

// ---------- how sure are we ----------

test("a single symbol of that name anywhere is an exact edge", () => {
  const ix = index([
    { path: "src/db.ts", content: "export function query(sql) { return sql; }\n" },
    { path: "src/api.ts", content: 'import { query } from "./db";\nexport function load() { return query("x"); }\n' },
  ]);
  assert.equal(ix.edgeResolutionFor("src/api.ts#load", "src/db.ts#query"), "exact");
});

test("an arbitrary pick among several candidates is labelled ambiguous, not resolved", () => {
  // The old last line was `return [...candidates][0]`: with three functions
  // named `send` and no import evidence it picked whichever came first in a Set
  // and recorded that as a call edge, indistinguishable from a resolved one. A
  // review could then name a "caller" that does not call the changed code.
  const ix = index([
    { path: "src/mail.ts", content: "export function send(x) { return x; }\n" },
    { path: "src/sms.ts", content: "export function send(x) { return x; }\n" },
    { path: "src/push.ts", content: "export function send(x) { return x; }\n" },
    { path: "src/notify.ts", content: "export function notify() { return send(1); }\n" },
  ]);
  const radius = ix.blastRadius(["src/mail.ts#send", "src/sms.ts#send", "src/push.ts#send"]);
  // The guess is still made, because a plausible caller is useful context for a
  // model. What matters is that it is no longer presented as a fact.
  assert.equal(radius.resolution, "ambiguous");
});

test("a same-file call is exact when the file declares the name once", () => {
  const ix = index([
    { path: "src/a.ts", content: "function helper() { return 1; }\nexport function main() { return helper(); }\n" },
  ]);
  assert.equal(ix.edgeResolutionFor("src/a.ts#main", "src/a.ts#helper"), "exact");
});

test("the weakest evidence for an edge is the one that survives", () => {
  // An edge is worth its worst link. Two call sites can reach the same symbol,
  // one provably and one by guess.
  const ix = index([
    { path: "src/one.ts", content: "export function shared() {}\n" },
    { path: "src/two.ts", content: "export function shared() {}\n" },
    {
      path: "src/caller.ts",
      content: 'import { shared } from "./one";\nexport function go() { shared(); other(); }\n',
    },
  ]);
  const r = ix.edgeResolutionFor("src/caller.ts#go", "src/one.ts#shared");
  assert.ok(r === "exact" || r === "heuristic", `resolution was ${r}`);
});

test("the blast radius carries no resolution when no edge was walked", () => {
  const ix = index([{ path: "a.ts", content: "export function alone() {}\n" }]);
  const radius = ix.blastRadius(["a.ts#alone"]);
  assert.equal(radius.resolution, undefined);
  assert.deepEqual(radius.callers, []);
});

// ---------- fanout ----------

test("a symbol called from everywhere is reported, not expanded", () => {
  // A utility called from four hundred places contributes four hundred caller
  // snippets, which evicts every other kind of context under a fixed token
  // budget: definitions, past discussions, the team's own rules.
  const files = [{ path: "src/log.ts", content: "export function log(m) { return m; }\n" }];
  for (let i = 0; i < DEFAULT_FANOUT_CAP + 5; i++) {
    files.push({
      path: `src/c${i}.ts`,
      content: `import { log } from "./log";\nexport function caller${i}() { return log(${i}); }\n`,
    });
  }
  const ix = index(files);
  const radius = ix.blastRadius(["src/log.ts#log"]);

  assert.equal(radius.callers.length, 0, "the hot symbol is not expanded");
  assert.equal(radius.truncated.length, 1);
  assert.equal(radius.truncated[0].symbol.name, "log");
  // The real number, so a reviewer told 412 reasons differently from one shown
  // 25 and left to assume that is all of them.
  assert.equal(radius.truncated[0].callers, DEFAULT_FANOUT_CAP + 5);
});

test("an ordinary symbol is still expanded fully", () => {
  const ix = index([
    { path: "src/pay.ts", content: "export function pay(x) { return x; }\n" },
    { path: "src/a.ts", content: 'import { pay } from "./pay";\nexport function a() { return pay(1); }\n' },
    { path: "src/b.ts", content: 'import { pay } from "./pay";\nexport function b() { return pay(2); }\n' },
  ]);
  const radius = ix.blastRadius(["src/pay.ts#pay"]);
  assert.equal(radius.callers.length, 2);
  assert.deepEqual(radius.truncated, []);
});

test("the cap is configurable, and the old depth-only signature still works", () => {
  const files = [{ path: "src/log.ts", content: "export function log(m) { return m; }\n" }];
  for (let i = 0; i < 4; i++) {
    files.push({
      path: `src/c${i}.ts`,
      content: `import { log } from "./log";\nexport function caller${i}() { return log(${i}); }\n`,
    });
  }
  const ix = index(files);
  assert.equal(ix.blastRadius(["src/log.ts#log"], { fanoutCap: 2 }).truncated.length, 1);
  assert.equal(ix.blastRadius(["src/log.ts#log"], { fanoutCap: 99 }).callers.length, 4);
  // Several call sites and tests pass a bare depth. That has to keep working.
  assert.equal(ix.blastRadius(["src/log.ts#log"], 3).callers.length, 4);
});
