import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeFor, openInSkippedFiles, EMPTY_LEDGER, type LedgerEntry, type PrLedger } from "@cavix/review-session";

// Narrowing what a re-review READS, without narrowing what it is responsible
// for. The verdict is still computed over the whole pull request; only the
// model's attention moves.

const file = (path: string, body = "changed") =>
  `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1,2 +1,3 @@
 const x = 1;
+${body}
`;

const WHOLE_PR = file("a.ts") + file("b.ts") + file("c.ts") + file("d.ts");

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    fingerprint: "f1",
    path: "b.ts",
    line: 2,
    severity: "high",
    category: "correctness",
    title: "Open finding",
    firstSeenSha: "old",
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    lastSeenSha: "old",
    lastSeenAt: "2026-08-01T00:00:00.000Z",
    timesReported: 1,
    fileDigest: "d",
    state: "open",
    ...over,
  };
}

const ledgerWith = (...entries: LedgerEntry[]): PrLedger => ({ entries, reviewsUsed: 1 });

test("a first review reads everything", () => {
  const s = scopeFor({ verdictDiff: WHOLE_PR, ledger: EMPTY_LEDGER, headSha: "aaa" });
  assert.equal(s.narrowed, false);
  assert.deepEqual(s.hot, ["a.ts", "b.ts", "c.ts", "d.ts"]);
  assert.match(s.reason, /first review/);
});

test("a re-review reads only what the push changed, plus nothing else", () => {
  const s = scopeFor({
    verdictDiff: WHOLE_PR,
    deltaDiff: file("a.ts", "new work"),
    ledger: ledgerWith(entry({ path: "b.ts" })),
    priorHeadSha: "aaa",
    headSha: "bbb",
  });
  assert.equal(s.narrowed, true);
  assert.deepEqual(s.hot, ["a.ts"]);
  // b.ts carries an open finding: not re-read, and not forgotten either.
  assert.deepEqual(s.warm, ["b.ts"]);
  assert.deepEqual(s.cold, ["c.ts", "d.ts"]);
});

test("open findings in files that were not re-read are reportable, not lost", () => {
  const ledger = ledgerWith(entry({ path: "b.ts" }), entry({ fingerprint: "f2", path: "c.ts" }));
  const s = scopeFor({
    verdictDiff: WHOLE_PR,
    deltaDiff: file("a.ts"),
    ledger,
    priorHeadSha: "aaa",
    headSha: "bbb",
  });
  const carried = openInSkippedFiles(ledger, s);
  assert.deepEqual(carried.map((e) => e.path).sort(), ["b.ts", "c.ts"]);
});

test("a resolved finding does not keep its file warm", () => {
  const s = scopeFor({
    verdictDiff: WHOLE_PR,
    deltaDiff: file("a.ts"),
    ledger: ledgerWith(entry({ path: "b.ts", state: "resolved", resolution: "fixed" })),
    priorHeadSha: "aaa",
    headSha: "bbb",
  });
  assert.deepEqual(s.warm, []);
  assert.deepEqual(s.cold, ["b.ts", "c.ts", "d.ts"]);
});

// ---------- everything that must fall back to reading the whole thing ----------

test("a rebase, a fresh review, or changed rules: the caller says so and nothing is narrowed", () => {
  // The caller knows things this module cannot see. Any of them means earlier
  // reviews were formed against different premises and cannot be relied on.
  const s = scopeFor({
    verdictDiff: WHOLE_PR,
    deltaDiff: file("a.ts"),
    ledger: EMPTY_LEDGER,
    priorHeadSha: "aaa",
    headSha: "bbb",
    forceFull: "the branch was rebased",
  });
  assert.equal(s.narrowed, false);
  assert.equal(s.reason, "the branch was rebased");
  assert.equal(s.hot.length, 4);
});

test("no record of what the previous review read means no narrowing", () => {
  const s = scopeFor({
    verdictDiff: WHOLE_PR,
    deltaDiff: file("a.ts"),
    ledger: EMPTY_LEDGER,
    headSha: "bbb",
  });
  assert.equal(s.narrowed, false);
});

test("an empty delta is not an excuse to skip everything", () => {
  // The dangerous reading of "nothing changed" is "read nothing". If the delta
  // could not be computed, the honest answer is to read it all.
  const s = scopeFor({
    verdictDiff: WHOLE_PR,
    deltaDiff: "   ",
    ledger: EMPTY_LEDGER,
    priorHeadSha: "aaa",
    headSha: "bbb",
  });
  assert.equal(s.narrowed, false);
  assert.equal(s.hot.length, 4);
});

test("two diffs that disagree about which files changed are not trusted", () => {
  // A push touching a file the pull request does not contain means the two
  // diffs were computed against different things. Comparing them would skip
  // files on evidence that does not line up.
  const s = scopeFor({
    verdictDiff: WHOLE_PR,
    deltaDiff: file("somewhere-else.ts"),
    ledger: EMPTY_LEDGER,
    priorHeadSha: "aaa",
    headSha: "bbb",
  });
  assert.equal(s.narrowed, false);
  assert.match(s.reason, /disagree/);
});

test("a push that touched every file narrows nothing, and does not claim to", () => {
  const s = scopeFor({
    verdictDiff: WHOLE_PR,
    deltaDiff: WHOLE_PR,
    ledger: EMPTY_LEDGER,
    priorHeadSha: "aaa",
    headSha: "bbb",
  });
  assert.equal(s.narrowed, false);
  assert.deepEqual(s.cold, []);
});

test("the same head twice is not a re-review to narrow against", () => {
  const s = scopeFor({
    verdictDiff: WHOLE_PR,
    deltaDiff: file("a.ts"),
    ledger: EMPTY_LEDGER,
    priorHeadSha: "aaa",
    headSha: "aaa",
  });
  assert.equal(s.narrowed, false);
});

test("nothing is ever skipped when the scope was not narrowed", () => {
  const ledger = ledgerWith(entry({ path: "b.ts" }));
  const s = scopeFor({ verdictDiff: WHOLE_PR, ledger, headSha: "aaa" });
  assert.deepEqual(openInSkippedFiles(ledger, s), []);
});

test("the verdict domain is never narrowed: every file stays accounted for", () => {
  // The property the whole design rests on. Whatever the split, hot + warm +
  // cold is the complete pull request, because the merge introduces all of it.
  const s = scopeFor({
    verdictDiff: WHOLE_PR,
    deltaDiff: file("a.ts"),
    ledger: ledgerWith(entry({ path: "b.ts" })),
    priorHeadSha: "aaa",
    headSha: "bbb",
  });
  assert.deepEqual([...s.hot, ...s.warm, ...s.cold].sort(), ["a.ts", "b.ts", "c.ts", "d.ts"]);
});
