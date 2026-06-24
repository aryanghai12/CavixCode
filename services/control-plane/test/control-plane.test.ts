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

const post = (base: string, path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

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
    await post(base, "/api/reviews", {
      org: "acme", repo: "widget", pr: 7, title: "fix",
      findings: [{ path: "a.js", line: 1, severity: "high", category: "security", title: "x", body: "", source: "sast", confidence: 0.9 }],
    });
    const reviews = await (await fetch(base + "/api/reviews?org=acme")).json();
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].findings.length, 1);
  });
});

test("decisions: accept/reject is recorded (the learning-loop signal)", async () => {
  await withServer(async (base) => {
    const review = await (await post(base, "/api/reviews", {
      org: "acme", repo: "widget", pr: 9, title: "t",
      findings: [
        { path: "a.js", line: 1, severity: "high", category: "security", title: "sqli", body: "", source: "sast", confidence: 0.9 },
        { path: "b.js", line: 2, severity: "low", category: "standards", title: "nit", body: "", source: "llm", confidence: 0.5, agent: "standards" },
      ],
    })).json();

    const accepted = review.findings[0].id;
    const rejected = review.findings[1].id;

    const r1 = await post(base, `/api/findings/${accepted}/decision`, { state: "accepted", user: "alice" });
    assert.equal(r1.status, 200);
    const r2 = await post(base, `/api/findings/${rejected}/decision`, { state: "rejected", user: "bob" });
    assert.equal(r2.status, 200);

    const decisions = await (await fetch(base + "/api/decisions")).json();
    assert.equal(decisions.length, 2);
    const byFinding = Object.fromEntries(decisions.map((d: { findingId: string; state: string }) => [d.findingId, d.state]));
    assert.equal(byFinding[accepted], "accepted");
    assert.equal(byFinding[rejected], "rejected");
  });
});

test("decisions: invalid state and unknown finding are rejected", async () => {
  await withServer(async (base) => {
    assert.equal((await post(base, "/api/findings/none/decision", { state: "maybe" })).status, 400);
    assert.equal((await post(base, "/api/findings/none/decision", { state: "accepted" })).status, 404);
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
