import { test } from "node:test";
import assert from "node:assert/strict";
import { commentableLines, parseUnifiedDiff } from "@cavix/core";
import { RestAzureClient } from "@cavix/orchestrator";
import type { PullRef } from "../src/github/client.ts";

// Azure DevOps as the fourth platform.
//
// The point of this file is the DIFF. Every other host hands one over; Azure
// returns a list of changed paths and no content, so Cavix reads both versions
// of each file and diffs them locally. Everything downstream treats the result
// as exact: which lines an inline comment may anchor to, what line number a
// finding carries, and where the sandbox reproduces a bug. So the tests below
// run the real client against realistic Azure responses and then check the
// answer the way the WORKFLOW will use it, not the way the client produced it.

const REF: PullRef = {
  // "organization/project", exactly as refFromJob produces it from
  // "acme/payments/billing-api" by splitting at the LAST slash.
  owner: "acme/payments",
  repo: "billing-api",
  number: 42,
  headSha: "head111",
  installationId: 0,
};

/** The file as it exists on the target branch. */
const BEFORE = `import { db } from "./db";

export async function charge(user, amount) {
  const token = sign(user);
  return db.charge(user.id, amount, token);
}
`;

/** The same file on the source branch: two inserts and one edited line. */
const AFTER = `import { db } from "./db";
import { audit } from "./audit";

export async function charge(user, amount) {
  const token = sign(user, { ttl: 3600 });
  await db.query("SELECT * FROM u WHERE id = " + user.id);
  return db.charge(user.id, amount, token);
}
`;

const PR = {
  title: "Charge with an audit trail",
  description: "author text",
  status: "active",
  isDraft: false,
  targetRefName: "refs/heads/main",
  lastMergeSourceCommit: { commitId: "head111" },
  lastMergeTargetCommit: { commitId: "base222" },
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/**
 * A fake Azure instance.
 *
 * Content routes are keyed by "path@commit" so the two versions of one file are
 * genuinely different documents, which is the whole point: a fake that returns
 * the same bytes for both would make any differ look correct.
 */
function api(opts: {
  pr?: unknown;
  changes?: unknown;
  files?: Record<string, string>;
  threads?: unknown;
  tree?: unknown;
  builds?: unknown;
}) {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });

    if (url.includes("/items?path=")) {
      const path = decodeURIComponent(/path=([^&]+)/.exec(url)?.[1] ?? "").replace(/^\//, "");
      const version = decodeURIComponent(/versionDescriptor\.version=([^&]+)/.exec(url)?.[1] ?? "");
      const content = opts.files?.[`${path}@${version}`];
      return content === undefined
        ? new Response("not found", { status: 404 })
        : new Response(content, { status: 200 });
    }
    if (url.includes("/items?scopePath=")) return json(opts.tree ?? { value: [] });
    if (url.includes("/diffs/commits")) return json(opts.changes ?? { changes: [] });
    if (url.includes("/threads")) return json(opts.threads ?? { id: 900 });
    if (url.includes("/statuses")) return json({ id: 5 });
    if (url.includes("/_apis/build/builds")) return json(opts.builds ?? { value: [] });
    if (url.includes("/_apis/connectionData")) return json({ authenticatedUser: { providerDisplayName: "Cavix Bot" } });
    if (url.includes("/pullrequests/42")) return json(opts.pr ?? PR);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

function client(opts: Parameters<typeof api>[0] & { maxDiffFiles?: number } = {}) {
  const { impl, calls } = api(opts);
  return {
    az: new RestAzureClient({
      tokens: { token: async () => "pat" },
      fetchImpl: impl,
      ...(opts.maxDiffFiles !== undefined ? { maxDiffFiles: opts.maxDiffFiles } : {}),
    }),
    calls,
  };
}

const editOf = (path: string) => ({ item: { path: `/${path}`, gitObjectType: "blob" }, changeType: "edit" });

test("it declares what Azure cannot do rather than pretending parity", () => {
  const { az } = client();
  assert.equal(az.platform, "azure-devops");
  // Azure has a comment "like" and no emoji vocabulary, and with commands
  // refused there is nothing to acknowledge anyway.
  assert.equal(az.capabilities.reactions, false);
  // A bot can only vote on a pull request it was added as a reviewer to, which
  // nobody will have done. Blocking is a status a branch policy can require.
  assert.equal(az.capabilities.blockingReview, false);
  // recursionLevel=full walks the tree server-side in one call.
  assert.equal(az.capabilities.treeListing, true);
});

test("commands are REFUSED, not stubbed: an unauthorizable command path is an open door", async () => {
  const { az } = client();
  assert.equal(await az.commandsAllowed(), false);
});

// ── the diff, which is the whole of the work ─────────────────────────────────

test("the diff is computed from both versions and its line numbers survive into an anchor", async () => {
  const { az } = client({
    changes: { changes: [editOf("src/billing.ts")], allChangesIncluded: true },
    files: { "src/billing.ts@base222": BEFORE, "src/billing.ts@head111": AFTER },
  });

  const diff = await az.fetchPullDiff(REF);
  const parsed = parseUnifiedDiff(diff);
  assert.deepEqual(parsed.map((f) => f.path), ["src/billing.ts"]);

  // The property the platform rests on: the anchors are the ADDED lines, and
  // each number indexes the line it claims to in the new file.
  const anchors = [...(commentableLines(parsed).get("src/billing.ts") ?? [])].sort((a, b) => a - b);
  assert.deepEqual(anchors, [2, 5, 6]);
  const newFile = AFTER.split("\n");
  assert.equal(newFile[1], 'import { audit } from "./audit";');
  assert.equal(newFile[4], "  const token = sign(user, { ttl: 3600 });");
  assert.equal(newFile[5], '  await db.query("SELECT * FROM u WHERE id = " + user.id);');

  // And nothing was left out, so the review claims full coverage honestly.
  assert.deepEqual(az.diffLimitations(REF), []);
});

test("an added file and a deleted file are diffed against nothing, not against themselves", async () => {
  const { az } = client({
    changes: {
      changes: [
        { item: { path: "/src/new.ts" }, changeType: "add" },
        { item: { path: "/src/gone.ts" }, changeType: "delete" },
      ],
    },
    files: {
      "src/new.ts@head111": "export const x = 1;\n",
      "src/gone.ts@base222": "export const y = 2;\n",
    },
  });

  const parsed = parseUnifiedDiff(await az.fetchPullDiff(REF));
  const added = parsed.find((f) => f.path === "src/new.ts");
  const deleted = parsed.find((f) => f.path === "src/gone.ts");
  assert.ok(added && !added.deleted);
  assert.ok(deleted && deleted.deleted);
  // A deletion still names the file it removed, which is what the walkthrough
  // prints and what the subsystem count is derived from.
  assert.equal(deleted.path, "src/gone.ts");
  assert.deepEqual([...(commentableLines(parsed).get("src/new.ts") ?? [])], [1]);
});

test("a rename carries both paths, so the old side is fetched at the old name", async () => {
  const { az, calls } = client({
    changes: {
      changes: [
        {
          item: { path: "/src/renamed.ts" },
          changeType: "edit, rename",
          sourceServerItem: "/src/original.ts",
        },
      ],
    },
    files: { "src/original.ts@base222": "const a = 1;\n", "src/renamed.ts@head111": "const a = 2;\n" },
  });

  const diff = await az.fetchPullDiff(REF);
  assert.match(diff, /^diff --git a\/src\/original\.ts b\/src\/renamed\.ts$/m);
  // Reading the new path at the OLD commit is how a rename gets diffed against
  // a file that does not exist there, and every line then reads as added.
  assert.ok(calls.some((c) => c.url.includes("original.ts") && c.url.includes("base222")));
});

test("a path Azure listed but neither version can be read is reported, not treated as empty", async () => {
  // "" on one side renders as a whole-file addition or deletion the pull request
  // does not contain, which is a fabricated change rather than a missing one.
  const { az } = client({
    changes: { changes: [editOf("src/unreadable.ts")] },
    files: {},
  });
  const diff = await az.fetchPullDiff(REF);
  assert.equal(diff, "");
  const limits = az.diffLimitations(REF);
  assert.equal(limits.length, 1);
  assert.equal(limits[0].path, "src/unreadable.ts");
  assert.match(limits[0].reason, /neither version of this file could be read/);
});

test("files past the budget are NAMED, never silently dropped", async () => {
  const changes = Array.from({ length: 5 }, (_, i) => editOf(`src/f${i}.ts`));
  const files: Record<string, string> = {};
  for (let i = 0; i < 5; i++) {
    files[`src/f${i}.ts@base222`] = "const a = 1;\n";
    files[`src/f${i}.ts@head111`] = "const a = 2;\n";
  }
  const { az } = client({ changes: { changes }, files, maxDiffFiles: 2 });

  const parsed = parseUnifiedDiff(await az.fetchPullDiff(REF));
  assert.deepEqual(parsed.map((f) => f.path), ["src/f0.ts", "src/f1.ts"]);

  const limits = az.diffLimitations(REF);
  assert.deepEqual(
    limits.map((l) => l.path),
    ["src/f2.ts", "src/f3.ts", "src/f4.ts"],
  );
  assert.match(limits[0].reason, /beyond the 2 files Cavix diffs per pull request/);
});

test("a file too rewritten to diff exactly is refused rather than approximated", async () => {
  // Every line different, so the edit distance is 2 x the line count. The
  // default budget is 1500, which a 400-line rewrite does NOT cross: real code
  // changes are nowhere near it, and that is the point of where it sits.
  const before = Array.from({ length: 1000 }, (_, i) => `old ${i}`).join("\n") + "\n";
  const after = Array.from({ length: 1000 }, (_, i) => `new ${i}`).join("\n") + "\n";
  const { az } = client({
    changes: { changes: [editOf("src/rewritten.ts"), editOf("src/small.ts")] },
    files: {
      "src/rewritten.ts@base222": before,
      "src/rewritten.ts@head111": after,
      "src/small.ts@base222": "const a = 1;\n",
      "src/small.ts@head111": "const a = 2;\n",
    },
  });

  const parsed = parseUnifiedDiff(await az.fetchPullDiff(REF));
  // The rest of the change is still reviewed. Refusing one file does not cost
  // the pull request its review.
  assert.deepEqual(parsed.map((f) => f.path), ["src/small.ts"]);
  const limits = az.diffLimitations(REF);
  assert.equal(limits.length, 1);
  assert.equal(limits[0].path, "src/rewritten.ts");
  assert.match(limits[0].reason, /rewritten past the .* edit budget/);
});

test("Azure truncating its own change list is reported, so coverage is never overclaimed", async () => {
  const { az } = client({
    changes: { changes: [editOf("src/a.ts")], allChangesIncluded: false },
    files: { "src/a.ts@base222": "const a = 1;\n", "src/a.ts@head111": "const a = 2;\n" },
  });
  await az.fetchPullDiff(REF);
  assert.match(az.diffLimitations(REF)[0].reason, /truncated its own list of changed files/);
});

test("limitations are keyed by pull request, so one review never reports another's", async () => {
  // One client serves every review this orchestrator runs concurrently. A plain
  // field here would report whichever pull request finished last, under somebody
  // else's review. The GitLab client learned this the expensive way.
  const { az } = client({
    changes: { changes: [editOf("src/broken.ts")] },
    files: {},
  });
  await az.fetchPullDiff(REF);
  assert.equal(az.diffLimitations(REF).length, 1);
  assert.deepEqual(az.diffLimitations({ ...REF, number: 99 }), [], "a different pull request");
  assert.deepEqual(az.diffLimitations({ ...REF, headSha: "other" }), [], "a different head commit");
});

test("a clean re-review clears the previous run's limitations rather than leaving them stale", async () => {
  const { az } = client({
    changes: { changes: [editOf("src/a.ts")] },
    files: { "src/a.ts@base222": "const a = 1;\n", "src/a.ts@head111": "const a = 2;\n" },
  });
  await az.fetchPullDiff(REF);
  assert.deepEqual(az.diffLimitations(REF), []);
});

// ── the rest of the port ─────────────────────────────────────────────────────

test("getPull maps Azure's vocabulary onto the one the workflow speaks", async () => {
  const { az } = client({ pr: PR });
  const meta = await az.getPull(REF);
  assert.equal(meta.headSha, "head111");
  assert.equal(meta.baseSha, "base222");
  assert.equal(meta.baseRef, "main", "refs/heads/ is stripped");
  assert.equal(meta.state, "open", `"active" is Azure's word for it`);
  assert.equal(meta.body, "author text");
  assert.equal(meta.draft, false);
});

test("a review is a summary thread first, then one anchored thread per finding", async () => {
  const { az, calls } = client({});
  const posted = await az.postReview(REF, {
    body: "SUMMARY",
    event: "COMMENT",
    comments: [{ path: "src/billing.ts", line: 6, body: "FINDING" }],
  });
  assert.equal(posted.id, 900);
  assert.match(posted.htmlUrl, /\/acme\/payments\/_git\/billing-api\/pullrequest\/42$/);

  const threads = calls.filter((c) => c.method === "POST" && c.url.includes("/threads"));
  assert.equal(threads.length, 2);
  // The summary goes FIRST and its failure is the only fatal one, because it
  // names every finding: a review that lost three anchors is still complete.
  assert.equal((threads[0].body as { comments: Array<{ content: string }> }).comments[0].content, "SUMMARY");

  const inline = threads[1].body as { threadContext: { filePath: string; rightFileStart: { line: number } } };
  // Azure rejects a thread whose path has no leading slash.
  assert.equal(inline.threadContext.filePath, "/src/billing.ts");
  assert.equal(inline.threadContext.rightFileStart.line, 6);
});

test("a refused inline anchor costs the anchor, never the review", async () => {
  let first = true;
  const impl = (async (url: string, init?: RequestInit) => {
    if (url.includes("/threads") && init?.method === "POST") {
      if (first) {
        first = false;
        return json({ id: 901 });
      }
      return new Response("bad anchor", { status: 400 });
    }
    return json({});
  }) as unknown as typeof fetch;
  const az = new RestAzureClient({ tokens: { token: async () => "pat" }, fetchImpl: impl });

  const posted = await az.postReview(REF, {
    body: "SUMMARY",
    event: "COMMENT",
    comments: [{ path: "a.ts", line: 1, body: "x" }],
  });
  assert.equal(posted.id, 901, "the summary is still posted");
});

test("the status row reports SUCCEEDED when Cavix could not run, so an outage of ours freezes nobody", async () => {
  const { az, calls } = client({});
  await az.updateCheckRun(REF, 1, {
    status: "completed",
    conclusion: "neutral",
    title: "Review could not be completed",
    summary: "",
  });
  const status = calls.find((c) => c.url.includes("/statuses"))?.body as { state: string };
  assert.equal(status.state, "succeeded");
});

test("a blocking review reports FAILED, which a branch policy can gate on", async () => {
  const { az, calls } = client({});
  await az.updateCheckRun(REF, 1, { status: "completed", conclusion: "failure", title: "Blocked", summary: "" });
  const status = calls.find((c) => c.url.includes("/statuses"))?.body as { state: string };
  assert.equal(status.state, "failed");
});

test("a PAT is sent as HTTP Basic, because a Bearer header reads as anonymous on Azure", async () => {
  // Azure silently accepts a Bearer header and behaves as an unauthenticated
  // request on public projects, which works in a demo and 404s on the private
  // repository a customer actually has.
  let auth = "";
  const impl = (async (_url: string, init?: RequestInit) => {
    auth = new Headers(init?.headers).get("authorization") ?? "";
    return json(PR);
  }) as unknown as typeof fetch;
  const az = new RestAzureClient({ tokens: { token: async () => "s3cret" }, fetchImpl: impl });
  await az.getPull(REF);
  assert.equal(auth, `Basic ${Buffer.from(":s3cret").toString("base64")}`);
});

test("a sign-in page is named as a 401 rather than crashing on unparseable JSON", async () => {
  const impl = (async () => new Response("<html>sign in</html>", { status: 200 })) as unknown as typeof fetch;
  const az = new RestAzureClient({ tokens: { token: async () => "pat" }, fetchImpl: impl });
  await assert.rejects(() => az.getPull(REF), /HTTP 401/);
});

test("the tree listing is one call and drops folders", async () => {
  const { az, calls } = client({
    tree: {
      value: [
        { path: "/src", isFolder: true, gitObjectType: "tree" },
        { path: "/src/a.ts", gitObjectType: "blob" },
        { path: "/openapi.json", gitObjectType: "blob" },
      ],
    },
  });
  assert.deepEqual(await az.listTree(REF), ["src/a.ts", "openapi.json"]);
  assert.equal(calls.filter((c) => c.url.includes("scopePath")).length, 1);
});

test("a build with no duration is skipped rather than dragging the trend to zero", async () => {
  const { az } = client({
    builds: {
      value: [
        {
          definition: { name: "ci" },
          sourceVersion: "c1",
          sourceBranch: "refs/heads/main",
          result: "succeeded",
          startTime: "2026-01-01T00:00:00Z",
          finishTime: "2026-01-01T00:04:00Z",
        },
        { definition: { name: "ci" }, result: "canceled", startTime: "", finishTime: "" },
      ],
    },
  });
  const runs = await az.listWorkflowRuns(REF, "main");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].durationMs, 240_000);
  assert.equal(runs[0].branch, "main", "refs/heads/ is stripped");
  assert.equal(runs[0].conclusion, "success");
});
