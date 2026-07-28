import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, InMemoryStore } from "@cavix/control-plane";

// The gate the orchestrator asks before it spends anything.
//
// The daily limit and the suspension flag used to be checked only when a
// FINISHED review was recorded, which is after the diff was fetched, the models
// were called and the comment was already on the pull request. A suspended
// workspace kept getting full reviews and simply stopped appearing on its own
// dashboard: the customer sees Cavix working and sees nothing to show for it,
// and the tokens are spent either way.
//
// So these tests are about ordering. The refusal has to happen at the gate.

const TOKEN = "internal-token-for-tests";

async function serve(store: InMemoryStore) {
  process.env.CAVIX_INTERNAL_TOKEN = TOKEN;
  const server = createControlPlane(store);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function gate(base: string, fullName: string) {
  const res = await fetch(`${base}/api/internal/repos/enabled?fullName=${encodeURIComponent(fullName)}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return (await res.json()) as { enabled?: boolean; org?: string; reason?: string };
}

function seeded(): InMemoryStore {
  const store = new InMemoryStore();
  store.createOrg("acme", { tier: "paid" });
  store.createRepo("acme", "acme/api", { visibility: "private" });
  return store;
}

test("a connected repo on a healthy workspace passes the gate", async () => {
  const store = seeded();
  const { base, close } = await serve(store);
  try {
    assert.deepEqual(await gate(base, "acme/api"), { enabled: true, org: "acme" });
  } finally {
    await close();
  }
});

test("a repo that was never connected is refused, with no reason attached", async () => {
  const store = seeded();
  const { base, close } = await serve(store);
  try {
    const d = await gate(base, "acme/not-connected");
    assert.equal(d.enabled, false);
    assert.equal(d.reason, undefined, "no reason means 'turn the repo on', which is a different message");
  } finally {
    await close();
  }
});

test("a suspended workspace is refused BEFORE the review runs, and told why", async () => {
  const store = seeded();
  store.setSuspended("acme", true);
  const { base, close } = await serve(store);
  try {
    const d = await gate(base, "acme/api");
    assert.equal(d.enabled, false, "the orchestrator never fetches a diff for a suspended org");
    assert.equal(d.org, "acme");
    assert.match(d.reason!, /suspended/i);
  } finally {
    await close();
  }
});

test("a workspace over its daily allowance is refused at the gate, not after the bill", async () => {
  const store = seeded();
  store.setTier("acme", "free");
  store.setReviewLimitOverride("acme", 2);
  for (let i = 1; i <= 2; i++) {
    store.saveReview({ org: "acme", repo: "acme/api", pr: i, title: "t", findings: [] });
  }

  const { base, close } = await serve(store);
  try {
    const d = await gate(base, "acme/api");
    assert.equal(d.enabled, false);
    assert.match(d.reason!, /used its 2 reviews for today/);
    assert.match(d.reason!, /free tier/);
  } finally {
    await close();
  }
});

test("the allowance is a rolling window, so yesterday's reviews do not block today", async () => {
  const store = seeded();
  store.setReviewLimitOverride("acme", 1);
  const old = store.saveReview({ org: "acme", repo: "acme/api", pr: 1, title: "t", findings: [] });
  // Age it past the 24-hour window the limit counts over.
  (old as { createdAt: string }).createdAt = new Date(Date.now() - 36 * 3600_000).toISOString();

  const { base, close } = await serve(store);
  try {
    assert.equal((await gate(base, "acme/api")).enabled, true);
  } finally {
    await close();
  }
});

test("one review below the limit still passes", async () => {
  const store = seeded();
  store.setReviewLimitOverride("acme", 2);
  store.saveReview({ org: "acme", repo: "acme/api", pr: 1, title: "t", findings: [] });
  const { base, close } = await serve(store);
  try {
    assert.equal((await gate(base, "acme/api")).enabled, true);
  } finally {
    await close();
  }
});

// ── Stage 5's graph storage ──────────────────────────────────────────────────
//
// The control-plane stores the contract graph; the orchestrator builds it. Only
// the orchestrator holds GitHub App installation tokens (the one credential that
// reads a private repo without borrowing a human's), and only the control-plane
// has Postgres and knows which repositories a workspace connected.

async function graph(base: string, org: string, init: RequestInit = {}) {
  const res = await fetch(`${base}/api/internal/orgs/${encodeURIComponent(org)}/graph`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("an unindexed workspace returns an empty graph, not an error", async () => {
  const { base, close } = await serve(seeded());
  try {
    const { status, body } = await graph(base, "acme");
    assert.equal(status, 200);
    assert.equal(body.graph, null, "the first review on a repo is what populates it");
    assert.deepEqual(body.indexedAt, {});
  } finally {
    await close();
  }
});

test("a graph round-trips, and records when each repo was indexed", async () => {
  const { base, close } = await serve(seeded());
  try {
    const put = await graph(base, "acme", {
      method: "PUT",
      body: JSON.stringify({ repo: "acme/api", graph: { v: 1, providers: [], consumers: [] } }),
    });
    assert.equal(put.status, 200);

    const { body } = await graph(base, "acme");
    assert.deepEqual(body.graph, { v: 1, providers: [], consumers: [] });
    assert.ok(Object.keys(body.indexedAt as object).includes("acme/api"));
  } finally {
    await close();
  }
});

test("a graph cannot name a repository the workspace never connected", async () => {
  // Without this, anything holding the internal token could write a graph naming
  // repositories a workspace has no relationship with, and those names would
  // then be quoted back on its pull requests.
  const { base, close } = await serve(seeded());
  try {
    const res = await graph(base, "acme", {
      method: "PUT",
      body: JSON.stringify({ repo: "someone-else/private", graph: {} }),
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test("the graph endpoint needs the internal token", async () => {
  process.env.CAVIX_INTERNAL_TOKEN = TOKEN;
  const store = seeded();
  const { base, close } = await serve(store);
  try {
    const res = await fetch(`${base}/api/internal/orgs/acme/graph`, { headers: { authorization: "Bearer wrong" } });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("the graph and the mute log survive a snapshot restore", async () => {
  // Both were added after the snapshot shape was written, and neither was in it,
  // so a restart quietly dropped them.
  const store = seeded();
  store.recordMute({ org: "acme", scope: "repo", target: "acme/api", restored: false });
  store.saveOrgGraph("acme", "acme/api", { v: 1, providers: [{ repo: "acme/api" }], consumers: [] });

  const restored = new InMemoryStore();
  restored.restore(JSON.parse(JSON.stringify(store.snapshot())));

  assert.equal(restored.listMutes("acme").length, 1);
  assert.ok(restored.orgGraph("acme"));
  assert.ok(Object.keys(restored.orgGraph("acme")!.indexedAt).includes("acme/api"));
});

// ── Stage 6's CI history storage ─────────────────────────────────────────────

async function telemetry(base: string, org: string, init: RequestInit = {}) {
  const res = await fetch(`${base}/api/internal/orgs/${encodeURIComponent(org)}/telemetry`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as { runs?: unknown[]; fetchedAt?: Record<string, string> } };
}

test("CI history round-trips and records when each repo was fetched", async () => {
  const { base, close } = await serve(seeded());
  try {
    const put = await telemetry(base, "acme", {
      method: "PUT",
      body: JSON.stringify({ repo: "acme/api", runs: [{ repo: "acme/api", workflow: "ci", durationMs: 1000, commit: "a", at: "2026-07-01T00:00:00Z" }] }),
    });
    assert.equal(put.status, 200);

    const { body } = await telemetry(base, "acme");
    assert.equal(body.runs!.length, 1);
    assert.ok(Object.keys(body.fetchedAt!).includes("acme/api"));
  } finally {
    await close();
  }
});

test("one repository's runs replace only its own", async () => {
  // The orchestrator sends the merged list it built, so appending here would
  // double every run on the second refresh.
  const store = seeded();
  store.createRepo("acme", "acme/web", { visibility: "private" });
  const { base, close } = await serve(store);
  try {
    const run = (repo: string, commit: string) => ({ repo, workflow: "ci", durationMs: 1000, commit, at: "2026-07-01T00:00:00Z" });
    await telemetry(base, "acme", { method: "PUT", body: JSON.stringify({ repo: "acme/api", runs: [run("acme/api", "a")] }) });
    await telemetry(base, "acme", { method: "PUT", body: JSON.stringify({ repo: "acme/web", runs: [run("acme/web", "b")] }) });
    await telemetry(base, "acme", { method: "PUT", body: JSON.stringify({ repo: "acme/api", runs: [run("acme/api", "a"), run("acme/api", "c")] }) });

    const { body } = await telemetry(base, "acme");
    assert.equal(body.runs!.filter((r) => (r as { repo: string }).repo === "acme/api").length, 2);
    assert.equal(body.runs!.filter((r) => (r as { repo: string }).repo === "acme/web").length, 1);
  } finally {
    await close();
  }
});

test("CI history is capped per repository", async () => {
  const { base, close } = await serve(seeded());
  try {
    const many = Array.from({ length: 600 }, (_, i) => ({ repo: "acme/api", workflow: "ci", durationMs: 1, commit: `c${i}`, at: "2026-07-01T00:00:00Z" }));
    await telemetry(base, "acme", { method: "PUT", body: JSON.stringify({ repo: "acme/api", runs: many }) });
    const { body } = await telemetry(base, "acme");
    assert.ok(body.runs!.length <= 400, `capped, got ${body.runs!.length}`);
  } finally {
    await close();
  }
});

test("CI history cannot name a repository the workspace never connected", async () => {
  const { base, close } = await serve(seeded());
  try {
    const res = await telemetry(base, "acme", { method: "PUT", body: JSON.stringify({ repo: "someone-else/private", runs: [] }) });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test("CI history survives a snapshot restore", async () => {
  const store = seeded();
  store.saveCiHistory("acme", "acme/api", [{ repo: "acme/api", durationMs: 1, commit: "a", at: "2026-07-01T00:00:00Z" }]);
  const restored = new InMemoryStore();
  restored.restore(JSON.parse(JSON.stringify(store.snapshot())));
  assert.equal(restored.ciHistory("acme").runs.length, 1);
});
