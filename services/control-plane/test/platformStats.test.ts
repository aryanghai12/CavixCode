import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, InMemoryStore } from "@cavix/control-plane";

// The founder console's numbers. These drive real decisions (who to call before
// their trial lapses, who signed up but never got a key in), so they have to be
// right rather than merely present.

function seeded(): InMemoryStore {
  const store = new InMemoryStore();

  // A paying customer, actively reviewing.
  store.createOrg("paying", { tier: "paid" });
  store.createUser({ email: "a@paying.dev", password: "password123", name: "A", org: "paying" });
  store.createUser({ email: "b@paying.dev", password: "password123", name: "B", org: "paying" });
  store.setApiKey("paying", "sk-real-key");
  store.createRepo("paying", "paying/api", { visibility: "private" });
  store.saveReview({
    org: "paying", repo: "paying/api", pr: 1, title: "t",
    findings: [
      { path: "a.ts", line: 1, severity: "high", category: "security", title: "x", body: "", source: "llm", confidence: 0.9, verified: true },
      { path: "a.ts", line: 2, severity: "low", category: "style", title: "y", body: "", source: "llm", confidence: 0.4 },
    ],
  });

  // A trial that is about to lapse — the call the founder needs to make.
  store.createOrg("trialing", { tier: "free" });
  store.createUser({ email: "c@trialing.dev", password: "password123", name: "C", org: "trialing" });
  store.startTrial("trialing", 3);

  // Signed up, connected a repo, never added a key: every review will fail.
  store.createOrg("stalled", { tier: "free" });
  store.createUser({ email: "d@stalled.dev", password: "password123", name: "D", org: "stalled" });
  store.createRepo("stalled", "stalled/site", { visibility: "public" });

  return store;
}

test("platformStats counts people, orgs, trials, usage and estimated revenue", () => {
  process.env.CAVIX_PRICE_PER_SEAT = "12";
  const s = seeded().platformStats();

  assert.equal(s.users.total, 4);
  assert.equal(s.users.new7d, 4, "everyone just signed up in this fixture");

  assert.equal(s.orgs.total, 3);
  assert.equal(s.orgs.paid, 1);
  assert.equal(s.orgs.free, 2);
  assert.equal(s.orgs.trialActive, 1);
  assert.equal(s.orgs.trialExpiring7d, 1, "the 3-day trial is the one to chase");
  assert.equal(s.orgs.withApiKey, 1);
  assert.equal(s.orgs.activeLast7d, 1, "only one org has actually run a review");

  assert.equal(s.repos.total, 2);
  assert.equal(s.repos.private, 1);
  assert.equal(s.repos.public, 1);

  assert.equal(s.reviews.total, 1);
  assert.equal(s.reviews.last24h, 1);
  assert.equal(s.reviews.perDay14.length, 14);
  assert.equal(s.reviews.perDay14[13], 1, "today is the last bucket");

  assert.equal(s.findings.total, 2);
  assert.equal(s.findings.verified, 1);

  // Estimate, not billing: 2 seats in the one paid, non-trial org.
  assert.equal(s.revenue.paidSeats, 2);
  assert.equal(s.revenue.estimatedMrr, 24);
  assert.equal(s.revenue.trialSeats, 1, "the trialing org's seat is pipeline, not revenue");
  assert.equal(s.revenue.pipelineMrr, 12);
  delete process.env.CAVIX_PRICE_PER_SEAT;
});

test("listOrgsAdmin surfaces the operator's per-org signals", () => {
  process.env.CAVIX_FREE_REVIEWS_PER_DAY = "25";
  const rows = seeded().listOrgsAdmin();

  const paying = rows.find((o) => o.name === "paying")!;
  assert.equal(paying.members, 2);
  assert.equal(paying.repos, 1);
  assert.equal(paying.reviewsToday, 1);
  assert.equal(paying.apiKeySet, true);
  assert.equal(paying.verifyFindings, true);
  assert.ok(paying.lastActivityAt, "we know when they last used it");

  const trialing = rows.find((o) => o.name === "trialing")!;
  assert.equal(trialing.trialActive, true);
  assert.equal(trialing.trialDaysLeft, 3);

  // The support case the console exists to catch.
  const stalled = rows.find((o) => o.name === "stalled")!;
  assert.equal(stalled.apiKeySet, false);
  assert.equal(stalled.lastActivityAt, undefined);
  assert.equal(stalled.usagePct, 0);
  delete process.env.CAVIX_FREE_REVIEWS_PER_DAY;
});

test("the admin stats endpoint is platform-admin only", async () => {
  process.env.CAVIX_ADMIN_EMAILS = "founder@cavix.dev";
  const store = new InMemoryStore();
  const server = createControlPlane(store);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signup = (email: string, org: string) =>
    fetch(base + "/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "password123", name: "N", org }) });
  try {
    assert.equal((await fetch(base + "/api/admin/stats")).status, 401, "anonymous is refused");

    const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
    const civilian = cookieOf(await signup("someone@else.dev", "else"));
    assert.equal((await fetch(base + "/api/admin/stats", { headers: { cookie: civilian } })).status, 403);

    const founder = cookieOf(await signup("founder@cavix.dev", "ops"));
    const res = await fetch(base + "/api/admin/stats", { headers: { cookie: founder } });
    assert.equal(res.status, 200);
    const stats = await res.json();
    assert.equal(typeof stats.users.total, "number");
    assert.equal(typeof stats.revenue.estimatedMrr, "number");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.CAVIX_ADMIN_EMAILS;
  }
});
