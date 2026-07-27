import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReviewJob, isCommandJob, SCHEMA_VERSION } from "@cavix/core";
import { refFromJob } from "@cavix/orchestrator";

// CROSS-LANGUAGE WIRE CONTRACT.
//
// The Go edge marshals canonical.ReviewJob onto the Redis stream; this service
// parses it. Nothing else pins those two shapes together, and every other test
// here builds job objects by hand in TypeScript — so a renamed or mistyped JSON
// tag on the Go side would pass the whole suite and then drop every job in
// production as a "poison stream entry". That is exactly how command jobs broke.
//
// The fixtures below are the VERBATIM bytes produced by the Go edge:
//
//   go test ./internal/webhook/ -run TestWireContract -v
//
// The matching Go test (command_test.go) asserts it still emits these, so the two
// halves cannot drift apart without one of them going red.

const COMMAND_JOB_FROM_EDGE =
  '{"schema_version":"1","idempotency_key":"73ff9a544acdf4a4de31f95b5d0a999e84aca7bc1d4e88ca3e15ea15f5712ecf",' +
  '"delivery_id":"delivery-1","org":"aryan-ghai","repo":"aryan-ghai/my-repo","repo_id":55,"pr_number":7,' +
  '"action":"command","head_sha":"","base_sha":"","installation_id":9182,"priority":90,' +
  '"title":"Add login lookup","author":"aryan-ghai","enqueued_at":"2026-07-27T07:14:11Z",' +
  '"trigger":"command","command":"review","comment_id":998877,"author_association":"OWNER","force_fresh":true}';

const PULL_REQUEST_JOB_FROM_EDGE =
  '{"schema_version":"1","idempotency_key":"aa11","delivery_id":"d-2","org":"aryan-ghai",' +
  '"repo":"aryan-ghai/my-repo","repo_id":55,"pr_number":7,"action":"opened",' +
  '"head_sha":"c0ffee1234","base_sha":"deadbeef","installation_id":9182,"priority":100,' +
  '"title":"Add login lookup","author":"aryan-ghai","enqueued_at":"2026-07-27T07:14:11Z",' +
  '"trigger":"pull_request"}';

test('wire contract: an "@cavixcode review" job from the Go edge parses intact', () => {
  const job = parseReviewJob(JSON.parse(COMMAND_JOB_FROM_EDGE));

  assert.equal(job.schema_version, SCHEMA_VERSION, "schema version must be in lockstep with the edge");
  assert.equal(isCommandJob(job), true, "must be recognised as a command, or no reaction is ever sent");
  assert.equal(job.command, "review");
  // Every one of these drives behaviour downstream; a rename silently disables it.
  assert.equal(job.comment_id, 998877, "without this there is nothing to react to");
  assert.equal(job.force_fresh, true);
  assert.equal(job.author_association, "OWNER");
  assert.equal(job.installation_id, 9182, "without this the App cannot mint a token");
  assert.equal(job.head_sha, "", "command jobs carry no commit; the workflow resolves it");
});

test("wire contract: a command job survives the bridge's poison-message guard", () => {
  // The bridge acks and DROPS anything parseReviewJob rejects. This is the exact
  // call it makes; if it throws, the command vanishes with no user-visible trace.
  assert.doesNotThrow(() => parseReviewJob(JSON.parse(COMMAND_JOB_FROM_EDGE)));
});

test("wire contract: refFromJob splits owner/repo the way the REST client needs", () => {
  const ref = refFromJob(parseReviewJob(JSON.parse(COMMAND_JOB_FROM_EDGE)));
  assert.equal(ref.owner, "aryan-ghai");
  assert.equal(ref.repo, "my-repo");
  assert.equal(ref.number, 7);
  assert.equal(ref.installationId, 9182);
  assert.equal(ref.headSha, "", "resolved later by getPull, never sent as an empty commit_id");
});

test("wire contract: an automatic pull_request job still parses and is NOT a command", () => {
  const job = parseReviewJob(JSON.parse(PULL_REQUEST_JOB_FROM_EDGE));
  assert.equal(isCommandJob(job), false, "auto reviews must not try to react to a comment");
  assert.equal(job.head_sha, "c0ffee1234");
  assert.equal(job.comment_id, undefined);
});

test("wire contract: a pull_request job with no head_sha is still rejected as poison", () => {
  // The relaxation for command jobs must not weaken the check for real PR events.
  const broken = { ...JSON.parse(PULL_REQUEST_JOB_FROM_EDGE), head_sha: "" };
  assert.throws(() => parseReviewJob(broken), /head_sha/);
});
