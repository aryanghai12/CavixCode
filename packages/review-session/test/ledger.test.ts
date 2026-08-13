import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "@cavix/core";
import {
  reconcile,
  fingerprintOf,
  fileDigests,
  openEntries,
  dismissAll,
  coerceLedger,
  EMPTY_LEDGER,
  MAX_ENTRIES,
  reviewBudget,
  clampLimit,
  exhaustedMessage,
  FREE_REVIEWS_PER_PR,
  PAID_REVIEWS_PER_PR,
  type PrLedger,
} from "@cavix/review-session";

// The fixture is a real-shaped pull request: one handler file with three
// separate defects in it, reviewed, partially fixed, pushed, reviewed again.
// That is the exact sequence that used to hand out a green check with two open
// findings still on the page.

const AUTH_V1 = `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 1111111..2222222 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -10,6 +10,14 @@ import { db } from "../db.ts";

 export async function loadSession(token: string) {
-  const row = await db.query("SELECT * FROM sessions WHERE token = '" + token + "'");
-  return row;
+  const row = await db.query("SELECT * FROM sessions WHERE token = '" + token + "'");
+  if (row.expiresAt < Date.now()) {
+    return row;
+  }
+  return row;
 }
+
+export function signOut(userId: string) {
+  cache.delete(userId);
+}
@@ -40,3 +48,7 @@ export function refresh(token: string) {
   return mint(token);
 }
+
+export function adminOnly(user: User) {
+  return true;
+}
`;

// The same pull request after the author fixed ONLY the SQL injection. The
// expiry check and the adminOnly stub are untouched, and the second hunk is
// byte-identical to what it was.
const AUTH_V2 = `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 1111111..3333333 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -10,6 +10,14 @@ import { db } from "../db.ts";

 export async function loadSession(token: string) {
-  const row = await db.query("SELECT * FROM sessions WHERE token = '" + token + "'");
-  return row;
+  const row = await db.query("SELECT * FROM sessions WHERE token = $1", [token]);
+  if (row.expiresAt < Date.now()) {
+    return row;
+  }
+  return row;
 }
+
+export function signOut(userId: string) {
+  cache.delete(userId);
+}
@@ -40,3 +48,7 @@ export function refresh(token: string) {
   return mint(token);
 }
+
+export function adminOnly(user: User) {
+  return true;
+}
`;

function finding(over: Partial<Finding> & Pick<Finding, "path" | "title">): Finding {
  return {
    line: 12,
    severity: "high",
    category: "security",
    body: "",
    source: "llm",
    confidence: 0.9,
    ...over,
  } as Finding;
}

const SQLI = finding({
  path: "src/auth/session.ts",
  title: "SQL injection: token is concatenated into the query",
  line: 12,
  severity: "critical",
});
const EXPIRY = finding({
  path: "src/auth/session.ts",
  title: "Expired session is returned instead of rejected",
  line: 14,
  severity: "high",
  category: "correctness",
});
const ADMIN = finding({
  path: "src/auth/session.ts",
  title: "adminOnly always returns true",
  line: 52,
  severity: "critical",
});

const clock = (iso: string) => () => new Date(iso);

// ---------------------------------------------------------------------------
// The bug this module was written for.
// ---------------------------------------------------------------------------

test("a re-review that goes quiet does NOT clear findings in code nobody touched", () => {
  // Review 1: all three raised.
  const first = reconcile({
    prior: EMPTY_LEDGER,
    findings: [SQLI, EXPIRY, ADMIN],
    diff: AUTH_V1,
    headSha: "aaa1111",
    now: clock("2026-07-30T10:00:00.000Z"),
  });
  assert.equal(first.fresh.length, 3);
  assert.equal(openEntries(first.ledger).length, 3);

  // Review 2, after the author fixed only the SQL injection. The model reports
  // nothing at all this time, which is exactly the flaky pass that used to hand
  // out a green check.
  const second = reconcile({
    prior: first.ledger,
    findings: [],
    diff: AUTH_V2,
    headSha: "bbb2222",
    now: clock("2026-07-30T11:00:00.000Z"),
  });

  // The file changed, so the reviewer's silence is allowed to clear findings in
  // the parts of it that moved. It is NOT allowed to clear a finding in a region
  // that is byte-identical.
  //
  // `adminOnly` lives under the second hunk, whose enclosing symbol git names as
  // `refresh` and whose content did not change by one byte between these two
  // pushes. Nobody touched that code, so a silent reviewer cannot retire it, and
  // before regions existed it did exactly that: a critical "adminOnly always
  // returns true" cleared itself because somebody fixed a SQL string 40 lines up.
  assert.equal(second.carried.length, 1);
  assert.equal(second.carried[0].title, ADMIN.title);
  assert.equal(second.carried[0].regionKey, "refresh");

  // The other two sit in the first hunk, which really did change, and git named
  // no symbol for it (its header is an import line). No region means the file
  // digest decides, which is the behaviour that shipped. One of the two was
  // genuinely fixed; the other is the honest limit of what a hunk header can
  // resolve, and it fails in the safe direction only when git names a symbol.
  assert.equal(second.resolved.length, 2);
  assert.ok(second.resolved.every((e) => e.resolution === "fixed"));
  assert.equal(second.historyRewritten, false);
});

test("a finding in an UNTOUCHED file is carried forward and still blocks", () => {
  // Two files, and the author only ever touches one of them.
  const v1 = `${AUTH_V1}diff --git a/src/billing/charge.ts b/src/billing/charge.ts
index 4444444..5555555 100644
--- a/src/billing/charge.ts
+++ b/src/billing/charge.ts
@@ -5,2 +5,5 @@ export function charge(cents: number) {
   return gateway.charge(cents);
 }
+export function refund(cents: number) {
+  return gateway.charge(cents);
+}
`;
  const v2 = `${AUTH_V2}diff --git a/src/billing/charge.ts b/src/billing/charge.ts
index 4444444..5555555 100644
--- a/src/billing/charge.ts
+++ b/src/billing/charge.ts
@@ -5,2 +5,5 @@ export function charge(cents: number) {
   return gateway.charge(cents);
 }
+export function refund(cents: number) {
+  return gateway.charge(cents);
+}
`;
  const REFUND = finding({
    path: "src/billing/charge.ts",
    title: "refund charges the customer instead of refunding them",
    line: 8,
    severity: "critical",
    category: "correctness",
  });

  const first = reconcile({
    prior: EMPTY_LEDGER,
    findings: [SQLI, REFUND],
    diff: v1,
    headSha: "aaa1111",
    now: clock("2026-07-30T10:00:00.000Z"),
  });
  assert.equal(openEntries(first.ledger).length, 2);

  // The author fixed the SQL injection and pushed. billing/charge.ts is
  // byte-identical. The model reports nothing this time.
  const second = reconcile({
    prior: first.ledger,
    findings: [],
    diff: v2,
    headSha: "bbb2222",
    now: clock("2026-07-30T11:00:00.000Z"),
  });

  assert.deepEqual(
    second.carried.map((e) => e.path),
    ["src/billing/charge.ts"],
  );
  assert.equal(second.carried[0].severity, "critical");
  assert.deepEqual(second.resolved.map((e) => e.path), ["src/auth/session.ts"]);
  // And it is still open in the persisted state, so the review after this one
  // carries it again.
  assert.equal(openEntries(second.ledger).length, 1);
});

test("a carried finding survives an unbounded number of silent re-reviews", () => {
  const v1 = `diff --git a/src/db/pool.ts b/src/db/pool.ts
--- a/src/db/pool.ts
+++ b/src/db/pool.ts
@@ -1,2 +1,3 @@
 export const pool = create();
+export const MAX = 1;
`;
  const LEAK = finding({ path: "src/db/pool.ts", title: "Connection is never released", severity: "high" });

  let ledger: PrLedger = reconcile({
    prior: EMPTY_LEDGER,
    findings: [LEAK],
    diff: v1,
    headSha: "sha0",
    now: clock("2026-07-30T10:00:00.000Z"),
  }).ledger;

  for (let i = 1; i <= 8; i++) {
    const r = reconcile({
      prior: ledger,
      findings: [],
      diff: v1,
      headSha: `sha${i}`,
      now: clock("2026-07-30T10:00:00.000Z"),
    });
    assert.equal(r.carried.length, 1, `review ${i} dropped the carried finding`);
    ledger = r.ledger;
  }
  assert.equal(openEntries(ledger).length, 1);
  assert.equal(ledger.reviewsUsed, 9);
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test("a finding keeps its identity when a fix above it shifts its line", () => {
  const at12 = finding({ path: "a.ts", title: "Missing null check on `user`", line: 12 });
  const at47 = finding({ path: "a.ts", title: "Missing null check on user", line: 47 });
  assert.equal(fingerprintOf(at12), fingerprintOf(at47));
});

test("different defects in the same file are different findings", () => {
  assert.notEqual(fingerprintOf(SQLI), fingerprintOf(EXPIRY));
  assert.notEqual(fingerprintOf(EXPIRY), fingerprintOf(ADMIN));
});

test("the same title in two files is two findings", () => {
  const a = finding({ path: "a.ts", title: "Unhandled promise rejection" });
  const b = finding({ path: "b.ts", title: "Unhandled promise rejection" });
  assert.notEqual(fingerprintOf(a), fingerprintOf(b));
});

test("ruleId wins over the title, so a rephrased scanner message is one finding", () => {
  const a = finding({ path: "a.ts", title: "Hardcoded AWS key", ruleId: "secret/aws-access-key" });
  const b = finding({ path: "a.ts", title: "AWS access key committed to the repository", ruleId: "secret/aws-access-key" });
  assert.equal(fingerprintOf(a), fingerprintOf(b));
});

test("numbers in a title are part of its identity", () => {
  const a = finding({ path: "a.ts", title: "off by one at index 3" });
  const b = finding({ path: "a.ts", title: "off by one at index 7" });
  assert.notEqual(fingerprintOf(a), fingerprintOf(b));
});

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

test("the file digest changes when the file's content changes, and only then", () => {
  const a = fileDigests(AUTH_V1);
  const b = fileDigests(AUTH_V2);
  assert.notEqual(a.get("src/auth/session.ts"), b.get("src/auth/session.ts"));
  assert.equal(a.get("src/auth/session.ts"), fileDigests(AUTH_V1).get("src/auth/session.ts"));
});

test("a finding whose file leaves the pull request is resolved as reverted", () => {
  const first = reconcile({
    prior: EMPTY_LEDGER,
    findings: [SQLI],
    diff: AUTH_V1,
    headSha: "aaa1111",
    now: clock("2026-07-30T10:00:00.000Z"),
  });
  const second = reconcile({
    prior: first.ledger,
    findings: [],
    diff: `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 # Cavix
+A line.
`,
    headSha: "bbb2222",
    now: clock("2026-07-30T11:00:00.000Z"),
  });
  assert.equal(second.resolved.length, 1);
  assert.equal(second.resolved[0].resolution, "reverted");
});

test("an off-diff finding stays open: nothing about it has changed", () => {
  const OFF = finding({ path: "src/never/in/the/diff.ts", title: "Caller does not handle the new error" });
  const first = reconcile({
    prior: EMPTY_LEDGER,
    findings: [OFF],
    diff: AUTH_V1,
    headSha: "aaa1111",
    now: clock("2026-07-30T10:00:00.000Z"),
  });
  assert.equal(first.ledger.entries[0].fileDigest, "");

  const second = reconcile({
    prior: first.ledger,
    findings: [],
    diff: AUTH_V2,
    headSha: "bbb2222",
    now: clock("2026-07-30T11:00:00.000Z"),
  });
  assert.equal(second.carried.length, 1);
  assert.equal(second.resolved.length, 0);
});

// ---------------------------------------------------------------------------
// Repeats, dismissals, history
// ---------------------------------------------------------------------------

test("a finding raised again is counted, not duplicated", () => {
  const first = reconcile({
    prior: EMPTY_LEDGER,
    findings: [SQLI],
    diff: AUTH_V1,
    headSha: "aaa1111",
    now: clock("2026-07-30T10:00:00.000Z"),
  });
  const second = reconcile({
    prior: first.ledger,
    findings: [SQLI],
    diff: AUTH_V2,
    headSha: "bbb2222",
    now: clock("2026-07-30T11:00:00.000Z"),
  });
  assert.equal(second.fresh.length, 0);
  assert.equal(second.repeated.length, 1);
  assert.equal(second.repeated[0].timesReported, 2);
  assert.equal(second.repeated[0].firstSeenSha, "aaa1111");
  assert.equal(openEntries(second.ledger).length, 1);
});

test("two agents reporting one defect make one entry", () => {
  const a = finding({ path: "a.ts", title: "Race on the cache", agent: "concurrency" });
  const b = finding({ path: "a.ts", title: "Race on the cache", agent: "correctness" });
  const r = reconcile({
    prior: EMPTY_LEDGER,
    findings: [a, b],
    diff: AUTH_V1,
    headSha: "aaa1111",
    now: clock("2026-07-30T10:00:00.000Z"),
  });
  assert.equal(r.ledger.entries.length, 1);
});

test("a dismissed finding never comes back", () => {
  const first = reconcile({
    prior: EMPTY_LEDGER,
    findings: [SQLI],
    diff: AUTH_V1,
    headSha: "aaa1111",
    now: clock("2026-07-30T10:00:00.000Z"),
  });
  const after = dismissAll(first.ledger, "2026-07-30T10:30:00.000Z");
  assert.equal(openEntries(after).length, 0);

  // Even when the very next review raises it again, the human's decision holds:
  // the dismissed entry is history, and the fresh report opens a new one only if
  // the reviewer actually raises it.
  const silent = reconcile({
    prior: after,
    findings: [],
    diff: AUTH_V1,
    headSha: "bbb2222",
    now: clock("2026-07-30T11:00:00.000Z"),
  });
  assert.equal(silent.carried.length, 0);
  assert.equal(openEntries(silent.ledger).length, 0);
});

test("trimming drops history and never an open finding", () => {
  const entries = [];
  for (let i = 0; i < MAX_ENTRIES + 50; i++) {
    entries.push({
      fingerprint: `fp${i}`,
      path: `src/f${i}.ts`,
      line: 1,
      severity: "high",
      category: "correctness",
      title: `finding ${i}`,
      firstSeenSha: "a",
      firstSeenAt: "2026-07-01T00:00:00.000Z",
      lastSeenSha: "a",
      lastSeenAt: "2026-07-01T00:00:00.000Z",
      timesReported: 1,
      fileDigest: "",
      // Half open, half history.
      state: (i % 2 === 0 ? "open" : "resolved") as "open" | "resolved",
    });
  }
  const r = reconcile({
    prior: { entries, reviewsUsed: 3 },
    findings: [],
    diff: "",
    headSha: "zzz",
    now: clock("2026-07-30T10:00:00.000Z"),
  });
  assert.equal(r.ledger.entries.length, MAX_ENTRIES);
  assert.equal(openEntries(r.ledger).length, (MAX_ENTRIES + 50) / 2);
});

// ---------------------------------------------------------------------------
// Off the wire
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Regions: an edit somewhere else in the file is not a fix here.
// ---------------------------------------------------------------------------

test("an edit elsewhere in the file does not clear a finding whose region is untouched", () => {
  const first = reconcile({
    prior: EMPTY_LEDGER,
    findings: [ADMIN],
    diff: AUTH_V1,
    headSha: "aaa1111",
    now: clock("2026-08-01T10:00:00.000Z"),
  });
  assert.equal(first.ledger.entries[0].regionKey, "refresh");

  // Somebody edits a completely different part of the same file. The file
  // digest moves. `refresh` does not.
  const second = reconcile({
    prior: first.ledger,
    findings: [],
    diff: AUTH_V2,
    headSha: "bbb2222",
    now: clock("2026-08-01T11:00:00.000Z"),
  });

  assert.equal(second.resolved.length, 0);
  assert.equal(second.carried.length, 1);
  assert.equal(openEntries(second.ledger).length, 1);
});

test("a finding IS cleared when its own region changes and nobody raises it again", () => {
  const first = reconcile({
    prior: EMPTY_LEDGER,
    findings: [ADMIN],
    diff: AUTH_V1,
    headSha: "aaa1111",
    now: clock("2026-08-01T10:00:00.000Z"),
  });

  // Now the author actually fixes adminOnly, inside the `refresh` hunk.
  const fixed = AUTH_V1.replace("  return true;", "  return user.isAdmin === true;");
  const second = reconcile({
    prior: first.ledger,
    findings: [],
    diff: fixed,
    headSha: "ccc3333",
    now: clock("2026-08-01T12:00:00.000Z"),
  });

  assert.equal(second.carried.length, 0);
  assert.equal(second.resolved.length, 1);
  assert.equal(second.resolved[0].resolution, "fixed");
});

// ---------------------------------------------------------------------------
// Renames: a finding follows its file.
// ---------------------------------------------------------------------------

const RENAMED = `diff --git a/src/auth/session.ts b/src/auth/token.ts
similarity index 98%
rename from src/auth/session.ts
rename to src/auth/token.ts
index 1111111..6666666 100644
--- a/src/auth/session.ts
+++ b/src/auth/token.ts
@@ -40,3 +48,7 @@ export function refresh(token: string) {
   return mint(token);
 }
+
+export function adminOnly(user: User) {
+  return true;
+}
`;

test("a rename carries findings across instead of clearing them and raising them again", () => {
  const first = reconcile({
    prior: EMPTY_LEDGER,
    findings: [ADMIN],
    diff: AUTH_V1,
    headSha: "aaa1111",
    now: clock("2026-08-01T10:00:00.000Z"),
  });

  // The file moves. Its content is untouched. Before renames were understood
  // this reported one finding fixed and one brand new, on a push that renamed
  // a file and changed nothing.
  const second = reconcile({
    prior: first.ledger,
    findings: [{ ...ADMIN, path: "src/auth/token.ts" }],
    diff: RENAMED,
    headSha: "ddd4444",
    now: clock("2026-08-01T13:00:00.000Z"),
  });

  assert.equal(second.resolved.length, 0, "nothing was fixed by a rename");
  assert.equal(second.fresh.length, 0, "and nothing is new");
  assert.equal(second.repeated.length, 1);
  assert.equal(second.renamed.length, 1);
  assert.equal(second.renamed[0].renamedFrom, "src/auth/session.ts");
  assert.equal(openEntries(second.ledger).length, 1);
  assert.equal(openEntries(second.ledger)[0].path, "src/auth/token.ts");
  // The identity was recomputed at the new path, so this review's re-raise
  // matched it rather than minting a second row.
  assert.equal(
    openEntries(second.ledger)[0].fingerprint,
    fingerprintOf({ ...ADMIN, path: "src/auth/token.ts" } as Finding),
  );
});

test("a rewritten file is not treated as a rename", () => {
  const rewritten = RENAMED.replace("similarity index 98%", "similarity index 31%");
  const first = reconcile({
    prior: EMPTY_LEDGER,
    findings: [ADMIN],
    diff: AUTH_V1,
    headSha: "aaa1111",
    now: clock("2026-08-01T10:00:00.000Z"),
  });
  const second = reconcile({
    prior: first.ledger,
    findings: [],
    diff: rewritten,
    headSha: "eee5555",
    now: clock("2026-08-01T14:00:00.000Z"),
  });
  // Below git's similarity floor the old file is gone, not moved.
  assert.equal(second.renamed.length, 0);
  assert.equal(second.resolved.length, 1);
  assert.equal(second.resolved[0].resolution, "reverted");
});

// ---------------------------------------------------------------------------
// Rewritten history: a rebase must not empty the ledger.
// ---------------------------------------------------------------------------

test("a rebase carries every open finding forward and clears nothing", () => {
  const first = reconcile({
    prior: EMPTY_LEDGER,
    findings: [SQLI, EXPIRY, ADMIN],
    diff: AUTH_V1,
    headSha: "aaa1111",
    baseSha: "base111",
    now: clock("2026-08-01T10:00:00.000Z"),
  });
  assert.equal(openEntries(first.ledger).length, 3);

  // The branch is rebased. Every hunk in the diff differs because the base it
  // is computed against moved, so every digest comparison is meaningless. On
  // file digests alone this cleared all three without a line being fixed.
  const second = reconcile({
    prior: first.ledger,
    findings: [],
    diff: AUTH_V2,
    headSha: "fff6666",
    baseSha: "base222",
    priorBaseSha: "base111",
    priorHeadSha: "aaa1111",
    now: clock("2026-08-01T15:00:00.000Z"),
  });

  assert.equal(second.historyRewritten, true);
  assert.equal(second.resolved.length, 0);
  assert.equal(second.carried.length, 3);
  assert.equal(openEntries(second.ledger).length, 3);
});

test("a force-push with no base change is still a rewritten history", () => {
  const first = reconcile({
    prior: EMPTY_LEDGER,
    findings: [SQLI],
    diff: AUTH_V1,
    headSha: "aaa1111",
    baseSha: "base111",
    now: clock("2026-08-01T10:00:00.000Z"),
  });
  const second = reconcile({
    prior: first.ledger,
    findings: [],
    diff: AUTH_V2,
    headSha: "999zzzz",
    baseSha: "base111",
    priorBaseSha: "base111",
    priorHeadSha: "aaa1111",
    linearHistory: false,
    now: clock("2026-08-01T16:00:00.000Z"),
  });
  assert.equal(second.historyRewritten, true);
  assert.equal(second.carried.length, 1);
  assert.equal(second.resolved.length, 0);
});

test("an ordinary push measures nothing about history and behaves exactly as before", () => {
  const first = reconcile({
    prior: EMPTY_LEDGER,
    findings: [SQLI],
    diff: AUTH_V1,
    headSha: "aaa1111",
    now: clock("2026-08-01T10:00:00.000Z"),
  });
  const second = reconcile({
    prior: first.ledger,
    findings: [],
    diff: AUTH_V2,
    headSha: "bbb2222",
    now: clock("2026-08-01T17:00:00.000Z"),
  });
  // No base was passed, so no claim is made, and an unasked question is not a
  // "yes": the file digest still decides.
  assert.equal(second.historyRewritten, false);
  assert.equal(second.resolved.length, 1);
});

test("the conservative pass re-stamps digests so the NEXT push resolves normally", () => {
  const first = reconcile({
    prior: EMPTY_LEDGER,
    findings: [SQLI],
    diff: AUTH_V1,
    headSha: "aaa1111",
    baseSha: "base111",
    now: clock("2026-08-01T10:00:00.000Z"),
  });
  const rebase = reconcile({
    prior: first.ledger,
    findings: [],
    diff: AUTH_V2,
    headSha: "fff6666",
    baseSha: "base222",
    priorBaseSha: "base111",
    now: clock("2026-08-01T18:00:00.000Z"),
  });
  // Same diff again on an ordinary push: nothing moved since the rebase, so the
  // finding is still carried rather than clearing itself on stale evidence.
  const after = reconcile({
    prior: rebase.ledger,
    findings: [],
    diff: AUTH_V2,
    headSha: "fff7777",
    baseSha: "base222",
    priorBaseSha: "base222",
    now: clock("2026-08-01T19:00:00.000Z"),
  });
  assert.equal(after.historyRewritten, false);
  assert.equal(after.carried.length, 1);
  assert.equal(after.resolved.length, 0);
});

test("a malformed ledger cannot fabricate or erase an open finding", () => {
  const parsed = coerceLedger({
    entries: [
      { fingerprint: "ok", path: "a.ts", state: "open", severity: "critical", fileDigest: "abc" },
      { path: "no-fingerprint.ts", state: "open" },
      { fingerprint: "no-path", state: "open" },
      "not an object",
      null,
      { fingerprint: "weird-state", path: "b.ts", state: "banana" },
    ],
    reviewsUsed: -4,
  });
  assert.deepEqual(parsed.entries.map((e) => e.fingerprint), ["ok", "weird-state"]);
  // An unrecognised state falls back to open. Never to resolved: a truncated
  // payload must not be able to clear somebody's blocking finding.
  assert.equal(parsed.entries[1].state, "open");
  assert.equal(parsed.reviewsUsed, 0);
});

test("coerceLedger survives a completely absent payload", () => {
  assert.deepEqual(coerceLedger(undefined), { entries: [], reviewsUsed: 0 });
  assert.deepEqual(coerceLedger("nonsense"), { entries: [], reviewsUsed: 0 });
});

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

test("free tier: the per-PR limit is fixed and an override is ignored", () => {
  const b = reviewBudget({ tier: "free", used: 3, override: 500 });
  assert.equal(b.limit, FREE_REVIEWS_PER_PR);
  assert.equal(b.remaining, FREE_REVIEWS_PER_PR - 3);
  assert.equal(b.raisable, false);
  assert.equal(b.exhausted, false);
});

test("free tier: a downgrade drops back to the free limit, keeping nothing bought", () => {
  const paid = reviewBudget({ tier: "paid", used: 0, override: 500 });
  assert.equal(paid.limit, 500);
  const downgraded = reviewBudget({ tier: "free", used: 0, override: 500 });
  assert.equal(downgraded.limit, FREE_REVIEWS_PER_PR);
});

test("paid tier: the maintainer's override wins, inside bounds", () => {
  assert.equal(reviewBudget({ tier: "paid", used: 0 }).limit, PAID_REVIEWS_PER_PR);
  assert.equal(reviewBudget({ tier: "paid", used: 0, override: 120 }).limit, 120);
  assert.equal(reviewBudget({ tier: "paid", used: 0, override: 0 }).limit, 1);
  assert.equal(reviewBudget({ tier: "paid", used: 0, override: 99999 }).limit, 1000);
  assert.equal(clampLimit(Number.NaN), PAID_REVIEWS_PER_PR);
});

test("exhaustion is inclusive, and the message names the tier's actual remedy", () => {
  const free = reviewBudget({ tier: "free", used: FREE_REVIEWS_PER_PR });
  assert.equal(free.exhausted, true);
  assert.equal(free.remaining, 0);
  assert.match(exhaustedMessage(free), /cannot be raised/);
  assert.doesNotMatch(exhaustedMessage(free), /Raise the per-pull-request limit/);

  const paid = reviewBudget({ tier: "paid", used: PAID_REVIEWS_PER_PR + 5 });
  assert.equal(paid.exhausted, true);
  assert.match(exhaustedMessage(paid), /Review settings/);
});

test("the exhausted message never claims the verdict was cleared", () => {
  for (const tier of ["free", "paid"] as const) {
    const msg = exhaustedMessage(reviewBudget({ tier, used: 9999 }));
    assert.match(msg, /keeps the result of the last review/);
  }
});
