import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReviewJob, SCHEMA_VERSION } from "@cavix/core";

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

test("parseReviewJob: rejects missing head_sha", () => {
  assert.throws(() => parseReviewJob({ ...valid, head_sha: "" }), /head_sha/);
});

test("parseReviewJob: rejects non-object", () => {
  assert.throws(() => parseReviewJob(null), /not an object/);
});
