import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, InMemoryStore, renderDashboardHtml } from "@cavix/control-plane";

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
    const org = await (await post(base, "/api/orgs", { name: "acme" })).json();
    assert.equal(org.name, "acme");
    const repo = await (await post(base, "/api/orgs/acme/repos", { name: "widget" })).json();
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

    const reviews = await (await fetch(base + "/api/reviews?org=acme", { headers: { cookie } })).json();
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
    const own = await (await fetch(base + "/api/reviews", { headers: { cookie: other } })).json();
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
    const saved = await (await post(base, "/api/reviews", {
      org: "acme", repo: "widget", pr: 3, title: "t",
      url: "javascript:alert(document.cookie)",
      findings: [],
    }, cookie)).json();
    assert.equal(saved.url, undefined);
  });
});

test("decisions: accept/reject is recorded (the learning-loop signal)", async () => {
  await withServer(async (base) => {
    const cookie = await signIn(base, "acme", "alice@acme.test");
    const review = await (await post(base, "/api/reviews", {
      org: "acme", repo: "widget", pr: 9, title: "t",
      findings: [
        { path: "a.js", line: 1, severity: "high", category: "security", title: "sqli", body: "", source: "sast", confidence: 0.9 },
        { path: "b.js", line: 2, severity: "low", category: "standards", title: "nit", body: "", source: "llm", confidence: 0.5, agent: "standards" },
      ],
    }, cookie)).json();

    const accepted = review.findings[0].id;
    const rejected = review.findings[1].id;

    const r1 = await post(base, `/api/findings/${accepted}/decision`, { state: "accepted" }, cookie);
    assert.equal(r1.status, 200);
    const r2 = await post(base, `/api/findings/${rejected}/decision`, { state: "rejected" }, cookie);
    assert.equal(r2.status, 200);

    const decisions = await (await fetch(base + "/api/decisions")).json();
    assert.equal(decisions.length, 2);
    const byFinding = Object.fromEntries(decisions.map((d: { findingId: string; state: string }) => [d.findingId, d.state]));
    assert.equal(byFinding[accepted], "accepted");
    assert.equal(byFinding[rejected], "rejected");
    // Attribution comes from the session, so a decision can never be filed under
    // a colleague's name by a client that simply asks to.
    assert.equal((await r1.json()).decision.user, "alice@acme.test");
  });
});

test("decisions: a decision needs a member of the workspace that owns the finding", async () => {
  await withServer(async (base) => {
    const cookie = await signIn(base, "acme");
    const review = await (await post(base, "/api/reviews", {
      org: "acme", repo: "widget", pr: 9, title: "t",
      findings: [{ path: "a.js", line: 1, severity: "high", category: "security", title: "sqli", body: "", source: "sast", confidence: 0.9 }],
    }, cookie)).json();
    const id = review.findings[0].id;

    assert.equal((await post(base, `/api/findings/${id}/decision`, { state: "accepted" })).status, 401);
    const other = await signIn(base, "rival");
    assert.equal((await post(base, `/api/findings/${id}/decision`, { state: "accepted" }, other)).status, 403);
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
    const feed = await (await fetch(base + "/api/feed/proven")).json();
    assert.equal(feed.length, 1, "only the verified finding is published");
    assert.equal(feed[0].title, "verified sqli");
  });
});

test("proven feed excludes private repos even when opted in", async () => {
  await withServer(async (base) => {
    await post(base, "/api/orgs", { name: "co", tier: "paid", provenFeedOptIn: true });
    await post(base, "/api/orgs/co/repos", { name: "app", visibility: "private" });
    await post(base, "/api/reviews", { org: "co", repo: "app", pr: 1, title: "t", findings: [{ path: "a", line: 1, severity: "high", category: "security", title: "secret bug", body: "", source: "llm", confidence: 0.9, verified: true }] });
    const feed = await (await fetch(base + "/api/feed/proven")).json();
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
