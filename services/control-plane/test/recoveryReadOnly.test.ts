import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, InMemoryStore } from "@cavix/control-plane";

// The gate main.ts closes while Postgres is still being recovered in the
// background. Recovery ends in store.restore(), which DISCARDS whatever
// accumulated in memory, so a write accepted during that window is silently
// thrown away a few seconds later — the exact shape of the workspace-vanishing
// bug the persistence work exists to stop. Reads have to keep working, because
// the site staying up is why the server listens before recovery finishes.
async function withServer(
  readOnly: () => boolean,
  fn: (base: string, store: InMemoryStore) => Promise<void>,
) {
  const store = new InMemoryStore();
  const server = createControlPlane(store, { readOnly });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const signup = (base: string) =>
  fetch(base + "/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@acme.test", password: "cavixdemo", org: "acme" }),
  });

test("recovering: a signup is refused with a retryable 503, not accepted into a doomed store", async () => {
  await withServer(() => true, async (base, store) => {
    const res = await signup(base);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "15");
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /recovered/);
    // The point of the 503: nothing reached the store.
    assert.equal(store.isEmpty(), true);
  });
});

test("recovering: the site still reads, so a deploy mid-recovery is not a dark site", async () => {
  await withServer(() => true, async (base) => {
    assert.equal((await fetch(base + "/healthz")).status, 200);
    assert.equal((await fetch(base + "/api/auth/providers")).status, 200);
    assert.equal((await fetch(base + "/")).status, 200);
  });
});

test("recovering: the OAuth GETs redirect rather than writing a token that is about to be discarded", async () => {
  await withServer(() => true, async (base) => {
    for (const [path, dest] of [
      ["/api/auth/github/start", "/login?error=recovering"],
      ["/api/auth/github/callback", "/login?error=recovering"],
      ["/api/github/connect", "/app/repositories?error=recovering"],
      ["/api/github/setup", "/app/repositories?error=recovering"],
    ]) {
      const res = await fetch(base + path, { redirect: "manual" });
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.get("location"), dest, path);
    }
  });
});

test("once recovery settles the gate lifts and writes are accepted again", async () => {
  let recovering = true;
  await withServer(() => recovering, async (base, store) => {
    assert.equal((await signup(base)).status, 503);
    recovering = false;
    const res = await signup(base);
    assert.equal(res.status, 201);
    assert.equal(store.isEmpty(), false);
  });
});

// The write hiding inside a read.
//
// GET /api/github/status looks like a pure read and is fetched as JSON by the
// dashboard on every visit to the Repositories page. It is not: it resolves a
// live token first, and an expired one is renewed and written back. GitHub
// rotates the refresh token when it is spent, so a refresh that lands during
// recovery leaves the snapshot's copy dead — restore then hands the user a
// refresh token GitHub will never honour again, and the only way out is to
// reconnect from scratch. Refusing the request is what keeps the stored
// credential the one that still works.
test("recovering: a GET that would refresh an expired token is refused, and the stored token is untouched", async () => {
  process.env.CAVIX_GITHUB_CLIENT_ID = "abc";
  process.env.CAVIX_GITHUB_CLIENT_SECRET = "def";
  // Signing in is itself a write, so the session is established BEFORE the gate
  // closes — this test is about the reads that follow, not about login.
  let recovering = false;
  try {
    await withServer(() => recovering, async (base, store) => {
      store.createOrg("acme", { tier: "paid" });
      const user = store.createUser({
        email: "owner@acme.test", name: "Owner", password: "cavixdemo", org: "acme", role: "owner",
      });
      const expired = {
        accessToken: "gho_expired",
        refreshToken: "ghr_original",
        expiresAt: Date.now() - 60_000,
      };
      store.setOAuthToken(user.id, expired);

      const login = await fetch(base + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@acme.test", password: "cavixdemo" }),
      });
      assert.equal(login.status, 200);
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

      recovering = true;
      for (const path of ["/api/github/status", "/api/github/installations", "/api/github/orgs", "/api/github/repos"]) {
        const res = await fetch(base + path, { headers: { cookie } });
        assert.equal(res.status, 503, path);
        assert.equal(res.headers.get("retry-after"), "15", path);
      }

      // The credential GitHub still accepts is exactly the one that was stored.
      assert.deepEqual(store.getOAuthToken(user.id), expired);

      // And it is a gate, not a permanent 404: the same read works once the
      // store is the durable record again.
      recovering = false;
      const after = await fetch(base + "/api/github/status", { headers: { cookie } });
      assert.equal(after.status, 200);
    });
  } finally {
    delete process.env.CAVIX_GITHUB_CLIENT_ID;
    delete process.env.CAVIX_GITHUB_CLIENT_SECRET;
  }
});
