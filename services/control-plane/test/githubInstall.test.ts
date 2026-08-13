import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, InMemoryStore } from "@cavix/control-plane";
import { readJson } from "./http.ts";

// The install flow: the door that actually has a repository picker on it.
//
// Everything here guards the distinction the old flow got wrong. "Continue with
// GitHub" runs the AUTHORIZATION grant, which is about the person and has no
// repository picker anywhere on it; once granted, GitHub honours it and returns
// immediately, which is what "it never asks me anything" actually was. Repository
// consent lives in the INSTALLATION grant, and that screen re-renders every time
// because an installation is a configuration rather than a one-time exchange.

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
const cookieFrom = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

async function configured(fn: () => Promise<void>): Promise<void> {
  process.env.CAVIX_GITHUB_CLIENT_ID = "abc";
  process.env.CAVIX_GITHUB_CLIENT_SECRET = "def";
  try {
    await fn();
  } finally {
    delete process.env.CAVIX_GITHUB_CLIENT_ID;
    delete process.env.CAVIX_GITHUB_CLIENT_SECRET;
  }
}

const stateOf = (res: Response): string =>
  new URL(res.headers.get("location") ?? "http://x/").searchParams.get("state") ?? "";

test("connect: an unconfigured deployment says so instead of sending people to a 404", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/api/github/connect", { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /error=github_unconfigured/);
  });
});

test("connect: sends the user to the INSTALL screen, not the authorize screen", async () => {
  await configured(async () => {
    await withServer(async (base, store) => {
      const res = await fetch(base + "/api/github/connect", { redirect: "manual" });
      assert.equal(res.status, 302);
      const loc = res.headers.get("location") ?? "";

      assert.match(loc, /github\.com\/apps\/[^/]+\/installations\/new/);
      assert.doesNotMatch(loc, /login\/oauth\/authorize/);

      const state = stateOf(res);
      assert.ok(state.length >= 16, "a real state, not a placeholder");
      assert.match(res.headers.get("set-cookie") ?? "", new RegExp(`gh_state=${state}`));

      // Stored server-side as well as in the cookie: the cookie does not always
      // survive the hop back, and a callback that cannot prove which session it
      // belongs to has to be rejected rather than guessed at.
      assert.ok(store.takeOAuthState(state));
      assert.equal(store.takeOAuthState(state), null, "single use");
    });
  });
});

test("connect: a chosen account is carried through, so nobody picks it twice", async () => {
  await configured(async () => {
    await withServer(async (base, store) => {
      const res = await fetch(
        base + "/api/github/connect?target=acme-inc&target_id=99&target_type=Organization",
        { redirect: "manual" },
      );
      const loc = res.headers.get("location") ?? "";
      assert.match(loc, /installations\/new\/permissions/);
      assert.match(loc, /target_id=99/);
      assert.equal(store.takeOAuthState(stateOf(res))?.target, "acme-inc");
    });
  });
});

test("connect: an off-site next destination is refused", async () => {
  await configured(async () => {
    await withServer(async (base, store) => {
      // GitHub hands this value straight back, so an absolute URL here is an open
      // redirect fired at somebody who has just proved they are signed in.
      const res = await fetch(base + "/api/github/connect?next=https://evil.example/steal", {
        redirect: "manual",
      });
      assert.equal(store.takeOAuthState(stateOf(res))?.next, undefined);
    });
  });
});

test("connect: an on-site next destination survives", async () => {
  await configured(async () => {
    await withServer(async (base, store) => {
      const res = await fetch(base + "/api/github/connect?next=/app/reviews", { redirect: "manual" });
      assert.equal(store.takeOAuthState(stateOf(res))?.next, "/app/reviews");
    });
  });
});

test("setup: a forged callback is rejected and the cookie is cleared", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/api/github/setup?state=forged&installation_id=1", {
      redirect: "manual",
      headers: { cookie: "gh_state=forged" },
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /error=github_state/);
    assert.match(res.headers.get("set-cookie") ?? "", /gh_state=;/);
  });
});

test("setup: a real state from a different browser is rejected", async () => {
  await configured(async () => {
    await withServer(async (base) => {
      const start = await fetch(base + "/api/github/connect", { redirect: "manual" });
      const res = await fetch(base + `/api/github/setup?state=${stateOf(start)}&installation_id=1`, {
        redirect: "manual",
        headers: { cookie: "gh_state=somebody-elses" },
      });
      assert.match(res.headers.get("location") ?? "", /error=github_state/);
    });
  });
});

test("setup: a state cannot be replayed", async () => {
  await configured(async () => {
    await withServer(async (base) => {
      const start = await fetch(base + "/api/github/connect", { redirect: "manual" });
      const state = stateOf(start);
      const cookie = `gh_state=${state}`;
      const first = await fetch(base + `/api/github/setup?state=${state}`, { redirect: "manual", headers: { cookie } });
      // Nobody signed in and no code, so it asks them to sign in. What matters
      // here is that the state is now spent.
      assert.match(first.headers.get("location") ?? "", /\/login/);
      const replay = await fetch(base + `/api/github/setup?state=${state}`, { redirect: "manual", headers: { cookie } });
      assert.match(replay.headers.get("location") ?? "", /error=github_state/);
    });
  });
});

test("setup: a spoofed installation_id attaches nothing", async () => {
  await configured(async () => {
    await withServer(async (base, store) => {
      store.createOrg("acme");
      const u = store.createUser({
        email: "u@acme.co",
        password: "password123",
        org: "acme",
        name: "U",
        role: "owner",
      });
      const start = await fetch(base + "/api/github/connect", { redirect: "manual" });
      const state = stateOf(start);
      // Bind the pending round trip to a real user, then arrive claiming an
      // installation id nobody verified. GitHub's own documentation warns that
      // "bad actors can hit this URL with a spoofed installation_id", and the
      // only proof is enumerating what the user can actually see.
      store.putOAuthState({ state, uid: u.id, kind: "install", createdAt: Date.now() });
      const res = await fetch(base + `/api/github/setup?state=${state}&installation_id=999999`, {
        redirect: "manual",
        headers: { cookie: `gh_state=${state}` },
      });
      assert.equal(res.status, 302);
      assert.equal(store.listInstallations("acme").length, 0, "nothing was attached on an unverified claim");
    });
  });
});

test("status: signed in with nothing installed is its own state, not 'connected'", async () => {
  await withServer(async (base, store) => {
    store.createOrg("acme");
    store.createUser({ email: "u@acme.co", password: "password123", org: "acme", name: "U", role: "owner" });
    const cookie = cookieFrom(await post(base, "/api/auth/login", { email: "u@acme.co", password: "password123" }));

    const before = await readJson(await fetch(base + "/api/github/status", { headers: { cookie } }));
    assert.equal(before.hasInstallation, false);
    assert.deepEqual(before.installations, []);
    assert.equal(before.connectUrl, "/api/github/connect");

    store.saveInstallation({
      id: 55,
      org: "acme",
      accountLogin: "acme",
      accountId: 1,
      accountType: "Organization",
      repositorySelection: "all",
      htmlUrl: "https://github.com/organizations/acme/settings/installations/55",
      suspended: false,
      repos: [{ id: 1, fullName: "acme/api", private: true }],
      updatedAt: "2026-08-01T00:00:00.000Z",
    });

    const after = await readJson(await fetch(base + "/api/github/status", { headers: { cookie } }));
    assert.equal(after.hasInstallation, true);
    assert.equal(after.installations.length, 1);
    // "all" means repositories created in future are automatically in scope, and
    // the difference has to reach the UI: inferring reach from a repository
    // snapshot instead gets that case permanently wrong.
    assert.equal(after.installations[0].repositorySelection, "all");
    assert.equal(after.installations[0].repoCount, 1);
    assert.match(after.installations[0].configureUrl, /installations\/55$/);
  });
});

test("disconnect: clears the credential and the installations, and says what it did not do", async () => {
  await withServer(async (base, store) => {
    store.createOrg("acme");
    store.createUser({ email: "u@acme.co", password: "password123", org: "acme", name: "U", role: "owner" });
    const cookie = cookieFrom(await post(base, "/api/auth/login", { email: "u@acme.co", password: "password123" }));
    store.saveInstallation({
      id: 55,
      org: "acme",
      accountLogin: "acme",
      accountId: 1,
      accountType: "Organization",
      repositorySelection: "selected",
      htmlUrl: "https://github.com/organizations/acme/settings/installations/55",
      suspended: false,
      repos: [{ id: 1, fullName: "acme/api", private: true }],
      updatedAt: "2026-08-01T00:00:00.000Z",
    });

    const body = await readJson(await post(base, "/api/github/disconnect", {}, cookie));
    assert.equal(body.ok, true);
    // Revoking the authorization does NOT uninstall the App. Somebody who
    // believes it did thinks Cavix has lost access that it still has.
    assert.match(body.note, /still be installed/i);
    assert.equal(store.listInstallations("acme").length, 0);
  });
});

// ---------- the store's half of the contract ----------

const INSTALL = {
  id: 9,
  org: "acme",
  accountLogin: "acme",
  accountId: 1,
  accountType: "Organization" as const,
  repositorySelection: "selected" as const,
  htmlUrl: "https://github.com/x/9",
  suspended: false,
};

test("an installation payload older than what is stored is discarded", () => {
  const store = new InMemoryStore();
  store.saveInstallation({
    ...INSTALL,
    repos: [{ id: 1, fullName: "acme/api", private: true }],
    updatedAt: "2026-08-02T00:00:00.000Z",
  });
  // Webhook deliveries arrive out of order and are redelivered. Applying an
  // older one silently reverts the repository set, and nothing would say so.
  const stale = store.saveInstallation({ ...INSTALL, repos: [], updatedAt: "2026-08-01T00:00:00.000Z" });
  assert.equal(stale, null);
  assert.equal(store.getInstallation(9)?.repos.length, 1);
});

test("repository deltas add and remove by numeric id", () => {
  const store = new InMemoryStore();
  store.saveInstallation({
    ...INSTALL,
    repos: [{ id: 1, fullName: "acme/api", private: true }],
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  const next = store.updateInstallationRepos(
    9,
    [{ id: 2, fullName: "acme/web", private: false }],
    [1],
    "2026-08-03T00:00:00.000Z",
  );
  // Keyed by GitHub's numeric id, never by owner/name: a rename orphans a
  // name-keyed row and mints a second one with no history behind it.
  assert.deepEqual(next?.repos.map((r) => r.id), [2]);
});

test("an expired round trip is not accepted", () => {
  const store = new InMemoryStore();
  store.putOAuthState({ state: "old", uid: null, kind: "install", createdAt: Date.now() - 60 * 60 * 1000 });
  assert.equal(store.takeOAuthState("old"), null);
});

test("installations survive a snapshot round trip", () => {
  const store = new InMemoryStore();
  store.saveInstallation({
    ...INSTALL,
    repos: [{ id: 1, fullName: "acme/api", private: true }],
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  const restored = new InMemoryStore();
  restored.restore(store.snapshot());
  assert.equal(restored.listInstallations("acme").length, 1);
  assert.equal(restored.getInstallation(9)?.repositorySelection, "selected");
});
