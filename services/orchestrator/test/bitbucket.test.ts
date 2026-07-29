import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff } from "@cavix/core";
import { RestBitbucketClient, StaticBitbucketToken } from "@cavix/orchestrator";
import type { PullRef } from "../src/github/client.ts";

// Bitbucket Cloud as the third platform. The point of this file is not that
// Bitbucket works; it is that the seam generalises past a lucky second, and that
// the places Bitbucket genuinely cannot keep up are declared rather than faked.

const REF: PullRef = { owner: "acme", repo: "widget", number: 7, headSha: "abc123", installationId: 0 };

function api(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const key = Object.keys(routes)
      .filter((k) => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return new Response("not found", { status: 404 });
    const value = routes[key];
    if (value instanceof Response) return value.clone();
    if (typeof value === "string") return new Response(value, { status: 200 });
    return new Response(JSON.stringify(value), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function client(routes: Record<string, unknown>) {
  const { impl, calls } = api(routes);
  return { bb: new RestBitbucketClient({ tokens: new StaticBitbucketToken("t"), fetchImpl: impl }), calls };
}

test("it declares what Bitbucket cannot do rather than pretending parity", () => {
  const { bb } = client({});
  assert.equal(bb.platform, "bitbucket");
  // No reaction API exists at all on a Bitbucket pull request comment.
  assert.equal(bb.capabilities.reactions, false);
  // /src pages one directory at a time: a repository map is one request per
  // directory, spent before a review is posted.
  assert.equal(bb.capabilities.treeListing, false);
  // Unlike GitLab, changes-requested is real here AND reversible, which is what
  // makes it dismissible.
  assert.equal(bb.capabilities.blockingReview, true);
});

test("the diff arrives ready to parse, with no reassembly", async () => {
  const raw = `diff --git a/src/a.js b/src/a.js
--- a/src/a.js
+++ b/src/a.js
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
`;
  const { bb } = client({ "/pullrequests/7/diff": raw });
  const files = parseUnifiedDiff(await bb.fetchPullDiff(REF));
  assert.deepEqual(files.map((f) => f.path), ["src/a.js"]);
});

test("getPull maps Bitbucket's vocabulary onto the one the workflow speaks", async () => {
  const { bb } = client({
    "/pullrequests/7": {
      title: "Add y",
      description: "author text",
      state: "OPEN",
      source: { commit: { hash: "head1" } },
      destination: { commit: { hash: "base1" }, branch: { name: "develop" } },
    },
  });
  const meta = await bb.getPull(REF);
  assert.equal(meta.state, "open", "Bitbucket says OPEN; the rest of Cavix says open");
  assert.equal(meta.headSha, "head1");
  assert.equal(meta.baseRef, "develop");
  // Bitbucket has no draft state on a pull request, so this is honestly false
  // rather than guessed from a title prefix.
  assert.equal(meta.draft, false);
});

test("updating the description echoes the title back, or Bitbucket blanks it", async () => {
  // The PR update endpoint takes the whole object. Sending description alone
  // clears the title, which is the one field the author cares most about.
  const { bb, calls } = client({
    "/pullrequests/7": {
      title: "Do not lose me",
      description: "old",
      state: "OPEN",
      source: { commit: { hash: "h" } },
      destination: { commit: { hash: "b" }, branch: { name: "main" } },
    },
  });
  await bb.updatePullBody(REF, "new body");
  const put = calls.find((c) => c.method === "PUT")!;
  assert.equal((put.body as { title: string }).title, "Do not lose me");
  assert.equal((put.body as { description: string }).description, "new body");
});

test("the review is a summary comment plus an inline comment per finding", async () => {
  const { bb, calls } = client({ "/pullrequests/7/comments": { id: 55 } });
  const posted = await bb.postReview(REF, {
    body: "## Cavix Review",
    event: "COMMENT",
    comments: [{ path: "src/a.js", line: 2, body: "finding" }],
  });
  assert.equal(posted.id, 55);
  assert.match(posted.htmlUrl, /bitbucket\.org\/acme\/widget\/pull-requests\/7$/);
  const inline = calls.filter((c) => c.method === "POST").at(-1)!;
  assert.deepEqual((inline.body as { inline: unknown }).inline, { path: "src/a.js", to: 2 });
});

test("a refused anchor costs the anchor, never the review", async () => {
  let first = true;
  const impl = (async (_url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return new Response("{}", { status: 200 });
    if (first) {
      first = false;
      return new Response(JSON.stringify({ id: 9 }), { status: 200 });
    }
    return new Response("bad anchor", { status: 400 });
  }) as unknown as typeof fetch;
  const bb = new RestBitbucketClient({ tokens: new StaticBitbucketToken("t"), fetchImpl: impl });
  const posted = await bb.postReview(REF, {
    body: "summary",
    event: "COMMENT",
    comments: [{ path: "a.js", line: 1, body: "x" }],
  });
  assert.equal(posted.id, 9, "the review still landed");
});

test("request-changes is posted only when the review asks to block, and is reversible", async () => {
  const { bb, calls } = client({ "/pullrequests/7/comments": { id: 1 }, "/request-changes": {} });
  await bb.postReview(REF, { body: "s", event: "REQUEST_CHANGES", comments: [] });
  assert.ok(calls.some((c) => c.method === "POST" && c.url.includes("/request-changes")));

  await bb.dismissReview(REF);
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url.includes("/request-changes")));
});

test("a plain comment review does not touch the blocking flag", async () => {
  const { bb, calls } = client({ "/pullrequests/7/comments": { id: 1 } });
  await bb.postReview(REF, { body: "s", event: "COMMENT", comments: [] });
  assert.equal(calls.some((c) => c.url.includes("/request-changes")), false);
});

test("our own inline comments are found by marker and by being inline", async () => {
  const { bb } = client({
    "/pullrequests/7/comments": {
      values: [
        { id: 1, inline: { path: "a.js" }, content: { raw: "<!-- cavix:inline -->\nours" } },
        { id: 2, inline: { path: "a.js" }, content: { raw: "a human's note" } },
        { id: 3, content: { raw: "<!-- cavix:inline -->\nnot inline" } },
      ],
    },
  });
  assert.deepEqual(await bb.listReviewCommentIds(REF), [1]);
});

test("the status row is a commit build status, and a failure is FAILED", async () => {
  const { bb, calls } = client({ "/statuses/build": {} });
  assert.equal(await bb.createCheckRun(REF, { status: "in_progress", title: "Reviewing", summary: "" }), 1);
  assert.equal((calls[0].body as { state: string }).state, "INPROGRESS");

  await bb.updateCheckRun(REF, 1, { status: "completed", conclusion: "failure", title: "1 critical", summary: "" });
  assert.equal((calls[1].body as { state: string }).state, "FAILED");

  // Cavix being unable to run must never freeze a team's merges. Same decision
  // as GitHub's `neutral` and GitLab's `success`.
  await bb.updateCheckRun(REF, 1, { status: "completed", conclusion: "neutral", title: "could not run", summary: "" });
  assert.equal((calls[2].body as { state: string }).state, "SUCCESSFUL");
});

test("a status description over the limit is truncated, not rejected", async () => {
  const { bb, calls } = client({ "/statuses/build": {} });
  await bb.createCheckRun(REF, { status: "completed", conclusion: "success", title: "x".repeat(400), summary: "" });
  assert.equal((calls[0].body as { description: string }).description.length, 140);
});

test("pipelines skip runs with no measurable duration", async () => {
  const { bb } = client({
    "/pipelines/": {
      values: [
        { state: { result: { name: "SUCCESSFUL" } }, target: { ref_name: "main", commit: { hash: "a" } }, duration_in_seconds: 120, completed_on: "2026-07-01T00:00:00Z" },
        { state: { name: "PENDING" }, target: { ref_name: "main" }, duration_in_seconds: 0 },
        { state: { result: { name: "FAILED" } }, target: { ref_name: "main", commit: { hash: "c" } }, duration_in_seconds: 30, completed_on: "2026-07-02T00:00:00Z" },
      ],
    },
  });
  const runs = await bb.listWorkflowRuns(REF, "main");
  assert.deepEqual(runs.map((r) => r.durationMs), [120_000, 30_000]);
  assert.deepEqual(runs.map((r) => r.conclusion), ["success", "failure"]);
});

test("commands are refused on Bitbucket, and that is the point", async () => {
  // Authorizing an arbitrary commenter needs workspace-admin scope a review bot
  // should not hold. A command path that cannot check permission lets anyone who
  // can comment spend a customer's model budget, which the GitLab session in
  // this repo already found once. Automatic reviews are unaffected.
  const { bb } = client({});
  assert.equal(await bb.commandsAllowed(), false);
});

test("the tree is empty rather than expensively wrong", async () => {
  const { bb, calls } = client({});
  assert.deepEqual(await bb.listTree(), []);
  assert.equal(calls.length, 0, "and it costs no request");
});
