import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReviewJob, isCommandJob, SCHEMA_VERSION } from "@cavix/core";

const valid = {
  schema_version: SCHEMA_VERSION,
  idempotency_key: "k",
  delivery_id: "d",
  org: "acme",
  repo: "acme/widget",
  repo_id: 1,
  pr_number: 42,
  action: "opened",
  head_sha: "abc",
  base_sha: "def",
  installation_id: 9,
  priority: 100,
  title: "t",
  author: "octocat",
  enqueued_at: "2026-01-01T00:00:00Z",
};

test("parseReviewJob: accepts a valid canonical job", () => {
  const job = parseReviewJob(valid);
  assert.equal(job.repo, "acme/widget");
  assert.equal(job.pr_number, 42);
});

test("parseReviewJob: rejects schema-version skew", () => {
  assert.throws(() => parseReviewJob({ ...valid, schema_version: "999" }), /schema mismatch/);
});

test("parseReviewJob: rejects missing head_sha on a pull_request job", () => {
  assert.throws(() => parseReviewJob({ ...valid, head_sha: "" }), /head_sha/);
});

// An issue_comment payload carries no commit, so a command job legitimately has
// no head_sha — the orchestrator resolves the PR head itself. Requiring it here
// meant every "@cavixcode review" was dropped as a poison message and the user
// saw nothing at all happen.
test("parseReviewJob: accepts a command job with no head_sha", () => {
  const job = parseReviewJob({
    ...valid,
    action: "command",
    head_sha: "",
    trigger: "command",
    command: "review",
    comment_id: 555,
    author_association: "OWNER",
    force_fresh: true,
  });
  assert.equal(job.trigger, "command");
  assert.equal(job.command, "review");
  assert.equal(job.comment_id, 555);
});

test("isCommandJob distinguishes a mention from an automatic review", () => {
  assert.equal(isCommandJob(parseReviewJob(valid)), false);
  assert.equal(
    isCommandJob(parseReviewJob({ ...valid, head_sha: "", trigger: "command", command: "review" })),
    true,
  );
});

test("parseReviewJob: rejects non-object", () => {
  assert.throws(() => parseReviewJob(null), /not an object/);
});
