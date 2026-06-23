import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewJob } from "@cavix/core";
import { FakeStreamSource, pumpOnce, type WorkflowEngine } from "@cavix/orchestrator";

function validJobJson(): string {
  const job: ReviewJob = {
    schema_version: "1",
    idempotency_key: "k",
    delivery_id: "d",
    org: "acme",
    repo: "acme/widget",
    repo_id: 1,
    pr_number: 7,
    action: "opened",
    head_sha: "h",
    base_sha: "b",
    installation_id: 1,
    priority: 100,
    title: "t",
    author: "a",
    enqueued_at: "2026-06-23T00:00:00Z",
  };
  return JSON.stringify(job);
}

class StubEngine implements WorkflowEngine {
  submitted: ReviewJob[] = [];
  failNext = false;
  registerWorker(): void {}
  async submit(job: ReviewJob) {
    if (this.failNext) throw new Error("engine down");
    this.submitted.push(job);
    return { id: "x" };
  }
  async close() {}
}

test("bridge: valid job is submitted and acked", async () => {
  const source = new FakeStreamSource([{ id: "1-0", job: validJobJson() }]);
  const engine = new StubEngine();
  const n = await pumpOnce(source, engine);
  assert.equal(n, 1);
  assert.equal(engine.submitted.length, 1);
  assert.deepEqual(source.acked, ["1-0"]);
});

test("bridge: poison (bad JSON / schema skew) is acked and dropped, not submitted", async () => {
  const source = new FakeStreamSource([
    { id: "p1", job: "{not json" },
    { id: "p2", job: JSON.stringify({ schema_version: "999" }) },
  ]);
  const engine = new StubEngine();
  await pumpOnce(source, engine);
  assert.equal(engine.submitted.length, 0);
  // Both poison entries acked so they stop redelivering forever.
  assert.deepEqual(source.acked.sort(), ["p1", "p2"]);
});

test("bridge: submit failure leaves the entry UNACKED for recovery", async () => {
  const source = new FakeStreamSource([{ id: "1-0", job: validJobJson() }]);
  const engine = new StubEngine();
  engine.failNext = true;
  await pumpOnce(source, engine);
  assert.equal(source.acked.length, 0, "must not ack a job that failed to submit");
});
