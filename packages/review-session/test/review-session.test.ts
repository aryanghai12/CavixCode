import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "@cavix/core";
import { ReviewSession, InMemoryReviewStateStore, planReview, type ReviewManager } from "@cavix/review-session";

type Ref = { repo: string; pr: number };

class FakeManager implements ReviewManager<Ref> {
  dismissed: number[] = [];
  deleted: number[] = [];
  async dismissReview(_ref: Ref, id: number): Promise<void> {
    this.dismissed.push(id);
  }
  async deleteReviewComment(_ref: Ref, id: number): Promise<void> {
    this.deleted.push(id);
  }
}

function f(path: string, line: number, ruleId: string): Finding {
  return { path, line, severity: "high", category: "security", title: ruleId, body: "", source: "llm", confidence: 0.9, ruleId };
}

test("planReview: first review is fresh; later pushes are incremental; force → fresh", () => {
  assert.equal(planReview(undefined, { repo: "r", pr: 1, headSha: "a", forceFresh: false }), "fresh");
  const state = { repo: "r", pr: 1, lastReviewedSha: "a", postedReviewIds: [], postedCommentIds: [], fingerprints: [], paused: false };
  assert.equal(planReview(state, { repo: "r", pr: 1, headSha: "b", forceFresh: false }), "incremental");
  assert.equal(planReview(state, { repo: "r", pr: 1, headSha: "b", forceFresh: true }), "fresh");
});

test("planReview: paused PR is skipped unless resumed or forced", () => {
  const paused = { repo: "r", pr: 1, lastReviewedSha: "a", postedReviewIds: [], postedCommentIds: [], fingerprints: [], paused: true };
  assert.equal(planReview(paused, { repo: "r", pr: 1, headSha: "b", forceFresh: false }), "skip-paused");
  assert.equal(planReview(paused, { repo: "r", pr: 1, headSha: "b", forceFresh: false, command: "resume" }), "incremental");
  assert.equal(planReview(paused, { repo: "r", pr: 1, headSha: "b", forceFresh: true }), "fresh");
});

test("@cavix review (fresh): dismisses stale reviews, deletes stale comments, busts cache", async () => {
  const store = new InMemoryReviewStateStore();
  const mgr = new FakeManager();
  const session = new ReviewSession<Ref>(store, mgr);

  // Prior review state.
  store.set({ repo: "acme/x", pr: 7, lastReviewedSha: "old", postedReviewIds: [100], postedCommentIds: [10, 11], fingerprints: ["deadbeef"], paused: false });

  const result = await session.begin({ repo: "acme/x", pr: 7 }, { repo: "acme/x", pr: 7, headSha: "new", forceFresh: true, command: "review" });
  assert.equal(result.mode, "fresh");
  assert.deepEqual(mgr.dismissed, [100], "stale review dismissed");
  assert.deepEqual(mgr.deleted, [10, 11], "stale comments deleted");

  // Cache busted: no fingerprints remain → a full review reposts everything.
  const state = store.get("acme/x", 7)!;
  assert.deepEqual(state.fingerprints, []);
  assert.deepEqual(state.postedReviewIds, []);
});

test("incremental: does not repost a finding already posted", () => {
  const store = new InMemoryReviewStateStore();
  const session = new ReviewSession<Ref>(store, new FakeManager());
  const old = f("a.js", 5, "sqli");
  session.recordPosted("acme/x", 7, "sha1", 200, [10], [old]);

  const findings = [old, f("b.js", 9, "xss")]; // one repeat, one new
  const fresh = session.filterNewFindings("acme/x", 7, findings);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].ruleId, "xss", "only the new finding survives");
});

test("full flow: fresh → record → incremental only surfaces new commits' findings", async () => {
  const store = new InMemoryReviewStateStore();
  const session = new ReviewSession<Ref>(store, new FakeManager());

  await session.begin({ repo: "r", pr: 1 }, { repo: "r", pr: 1, headSha: "sha1", forceFresh: false });
  const first = [f("a.js", 1, "r1"), f("a.js", 2, "r2")];
  session.recordPosted("r", 1, "sha1", 300, [20, 21], first);

  // New commit adds one more finding; the two old ones are not reposted.
  const second = [...first, f("c.js", 3, "r3")];
  const toPost = session.filterNewFindings("r", 1, second);
  assert.deepEqual(toPost.map((x) => x.ruleId), ["r3"]);
});
