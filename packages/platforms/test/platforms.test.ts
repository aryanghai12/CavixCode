import { test } from "node:test";
import assert from "node:assert/strict";
import { makePlatform, type PullRef, type ReviewSubmission } from "@cavix/platforms";

const ref: PullRef = { project: "team", repo: "app", number: 7, commit: "abc123", baseCommit: "def456" };
const review: ReviewSubmission = {
  summary: "## Cavix review\n2 findings",
  comments: [{ path: "src/a.js", line: 12, body: "SQL injection" }],
};

function recorder() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ id: 99, html_url: "u", links: { html: { href: "u" } } }), { status: 201 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function authHeader(init: RequestInit): string {
  const h = init.headers as Record<string, string>;
  return h.authorization ?? h["private-token"] ?? "";
}

test("github: posts a review to the reviews endpoint with Bearer auth", async () => {
  const { calls, fetchImpl } = recorder();
  const r = await makePlatform("github", { token: "tok", fetchImpl }).postReview(ref, review);
  assert.match(calls[0].url, /\/repos\/team\/app\/pulls\/7\/reviews$/);
  assert.match(authHeader(calls[0].init), /^Bearer tok$/);
  assert.equal(r.inlinePosted, 1);
});

test("gitlab: posts a summary note + an inline discussion with PRIVATE-TOKEN", async () => {
  const { calls, fetchImpl } = recorder();
  const r = await makePlatform("gitlab", { token: "glpat", fetchImpl }).postReview(ref, review);
  assert.ok(calls.some((c) => /\/merge_requests\/7\/notes$/.test(c.url)), "summary note");
  const disc = calls.find((c) => /\/merge_requests\/7\/discussions$/.test(c.url))!;
  assert.ok(disc, "inline discussion");
  assert.equal(authHeader(disc.init), "glpat");
  assert.match(disc.init.body as string, /new_line/);
  assert.equal(r.inlinePosted, 1);
});

test("bitbucket-server (Data Center): posts comments to /rest/api/1.0 with an ADDED anchor", async () => {
  const { calls, fetchImpl } = recorder();
  const r = await makePlatform("bitbucket-server", { token: "pat", baseUrl: "https://bb.acme.io", fetchImpl }).postReview(ref, review);
  assert.ok(calls.every((c) => c.url.startsWith("https://bb.acme.io/rest/api/1.0/")));
  assert.ok(calls.some((c) => /pull-requests\/7\/comments$/.test(c.url)));
  const inline = calls[1];
  assert.match(inline.init.body as string, /"lineType":"ADDED"/);
  assert.match(authHeader(inline.init), /^Bearer pat$/);
  assert.equal(r.inlinePosted, 1);
});

test("bitbucket-server requires a baseUrl (self-hosted)", () => {
  assert.throws(() => makePlatform("bitbucket-server", { token: "x" }), /requires baseUrl/);
});

test("azure-devops: posts threads with Basic-PAT auth and a rightFile threadContext", async () => {
  const { calls, fetchImpl } = recorder();
  const azRef: PullRef = { ...ref, project: "org/proj" };
  const r = await makePlatform("azure-devops", { token: "azpat", fetchImpl }).postReview(azRef, review);
  assert.ok(calls.every((c) => /_apis\/git\/repositories\/app\/pullRequests\/7\/threads/.test(c.url)));
  assert.match(authHeader(calls[0].init), /^Basic /);
  const inline = calls[1];
  assert.match(inline.init.body as string, /threadContext/);
  assert.match(inline.init.body as string, /rightFileStart/);
  assert.equal(r.inlinePosted, 1);
});

test("bitbucket-cloud: posts inline comments with an inline anchor", async () => {
  const { calls, fetchImpl } = recorder();
  const r = await makePlatform("bitbucket-cloud", { token: "tok", fetchImpl }).postReview(ref, review);
  assert.ok(calls.every((c) => /\/pullrequests\/7\/comments$/.test(c.url)));
  assert.match(calls[1].init.body as string, /"inline"/);
  assert.equal(r.inlinePosted, 1);
});
