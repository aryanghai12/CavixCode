import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepoGate } from "../src/byok/gate.ts";

// The gate answers two questions: may we review this repo, and which dashboard
// workspace owns it. The second one matters because the job's `org` is the GitHub
// owner login, while the BYOK key is stored under the Cavix workspace name.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const noSleep = async () => {};

test("returns the owning workspace alongside the enabled flag", async () => {
  let seenUrl = "";
  const gate = makeRepoGate({
    url: "https://cavix.example/",
    token: "tok",
    fetchImpl: (async (url: string) => {
      seenUrl = String(url);
      return jsonResponse({ enabled: true, org: "acme-workspace" });
    }) as unknown as typeof fetch,
  });

  assert.deepEqual(await gate("acme/widget"), { enabled: true, org: "acme-workspace" });
  assert.match(seenUrl, /\/api\/internal\/repos\/enabled\?fullName=acme%2Fwidget$/);
});

test("a repo that is not enabled returns enabled:false", async () => {
  const gate = makeRepoGate({
    url: "https://cavix.example",
    token: "tok",
    fetchImpl: (async () => jsonResponse({ enabled: false })) as unknown as typeof fetch,
  });
  assert.deepEqual(await gate("acme/widget"), { enabled: false, org: undefined });
});

test("retries a sleeping control-plane instead of silently skipping the review", async () => {
  let calls = 0;
  const gate = makeRepoGate({
    url: "https://cavix.example",
    token: "tok",
    retryDelayMs: 0,
    sleepImpl: noSleep,
    fetchImpl: (async () => {
      calls++;
      // A free-tier host cold-starting: the first requests fail, then it wakes.
      if (calls < 3) throw new Error("fetch failed");
      return jsonResponse({ enabled: true, org: "acme" });
    }) as unknown as typeof fetch,
  });

  assert.deepEqual(await gate("acme/widget"), { enabled: true, org: "acme" });
  assert.equal(calls, 3);
});

test("gives up fail-closed after exhausting attempts", async () => {
  let calls = 0;
  const gate = makeRepoGate({
    url: "https://cavix.example",
    token: "tok",
    attempts: 2,
    retryDelayMs: 0,
    sleepImpl: noSleep,
    fetchImpl: (async () => { calls++; throw new Error("ETIMEDOUT"); }) as unknown as typeof fetch,
  });

  assert.deepEqual(await gate("acme/widget"), { enabled: false });
  assert.equal(calls, 2);
});

test("failOpen reviews anyway when the control-plane cannot be reached", async () => {
  const gate = makeRepoGate({
    url: "https://cavix.example",
    token: "tok",
    failOpen: true,
    attempts: 1,
    sleepImpl: noSleep,
    fetchImpl: (async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch,
  });
  assert.deepEqual(await gate("acme/widget"), { enabled: true });
});

test("a 401 is a config mistake, not a cold start — no retries", async () => {
  let calls = 0;
  const warnings: string[] = [];
  const gate = makeRepoGate({
    url: "https://cavix.example",
    token: "wrong",
    retryDelayMs: 0,
    sleepImpl: noSleep,
    logger: { warn: (_m, meta) => warnings.push(String(meta?.hint ?? "")) },
    fetchImpl: (async () => { calls++; return jsonResponse({ error: "unauthorized" }, 401); }) as unknown as typeof fetch,
  });

  assert.deepEqual(await gate("acme/widget"), { enabled: false });
  assert.equal(calls, 1, "a bad token will never start working — do not retry");
  assert.match(warnings[0], /CAVIX_INTERNAL_TOKEN differs/);
});
