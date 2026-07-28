import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewJob } from "@cavix/core";
import type { BuildRun } from "@cavix/telemetry";
import { Gateway, FakeProvider, type GatewayConfigData } from "@cavix/gateway";
import {
  FakeGitHubClient,
  makeCiIngestStep,
  makeRegressionStep,
  Reviewer,
  runReview,
  type CiStore,
  type WorkflowRun,
} from "@cavix/orchestrator";

// Stage 6: warning before merge that the pipeline this change joins is degrading.
//
// The roadmap calls this the one genuinely empty lane in the competitive set,
// because static analysis sees the code and not its consequences. A change can
// be correct, well-tested and well-reviewed and still be the one that takes the
// build from four minutes to nine, which nobody notices for a month and nobody
// can then attribute to anything.

const DIFF = `diff --git a/src/build.ts b/src/build.ts
--- a/src/build.ts
+++ b/src/build.ts
@@ -1,2 +1,3 @@ export function build() {
 export function build() {
+  return compileEverything();
 }
`;

function memoryStore(): CiStore & { saves: number } {
  const state = { runs: [] as BuildRun[], fetchedAt: {} as Record<string, string> };
  return {
    saves: 0,
    async load() {
      return { runs: [...state.runs], fetchedAt: { ...state.fetchedAt } };
    },
    async save(_org, repo, runs) {
      state.runs = [...state.runs.filter((r) => r.repo !== repo), ...runs];
      state.fetchedAt[repo] = new Date().toISOString();
      (this as { saves: number }).saves++;
    },
  };
}

/** `count` completed runs of `workflow`, each `durationMs` long, oldest first. */
function runs(count: number, durationMs: number, opts: { from?: number; conclusion?: string; workflow?: string } = {}): BuildRun[] {
  const from = opts.from ?? Date.now() - 40 * 86_400_000;
  return Array.from({ length: count }, (_, i) => ({
    repo: "acme/api",
    workflow: opts.workflow ?? "ci",
    durationMs,
    commit: `c${from}-${i}`,
    conclusion: opts.conclusion ?? "success",
    branch: "main",
    at: new Date(from + i * 3600_000).toISOString(),
  }));
}

function job(): ReviewJob {
  return {
    schema_version: "1",
    idempotency_key: "k",
    delivery_id: "d",
    org: "acme",
    repo: "acme/api",
    repo_id: 1,
    pr_number: 3,
    action: "opened",
    head_sha: "headsha",
    base_sha: "basesha",
    installation_id: 9,
    priority: 100,
    title: "Compile everything",
    author: "octocat",
    enqueued_at: "2026-07-28T00:00:00Z",
  };
}

function wire(workflowRuns: WorkflowRun[] = []) {
  const config: GatewayConfigData = { orgs: { acme: { provider: "fake", apiKey: "k", model: "m" } } };
  const gateway = new Gateway({
    providers: new Map([["fake", new FakeProvider(() => JSON.stringify({ summary: "s", effort: 2, findings: [] }))]]),
    config,
  });
  const github = new FakeGitHubClient({ diff: DIFF, workflowRuns });
  return { github, reviewer: new Reviewer({ gateway }) };
}

const ref = { owner: "acme", repo: "api", number: 3, headSha: "h", installationId: 9 };

// ── the warning ──────────────────────────────────────────────────────────────

test("a pipeline that has been getting slower is called out, with the numbers", async () => {
  const store = memoryStore();
  const old = Date.now() - 40 * 86_400_000;
  await store.save("acme", "acme/api", [
    ...runs(12, 200_000, { from: old }),
    ...runs(10, 340_000, { from: old + 20 * 3600_000 }),
  ]);

  const out = await makeRegressionStep({ store })({ org: "acme", ref });

  assert.equal(out.findings.length, 1);
  const f = out.findings[0];
  assert.match(f.title, /CI pipeline "ci" is 70% slower/);
  assert.match(f.body, /averaged \*\*5m 40s\*\*/);
  assert.match(f.body, /against \*\*3m 20s\*\*/);
  assert.equal(f.category, "performance");
  assert.equal(f.source, "telemetry");
  assert.equal(out.runsAnalysed, 22);
});

test("the warning says plainly that it is not blaming this pull request", async () => {
  // It cannot: the trend is measured on the default branch, over runs that
  // finished before this branch existed. Claiming causation from that data would
  // be the kind of confident wrongness this product is built to avoid.
  const store = memoryStore();
  const old = Date.now() - 40 * 86_400_000;
  await store.save("acme", "acme/api", [...runs(12, 200_000, { from: old }), ...runs(10, 400_000, { from: old + 20 * 3600_000 })]);

  const [f] = (await makeRegressionStep({ store })({ org: "acme", ref })).findings;
  assert.match(f.body, /not a claim about this pull request/);
  assert.match(f.body, /before this branch existed/);
});

test("a steady pipeline produces nothing", async () => {
  const store = memoryStore();
  await store.save("acme", "acme/api", runs(24, 200_000));
  const out = await makeRegressionStep({ store })({ org: "acme", ref });
  assert.equal(out.findings.length, 0);
  assert.equal(out.runsAnalysed, 24, "it looked; there was simply nothing to say");
});

test("a small percentage on a fast pipeline is runner noise, not a trend", async () => {
  // 8s to 10s is 25%, which clears the percentage gate and should still say
  // nothing: two seconds is not worth a reviewer's attention.
  const store = memoryStore();
  const old = Date.now() - 40 * 86_400_000;
  await store.save("acme", "acme/api", [...runs(12, 8_000, { from: old }), ...runs(10, 10_000, { from: old + 20 * 3600_000 })]);
  assert.equal((await makeRegressionStep({ store })({ org: "acme", ref })).findings.length, 0);
});

test("too little history says nothing rather than guessing", async () => {
  const store = memoryStore();
  await store.save("acme", "acme/api", runs(6, 200_000));
  const out = await makeRegressionStep({ store })({ org: "acme", ref });
  assert.equal(out.findings.length, 0);
  assert.equal(out.runsAnalysed, 6);
});

test("a pipeline that fails most of the time is worth saying out loud", async () => {
  const store = memoryStore();
  const old = Date.now() - 40 * 86_400_000;
  await store.save("acme", "acme/api", [
    ...runs(12, 200_000, { from: old }),
    ...runs(10, 200_000, { from: old + 20 * 3600_000, conclusion: "failure" }),
  ]);

  const [f] = (await makeRegressionStep({ store })({ org: "acme", ref })).findings;
  assert.match(f.title, /failed 100% of its recent runs/);
  assert.equal(f.category, "reliability");
  assert.match(f.body, /stops being a signal/);
});

test("two pipelines are judged separately, never averaged together", async () => {
  const store = memoryStore();
  const old = Date.now() - 40 * 86_400_000;
  await store.save("acme", "acme/api", [
    ...runs(12, 200_000, { from: old, workflow: "ci" }),
    ...runs(10, 400_000, { from: old + 20 * 3600_000, workflow: "ci" }),
    ...runs(24, 30_000, { from: old, workflow: "lint" }),
  ]);

  const out = await makeRegressionStep({ store })({ org: "acme", ref });
  assert.equal(out.workflows, 2);
  assert.equal(out.findings.length, 1, "only the one that actually slowed");
  assert.match(out.findings[0].title, /"ci"/);
});

test("no history at all is silence, not an error", async () => {
  const out = await makeRegressionStep({ store: memoryStore() })({ org: "acme", ref });
  assert.deepEqual(out, { findings: [], runsAnalysed: 0, workflows: 0 });
});

// ── the review path ──────────────────────────────────────────────────────────

test("the warning reaches the pull request, and the Scope module", async () => {
  const store = memoryStore();
  const old = Date.now() - 40 * 86_400_000;
  await store.save("acme", "acme/api", [...runs(12, 200_000, { from: old }), ...runs(10, 400_000, { from: old + 20 * 3600_000 })]);
  const { github, reviewer } = wire();

  await runReview(job(), { github, reviewer, regression: makeRegressionStep({ store }) });

  const body = github.lastReview()!.body;
  assert.match(body, /CI pipeline "ci" is 100% slower/);
  assert.match(body, /\| \*\*CI Telemetry\*\* \| 22 completed pipeline runs analysed for regression \|/);
});

test("a failing telemetry read costs the section, never the review", async () => {
  const { github, reviewer } = wire();
  const outcome = await runReview(job(), {
    github,
    reviewer,
    regression: async () => {
      throw new Error("control-plane down");
    },
  });
  assert.equal(github.submissions.length, 1);
  assert.equal(outcome.findingCount, 0);
  assert.doesNotMatch(github.lastReview()!.body, /CI Telemetry/);
});

// ── ingestion ────────────────────────────────────────────────────────────────

function ghRuns(n: number): WorkflowRun[] {
  return Array.from({ length: n }, (_, i) => ({
    workflow: "ci",
    commit: `sha${i}`,
    branch: "main",
    durationMs: 200_000,
    conclusion: "success",
    at: new Date(Date.now() - i * 3600_000).toISOString(),
  }));
}

test("ingestion pulls completed runs and stores them", async () => {
  const store = memoryStore();
  const { github } = wire(ghRuns(20));

  const result = await makeCiIngestStep({ github, store })(ref, "acme", "main");

  assert.ok(result);
  assert.equal(result.runsFetched, 20);
  assert.equal(result.runsStored, 20);
  assert.deepEqual(result.workflows, ["ci"]);
});

test("a second pull does not double-count the runs it already has", async () => {
  // Refreshes overlap by design. Appending blind would count the same run five
  // times and then report a trend built entirely out of duplicates.
  const store = memoryStore();
  const { github } = wire(ghRuns(20));

  await makeCiIngestStep({ github, store })(ref, "acme", "main");
  const second = await makeCiIngestStep({ github, store, staleMs: 0 })(ref, "acme", "main");

  assert.equal(second!.runsStored, 20, "still twenty, not forty");
});

test("fresh history is not re-fetched", async () => {
  const store = memoryStore();
  const { github } = wire(ghRuns(20));
  const ingest = makeCiIngestStep({ github, store });

  await ingest(ref, "acme", "main");
  assert.equal(store.saves, 1);
  assert.equal(await ingest(ref, "acme", "main"), null);
  assert.equal(store.saves, 1);
});

test("a repository with no CI is silent, not an error", async () => {
  const store = memoryStore();
  const { github } = wire([]); // Actions disabled, no permission, or no CI
  assert.equal(await makeCiIngestStep({ github, store })(ref, "acme", "main"), null);
  assert.equal(store.saves, 0);
});

test("ingesting one repository leaves another's history alone", async () => {
  const store = memoryStore();
  await store.save("acme", "acme/web", runs(5, 100_000).map((r) => ({ ...r, repo: "acme/web" })));
  const { github } = wire(ghRuns(10));

  await makeCiIngestStep({ github, store })(ref, "acme", "main");

  const { runs: all } = await store.load("acme");
  assert.equal(all.filter((r) => r.repo === "acme/web").length, 5);
  assert.equal(all.filter((r) => r.repo === "acme/api").length, 10);
});
