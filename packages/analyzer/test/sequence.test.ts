import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeIndex, HeuristicParser, traceSequence } from "@cavix/analyzer";

// Stage 4's graph, asked a question it could not previously answer: in what
// ORDER does this change call across files? Everything here runs the real
// heuristic parser over real source, because the failure mode this feature has
// is not "the code throws", it is "the picture is wrong", and only real parsing
// produces a wrong picture.

function index(files: Array<{ path: string; content: string }>): CodeIndex {
  const ix = new CodeIndex(new HeuristicParser());
  ix.indexFiles(files);
  return ix;
}

/** A diff whose line numbers line up with `content`, touching `line`. */
function touch(path: string, line: number, text: string): string {
  return `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -${line},1 +${line},2 @@
+${text}
`;
}

const WEBHOOK = [
  {
    path: "services/payments/webhook.ts",
    content: `import { issueRefund } from "./refund.ts";
import { verifySignature } from "../auth/signature.ts";
import { writeAudit } from "../audit/log.ts";

export async function onWebhook(req) {
  verifySignature(req);
  const event = parseBody(req);
  await issueRefund(event.id, event.amount);
  writeAudit("webhook", event.type);
}

function parseBody(req) {
  return JSON.parse(req.body);
}
`,
  },
  {
    path: "services/payments/refund.ts",
    content: `import { chargeLookup } from "../stripe/charges.ts";
import { writeAudit } from "../audit/log.ts";

export async function issueRefund(chargeId, amount) {
  const charge = await chargeLookup(chargeId);
  writeAudit("refund", chargeId);
}
`,
  },
  { path: "services/auth/signature.ts", content: `export function verifySignature(req) {\n  return true;\n}\n` },
  { path: "services/audit/log.ts", content: `export function writeAudit(kind, detail) {\n  return kind;\n}\n` },
  { path: "services/stripe/charges.ts", content: `export async function chargeLookup(id) {\n  return { id };\n}\n` },
];

test("callSitesFrom returns the calls in written order, with their lines", () => {
  // calleesOf cannot answer this: resolveEdges folds call sites into a Set, so
  // the order and the line are gone by the time it is asked.
  const ix = index(WEBHOOK);
  const sites = ix.callSitesFrom("services/payments/webhook.ts#onWebhook");
  assert.deepEqual(
    sites.map((s) => s.symbol.name),
    ["verifySignature", "parseBody", "issueRefund", "writeAudit"],
  );
  assert.ok(sites[0].line < sites[3].line, "and the lines ascend with the source");
});

test("callSitesFrom collapses a repeated call to one interaction", () => {
  // A loop that calls save() three times is one interaction in a flow. Drawing
  // it three times says something about the source that is not true of the run.
  const ix = index([
    { path: "a.ts", content: `import { save } from "./b.ts";\nexport function run(xs) {\n  save(xs[0]);\n  save(xs[1]);\n  save(xs[2]);\n}\n` },
    { path: "b.ts", content: `export function save(x) { return x; }\n` },
  ]);
  const sites = ix.callSitesFrom("a.ts#run");
  assert.equal(sites.length, 1);
  assert.equal(sites[0].line, 3, "the first call site, not the last");
});

test("a cross-file change traces the call path in order", () => {
  const trace = traceSequence(index(WEBHOOK), touch("services/payments/webhook.ts", 8, `  await issueRefund(event.id, event.amount);`));
  assert.ok(trace, "there is a flow here");
  assert.deepEqual(trace!.entryPoints, ["onWebhook"]);
  assert.deepEqual(
    trace!.steps.map((s) => `${s.fromSymbol}->${s.toSymbol}`),
    ["onWebhook->verifySignature", "onWebhook->issueRefund", "issueRefund->chargeLookup", "issueRefund->writeAudit", "onWebhook->writeAudit"],
    "depth-first, in call-site order, so it reads as the flow rather than as the graph",
  );
  assert.equal(trace!.truncated, false);
});

test("local helper calls are walked THROUGH, not drawn", () => {
  // The bug a realistic fixture found. A handler calls a dozen local helpers
  // before it calls anything else; drawing each as a self-message filled the
  // step budget and pushed the one interaction that mattered off the bottom.
  // Past about fifteen helpers it removed EVERY cross-file call, leaving one
  // lifeline and therefore no diagram, on exactly the changes that deserve one.
  const helpers = Array.from({ length: 15 }, (_, i) => `function h${i}(x) { return x; }`).join("\n");
  const calls = Array.from({ length: 15 }, (_, i) => `  h${i}(v);`).join("\n");
  const ix = index([
    { path: "src/handler.ts", content: `import { persist } from "./store.ts";\nimport { audit } from "./audit.ts";\n\nexport function handle(v) {\n${calls}\n  persist(v);\n  audit(v);\n}\n\n${helpers}\n` },
    { path: "src/store.ts", content: `export function persist(v) { return v; }\n` },
    { path: "src/audit.ts", content: `export function audit(v) { return v; }\n` },
  ]);
  const trace = traceSequence(ix, touch("src/handler.ts", 5, `  h0(v);`));
  assert.ok(trace, "the cross-file calls survive fifteen local helpers");
  assert.deepEqual(trace!.steps.map((s) => s.toSymbol), ["persist", "audit"]);
  assert.ok(trace!.steps.every((s) => s.fromPath !== s.toPath), "every arrow crosses a file");
});

test("a helper that reaches another file is drawn from where its call site is written", () => {
  const ix = index([
    { path: "src/handler.ts", content: `import { persist } from "./store.ts";\n\nexport function handle(v) {\n  local(v);\n  other(v);\n}\n\nfunction local(v) {\n  return persist(v);\n}\n\nfunction other(v) {\n  return persist(v);\n}\n` },
    { path: "src/store.ts", content: `export function persist(v) { return v; }\n` },
  ]);
  const trace = traceSequence(ix, touch("src/handler.ts", 4, `  local(v);`));
  assert.ok(trace);
  assert.equal(trace!.steps[0].fromSymbol, "local", "attributed to the symbol that actually calls it");
  assert.equal(trace!.steps[0].fromPath, "src/handler.ts", "which is still a fact about this file");
});

test("a single-file change gets no diagram at all", () => {
  // Most pull requests. A sequence diagram with one lifeline is a list, and the
  // walkthrough is already a list.
  const ix = index([WEBHOOK[1], WEBHOOK[3], WEBHOOK[4]]);
  const solo = index([{ path: "src/only.ts", content: `export function a() {\n  return b();\n}\nfunction b() { return 1; }\n` }]);
  assert.equal(traceSequence(solo, touch("src/only.ts", 2, `  return b();`)), null);
  assert.ok(traceSequence(ix, touch("services/payments/refund.ts", 5, `  const charge = await chargeLookup(chargeId);`)), "but a cross-file one does");
});

test("one interaction is not a sequence", () => {
  const ix = index([
    { path: "a.ts", content: `import { save } from "./b.ts";\nexport function run(x) {\n  save(x);\n}\n` },
    { path: "b.ts", content: `export function save(x) { return x; }\n` },
  ]);
  assert.equal(traceSequence(ix, touch("a.ts", 3, `  save(x);`)), null);
});

test("a change the graph cannot place produces nothing, not a crash", () => {
  const ix = index(WEBHOOK);
  // A diff against a file the index never saw.
  assert.equal(traceSequence(ix, touch("does/not/exist.ts", 3, `  whatever();`)), null);
  assert.equal(traceSequence(ix, ""), null);
});

test("a call cycle terminates", () => {
  const ix = index([
    { path: "src/a.ts", content: `import { b } from "./b.ts";\nexport function a() {\n  return b();\n}\n` },
    { path: "src/b.ts", content: `import { a } from "./a.ts";\nexport function b() {\n  return a();\n}\n` },
  ]);
  const trace = traceSequence(ix, touch("src/a.ts", 3, `  return b();`));
  assert.ok(trace, "a mutual recursion is still a flow");
  assert.deepEqual(trace!.steps.map((s) => `${s.fromSymbol}->${s.toSymbol}`), ["a->b", "b->a"]);
});

test("a wide fan-out is capped and says so", () => {
  const ix = index([
    {
      path: "src/root.ts",
      content: `${Array.from({ length: 30 }, (_, i) => `import { f${i} } from "./m${i}.ts";`).join("\n")}\nexport function root() {\n${Array.from({ length: 30 }, (_, i) => `  f${i}();`).join("\n")}\n}\n`,
    },
    ...Array.from({ length: 30 }, (_, i) => ({ path: `src/m${i}.ts`, content: `export function f${i}() { return ${i}; }\n` })),
  ]);
  const trace = traceSequence(ix, touch("src/root.ts", 32, `  f0();`));
  assert.ok(trace);
  assert.ok(trace!.participants.length <= 6, `${trace!.participants.length} lifelines is a wall, not a diagram`);
  assert.ok(trace!.steps.length <= 14);
  assert.equal(trace!.truncated, true, "and the caption has to admit it was cut");
});

test("the same change traces identically twice", () => {
  // A re-review that redraws the description differently for no reason is a diff
  // in somebody's pull request history.
  const diff = touch("services/payments/webhook.ts", 8, `  await issueRefund(event.id, event.amount);`);
  const a = traceSequence(index(WEBHOOK), diff);
  const b = traceSequence(index([...WEBHOOK].reverse()), diff);
  assert.deepEqual(a, b, "and file ingestion order must not change it either");
});
