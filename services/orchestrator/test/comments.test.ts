import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "@cavix/core";
import { reconcileInlineComments, inlineFingerprint } from "@cavix/orchestrator";

// Six pushes on a three-finding pull request used to leave eighteen inline
// comments, all saying the same three things, and the only way to tell which
// were current was to read the timestamps. The ledger could be perfectly correct
// while the page was nonsense, and the reader believes the page.

function finding(over: Partial<Finding> = {}): Finding {
  return {
    path: "src/api/refund.ts",
    line: 41,
    severity: "high",
    category: "security",
    title: "SQL injection via orderId",
    body: "orderId is concatenated into the query.",
    source: "llm",
    confidence: 0.9,
    ...over,
  };
}

const marker = "<!-- cavix:inline -->";
const comment = (f: Finding, extra = "") => ({
  path: f.path,
  line: f.line,
  body: `${marker}\n${inlineFingerprint(f)}\n> **${f.title}**${extra}`,
});
const existingFor = (id: number, f: Finding) => ({ id, body: comment(f).body, path: f.path, line: f.line });

test("a finding already on the page is not posted again", () => {
  const f = finding();
  const plan = reconcileInlineComments({ existing: [existingFor(1, f)], incoming: [comment(f)] });
  assert.equal(plan.post.length, 0, "nothing new to say");
  assert.deepEqual(plan.keep, [1]);
  assert.deepEqual(plan.remove, []);
});

test("a genuinely new finding is posted", () => {
  const old = finding();
  const fresh = finding({ title: "Rounding drops the final cent", line: 94 });
  const plan = reconcileInlineComments({ existing: [existingFor(1, old)], incoming: [comment(fresh)] });
  assert.equal(plan.post.length, 1);
  assert.equal(plan.post[0].line, 94);
});

test("a comment for a finding this review CLEARED is removed", () => {
  const fixed = finding();
  const plan = reconcileInlineComments({
    existing: [existingFor(7, fixed)],
    incoming: [],
    resolved: [inlineFingerprintOf(fixed)],
  });
  // A comment describing a defect that has been fixed is worse than no comment:
  // it reads as an open problem.
  assert.deepEqual(plan.remove, [7]);
});

test("silence is NOT resolution: an unmentioned finding keeps its comment", () => {
  // The same rule the ledger is built on. A reviewer going quiet about a defect
  // in code nobody touched is a statement about the reviewer, not about the
  // code, and deleting the comment would hide an open finding from the one place
  // a developer actually reads.
  const quiet = finding();
  const plan = reconcileInlineComments({ existing: [existingFor(7, quiet)], incoming: [] });
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.stale.length, 1);
});

test("a comment Cavix did not write is never touched", () => {
  const human = { id: 99, body: "Why is this needed?", path: "src/api/refund.ts", line: 41 };
  const plan = reconcileInlineComments({ existing: [human], incoming: [comment(finding())] });
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.keep, []);
  assert.equal(plan.post.length, 1, "our finding is still posted");
});

test("a comment from before fingerprints existed is left alone", () => {
  const legacy = { id: 5, body: `${marker}\n> **Old finding**`, path: "a.ts", line: 1 };
  const plan = reconcileInlineComments({ existing: [legacy], incoming: [] });
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.keep, []);
});

test("duplicates that somehow accumulated converge on one", () => {
  const f = finding();
  const plan = reconcileInlineComments({
    existing: [existingFor(1, f), existingFor(2, f), existingFor(3, f)],
    incoming: [comment(f)],
  });
  assert.deepEqual(plan.keep, [1]);
  assert.deepEqual(plan.remove.sort(), [2, 3]);
  assert.equal(plan.post.length, 0);
});

test("an incoming comment with no fingerprint is posted rather than dropped", () => {
  // A duplicate comment is a far smaller failure than a silently dropped one.
  const plan = reconcileInlineComments({
    existing: [],
    incoming: [{ path: "a.ts", line: 1, body: "no marker here" }],
  });
  assert.equal(plan.post.length, 1);
});

test("nothing on the page means everything is posted", () => {
  const a = finding();
  const b = finding({ title: "Second", line: 94 });
  const plan = reconcileInlineComments({ existing: [], incoming: [comment(a), comment(b)] });
  assert.equal(plan.post.length, 2);
  assert.deepEqual(plan.keep, []);
});

test("the four pushes case: one comment per finding, not four", () => {
  const a = finding();
  const b = finding({ title: "Rounding drops the final cent", line: 94 });

  // Review 1 posts both.
  let existing = [existingFor(1, a), existingFor(2, b)];

  // Reviews 2, 3 and 4 raise the same two findings again.
  for (let i = 0; i < 3; i++) {
    const plan = reconcileInlineComments({ existing, incoming: [comment(a), comment(b)] });
    assert.equal(plan.post.length, 0, `push ${i + 2} posts nothing new`);
    assert.equal(plan.remove.length, 0);
  }

  // Push 5 fixes the first one.
  const plan = reconcileInlineComments({
    existing,
    incoming: [comment(b)],
    resolved: [inlineFingerprintOf(a)],
  });
  assert.deepEqual(plan.remove, [1], "the fixed one's comment goes");
  assert.deepEqual(plan.keep, [2], "the open one stays exactly where it is");
  assert.equal(plan.post.length, 0);
});

/** The fingerprint alone, for building `resolved` lists in these tests. */
function inlineFingerprintOf(f: Finding): string {
  const m = /fp=([0-9a-f]+)/.exec(inlineFingerprint(f));
  return m ? m[1] : "";
}
