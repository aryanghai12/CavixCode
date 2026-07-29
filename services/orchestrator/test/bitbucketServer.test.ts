import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff } from "@cavix/core";
import { RestBitbucketServerClient } from "@cavix/orchestrator";
import type { PullRef } from "../src/github/client.ts";

// Bitbucket Server / Data Center, which shares nothing with Bitbucket Cloud but
// the name. These tests exist to prove that: every path, every payload shape and
// every state vocabulary below differs from the Cloud client's, which is why it
// is a separate class rather than a baseUrl.

const REF: PullRef = { owner: "PAY", repo: "billing", number: 7, headSha: "head1", installationId: 0 };

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function api(routes: Record<string, unknown>) {
  const calls: Call[] = [];
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

function client(routes: Record<string, unknown> = {}) {
  const { impl, calls } = api(routes);
  return {
    bs: new RestBitbucketServerClient({
      tokens: { token: async () => "t" },
      baseUrl: "https://bitbucket.acme.com",
      fetchImpl: impl,
    }),
    calls,
  };
}

test("it is a different product from Cloud, and says so in its capabilities", () => {
  const { bs } = client();
  assert.equal(bs.platform, "bitbucket-server");
  // /files pages the whole repository, unlike Cloud's directory-at-a-time /src.
  assert.equal(bs.capabilities.treeListing, true);
  // No built-in pipeline product, so there is no build DURATION to trend.
  assert.equal(bs.capabilities.ciHistory, false);
  // A reviewer can be NEEDS_WORK and a merge check can require none are.
  assert.equal(bs.capabilities.blockingReview, true);
  assert.equal(bs.capabilities.reactions, false);
});

test("commands are refused, exactly as on Cloud and for the same reason", async () => {
  const { bs } = client();
  assert.equal(await bs.commandsAllowed(), false);
});

test("the API path is projects/KEY/repos/slug, not Cloud's workspace/slug", async () => {
  const raw = `diff --git a/src/a.js b/src/a.js
--- a/src/a.js
+++ b/src/a.js
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
`;
  const { bs, calls } = client({ "/pull-requests/7.diff": raw });
  const files = parseUnifiedDiff(await bs.fetchPullDiff(REF));
  assert.deepEqual(files.map((f) => f.path), ["src/a.js"]);
  assert.match(calls[0].url, /\/rest\/api\/1\.0\/projects\/PAY\/repos\/billing\/pull-requests\/7\.diff/);
  // contextLines is pinned: the server default is configurable per install, and
  // a 0 would strip the context every anchor is positioned against.
  assert.match(calls[0].url, /contextLines=3/);
});

test("a personal project lives under /users, not /projects", async () => {
  const { bs, calls } = client({ ".diff": "" });
  await bs.fetchPullDiff({ ...REF, owner: "~dev" });
  assert.match(calls[0].url, /\/rest\/api\/1\.0\/users\/dev\/repos\/billing\//);
});

test("getPull maps Data Center's vocabulary onto the one the workflow speaks", async () => {
  const { bs } = client({
    "/pull-requests/7": {
      title: "Add y",
      description: "author text",
      state: "OPEN",
      fromRef: { latestCommit: "head1" },
      toRef: { latestCommit: "base1", displayId: "develop" },
    },
  });
  const meta = await bs.getPull(REF);
  assert.equal(meta.headSha, "head1");
  assert.equal(meta.baseSha, "base1");
  assert.equal(meta.baseRef, "develop");
  assert.equal(meta.state, "open");
  assert.equal(meta.body, "author text");
  assert.equal(meta.draft, false, "Data Center has no draft state; false is honest, not guessed");
});

test("updating the description echoes the title AND the version, so nothing is blanked or clobbered", async () => {
  // Sending the description alone blanks the title, which is the same trap Cloud
  // has. The version is optimistic locking: a stale one 409s rather than racing
  // somebody's concurrent edit.
  const { bs, calls } = client({
    "/pull-requests/7": { title: "Keep me", version: 4 },
  });
  await bs.updatePullBody(REF, "new body");
  const put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(put?.body, { title: "Keep me", description: "new body", version: 4 });
});

test("a review is a summary comment then anchored comments, in Data Center's own anchor shape", async () => {
  const { bs, calls } = client({ "/pull-requests/7/comments": { id: 55 } });
  const posted = await bs.postReview(REF, {
    body: "SUMMARY",
    event: "COMMENT",
    comments: [{ path: "src/a.js", line: 12, body: "FINDING" }],
  });
  assert.equal(posted.id, 55);
  assert.match(posted.htmlUrl, /\/projects\/PAY\/repos\/billing\/pull-requests\/7\/overview$/);

  const posts = calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 2);
  // `text`, not Cloud's `content: {raw}`.
  assert.deepEqual(posts[0].body, { text: "SUMMARY" });
  assert.deepEqual(posts[1].body, {
    text: "FINDING",
    // `anchor`, not Cloud's `inline: {path, to}`. ADDED must agree with the
    // line, or the server rejects the comment outright.
    anchor: { path: "src/a.js", line: 12, lineType: "ADDED", fileType: "TO" },
  });
});

test("comments are found through the activity feed, which is the only place they live", async () => {
  const { bs } = client({
    "/pull-requests/7/activities": {
      values: [
        { action: "OPENED" },
        { action: "COMMENTED", comment: { id: 1, text: "someone else" } },
        { action: "COMMENTED", comment: { id: 2, text: "<!-- cavix:review -->\n## Cavix Review" } },
        {
          action: "COMMENTED",
          commentAnchor: { path: "a.js", line: 3 },
          comment: { id: 3, text: "<!-- cavix:inline -->\nfinding" },
        },
      ],
    },
  });
  assert.deepEqual(await bs.findComment(REF, "<!-- cavix:review -->"), { id: 2 });
  assert.deepEqual(await bs.listOwnReviews(REF), [{ id: 2, state: "CHANGES_REQUESTED" }]);
  // Only the ANCHORED one is an inline comment; the summary body stays, exactly
  // as a GitHub review body does.
  assert.deepEqual(await bs.listReviewCommentIds(REF), [3]);
});

test("deleting a comment sends its current version, so a concurrent edit is refused not clobbered", async () => {
  const { bs, calls } = client({ "/comments/3": { id: 3, version: 9 } });
  await bs.deleteReviewComment(REF, 3);
  const del = calls.find((c) => c.method === "DELETE");
  assert.match(del?.url ?? "", /\/comments\/3\?version=9$/);
});

test("the build status lives outside the core API and reports SUCCESSFUL when Cavix could not run", async () => {
  const { bs, calls } = client({ "/rest/build-status/1.0/commits/": { ok: true } });
  const id = await bs.createCheckRun(REF, { status: "in_progress", title: "Reviewing", summary: "" });
  assert.equal(id, 1, "keyed by (commit, key) rather than returning an id");
  await bs.updateCheckRun(REF, id, {
    status: "completed",
    conclusion: "neutral",
    title: "Review could not be completed",
    summary: "",
  });
  const posts = calls.filter((c) => c.url.includes("/rest/build-status/1.0/commits/head1"));
  assert.equal(posts.length, 2);
  assert.equal((posts[0].body as { state: string }).state, "INPROGRESS");
  // An outage of ours must never freeze a team's merges.
  assert.equal((posts[1].body as { state: string }).state, "SUCCESSFUL");
});

test("the tree listing pages until the server says it is done", async () => {
  let page = 0;
  const impl = (async (url: string) => {
    if (!url.includes("/files")) return new Response("{}", { status: 200 });
    page++;
    return new Response(
      JSON.stringify(
        page === 1
          ? { values: ["a.ts", "b.ts"], isLastPage: false, nextPageStart: 2 }
          : { values: ["c.ts"], isLastPage: true },
      ),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const bs = new RestBitbucketServerClient({
    tokens: { token: async () => "t" },
    baseUrl: "https://bitbucket.acme.com",
    fetchImpl: impl,
  });
  assert.deepEqual(await bs.listTree(REF), ["a.ts", "b.ts", "c.ts"]);
});

test("who we are comes from the X-AUSERNAME response header, not a /user endpoint", async () => {
  const impl = (async () =>
    new Response("{}", { status: 200, headers: { "x-ausername": "cavix-bot" } })) as unknown as typeof fetch;
  const bs = new RestBitbucketServerClient({
    tokens: { token: async () => "t" },
    baseUrl: "https://bitbucket.acme.com",
    fetchImpl: impl,
  });
  assert.deepEqual(await bs.whoAmI(), { kind: "user", login: "cavix-bot" });
});

test("an anonymous response is reported as unknown, never as a login called anonymous", async () => {
  const impl = (async () =>
    new Response("{}", { status: 200, headers: { "x-ausername": "anonymous" } })) as unknown as typeof fetch;
  const bs = new RestBitbucketServerClient({
    tokens: { token: async () => "t" },
    baseUrl: "https://bitbucket.acme.com",
    fetchImpl: impl,
  });
  assert.deepEqual(await bs.whoAmI(), { kind: "unknown", login: "" });
});
