import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewJob } from "@cavix/core";
import { OrgGraph } from "@cavix/orggraph";
import { Gateway, FakeProvider, type GatewayConfigData } from "@cavix/gateway";
import {
  FakeGitHubClient,
  makeBlastRadiusStep,
  makeGraphIndexer,
  Reviewer,
  runReview,
  selectFiles,
  type GraphStore,
} from "@cavix/orchestrator";

// Stage 5: what this pull request breaks in OTHER repositories.
//
// This is the finding no single-repo reviewer can produce. A change to
// `DELETE /orders/{id}` reads as a clean, well-tested diff inside the orders
// service, and the only thing wrong with it lives in a repository nobody in the
// pull request has open.

/** An in-memory stand-in for the control-plane's graph storage. */
function memoryStore(): GraphStore & { saves: number } {
  const state = { graph: null as unknown, indexedAt: {} as Record<string, string> };
  return {
    saves: 0,
    async load() {
      return { graph: state.graph, indexedAt: { ...state.indexedAt } };
    },
    async save(_org, repo, graph) {
      state.graph = graph;
      state.indexedAt[repo] = new Date().toISOString();
      (this as { saves: number }).saves++;
    },
  };
}

const OPENAPI = JSON.stringify({
  openapi: "3.0.0",
  paths: { "/orders/{id}": { get: {}, delete: {} } },
});

/** A diff that removes the DELETE operation from the contract. */
const CONTRACT_DIFF = `diff --git a/openapi.json b/openapi.json
--- a/openapi.json
+++ b/openapi.json
@@ -3,5 +3,4 @@ "paths": {
     "/orders/{id}": {
       "get": {},
-      "delete": {}
     }
`;

function job(): ReviewJob {
  return {
    schema_version: "1",
    idempotency_key: "k",
    delivery_id: "d",
    org: "acme",
    repo: "acme/orders",
    repo_id: 1,
    pr_number: 7,
    action: "opened",
    head_sha: "headsha",
    base_sha: "basesha",
    installation_id: 9,
    priority: 100,
    title: "Drop the delete endpoint",
    author: "octocat",
    enqueued_at: "2026-07-28T00:00:00Z",
  };
}

function wire(diff: string, files: Record<string, string> = {}) {
  const config: GatewayConfigData = {
    orgs: { acme: { provider: "fake", apiKey: "k", model: "m" } },
  };
  const gateway = new Gateway({
    providers: new Map([["fake", new FakeProvider(() => JSON.stringify({ summary: "s", effort: 2, findings: [] }))]]),
    config,
  });
  const github = new FakeGitHubClient({ diff, files });
  return { github, reviewer: new Reviewer({ gateway }) };
}

/** A graph where acme/billing calls the orders endpoints. */
function graphWithConsumer(): unknown {
  const g = new OrgGraph();
  g.ingestRepo("acme/orders", [{ path: "openapi.json", content: OPENAPI }]);
  g.ingestRepo("acme/billing", [
    { path: "src/refund.ts", content: `await fetch("https://orders.internal/orders/abc", { method: "DELETE" });` },
  ]);
  return g.toJSON();
}

// ── the query ────────────────────────────────────────────────────────────────

test("a changed endpoint is traced to the repositories that call it", async () => {
  const store = memoryStore();
  await store.save("acme", "acme/billing", graphWithConsumer());

  const step = makeBlastRadiusStep({ store });
  const out = await step({
    org: "acme",
    ref: { owner: "acme", repo: "orders", number: 7, headSha: "h", installationId: 9 },
    diff: CONTRACT_DIFF,
  });

  assert.equal(out.findings.length, 1, "one finding per changed interface, not per consumer");
  assert.equal(out.consumers, 1);
  const f = out.findings[0];
  assert.match(f.title, /consumed by 1 other repository/);
  assert.match(f.body, /acme\/billing/);
  assert.match(f.body, /src\/refund\.ts:1/);
  assert.equal(f.category, "api");
  assert.equal(f.severity, "medium", "one consumer is medium; several is high");
});

test("several consumers are one finding, at a higher severity", async () => {
  const g = new OrgGraph();
  g.ingestRepo("acme/orders", [{ path: "openapi.json", content: OPENAPI }]);
  for (const r of ["acme/billing", "acme/notify", "acme/admin"]) {
    g.ingestRepo(r, [{ path: "src/a.ts", content: `fetch("https://orders.internal/orders/1", { method: "DELETE" })` }]);
  }
  const store = memoryStore();
  await store.save("acme", "acme/billing", g.toJSON());

  const out = await makeBlastRadiusStep({ store })({
    org: "acme",
    ref: { owner: "acme", repo: "orders", number: 7, headSha: "h", installationId: 9 },
    diff: CONTRACT_DIFF,
  });

  assert.equal(out.findings.length, 1, "a rename that breaks three services is one decision, not three comments");
  assert.equal(out.findings[0].severity, "high");
  assert.match(out.findings[0].title, /3 other repositories/);
});

test("an empty graph produces nothing, and says so rather than guessing", async () => {
  const out = await makeBlastRadiusStep({ store: memoryStore() })({
    org: "acme",
    ref: { owner: "acme", repo: "orders", number: 7, headSha: "h", installationId: 9 },
    diff: CONTRACT_DIFF,
  });
  assert.deepEqual(out, { findings: [], consumers: 0, indexedRepos: 0 });
});

test("a change that touches no public interface reports no impact", async () => {
  const store = memoryStore();
  await store.save("acme", "acme/billing", graphWithConsumer());
  const out = await makeBlastRadiusStep({ store })({
    org: "acme",
    ref: { owner: "acme", repo: "orders", number: 7, headSha: "h", installationId: 9 },
    diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # Orders\n+A line.\n",
  });
  assert.equal(out.findings.length, 0);
  assert.equal(out.indexedRepos, 2, "the graph is there; this change simply does not reach it");
});

// ── the review path ──────────────────────────────────────────────────────────

test("the cross-repo finding reaches the pull request, and the Scope module", async () => {
  const store = memoryStore();
  await store.save("acme", "acme/billing", graphWithConsumer());
  const { github, reviewer } = wire(CONTRACT_DIFF);

  const outcome = await runReview(job(), {
    github,
    reviewer,
    blastRadius: makeBlastRadiusStep({ store }),
  });

  assert.equal(outcome.findingCount, 1);
  const body = github.lastReview()!.body;
  assert.match(body, /consumed by 1 other repository/);
  assert.match(body, /\| \*\*Blast Radius\*\* \| 1 downstream call site checked in other repositories \|/);
});

test("a failing cross-repo trace costs the section, never the review", async () => {
  const { github, reviewer } = wire(CONTRACT_DIFF);
  const outcome = await runReview(job(), {
    github,
    reviewer,
    blastRadius: async () => {
      throw new Error("control-plane is down");
    },
  });
  assert.equal(github.submissions.length, 1, "the review still lands");
  assert.equal(outcome.findingCount, 0);
  assert.doesNotMatch(github.lastReview()!.body, /Blast Radius/);
});

test("without the step there is no Blast Radius row at all", async () => {
  const { github, reviewer } = wire(CONTRACT_DIFF);
  await runReview(job(), { github, reviewer });
  assert.doesNotMatch(github.lastReview()!.body, /Blast Radius/);
});

// ── the indexer ──────────────────────────────────────────────────────────────

test("indexing reads a repository's contracts and stores the graph", async () => {
  const store = memoryStore();
  const { github } = wire(CONTRACT_DIFF, {
    "openapi.json": OPENAPI,
    "src/handler.ts": `export function handler() {}`,
  });

  const result = await makeGraphIndexer({ github, store })(
    { owner: "acme", repo: "orders", number: 7, headSha: "h", installationId: 9 },
    "acme",
  );

  assert.ok(result);
  assert.equal(result.repo, "acme/orders");
  assert.equal(result.providers, 2, "GET and DELETE on /orders/{id}");
  assert.equal(store.saves, 1);
});

test("a fresh slice is not re-indexed, so the usual case is one timestamp read", async () => {
  const store = memoryStore();
  const { github } = wire(CONTRACT_DIFF, { "openapi.json": OPENAPI });
  const index = makeGraphIndexer({ github, store });
  const ref = { owner: "acme", repo: "orders", number: 7, headSha: "h", installationId: 9 };

  await index(ref, "acme");
  assert.equal(store.saves, 1);
  assert.equal(await index(ref, "acme"), null, "second run inside the window does nothing");
  assert.equal(store.saves, 1);
});

test("a stale slice is re-indexed", async () => {
  const store = memoryStore();
  const { github } = wire(CONTRACT_DIFF, { "openapi.json": OPENAPI });
  const ref = { owner: "acme", repo: "orders", number: 7, headSha: "h", installationId: 9 };

  await makeGraphIndexer({ github, store })(ref, "acme");
  // staleMs of 0 means everything is stale, which is how a forced refresh works.
  await makeGraphIndexer({ github, store, staleMs: 0 })(ref, "acme");
  assert.equal(store.saves, 2);
});

test("indexing one repository does not erase the rest of the graph", async () => {
  // A workspace that only ever knew about whichever repo last saw a pull request
  // would be worse than useless: it would report "no consumers" with confidence.
  const store = memoryStore();
  await store.save("acme", "acme/billing", graphWithConsumer());
  const { github } = wire(CONTRACT_DIFF, { "openapi.json": OPENAPI });

  await makeGraphIndexer({ github, store })(
    { owner: "acme", repo: "orders", number: 7, headSha: "h", installationId: 9 },
    "acme",
  );

  const after = OrgGraph.fromJSON((await store.load("acme")).graph);
  assert.ok(after.indexedRepos().includes("acme/billing"), "the other repository survived");
  assert.ok(after.indexedRepos().includes("acme/orders"));
});

test("a repository whose tree cannot be read leaves the graph as it was", async () => {
  const store = memoryStore();
  await store.save("acme", "acme/billing", graphWithConsumer());
  const { github } = wire(CONTRACT_DIFF); // no files, so listTree is empty

  const result = await makeGraphIndexer({ github, store })(
    { owner: "acme", repo: "orders", number: 7, headSha: "h", installationId: 9 },
    "acme",
  );
  assert.equal(result, null);
  assert.equal(store.saves, 1, "only the seeding save; nothing was overwritten");
});

// ── file selection: what the indexer decides to read ─────────────────────────

test("selection finds contracts and skips vendored trees", () => {
  const { contracts, sources } = selectFiles([
    "openapi.json",
    "api/orders.proto",
    "schema.graphql",
    "package.json",
    "go.mod",
    "src/index.ts",
    "node_modules/left-pad/openapi.json",
    "vendor/github.com/x/api.proto",
    "dist/bundle.js",
    "src/index.test.ts",
  ]);

  assert.deepEqual(contracts, ["openapi.json", "api/orders.proto", "schema.graphql", "package.json", "go.mod"]);
  assert.deepEqual(sources, ["src/index.ts"], "no vendored code, no build output, no tests");
});

test("selection is bounded, shallowest first", () => {
  const deep = Array.from({ length: 80 }, (_, i) => `a/b/c/d/e/f${i}.ts`);
  const shallow = ["main.ts", "src/app.ts"];
  const { sources } = selectFiles([...deep, ...shallow]);

  assert.ok(sources.length <= 40, "a repository cannot cost eighty file reads");
  assert.equal(sources[0], "main.ts", "a service's outbound calls live near the top of its tree");
  assert.equal(sources[1], "src/app.ts");
});
