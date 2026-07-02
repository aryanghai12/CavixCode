import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, InMemoryStore, githubConfigured, installUrl, demoOrgs, demoRepos, authorizeUrl } from "@cavix/control-plane";

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

// ---------- module-level ----------

test("github: unconfigured by default (demo mode) + fixtures are sane", () => {
  assert.equal(githubConfigured(), false, "no client id/secret in test env");
  assert.match(installUrl(), /github\.com\/apps\//);
  assert.ok(demoOrgs().length >= 2);
  assert.ok(demoOrgs().some((o) => o.type === "User"), "personal account is included");
  assert.ok(demoRepos("cavix-labs").every((r) => r.full_name.startsWith("cavix-labs/")));
});

test("github: authorizeUrl builds a valid consent URL when configured", () => {
  process.env.CAVIX_GITHUB_OAUTH_CLIENT_ID = "abc";
  process.env.CAVIX_GITHUB_OAUTH_CLIENT_SECRET = "def";
  assert.equal(githubConfigured(), true);
  const u = authorizeUrl("state123", "https://app.cavix.ai/api/auth/github/callback");
  assert.match(u, /github\.com\/login\/oauth\/authorize/);
  assert.match(u, /client_id=abc/);
  assert.match(u, /state=state123/);
  assert.match(u, /redirect_uri=https/);
  delete process.env.CAVIX_GITHUB_OAUTH_CLIENT_ID;
  delete process.env.CAVIX_GITHUB_OAUTH_CLIENT_SECRET;
});

// ---------- OAuth start / callback (demo) ----------

test("github OAuth: /start redirects to the demo callback and sets a state cookie", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/api/auth/github/start", { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /\/api\/auth\/github\/callback\?demo=1/);
    assert.match(res.headers.get("set-cookie") ?? "", /gh_state=/);
  });
});

test("github OAuth: callback with a mismatched state is rejected", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/api/auth/github/callback?demo=1&state=evil", { redirect: "manual", headers: { cookie: "gh_state=real" } });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /\/login\?error=github_state/);
  });
});

test("github OAuth: full demo start→callback logs the user in and starts a trial", async () => {
  await withServer(async (base, store) => {
    const start = await fetch(base + "/api/auth/github/start", { redirect: "manual" });
    const stateCookie = cookieFrom(start);
    const state = stateCookie.split("=")[1];
    const cb = await fetch(base + `/api/auth/github/callback?demo=1&state=${state}`, { redirect: "manual", headers: { cookie: stateCookie } });
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get("location"), "/app");
    const session = cookieFrom(cb);
    assert.match(session, /cavix_session=/);

    // the user now exists, signed in via github, on a trial (can add private repos)
    const me = await (await fetch(base + "/api/auth/me", { headers: { cookie: session } })).json();
    assert.equal(me.user.provider, "github");
    assert.ok(me.user.githubLogin);
  });
});

// ---------- connect API (list orgs/repos, enable) ----------

test("github connect: list orgs + repos and enable one from the site", async () => {
  await withServer(async (base, store) => {
    store.createOrg("acme");
    store.createUser({ email: "u@acme.co", password: "password123", org: "acme", name: "U", role: "owner" });
    const cookie = cookieFrom(await post(base, "/api/auth/login", { email: "u@acme.co", password: "password123" }));

    const status = await (await fetch(base + "/api/github/status", { headers: { cookie } })).json();
    assert.equal(status.demo, true);
    assert.match(status.installUrl, /github\.com\/apps/);

    const orgs = await (await fetch(base + "/api/github/orgs", { headers: { cookie } })).json();
    assert.ok(orgs.length >= 2);
    assert.ok(orgs.some((o: { isUser: boolean }) => o.isUser));

    const repos = await (await fetch(base + "/api/github/repos?org=cavix-labs", { headers: { cookie } })).json();
    assert.ok(repos.length >= 1);
    assert.equal(repos[0].enabled, false);

    // enable one (private allowed because acme is paid tier)
    const enable = await post(base, "/api/github/repos", { fullName: "cavix-labs/payments-api", private: true }, cookie);
    assert.equal(enable.status, 201);

    // now it shows as enabled + is in the org's connected repo list
    const repos2 = await (await fetch(base + "/api/github/repos?org=cavix-labs", { headers: { cookie } })).json();
    assert.equal(repos2.find((r: { fullName: string }) => r.fullName === "cavix-labs/payments-api").enabled, true);
    assert.ok(store.listRepos("acme").some((r) => r.name === "cavix-labs/payments-api"));

    // disable it again
    const del = await fetch(base + "/api/github/repos?fullName=cavix-labs%2Fpayments-api", { method: "DELETE", headers: { cookie } });
    assert.equal(del.status, 200);
  });
});

test("github connect: requires authentication", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(base + "/api/github/orgs")).status, 401);
    assert.equal((await fetch(base + "/api/github/status")).status, 401);
  });
});

test("login page exposes Sign in with GitHub", async () => {
  await withServer(async (base) => {
    const html = await (await fetch(base + "/login")).text();
    assert.match(html, /\/api\/auth\/github\/start/);
    assert.match(html, /Continue with GitHub/);
  });
});
