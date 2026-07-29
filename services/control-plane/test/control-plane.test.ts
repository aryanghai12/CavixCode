import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, InMemoryStore, renderDashboardHtml } from "@cavix/control-plane";
import { readJson } from "./http.ts";

async function withServer(fn: (base: string, store: InMemoryStore) => Promise<void>) {
  const store = new InMemoryStore();
  const server = createControlPlane(store);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const post = (base: string, path: string, body: unknown, cookie?: string) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

/**
 * Sign up and return the session cookie. Reviews carry findings from private
 * repositories, so reading or deciding on them needs a member of the workspace.
 */
async function signIn(base: string, org: string, email = `owner@${org}.test`): Promise<string> {
  const res = await post(base, "/api/auth/signup", { email, password: "password123", org, name: "Owner" });
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

test("onboarding: create org + repo", async () => {
  await withServer(async (base) => {
    const org = await readJson(await post(base, "/api/orgs", { name: "acme" }));
    assert.equal(org.name, "acme");
    const repo = await readJson(await post(base, "/api/orgs/acme/repos", { name: "widget" }));
    assert.equal(repo.org, "acme");
    assert.equal(repo.name, "widget");
  });
});

test("reviews: save a review and list it", async () => {
  await withServer(async (base) => {
    const cookie = await signIn(base, "acme");
    // This is the round trip the orchestrator makes after it posts a review, and
    // the only reason the dashboard has anything on it.
    const saved = await post(base, "/api/reviews", {
      org: "acme", repo: "widget", pr: 7, title: "fix",
      url: "https://github.com/acme/widget/pull/7",
      findings: [{ path: "a.js", line: 1, severity: "high", category: "security", title: "x", body: "", source: "sast", confidence: 0.9 }],
    }, cookie);
    assert.equal(saved.status, 201);

    const reviews = await readJson(await fetch(base + "/api/reviews?org=acme", { headers: { cookie } }));
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].findings.length, 1);
    assert.equal(reviews[0].url, "https://github.com/acme/widget/pull/7", "the dashboard row links back to the PR");
  });
});

test("reviews: a workspace's findings are not readable by anyone who names its org", async () => {
  await withServer(async (base) => {
    const acme = await signIn(base, "acme");
    await post(base, "/api/reviews", {
      org: "acme", repo: "secret-repo", pr: 1, title: "t",
      findings: [{ path: "a.js", line: 1, severity: "critical", category: "security", title: "leaked", body: "", source: "llm", confidence: 0.9 }],
    }, acme);

    // Anonymous, and a signed-in member of a different workspace.
    assert.equal((await fetch(base + "/api/reviews?org=acme")).status, 401);
    const other = await signIn(base, "rival");
    assert.equal((await fetch(base + "/api/reviews?org=acme", { headers: { cookie: other } })).status, 403);
    const own = await readJson(await fetch(base + "/api/reviews", { headers: { cookie: other } }));
    assert.deepEqual(own, [], "a workspace with no reviews sees its own emptiness, not someone else's data");
  });
});

test("reviews: recording needs the service token once one is configured", async () => {
  process.env.CAVIX_INTERNAL_TOKEN = "s3cret";
  await withServer(async (base) => {
    const body = { org: "acme", repo: "acme/widget", pr: 1, title: "t", findings: [] };
    assert.equal((await post(base, "/api/reviews", body)).status, 401, "no credential at all is refused");

    const asService = await fetch(base + "/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
      body: JSON.stringify(body),
    });
    assert.equal(asService.status, 201, "the orchestrator authenticates as a service, not as a user");
  });
  delete process.env.CAVIX_INTERNAL_TOKEN;
});

test("reviews: a review link that is not plain https is dropped, never stored", async () => {
  await withServer(async (base) => {
    const cookie = await signIn(base, "acme");
    const saved = await readJson(
      post(
        base,
        "/api/reviews",
        { org: "acme", repo: "widget", pr: 3, title: "t", url: "javascript:alert(document.cookie)", findings: [] },
        cookie,
      ),
    );
    assert.equal(saved.url, undefined);
  });
});

test("decisions: accept/reject is recorded (the learning-loop signal)", async () => {
  await withServer(async (base) => {
    const cookie = await signIn(base, "acme", "alice@acme.test");
    const review = await readJson(await post(base, "/api/reviews", {
      org: "acme", repo: "widget", pr: 9, title: "t",
      findings: [
        { path: "a.js", line: 1, severity: "high", category: "security", title: "sqli", body: "", source: "sast", confidence: 0.9 },
        { path: "b.js", line: 2, severity: "low", category: "standards", title: "nit", body: "", source: "llm", confidence: 0.5, agent: "standards" },
      ],
    }, cookie));

    const accepted = review.findings[0].id;
    const rejected = review.findings[1].id;

    const r1 = await post(base, `/api/findings/${accepted}/decision`, { state: "accepted" }, cookie);
    assert.equal(r1.status, 200);
    const r2 = await post(base, `/api/findings/${rejected}/decision`, { state: "rejected" }, cookie);
    assert.equal(r2.status, 200);

    const decisions = await readJson(await fetch(base + "/api/decisions", { headers: { cookie } }));
    assert.equal(decisions.length, 2);
    const byFinding = Object.fromEntries(decisions.map((d: { findingId: string; state: string }) => [d.findingId, d.state]));
    assert.equal(byFinding[accepted], "accepted");
    assert.equal(byFinding[rejected], "rejected");
    // Attribution comes from the session, so a decision can never be filed under
    // a colleague's name by a client that simply asks to.
    assert.equal((await readJson(r1)).decision.user, "alice@acme.test");
  });
});

test("decisions: a decision needs a member of the workspace that owns the finding", async () => {
  await withServer(async (base) => {
    const cookie = await signIn(base, "acme");
    const review = await readJson(await post(base, "/api/reviews", {
      org: "acme", repo: "widget", pr: 9, title: "t",
      findings: [{ path: "a.js", line: 1, severity: "high", category: "security", title: "sqli", body: "", source: "sast", confidence: 0.9 }],
    }, cookie));
    const id = review.findings[0].id;

    assert.equal((await post(base, `/api/findings/${id}/decision`, { state: "accepted" })).status, 401);
    const other = await signIn(base, "rival");
    assert.equal((await post(base, `/api/findings/${id}/decision`, { state: "accepted" }, other)).status, 403);
  });
});

// Two pages read list endpoints that used to answer for the whole platform:
// Billing (`/api/orgs`) and Learnings (`/api/decisions`). Both showed other
// customers' data, and Learnings showed it under a heading calling it yours.

test("billing: /api/orgs answers for your workspace, not every customer", async () => {
  await withServer(async (base) => {
    const acme = await signIn(base, "acme");
    await signIn(base, "rival");

    assert.equal((await fetch(base + "/api/orgs")).status, 401);
    const mine = await readJson(await fetch(base + "/api/orgs", { headers: { cookie: acme } }));
    assert.equal(mine.length, 1);
    assert.equal(mine[0].name, "acme");
  });
});

test("learnings: /api/decisions answers for your workspace only", async () => {
  await withServer(async (base) => {
    const acme = await signIn(base, "acme", "alice@acme.test");
    const rival = await signIn(base, "rival", "bob@rival.test");

    for (const [org, cookie] of [["acme", acme], ["rival", rival]] as const) {
      const rev = await readJson(await post(base, "/api/reviews", {
        org, repo: "r", pr: 1, title: "t",
        findings: [{ path: "a.js", line: 1, severity: "high", category: "security", title: `${org} finding`, body: "", source: "llm", confidence: 0.9 }],
      }, cookie));
      await post(base, `/api/findings/${rev.findings[0].id}/decision`, { state: "accepted" }, cookie);
    }

    assert.equal((await fetch(base + "/api/decisions")).status, 401);
    const mine = await readJson(await fetch(base + "/api/decisions", { headers: { cookie: rival } }));
    assert.equal(mine.length, 1, "one workspace, one decision: not the platform's");
    assert.equal(mine[0].user, "bob@rival.test");
  });
});

test("decisions: invalid state and unknown finding are rejected", async () => {
  await withServer(async (base) => {
    const cookie = await signIn(base, "acme");
    assert.equal((await post(base, "/api/findings/none/decision", { state: "maybe" }, cookie)).status, 400);
    assert.equal((await post(base, "/api/findings/none/decision", { state: "accepted" }, cookie)).status, 404);
  });
});

test("free tier: onboards public repos only, and rejects private", async () => {
  await withServer(async (base) => {
    await post(base, "/api/orgs", { name: "oss", tier: "free", provenFeedOptIn: true });
    const pub = await post(base, "/api/orgs/oss/repos", { name: "lib", visibility: "public" });
    assert.equal(pub.status, 201);
    const priv = await post(base, "/api/orgs/oss/repos", { name: "secret", visibility: "private" });
    assert.equal(priv.status, 403, "free tier cannot onboard private repos");
  });
});

test("free tier: rate limit returns 429 once the daily quota is exceeded", async () => {
  process.env.CAVIX_FREE_REVIEWS_PER_DAY = "2";
  await withServer(async (base) => {
    await post(base, "/api/orgs", { name: "oss", tier: "free" });
    const review = { org: "oss", repo: "lib", pr: 1, title: "t", findings: [] };
    assert.equal((await post(base, "/api/reviews", review)).status, 201);
    assert.equal((await post(base, "/api/reviews", review)).status, 201);
    assert.equal((await post(base, "/api/reviews", review)).status, 429, "third review over the free quota");
  });
  delete process.env.CAVIX_FREE_REVIEWS_PER_DAY;
});

test("proven-catches feed: only verified findings from opted-in public repos", async () => {
  await withServer(async (base) => {
    await post(base, "/api/orgs", { name: "oss", tier: "free", provenFeedOptIn: true });
    await post(base, "/api/orgs/oss/repos", { name: "lib", visibility: "public" });
    await post(base, "/api/reviews", {
      org: "oss", repo: "lib", pr: 5, title: "t",
      findings: [
        { path: "a.js", line: 1, severity: "high", category: "security", title: "verified sqli", body: "", source: "llm", confidence: 0.9, verified: true },
        { path: "b.js", line: 2, severity: "low", category: "standards", title: "unverified nit", body: "", source: "llm", confidence: 0.5, verified: false },
      ],
    });
    const feed = await readJson(await fetch(base + "/api/feed/proven"));
    assert.equal(feed.length, 1, "only the verified finding is published");
    assert.equal(feed[0].title, "verified sqli");
  });
});

test("proven feed excludes private repos even when opted in", async () => {
  await withServer(async (base) => {
    await post(base, "/api/orgs", { name: "co", tier: "paid", provenFeedOptIn: true });
    await post(base, "/api/orgs/co/repos", { name: "app", visibility: "private" });
    await post(base, "/api/reviews", { org: "co", repo: "app", pr: 1, title: "t", findings: [{ path: "a", line: 1, severity: "high", category: "security", title: "secret bug", body: "", source: "llm", confidence: 0.9, verified: true }] });
    const feed = await readJson(await fetch(base + "/api/feed/proven"));
    assert.equal(feed.length, 0, "private repo never leaks to the public feed");
  });
});

test("dashboard HTML renders findings with accept/reject controls", () => {
  const store = new InMemoryStore();
  const rec = store.saveReview({ org: "acme", repo: "w", pr: 1, title: "t", findings: [
    { path: "a.js", line: 1, severity: "high", category: "security", title: "sqli", body: "", source: "sast", confidence: 0.9 },
  ]});
  const html = renderDashboardHtml([rec]);
  assert.match(html, /Accept/);
  assert.match(html, /Reject/);
  assert.match(html, /sqli/);
});
