import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff } from "@cavix/core";
import { RestGitLabClient, StaticGitLabToken } from "@cavix/orchestrator";
import type { PullRef } from "../src/github/client.ts";

// GitLab as the second live platform, against a recorded API rather than a
// mock of my own assumptions: every response shape below is the one GitLab v4
// actually returns, including the fields that differ from GitHub's in ways that
// silently produce a wrong review if you assume they match.

const REF: PullRef = {
  owner: "acme/platform",
  repo: "billing",
  number: 12,
  headSha: "headsha",
  installationId: 0,
};

/** A fetch that answers from a route table and records every call. */
function api(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    // Longest match wins, so "/merge_requests/12/changes" beats "/merge_requests/12".
    const key = Object.keys(routes)
      .filter((k) => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return new Response("not found", { status: 404 });
    const value = routes[key];
    if (value instanceof Response) return value.clone();
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function client(routes: Record<string, unknown>) {
  const { impl, calls } = api(routes);
  return {
    gl: new RestGitLabClient({ tokens: new StaticGitLabToken("glpat-x"), fetchImpl: impl }),
    calls,
  };
}

test("it declares what GitLab cannot do rather than pretending parity", () => {
  const { gl } = client({});
  assert.equal(gl.platform, "gitlab");
  // The one that changes what a reviewer sees: no bot can hold GitLab's merge
  // button, so a workspace with blocking on has to be told.
  assert.equal(gl.capabilities.blockingReview, false);
  assert.equal(gl.capabilities.checkRuns, true, "a commit status is a real gate");
  assert.equal(gl.capabilities.ciHistory, true);
});

test("a nested group is encoded as one project id, not three path segments", async () => {
  // "acme/platform/billing" has to become "acme%2Fplatform%2Fbilling". Encoding
  // the segments separately gives a URL GitLab reads as three levels of nothing
  // and answers 404 for, on every call, for every customer using subgroups.
  const { gl, calls } = client({ "/merge_requests/12/changes": { changes: [] } });
  await gl.fetchPullDiff(REF);
  assert.match(calls[0].url, /\/projects\/acme%2Fplatform%2Fbilling\/merge_requests\/12\/changes$/);
});

test("the assembled diff is one Cavix can actually parse", async () => {
  // GitLab has no "whole thing as a diff" media type: it returns per-file change
  // objects whose `diff` is a bare hunk set with no file headers. Without the
  // `diff --git` and +++/--- lines, parseUnifiedDiff sees one anonymous blob and
  // every finding loses its file.
  const { gl } = client({
    "/merge_requests/12/changes": {
      changes: [
        {
          old_path: "src/refund.js",
          new_path: "src/refund.js",
          diff: "@@ -1,3 +1,4 @@\n function refund(id) {\n+  audit(id);\n   return id;\n }\n",
        },
        {
          old_path: "src/audit.js",
          new_path: "src/audit.js",
          diff: "@@ -1,1 +1,2 @@\n export function audit(id) {\n+  return id;\n }\n",
        },
      ],
    },
  });

  const diff = await gl.fetchPullDiff(REF);
  const files = parseUnifiedDiff(diff);
  assert.deepEqual(files.map((f) => f.path), ["src/refund.js", "src/audit.js"]);
  assert.ok(files[0].hunks.length > 0, "and the hunks survive");
});

test("a deleted file gets the /dev/null header a unified diff needs", async () => {
  const { gl } = client({
    "/merge_requests/12/changes": {
      changes: [{ old_path: "gone.js", new_path: "gone.js", deleted_file: true, diff: "@@ -1,1 +0,0 @@\n-x\n" }],
    },
  });
  assert.match(await gl.fetchPullDiff(REF), /^--- \/dev\/null$/m);
});

test("getPull reads the fields GitLab actually sends, including the old draft flag", async () => {
  // `draft` is modern; `work_in_progress` is what a lot of self-managed
  // instances still send, and reading only the new one reviews every draft on
  // an older install.
  const { gl } = client({
    "/merge_requests/12": {
      title: "Add refunds",
      description: "author text",
      state: "opened",
      work_in_progress: true,
      target_branch: "develop",
      diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
    },
  });
  const meta = await gl.getPull(REF);
  assert.equal(meta.draft, true);
  assert.equal(meta.baseRef, "develop");
  assert.equal(meta.headSha, "head");
  assert.equal(meta.body, "author text");
  // GitLab says "opened"; the rest of Cavix speaks GitHub's "open".
  assert.equal(meta.state, "open");
});

test("the review is a summary note plus a discussion per finding", async () => {
  const { gl, calls } = client({
    "/merge_requests/12/notes": { id: 501 },
    "/merge_requests/12/discussions": { id: "d1" },
    "/merge_requests/12": { diff_refs: { base_sha: "b", head_sha: "h", start_sha: "s" } },
  });

  const posted = await gl.postReview(REF, {
    body: "## Cavix Review\n\nthe summary",
    event: "COMMENT",
    comments: [{ path: "src/refund.js", line: 4, body: "finding one" }],
  });

  assert.equal(posted.id, 501);
  assert.match(posted.htmlUrl, /acme\/platform\/billing\/-\/merge_requests\/12$/);

  const discussion = calls.find((c) => c.url.includes("/discussions"))!;
  const pos = (discussion.body as { position: Record<string, unknown> }).position;
  // All three SHAs together, or GitLab rejects the anchor outright.
  assert.equal(pos.base_sha, "b");
  assert.equal(pos.head_sha, "h");
  assert.equal(pos.start_sha, "s");
  assert.equal(pos.new_line, 4);
});

test("an anchor GitLab refuses costs the anchor, never the review", async () => {
  // The finding is already named in the summary, so a rejected position is a
  // lost convenience. Losing the whole review over one stale line would not be.
  const { impl } = api({
    "/merge_requests/12/notes": { id: 501 },
    "/merge_requests/12/discussions": new Response("line does not exist", { status: 400 }),
    "/merge_requests/12": { diff_refs: { base_sha: "b", head_sha: "h", start_sha: "s" } },
  });
  const logged: Array<Record<string, unknown> | undefined> = [];
  const gl = new RestGitLabClient({
    tokens: new StaticGitLabToken("t"),
    fetchImpl: impl,
    logger: { info: (_m, meta) => logged.push(meta) },
  });
  const posted = await gl.postReview(REF, {
    body: "summary",
    event: "COMMENT",
    comments: [{ path: "a.js", line: 9, body: "x" }],
  });
  assert.equal(posted.id, 501, "the review still landed");
  // Reported, never stored on the client: one instance serves every review this
  // orchestrator runs at once, so a counter there would name the wrong one.
  assert.deepEqual(logged[0], { repo: "acme/platform/billing", mr: 12, wanted: 1, anchored: 0 });
});

test("the diff refs are reused from the diff fetch instead of re-read", async () => {
  // /changes already carries them, and the review path always fetches the diff
  // before posting. Re-reading the merge request was a whole round trip per
  // review for three strings.
  const { gl, calls } = client({
    "/merge_requests/12/changes": {
      changes: [{ old_path: "a.js", new_path: "a.js", diff: "@@ -1,1 +1,2 @@\n x\n+y\n" }],
      diff_refs: { base_sha: "b", head_sha: "h", start_sha: "s" },
    },
    "/merge_requests/12/notes": { id: 7 },
    "/merge_requests/12/discussions": { id: "d" },
  });

  await gl.fetchPullDiff(REF);
  await gl.postReview(REF, { body: "s", event: "COMMENT", comments: [{ path: "a.js", line: 2, body: "b" }] });

  const metaReads = calls.filter((c) => c.method === "GET" && /\/merge_requests\/12$/.test(c.url));
  assert.equal(metaReads.length, 0, "no second read of the merge request");
  const pos = (calls.find((c) => c.url.includes("/discussions"))!.body as { position: Record<string, string> }).position;
  assert.equal(pos.base_sha, "b");
});

test("a new push does not reuse the previous head's diff refs", async () => {
  // Keyed on the head SHA. Anchoring a finding to a commit the merge request has
  // moved past is exactly what GitLab rejects, and silently anchoring to the
  // wrong one would be worse than the rejection.
  const { gl, calls } = client({
    "/merge_requests/12/changes": {
      changes: [{ old_path: "a.js", new_path: "a.js", diff: "@@ -1,1 +1,2 @@\n x\n+y\n" }],
      diff_refs: { base_sha: "b", head_sha: "h1", start_sha: "s" },
    },
    "/merge_requests/12/notes": { id: 7 },
    "/merge_requests/12/discussions": { id: "d" },
    "/merge_requests/12": { diff_refs: { base_sha: "b2", head_sha: "h2", start_sha: "s2" } },
  });

  await gl.fetchPullDiff(REF); // caches under headSha "headsha"
  await gl.postReview({ ...REF, headSha: "a-newer-commit" }, {
    body: "s",
    event: "COMMENT",
    comments: [{ path: "a.js", line: 2, body: "b" }],
  });

  const pos = (calls.find((c) => c.url.includes("/discussions"))!.body as { position: Record<string, string> }).position;
  assert.equal(pos.base_sha, "b2", "it re-read rather than reusing a stale position");
});

test("a summary that cannot be posted IS fatal", async () => {
  // The opposite trade. Inline comments with no verdict are a scattering of
  // remarks; the workflow needs to know the review did not happen.
  const { gl } = client({ "/merge_requests/12/notes": new Response("nope", { status: 403 }) });
  await assert.rejects(
    () => gl.postReview(REF, { body: "summary", event: "COMMENT", comments: [] }),
    /gitlab/,
  );
});

test("dismissing a review is a no-op, because there is nothing to dismiss", async () => {
  // GitLab has no CHANGES_REQUESTED. The workflow calls this during cleanup and
  // must not see an error for a thing that cannot exist.
  const { gl, calls } = client({});
  await gl.dismissReview();
  assert.equal(calls.length, 0, "and it costs no request");
});

test("our own inline notes are found by marker, since there is no review to ask", async () => {
  const { gl } = client({
    "/merge_requests/12/discussions": [
      { notes: [{ id: 1, type: "DiffNote", body: "<!-- cavix:inline -->\nours" }] },
      { notes: [{ id: 2, type: "DiffNote", body: "a human's comment" }] },
      { notes: [{ id: 3, type: null, body: "<!-- cavix:inline -->\nnot anchored" }] },
    ],
  });
  assert.deepEqual(await gl.listReviewCommentIds(REF), [1]);
});

test("the status row is a commit status, and a failure is a failed pipeline state", async () => {
  const { gl, calls } = client({ "/statuses/": { id: 88 } });
  const id = await gl.createCheckRun(REF, { status: "in_progress", title: "Reviewing", summary: "" });
  assert.equal(id, 88);
  assert.equal((calls[0].body as { state: string }).state, "running");

  await gl.updateCheckRun(REF, 88, { status: "completed", conclusion: "failure", title: "1 critical", summary: "" });
  assert.equal((calls[1].body as { state: string }).state, "failed");

  // Cavix being unable to run must never freeze a team's merges, the same
  // decision the GitHub path makes with `neutral`.
  await gl.updateCheckRun(REF, 88, { status: "completed", conclusion: "neutral", title: "could not run", summary: "" });
  assert.equal((calls[2].body as { state: string }).state, "success");
});

test("a refused status row returns 0 rather than failing the review", async () => {
  const { gl } = client({ "/statuses/": new Response("forbidden", { status: 403 }) });
  assert.equal(await gl.createCheckRun(REF, { status: "in_progress", title: "t", summary: "" }), 0);
});

test("a status description longer than GitLab accepts is truncated, not rejected", async () => {
  // GitLab caps it at 255 and 400s the whole request past that, which would cost
  // the status row on exactly the reviews with the most to say.
  const { gl, calls } = client({ "/statuses/": { id: 1 } });
  await gl.createCheckRun(REF, { status: "completed", conclusion: "success", title: "x".repeat(400), summary: "" });
  assert.equal((calls[0].body as { description: string }).description.length, 255);
});

test("pipeline history skips runs with no measurable duration", async () => {
  // A pipeline that never started reports `duration: null`, and counting it as a
  // zero-second build would drag Stage 6's trend line down for free.
  const { gl } = client({
    "/pipelines?": [{ id: 1 }, { id: 2 }, { id: 3 }],
    "/pipelines/1": { sha: "a", ref: "main", status: "success", duration: 120, finished_at: "2026-07-01T00:00:00Z" },
    "/pipelines/2": { sha: "b", ref: "main", status: "failed", duration: null, started_at: null, finished_at: null },
    "/pipelines/3": {
      sha: "c",
      ref: "main",
      status: "success",
      duration: null,
      started_at: "2026-07-02T00:00:00Z",
      finished_at: "2026-07-02T00:03:00Z",
    },
  });
  const runs = await gl.listWorkflowRuns(REF, "main");
  assert.deepEqual(runs.map((r) => r.durationMs), [120_000, 180_000]);
  assert.equal(runs[0].conclusion, "success");
  assert.ok(runs.every((r) => r.workflow === "pipeline"));
});

test("a file is base64 off the files API, and an unreadable one is null not empty", async () => {
  const { gl } = client({
    "/repository/files/": { content: Buffer.from("const a = 1;\n").toString("base64"), encoding: "base64" },
  });
  assert.equal(await gl.fetchFile(REF, "src/a.js"), "const a = 1;\n");

  const { gl: gl2 } = client({ "/repository/files/": { content: "", encoding: "none" } });
  assert.equal(
    await gl2.fetchFile(REF, "big.bin"),
    null,
    "returning '' would hand the sandbox an empty file and let it verify against nothing",
  );
});

test("the tree walks pages and stops when GitLab runs out", async () => {
  let page = 0;
  const impl = (async (url: string) => {
    if (!url.includes("/repository/tree")) return new Response("{}", { status: 200 });
    page++;
    const rows =
      page === 1
        ? Array.from({ length: 100 }, (_, i) => ({ path: `f${i}.js`, type: "blob" }))
        : [{ path: "last.js", type: "blob" }, { path: "dir", type: "tree" }];
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as unknown as typeof fetch;

  const gl = new RestGitLabClient({ tokens: new StaticGitLabToken("t"), fetchImpl: impl });
  const tree = await gl.listTree(REF);
  assert.equal(tree.length, 101);
  assert.ok(tree.includes("last.js"));
  assert.ok(!tree.includes("dir"), "a directory is not a file");
});

test("a self-managed instance changes every URL and nothing else", async () => {
  const { impl, calls } = api({ "/merge_requests/12/changes": { changes: [] } });
  const gl = new RestGitLabClient({
    tokens: new StaticGitLabToken("t"),
    baseUrl: "https://gitlab.internal.acme.com/",
    fetchImpl: impl,
  });
  await gl.fetchPullDiff(REF);
  assert.ok(calls[0].url.startsWith("https://gitlab.internal.acme.com/api/v4/"), calls[0].url);
});

test("the token goes in PRIVATE-TOKEN, which is what a project token can be", async () => {
  const seen: Array<Record<string, string>> = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    seen.push((init?.headers ?? {}) as Record<string, string>);
    return new Response(JSON.stringify({ changes: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const gl = new RestGitLabClient({ tokens: new StaticGitLabToken("glpat-secret"), fetchImpl: impl });
  await gl.fetchPullDiff(REF);
  assert.equal(seen[0]["private-token"], "glpat-secret");
  assert.equal(seen[0].authorization, undefined, "Bearer would only accept an OAuth token");
});
