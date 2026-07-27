import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding, Verification } from "@cavix/core";
import { makeReviewRecorder, toWireFinding } from "../src/report/recorder.ts";

// Recording is the step that puts a review on the dashboard. Before it existed
// the orchestrator posted a perfect review on GitHub and the site said "No
// reviews yet" forever, so these tests pin down the two things that matters:
// what goes on the wire, and that a broken control-plane costs a dashboard row
// rather than a review.

const noSleep = async () => {};

function finding(over: Partial<Finding> = {}): Finding {
  return {
    path: "src/auth.js",
    line: 12,
    severity: "high",
    category: "security",
    title: "SQL injection via string concatenation",
    body: "x".repeat(4000), // the dashboard never shows this
    source: "llm",
    confidence: 0.92,
    ...over,
  };
}

const PROOF: Verification = {
  status: "VERIFIED",
  exploit: false,
  reproduced: true,
  fixWorks: true,
  suitePasses: true,
  reason: "reproduced in the sandbox",
  steps: [],
};

test("posts the review to the control-plane with the service token", async () => {
  let seenUrl = "";
  let seenAuth = "";
  let seenBody: Record<string, unknown> = {};
  const record = makeReviewRecorder({
    url: "https://cavix.example/",
    token: "s3cret",
    fetchImpl: (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init.headers as Record<string, string>).authorization);
      seenBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: "rev_1" }), { status: 201 });
    }) as unknown as typeof fetch,
  });

  const ok = await record({
    org: "acme-workspace",
    repo: "acme/widget",
    pr: 42,
    title: "Add login lookup",
    url: "https://github.com/acme/widget/pull/42#pullrequestreview-1",
    findings: [finding({ verification: PROOF }), finding({ line: 20, severity: "low", source: "policy", immutable: true })],
  });

  assert.equal(ok, true);
  assert.equal(seenUrl, "https://cavix.example/api/reviews");
  assert.equal(seenAuth, "Bearer s3cret");
  // The workspace that enabled the repo, not the GitHub owner login: recording
  // under the login files the review against a workspace nobody can see.
  assert.equal(seenBody.org, "acme-workspace");
  assert.equal(seenBody.repo, "acme/widget");
  assert.equal(seenBody.pr, 42);
  assert.equal(seenBody.url, "https://github.com/acme/widget/pull/42#pullrequestreview-1");

  const wire = seenBody.findings as Array<Record<string, unknown>>;
  assert.equal(wire.length, 2);
  assert.equal(wire[0].verified, true, "the sandbox result drives the dashboard's headline number");
  assert.equal(wire[1].verified, false);
  assert.equal(wire[1].immutable, true, "a policy finding stays marked as one");
  assert.equal(wire[0].body, undefined, "finding bodies are never sent: the dashboard does not show them");
});

test("toWireFinding: verified is the sandbox verdict, not merely that it ran", () => {
  assert.equal(toWireFinding(finding({ verification: PROOF })).verified, true);
  assert.equal(toWireFinding(finding({ verification: { ...PROOF, status: "INCONCLUSIVE" } })).verified, false);
  assert.equal(toWireFinding(finding()).verified, false);
});

test("a control-plane 5xx is retried, because a cold start is not a failure", async () => {
  let calls = 0;
  const record = makeReviewRecorder({
    url: "https://cavix.example",
    token: "tok",
    retryDelayMs: 0,
    sleepImpl: noSleep,
    fetchImpl: (async () => {
      calls++;
      return calls < 3 ? new Response("", { status: 503 }) : new Response("{}", { status: 201 });
    }) as unknown as typeof fetch,
  });

  assert.equal(await record({ org: "acme", repo: "acme/w", pr: 1, title: "t", findings: [] }), true);
  assert.equal(calls, 3);
});

test("being over the daily quota is reported once, not retried", async () => {
  let calls = 0;
  const warnings: string[] = [];
  const record = makeReviewRecorder({
    url: "https://cavix.example",
    token: "tok",
    retryDelayMs: 0,
    sleepImpl: noSleep,
    logger: { warn: (m) => warnings.push(m) },
    fetchImpl: (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "rate limit reached" }), { status: 429 });
    }) as unknown as typeof fetch,
  });

  assert.equal(await record({ org: "acme", repo: "acme/w", pr: 1, title: "t", findings: [] }), false);
  assert.equal(calls, 1, "a quota that is already spent does not un-spend itself on retry");
  assert.match(warnings.join(" "), /not recorded/);
});

test("an unreachable control-plane returns false instead of throwing", async () => {
  // The review is already on the pull request by this point. Throwing here would
  // make the queue retry a review that succeeded, and post it twice.
  const record = makeReviewRecorder({
    url: "https://cavix.example",
    token: "tok",
    attempts: 2,
    retryDelayMs: 0,
    sleepImpl: noSleep,
    fetchImpl: (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch,
  });

  assert.equal(await record({ org: "acme", repo: "acme/w", pr: 1, title: "t", findings: [] }), false);
});
