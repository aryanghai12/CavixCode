import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, InMemoryStore, isPlatformAdmin } from "@cavix/control-plane";

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
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const cookieFrom = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

// ---------- store: effective review limit ----------

test("effectiveReviewsPerDay: tier default, override, trial, and suspend", () => {
  const store = new InMemoryStore();
  store.createOrg("free-org", { tier: "free" });
  store.createOrg("paid-org", { tier: "paid" });
  process.env.CAVIX_FREE_REVIEWS_PER_DAY = "25";

  assert.equal(store.effectiveReviewsPerDay("free-org"), 25, "free tier default");
  assert.ok(store.effectiveReviewsPerDay("paid-org") >= 1000000, "paid tier effectively unlimited");

  // founder override beats the tier
  store.setReviewLimitOverride("free-org", 200);
  assert.equal(store.effectiveReviewsPerDay("free-org"), 200);
  store.setReviewLimitOverride("free-org", null);
  assert.equal(store.effectiveReviewsPerDay("free-org"), 25, "override cleared → back to tier");

  // an active trial lifts a free org to paid limits
  store.startTrial("free-org", 14);
  assert.ok(store.effectiveReviewsPerDay("free-org") >= 1000000, "trial grants paid limits");
  store.endTrial("free-org");
  assert.equal(store.effectiveReviewsPerDay("free-org"), 25);

  // suspension blocks reviews entirely
  store.setSuspended("paid-org", true);
  assert.equal(store.effectiveReviewsPerDay("paid-org"), 0, "suspended → 0");
  delete process.env.CAVIX_FREE_REVIEWS_PER_DAY;
});

test("isPlatformAdmin honors CAVIX_ADMIN_EMAILS", () => {
  process.env.CAVIX_ADMIN_EMAILS = "founder@cavix.dev, cofounder@cavix.dev";
  assert.equal(isPlatformAdmin("founder@cavix.dev"), true);
  assert.equal(isPlatformAdmin("FOUNDER@CAVIX.DEV"), true, "case-insensitive");
  assert.equal(isPlatformAdmin("random@user.com"), false);
  delete process.env.CAVIX_ADMIN_EMAILS;
});

// ---------- admin API access control ----------

test("admin API: only platform admins may access it", async () => {
  process.env.CAVIX_ADMIN_EMAILS = "founder@cavix.dev";
  await withServer(async (base, store) => {
    store.createOrg("acme");
    store.createUser({ email: "founder@cavix.dev", password: "password123", org: "acme", name: "F", role: "owner" });
    store.createUser({ email: "user@acme.co", password: "password123", org: "acme", name: "U", role: "owner" });

    // unauthenticated → 401
    assert.equal((await fetch(base + "/api/admin/orgs")).status, 401);

    // a normal (non-admin) owner → 403
    const userCookie = cookieFrom(await post(base, "/api/auth/login", { email: "user@acme.co", password: "password123" }));
    assert.equal((await fetch(base + "/api/admin/orgs", { headers: { cookie: userCookie } })).status, 403);

    // the founder → 200
    const adminCookie = cookieFrom(await post(base, "/api/auth/login", { email: "founder@cavix.dev", password: "password123" }));
    const list = await fetch(base + "/api/admin/orgs", { headers: { cookie: adminCookie } });
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(await list.json()));

    // /me tells the UI who is an admin
    const me = await (await fetch(base + "/api/auth/me", { headers: { cookie: adminCookie } })).json();
    assert.equal(me.user.platformAdmin, true);
  });
  delete process.env.CAVIX_ADMIN_EMAILS;
});

test("admin API: change tier, start trial, override limit, suspend — and enforce it", async () => {
  process.env.CAVIX_ADMIN_EMAILS = "founder@cavix.dev";
  process.env.CAVIX_FREE_REVIEWS_PER_DAY = "2";
  await withServer(async (base, store) => {
    store.createOrg("startup", { tier: "free" });
    store.createUser({ email: "founder@cavix.dev", password: "password123", org: "ops", name: "F", role: "owner" });
    const admin = cookieFrom(await post(base, "/api/auth/login", { email: "founder@cavix.dev", password: "password123" }));

    // override the free org's limit up to 5
    let res = await post(base, "/api/admin/orgs/startup", { reviewsPerDay: 5 }, admin);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).effectiveReviewsPerDay, 5);

    // upgrade to paid tier
    res = await post(base, "/api/admin/orgs/startup", { tier: "paid" }, admin);
    assert.equal((await res.json()).tier, "paid");

    // clear the override, start a 7-day trial
    await post(base, "/api/admin/orgs/startup", { reviewsPerDay: null, trialDays: 7 }, admin);
    const view = (await (await fetch(base + "/api/admin/orgs", { headers: { cookie: admin } })).json()).find((o) => o.name === "startup");
    assert.equal(view.trialActive, true);

    // suspend it → reviews are blocked with 429
    await post(base, "/api/admin/orgs/startup", { suspended: true }, admin);
    const blocked = await post(base, "/api/reviews", { org: "startup", repo: "r", pr: 1, title: "t", findings: [] });
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).error, /suspended/);

    // unsuspend → reviews flow again
    await post(base, "/api/admin/orgs/startup", { suspended: false }, admin);
    assert.equal((await post(base, "/api/reviews", { org: "startup", repo: "r", pr: 2, title: "t", findings: [] })).status, 201);
  });
  delete process.env.CAVIX_ADMIN_EMAILS;
  delete process.env.CAVIX_FREE_REVIEWS_PER_DAY;
});
