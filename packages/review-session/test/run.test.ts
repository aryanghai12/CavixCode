import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideClaim,
  mayPost,
  beginPosting,
  finishRun,
  coerceRun,
  isActive,
  STALE_AFTER_MS,
  HEARTBEAT_EVERY_MS,
  type ReviewRun,
} from "@cavix/review-session";

const T0 = "2026-08-13T10:00:00.000Z";
const clock = (iso: string) => () => new Date(iso);

function run(over: Partial<ReviewRun> = {}): ReviewRun {
  return {
    runId: "run-1",
    headSha: "aaa1111",
    status: "running",
    startedAt: T0,
    updatedAt: T0,
    ...over,
  };
}

test("nothing in flight: the claim is granted", () => {
  const out = decideClaim(undefined, { runId: "r", headSha: "bbb" }, { now: clock(T0) });
  assert.equal(out.decision, "claimed");
  if (out.decision !== "claimed") return;
  assert.equal(out.run.status, "running");
  assert.equal(out.superseded, undefined);
});

test("a finished run does not hold the slot", () => {
  for (const status of ["completed", "failed", "cancelled", "superseded"] as const) {
    const out = decideClaim(run({ status }), { runId: "r2", headSha: "bbb" }, { now: clock(T0) });
    assert.equal(out.decision, "claimed", status);
  }
});

test("the same commit arriving twice is coalesced, not run twice", () => {
  // Two webhooks for one push, or a manual re-request while a review is running.
  // Running it again posts the same review twice.
  const out = decideClaim(run(), { runId: "r2", headSha: "aaa1111" }, { now: clock(T0) });
  assert.equal(out.decision, "duplicate");
});

test("a newer commit supersedes the running review", () => {
  // The whole point. The older run is now reviewing a commit nobody will merge,
  // and its line numbers point at code that has moved.
  const out = decideClaim(run(), { runId: "r2", headSha: "bbb2222" }, { now: clock("2026-08-13T10:01:00.000Z") });
  assert.equal(out.decision, "claimed");
  if (out.decision !== "claimed") return;
  assert.equal(out.superseded?.status, "superseded");
  assert.match(out.superseded?.reason ?? "", /bbb2222/);
  assert.equal(out.run.headSha, "bbb2222");
});

test("a review that has started POSTING is never interrupted", () => {
  // A pull request with three inline comments and no review body is worse than
  // a late review.
  const out = decideClaim(run({ status: "posting" }), { runId: "r2", headSha: "bbb2222" }, { now: clock(T0) });
  assert.equal(out.decision, "wait");
});

test("a run whose worker stopped reporting is taken over, and recorded as failed", () => {
  // Failed, not superseded. Nothing newer replaced it; it died. The two read
  // very differently to somebody working out why a review never appeared.
  const stale = run({ updatedAt: T0 });
  const later = new Date(Date.parse(T0) + STALE_AFTER_MS + 1000).toISOString();
  const out = decideClaim(stale, { runId: "r2", headSha: "aaa1111" }, { now: clock(later) });
  assert.equal(out.decision, "claimed");
  if (out.decision !== "claimed") return;
  assert.equal(out.superseded?.status, "failed");
  assert.match(out.superseded?.reason ?? "", /stopped reporting/);
});

test("a live run is not taken over just because it is slow", () => {
  const busy = run({ updatedAt: T0 });
  const soon = new Date(Date.parse(T0) + 60_000).toISOString();
  const out = decideClaim(busy, { runId: "r2", headSha: "aaa1111" }, { now: clock(soon) });
  assert.equal(out.decision, "duplicate", "same sha, still alive");
});

test("mayPost refuses a run that lost its slot", () => {
  assert.equal(mayPost(run({ runId: "run-1" }), "run-1"), true);
  assert.equal(mayPost(run({ runId: "run-2" }), "run-1"), false, "somebody else holds it");
  assert.equal(mayPost(run({ runId: "run-1", status: "superseded" }), "run-1"), false);
  assert.equal(mayPost(run({ runId: "run-1", status: "cancelled" }), "run-1"), false);
});

test("mayPost allows a deployment that does not track runs at all", () => {
  // No record means run tracking is off, which is what every deployment did
  // before this existed. It must never read as "you were cancelled".
  assert.equal(mayPost(undefined, "run-1"), true);
});

test("posting is an active state, so it still holds the slot", () => {
  assert.equal(isActive("posting"), true);
  assert.equal(isActive("running"), true);
  assert.equal(isActive("queued"), true);
  assert.equal(isActive("completed"), false);
  assert.equal(isActive("superseded"), false);
});

test("transitions carry the reason and move the clock", () => {
  const posting = beginPosting(run(), "2026-08-13T10:05:00.000Z");
  assert.equal(posting.status, "posting");
  assert.equal(posting.updatedAt, "2026-08-13T10:05:00.000Z");

  const done = finishRun(posting, "completed", undefined, "2026-08-13T10:06:00.000Z");
  assert.equal(done.status, "completed");

  const failed = finishRun(run(), "failed", "the model refused", "2026-08-13T10:06:00.000Z");
  assert.equal(failed.reason, "the model refused");
});

test("a malformed run record off the wire cannot hold a slot", () => {
  assert.equal(coerceRun(null), undefined);
  assert.equal(coerceRun({ runId: "r" }), undefined, "no head sha");
  assert.equal(coerceRun({ headSha: "a" }), undefined, "no run id");
  const ok = coerceRun({ runId: "r", headSha: "a", status: "nonsense" });
  assert.equal(ok?.status, "running", "an unknown status is treated as live, never as free");
});

// The sequence the whole module exists for.
test("push, push again mid-review: only the newer review posts", () => {
  const first = decideClaim(undefined, { runId: "r1", headSha: "aaa" }, { now: clock(T0) });
  assert.equal(first.decision, "claimed");
  if (first.decision !== "claimed") return;

  const second = decideClaim(first.run, { runId: "r2", headSha: "bbb" }, { now: clock("2026-08-13T10:00:30.000Z") });
  assert.equal(second.decision, "claimed");
  if (second.decision !== "claimed") return;

  // r1 reaches its post step and asks. It has lost the slot.
  assert.equal(mayPost(second.run, "r1"), false);
  assert.equal(mayPost(second.run, "r2"), true);
});

// ---------------------------------------------------------------------------
// The failure this cost a real afternoon: a stuck run that nobody could clear.
// ---------------------------------------------------------------------------

test("a human asking again is never turned away as a duplicate", () => {
  // Coalescing exists for webhooks that arrive twice. Applying it to somebody
  // typing "@cavixcode review" meant a run that died with its process kept the
  // slot, every retry was refused, and the person kept asking into silence.
  const stuck = run({ runId: "dead", headSha: "aaa1111" });
  const out = decideClaim(stuck, { runId: "r2", headSha: "aaa1111", force: true }, { now: clock(T0) });
  assert.equal(out.decision, "claimed");
  if (out.decision !== "claimed") return;
  assert.equal(out.superseded?.status, "superseded");
  // And the reason says what actually happened, not "a newer commit was pushed",
  // because no newer commit was pushed.
  assert.match(out.superseded?.reason ?? "", /a person asked/);
});

test("a forced claim still will not interrupt a review that is posting", () => {
  const posting = run({ status: "posting" });
  const out = decideClaim(posting, { runId: "r2", headSha: "aaa1111", force: true }, { now: clock(T0) });
  assert.equal(out.decision, "wait", "a half-written review is worse than a late one");
});

test("a webhook redelivery is still coalesced", () => {
  const out = decideClaim(run(), { runId: "r2", headSha: "aaa1111" }, { now: clock(T0) });
  assert.equal(out.decision, "duplicate");
});

test("a dead holder frees the pull request in minutes, not twenty of them", () => {
  // The window is short BECAUSE a live run heartbeats. A process that was
  // restarted or redeployed stops reporting, and the next attempt takes over.
  assert.ok(STALE_AFTER_MS <= 5 * 60 * 1000, "a dead holder must not wedge a PR for long");
  assert.ok(
    HEARTBEAT_EVERY_MS * 3 <= STALE_AFTER_MS,
    "several beats must be missed before anyone concludes the holder is gone",
  );

  const killed = run({ updatedAt: T0 });
  const later = new Date(Date.parse(T0) + STALE_AFTER_MS + 1000).toISOString();
  const out = decideClaim(killed, { runId: "r2", headSha: "aaa1111" }, { now: clock(later) });
  assert.equal(out.decision, "claimed");
  if (out.decision !== "claimed") return;
  assert.equal(out.superseded?.status, "failed");
});

test("a live run that keeps reporting in keeps its slot", () => {
  // The other half. Before the heartbeat existed, the claim's timestamp was
  // frozen at the moment it was taken, so a legitimately slow review had its
  // slot taken while it was still working.
  const start = Date.parse(T0);
  const working = run({ updatedAt: new Date(start + 10 * 60 * 1000).toISOString() });
  const now = new Date(start + 10 * 60 * 1000 + 30_000).toISOString();
  const out = decideClaim(working, { runId: "r2", headSha: "aaa1111" }, { now: clock(now) });
  assert.equal(out.decision, "duplicate", "still alive after ten minutes of work");
});
