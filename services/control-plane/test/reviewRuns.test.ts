import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, InMemoryStore } from "@cavix/control-plane";
import { makeRunClient } from "@cavix/orchestrator";
import { readJson } from "./http.ts";

// The single in-flight review slot, end to end: the orchestrator's client
// against the control-plane's real routes.
//
// The bug: a push while a review was running produced TWO reviews seconds apart.
// The older one was computed against a commit that no longer exists, so every
// line number in it pointed at whatever had since moved into that position, and
// the two raced to write the ledger.

const TOKEN = "internal-token-for-tests";

async function withServer(fn: (store: InMemoryStore, base: string) => Promise<void>) {
  const previous = process.env.CAVIX_INTERNAL_TOKEN;
  process.env.CAVIX_INTERNAL_TOKEN = TOKEN;
  const store = new InMemoryStore();
  const server = createControlPlane(store);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(store, `http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    if (previous === undefined) delete process.env.CAVIX_INTERNAL_TOKEN;
    else process.env.CAVIX_INTERNAL_TOKEN = previous;
  }
}

const REF = { org: "acme", repo: "acme/widgets", pr: 42 };
const client = (base: string) => makeRunClient({ url: base, token: TOKEN, logger: { warn: () => {} } });

test("a push mid-review supersedes the older run, and only the newer one may post", async () => {
  await withServer(async (_store, base) => {
    const runs = client(base);

    const first = await runs.claim(REF, { runId: "r1", headSha: "aaa1111" });
    assert.equal(first.decision, "claimed");
    assert.equal(await runs.stillMine(REF, "r1"), true);

    // A second commit lands while r1 is still computing.
    const second = await runs.claim(REF, { runId: "r2", headSha: "bbb2222" });
    assert.equal(second.decision, "claimed");
    if (second.decision !== "claimed") return;
    assert.equal(second.superseded?.runId, "r1");
    assert.equal(second.superseded?.status, "superseded");

    // r1 reaches its post step and asks. It has lost the slot, so its findings,
    // anchored to a commit nobody will merge, never reach the pull request.
    assert.equal(await runs.stillMine(REF, "r1"), false);
    assert.equal(await runs.stillMine(REF, "r2"), true);
  });
});

test("the same commit arriving twice is coalesced", async () => {
  await withServer(async (_store, base) => {
    const runs = client(base);
    await runs.claim(REF, { runId: "r1", headSha: "aaa1111" });
    const again = await runs.claim(REF, { runId: "r2", headSha: "aaa1111" });
    assert.equal(again.decision, "duplicate");
  });
});

test("a review that has begun posting is never interrupted", async () => {
  await withServer(async (_store, base) => {
    const runs = client(base);
    await runs.claim(REF, { runId: "r1", headSha: "aaa1111" });
    await runs.beginPosting(REF, "r1");

    // A pull request carrying three inline comments and no review body is worse
    // than a late review, so the newer push waits instead of cutting in.
    const next = await runs.claim(REF, { runId: "r2", headSha: "bbb2222" });
    assert.equal(next.decision, "wait");
    assert.equal(await runs.stillMine(REF, "r1"), true);

    // Once it lands, the slot frees and the newer push can run.
    await runs.finish(REF, "r1", "completed");
    const after = await runs.claim(REF, { runId: "r2", headSha: "bbb2222" });
    assert.equal(after.decision, "claimed");
  });
});

test("a finished review frees the slot immediately", async () => {
  await withServer(async (_store, base) => {
    const runs = client(base);
    await runs.claim(REF, { runId: "r1", headSha: "aaa1111" });
    await runs.finish(REF, "r1", "completed");
    const next = await runs.claim(REF, { runId: "r2", headSha: "ccc3333" });
    assert.equal(next.decision, "claimed");
  });
});

test("a failed review gives the slot back, keyed on its commit", async () => {
  await withServer(async (store, base) => {
    const runs = client(base);
    await runs.claim(REF, { runId: "r1", headSha: "aaa1111" });

    // Without this a failed review holds the pull request for the whole stale
    // window, so the retry that would have fixed it is turned away as a
    // duplicate and the pull request silently stops being reviewed.
    await runs.failForHead(REF, "aaa1111", "the model refused");
    assert.equal(store.getReviewRun("acme", "acme/widgets", 42)?.status, "failed");

    const retry = await runs.claim(REF, { runId: "r2", headSha: "aaa1111" });
    assert.equal(retry.decision, "claimed");
  });
});

test("a failed OLDER review cannot free a newer review's slot", async () => {
  await withServer(async (store, base) => {
    const runs = client(base);
    await runs.claim(REF, { runId: "r1", headSha: "aaa1111" });
    await runs.claim(REF, { runId: "r2", headSha: "bbb2222" });

    // r1 now fails. It must not release r2's claim: doing so would let a third
    // push start a second concurrent review of the same pull request.
    await runs.failForHead(REF, "aaa1111", "boom");
    const held = store.getReviewRun("acme", "acme/widgets", 42);
    assert.equal(held?.runId, "r2");
    assert.equal(held?.status, "running");
  });
});

test("a superseded run reporting completion cannot clobber the newer claim", async () => {
  await withServer(async (store, base) => {
    const runs = client(base);
    await runs.claim(REF, { runId: "r1", headSha: "aaa1111" });
    await runs.claim(REF, { runId: "r2", headSha: "bbb2222" });
    await runs.finish(REF, "r1", "completed");
    const held = store.getReviewRun("acme", "acme/widgets", 42);
    assert.equal(held?.runId, "r2", "the newer review still holds the slot");
    assert.equal(held?.status, "running");
  });
});

test("only the holder may keep a claim alive", async () => {
  await withServer(async (store, base) => {
    const runs = client(base);
    await runs.claim(REF, { runId: "r1", headSha: "aaa1111" });
    await runs.claim(REF, { runId: "r2", headSha: "bbb2222" });
    // r1 heartbeating must not take the slot back from r2.
    await runs.touch(REF, "r1");
    assert.equal(store.getReviewRun("acme", "acme/widgets", 42)?.runId, "r2");
  });
});

test("the route refuses an unauthenticated caller", async () => {
  await withServer(async (_store, base) => {
    const res = await fetch(`${base}/api/internal/reviews/acme/acme/widgets/42/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "r1", headSha: "aaa" }),
    });
    assert.equal(res.status, 401);
  });
});

test("a control-plane that cannot be reached never stops a review", async () => {
  // The direction matters. Refusing to review because a dashboard is down is a
  // far worse failure than the duplicate this mechanism prevents, which is what
  // every deployment did before it existed.
  const runs = makeRunClient({
    url: "http://127.0.0.1:1",
    token: TOKEN,
    timeoutMs: 200,
    logger: { warn: () => {} },
  });
  const out = await runs.claim(REF, { runId: "r1", headSha: "aaa1111" });
  assert.equal(out.decision, "claimed");
  assert.equal(await runs.stillMine(REF, "r1"), true);
});

test("finished runs are the only ones ever evicted", async () => {
  await withServer(async (store, base) => {
    const runs = client(base);
    await runs.claim(REF, { runId: "r1", headSha: "aaa1111" });
    const body = await readJson(
      await fetch(`${base}/api/internal/reviews/acme/acme/widgets/42/touch`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ runId: "r1" }),
      }),
    );
    assert.equal(body.run.runId, "r1");
    assert.equal(store.getReviewRun("acme", "acme/widgets", 42)?.status, "running");
  });
});
