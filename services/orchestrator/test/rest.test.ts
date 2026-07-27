import { test } from "node:test";
import assert from "node:assert/strict";
import { RestGitHubClient, StaticTokenProvider } from "../src/github/rest.ts";
import type { PullRef } from "../src/github/client.ts";

// RestGitHubClient is the REAL transport: every reaction, comment, diff fetch and
// posted review goes through here. The FakeGitHubClient used elsewhere satisfies
// the interface but proves nothing about URLs, headers or request bodies — so a
// wrong reactions path would pass the whole suite and simply never show an emoji.

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function client(respond: (c: Captured) => Response) {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const c: Captured = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    return respond(c);
  }) as unknown as typeof fetch;
  const gh = new RestGitHubClient({ tokens: new StaticTokenProvider("tok-123"), fetchImpl });
  return { gh, calls };
}

const REF: PullRef = { owner: "aryan-ghai", repo: "my-repo", number: 7, headSha: "c0ffee", installationId: 9182 };
const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("addReaction posts to the issue-comment reactions endpoint", async () => {
  const { gh, calls } = client(() => ok({ id: 1 }, 201));
  await gh.addReaction(REF, 998877, "eyes");

  assert.equal(calls[0].url, "https://api.github.com/repos/aryan-ghai/my-repo/issues/comments/998877/reactions");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { content: "eyes" });
  assert.equal(calls[0].headers.authorization, "Bearer tok-123");
  assert.equal(calls[0].headers["x-github-api-version"], "2022-11-28");
});

test("addReaction treats 200 (already reacted) as success, not an error", async () => {
  const { gh } = client(() => ok({ id: 1 }, 200));
  await assert.doesNotReject(() => gh.addReaction(REF, 1, "rocket"));
});

test("addReaction surfaces a real failure", async () => {
  const { gh } = client(() => new Response("no access", { status: 403 }));
  await assert.rejects(() => gh.addReaction(REF, 1, "eyes"), /403/);
});

test("createComment posts to the issue comments endpoint", async () => {
  const { gh, calls } = client(() => ok({ id: 5001, html_url: "https://github.com/x#issuecomment-5001" }, 201));
  const res = await gh.createComment(REF, "Cavix could not finish this review.");

  assert.equal(calls[0].url, "https://api.github.com/repos/aryan-ghai/my-repo/issues/7/comments");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { body: "Cavix could not finish this review." });
  assert.equal(res.id, 5001);
});

test("getPull reads the head SHA a command job is missing", async () => {
  const { gh, calls } = client(() =>
    ok({ title: "Add login", draft: false, state: "open", head: { sha: "abc123" }, base: { sha: "base456" } }),
  );
  const meta = await gh.getPull({ ...REF, headSha: "" });

  assert.equal(calls[0].url, "https://api.github.com/repos/aryan-ghai/my-repo/pulls/7");
  assert.equal(meta.headSha, "abc123");
  assert.equal(meta.baseSha, "base456");
  assert.equal(meta.title, "Add login");
});

test("fetchPullDiff asks for the diff media type", async () => {
  const { gh, calls } = client(() => new Response("diff --git a/x b/x", { status: 200 }));
  const diff = await gh.fetchPullDiff(REF);
  assert.equal(calls[0].headers.accept, "application/vnd.github.diff");
  assert.match(diff, /^diff --git/);
});

test("postReview sends commit_id when the head SHA is known", async () => {
  const { gh, calls } = client(() => ok({ id: 11, html_url: "u" }, 200));
  await gh.postReview(REF, { body: "summary", event: "COMMENT", comments: [] });

  const body = calls[0].body as Record<string, unknown>;
  assert.equal(body.commit_id, "c0ffee");
  assert.equal(body.event, "COMMENT");
});

// Regression: sending commit_id:"" is a 422 from GitHub. Command jobs arrive with
// no SHA, so the field must be OMITTED rather than sent empty.
test("postReview OMITS commit_id entirely when the head SHA is unknown", async () => {
  const { gh, calls } = client(() => ok({ id: 11, html_url: "u" }, 200));
  await gh.postReview({ ...REF, headSha: "" }, { body: "s", event: "COMMENT", comments: [] });

  const body = calls[0].body as Record<string, unknown>;
  assert.ok(!("commit_id" in body), 'commit_id must be absent, not ""');
});

test("postReview anchors inline comments on the RIGHT side of the diff", async () => {
  const { gh, calls } = client(() => ok({ id: 11, html_url: "u" }, 200));
  await gh.postReview(REF, {
    body: "s",
    event: "COMMENT",
    comments: [{ path: "src/auth.js", line: 12, body: "SQL injection" }],
  });

  const body = calls[0].body as { comments: Array<Record<string, unknown>> };
  assert.deepEqual(body.comments[0], { path: "src/auth.js", line: 12, side: "RIGHT", body: "SQL injection" });
});

test("a failed review post reports the status and GitHub's explanation", async () => {
  const { gh } = client(() => new Response('{"message":"Validation Failed"}', { status: 422 }));
  await assert.rejects(() => gh.postReview(REF, { body: "s", event: "COMMENT", comments: [] }), /422.*Validation Failed/s);
});
