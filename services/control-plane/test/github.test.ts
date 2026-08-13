import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { createControlPlane, InMemoryStore, githubConfigured, installUrl, configureUrl, pkce, demoOrgs, demoRepos, authorizeUrl, encryptSecret } from "@cavix/control-plane";
import { readJson, type Body } from "./http.ts";

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
  assert.match(installUrl(), /installations\/new/);
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

  // The account chooser, so a user with a personal and a work account is never
  // silently signed in as whichever GitHub saw last.
  assert.match(u, /prompt=select_account/);

  // NO scope parameter. A GitHub App user token does not use scopes, it uses the
  // App's registered fine-grained permissions, so GitHub discards this on
  // arrival. Sending "repo" here read like an access control and was not one,
  // and reading it as though it granted repository access is exactly the
  // confusion that made this flow look broken.
  assert.doesNotMatch(u, /[?&]scope=/);

  // PKCE when a challenge is supplied. GitHub strongly recommends it for this
  // flow and it costs one hash.
  const withPkce = authorizeUrl("state123", "https://app.cavix.ai/cb", "challenge123");
  assert.match(withPkce, /code_challenge=challenge123/);
  assert.match(withPkce, /code_challenge_method=S256/);

  delete process.env.CAVIX_GITHUB_OAUTH_CLIENT_ID;
  delete process.env.CAVIX_GITHUB_OAUTH_CLIENT_SECRET;
});

test("the authorize screen and the install screen are different doors", () => {
  // The distinction this whole flow turns on. GitHub: "You can install a GitHub
  // App without authorizing the app. Similarly, you can authorize the app
  // without installing the app." Authorization grants access to the PERSON and
  // has no repository picker on it at all. Installation grants access to
  // REPOSITORIES and always renders one.
  const signIn = authorizeUrl("s", "https://app.cavix.ai/cb");
  const connect = installUrl({ state: "s" });
  assert.match(signIn, /login\/oauth\/authorize/);
  assert.match(connect, /apps\/[^/]+\/installations\/new/);
  assert.notEqual(signIn, connect);
  assert.match(connect, /state=s/);
});

test("installUrl can pre-target an account, skipping the chooser", () => {
  const targeted = installUrl({ state: "s", targetId: 4242, targetType: "Organization" });
  assert.match(targeted, /installations\/new\/permissions/);
  assert.match(targeted, /target_id=4242/);
  assert.match(targeted, /target_type=Organization/);
});

test("configureUrl prefers what GitHub handed back, and never guesses over it", () => {
  // The path differs between a user account and an organisation, and a guess
  // that gets it wrong sends somebody to a 404 in the middle of the one flow
  // that matters.
  assert.equal(
    configureUrl({ id: 7, account: { login: "acme", type: "Organization" }, html_url: "https://github.com/x/7" }),
    "https://github.com/x/7",
  );
  assert.match(
    configureUrl({ id: 7, account: { login: "sam", type: "User" } }),
    /^https:\/\/github\.com\/settings\/installations\/7$/,
  );
  assert.match(
    configureUrl({ id: 7, account: { login: "acme", type: "Organization" } }),
    /^https:\/\/github\.com\/organizations\/acme\/settings\/installations\/7$/,
  );
});

test("pkce produces a verifier and a matching S256 challenge", () => {
  const a = pkce();
  const b = pkce();
  assert.notEqual(a.verifier, b.verifier, "a fresh verifier every time");
  assert.equal(createHash("sha256").update(a.verifier).digest("base64url"), a.challenge);
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
  await withServer(async (base) => {
    const start = await fetch(base + "/api/auth/github/start", { redirect: "manual" });
    const stateCookie = cookieFrom(start);
    const state = stateCookie.split("=")[1];
    const cb = await fetch(base + `/api/auth/github/callback?demo=1&state=${state}`, { redirect: "manual", headers: { cookie: stateCookie } });
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get("location"), "/app");
    const session = cookieFrom(cb);
    assert.match(session, /cavix_session=/);

    // the user now exists, signed in via github, on a trial (can add private repos)
    const me = await readJson(await fetch(base + "/api/auth/me", { headers: { cookie: session } }));
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

    const status = await readJson(await fetch(base + "/api/github/status", { headers: { cookie } }));
    assert.equal(status.demo, true);
    // A Cavix route, NOT a github.com link. The route mints and stores the state
    // that ties the install GitHub sends back to this session; a link straight to
    // github.com skips that, so nothing on the way back can be trusted.
    assert.equal(status.connectUrl, "/api/github/connect");
    assert.equal(status.hasInstallation, false);

    const orgs = await readJson(await fetch(base + "/api/github/orgs", { headers: { cookie } }));
    assert.ok(orgs.length >= 2);
    assert.ok(orgs.some((o: { isUser: boolean }) => o.isUser));

    const repos = await readJson(await fetch(base + "/api/github/repos?org=cavix-labs", { headers: { cookie } }));
    assert.ok(repos.length >= 1);
    assert.equal(repos[0].enabled, false);

    // enable one (private allowed because acme is paid tier)
    const enable = await post(base, "/api/github/repos", { fullName: "cavix-labs/payments-api", private: true }, cookie);
    assert.equal(enable.status, 201);

    // now it shows as enabled + is in the org's connected repo list
    const repos2 = await readJson(await fetch(base + "/api/github/repos?org=cavix-labs", { headers: { cookie } }));
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

test("auth providers endpoint reports availability (github off, demo boolean)", async () => {
  await withServer(async (base) => {
    const p = await readJson(await fetch(base + "/api/auth/providers"));
    assert.equal(p.github, false); // no OAuth env in tests
    assert.equal(typeof p.demo, "boolean");
  });
});

test("github start: demo disabled + no OAuth → clear error, never a fake login", async () => {
  process.env.CAVIX_DEMO = "false";
  await withServer(async (base) => {
    const res = await fetch(base + "/api/auth/github/start", { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /\/login\?error=github_unconfigured/);
  });
  delete process.env.CAVIX_DEMO;
});

test("login page hides the GitHub button by default (revealed by JS when available)", async () => {
  await withServer(async (base) => {
    const html = await (await fetch(base + "/login")).text();
    assert.match(html, /id="githubBtn" class="[^"]*hidden|btn-github btn-block hidden/);
  });
});

test("installations: lists orgs with install status + repos + enabled state (demo)", async () => {
  await withServer(async (base, store) => {
    store.createOrg("acme");
    store.createUser({ email: "u@acme.co", password: "password123", org: "acme", name: "U", role: "owner" });
    const cookie = cookieFrom(await post(base, "/api/auth/login", { email: "u@acme.co", password: "password123" }));

    const data = await readJson(await fetch(base + "/api/github/installations", { headers: { cookie } }));
    assert.equal(data.connectUrl, "/api/github/connect");
    const byLogin = Object.fromEntries(data.orgs.map((o: Body) => [o.login, o]));
    // demo: cavix-labs installed, acme-inc NOT installed (Install button case)
    assert.equal(byLogin["cavix-labs"].installed, true);
    assert.ok(byLogin["cavix-labs"].repos.length >= 1);
    assert.equal(byLogin["acme-inc"].installed, false);
    assert.equal(byLogin["acme-inc"].repos.length, 0);
    // nothing enabled yet
    assert.ok(byLogin["cavix-labs"].repos.every((r: Body) => r.enabled === false));

    // Every org row carries somewhere to go, and the two destinations are
    // different questions. Not installed goes to the install screen. Installed
    // goes to GitHub's configure page, which is the ONLY place an existing
    // installation's repository selection can be changed. Without the second
    // one there was no route back to the picker after the first install, which
    // is most of what "GitHub never asks me anything" actually was.
    assert.match(byLogin["acme-inc"].manageUrl, /^\/api\/github\/connect\?target=acme-inc$/);
    assert.match(byLogin["cavix-labs"].manageUrl, /github\.com.*installations\/\d+$/);
    assert.equal(byLogin["cavix-labs"].repositorySelection, "all");
    assert.equal(byLogin["acme-inc"].repositorySelection, null);
  });
});

// ---------- the credential lifecycle ----------
//
// A GitHub App's user token lives 8 hours. Cavix uses one App for both sign-in
// and installs, so without renewal every GitHub-backed page starts answering
// "GitHub API /user → 401" a working day after sign-in, and the dashboard
// reported that as though GitHub itself were down. These pin the three states a
// credential can be in: fresh, renewable, and spent.

/** Sign up, then plant a credential in whatever state the test needs. */
async function userWithToken(
  base: string,
  store: InMemoryStore,
  tokens: { accessToken: string; refreshToken?: string; expiresAt?: number },
): Promise<string> {
  store.createOrg("acme");
  const user = store.createUser({ email: "u@acme.co", password: "password123", org: "acme", name: "U", role: "owner" });
  store.setOAuthToken(user.id, tokens);
  return cookieFrom(await post(base, "/api/auth/login", { email: "u@acme.co", password: "password123" }));
}

test("tokens: a live credential round-trips, refresh half and all", async () => {
  const store = new InMemoryStore();
  store.createOrg("acme");
  const u = store.createUser({ email: "a@b.co", password: "password123", org: "acme", name: "A" });
  const expiresAt = Date.now() + 3600_000;
  store.setOAuthToken(u.id, { accessToken: "gho_live", refreshToken: "ghr_live", expiresAt });
  assert.deepEqual(store.getOAuthToken(u.id), { accessToken: "gho_live", refreshToken: "ghr_live", expiresAt });

  store.clearOAuthToken(u.id);
  assert.equal(store.getOAuthToken(u.id), null, "a cleared credential is gone, not stale");
});

test("tokens: a credential saved before refresh support still reads back", async () => {
  // Older deploys stored the bare access token. Those rows are in Postgres right
  // now, and reading them must not throw or sign the user out.
  const store = new InMemoryStore();
  store.createOrg("acme");
  const u = store.createUser({ email: "a@b.co", password: "password123", org: "acme", name: "A" });
  store.restore({ ...store.snapshot(), oauthTokens: [[u.id, encryptSecret("gho_legacy")]] });
  assert.deepEqual(store.getOAuthToken(u.id), { accessToken: "gho_legacy" });
});

test("tokens: an expired credential with nothing to renew from asks for a reconnect", async () => {
  process.env.CAVIX_DEMO = "false";
  process.env.CAVIX_GITHUB_CLIENT_ID = "iv1.test";
  process.env.CAVIX_GITHUB_CLIENT_SECRET = "shh";
  await withServer(async (base, store) => {
    const cookie = await userWithToken(base, store, { accessToken: "gho_stale", expiresAt: Date.now() - 1000 });

    // Not "connected": the credential GitHub would be handed is already dead.
    const status = await readJson(await fetch(base + "/api/github/status", { headers: { cookie } }));
    assert.equal(status.connected, false);
    assert.equal(status.demo, false, "a live site never invents repositories to fill the page");

    const res = await fetch(base + "/api/github/installations", { headers: { cookie } });
    const body = await readJson(res);
    assert.equal(res.status, 401);
    assert.equal(body.reconnect, true, "the dashboard needs to tell these apart from a dead session");
    assert.match(body.error, /expired|Connect/i);

    // And the dead credential is dropped rather than retried on every page load.
    const users = store.listTeam("acme");
    assert.equal(store.getOAuthToken(users[0].id), null);
  });
  delete process.env.CAVIX_DEMO;
  delete process.env.CAVIX_GITHUB_CLIENT_ID;
  delete process.env.CAVIX_GITHUB_CLIENT_SECRET;
});

test("tokens: an aged-out credential is renewed silently, and the rotation is kept", async () => {
  process.env.CAVIX_DEMO = "false";
  process.env.CAVIX_GITHUB_CLIENT_ID = "iv1.test";
  process.env.CAVIX_GITHUB_CLIENT_SECRET = "shh";
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  // Stand in for GitHub: honour the refresh, then answer the API calls the
  // Repositories page makes with the NEW token only.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/login/oauth/access_token")) {
      return new Response(
        JSON.stringify({ access_token: "gho_fresh", refresh_token: "ghr_rotated", expires_in: 28800 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://api.github.com/")) {
      const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
      if (auth !== "Bearer gho_fresh") return new Response("bad credentials", { status: 401 });
      const body = url.includes("/user/installations")
        ? { installations: [] }
        : url.includes("/user/orgs")
          ? []
          : { login: "aryanghai12", name: "Aryan", email: null, avatar_url: "" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    await withServer(async (base, store) => {
      const cookie = await userWithToken(base, store, {
        accessToken: "gho_stale",
        refreshToken: "ghr_original",
        expiresAt: Date.now() - 1000,
      });

      const res = await fetch(base + "/api/github/installations", { headers: { cookie } });
      assert.equal(res.status, 200, "the user never sees the expiry: it is renewed underneath them");
      const data = await readJson(res);
      assert.equal(data.demo, false, "this is real data, not fixtures");
      assert.ok(calls.some((u) => u.includes("/login/oauth/access_token")), "the refresh actually happened");

      // The rotated refresh token is persisted, or the NEXT renewal fails and
      // the user is signed out 8 hours later anyway.
      const stored = store.getOAuthToken(store.listTeam("acme")[0].id)!;
      assert.equal(stored.accessToken, "gho_fresh");
      assert.equal(stored.refreshToken, "ghr_rotated");
      assert.ok(stored.expiresAt! > Date.now());
    });
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.CAVIX_DEMO;
    delete process.env.CAVIX_GITHUB_CLIENT_ID;
    delete process.env.CAVIX_GITHUB_CLIENT_SECRET;
  }
});

test("tokens: a credential GitHub rejects mid-call is dropped, not reported as an outage", async () => {
  process.env.CAVIX_DEMO = "false";
  process.env.CAVIX_GITHUB_CLIENT_ID = "iv1.test";
  process.env.CAVIX_GITHUB_CLIENT_SECRET = "shh";
  const realFetch = globalThis.fetch;
  // A token that has not expired by the clock but that GitHub refuses anyway:
  // the user revoked the app, or the install was removed.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) return new Response("bad credentials", { status: 401 });
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    await withServer(async (base, store) => {
      const cookie = await userWithToken(base, store, { accessToken: "gho_revoked" });
      const res = await fetch(base + "/api/github/installations", { headers: { cookie } });
      assert.equal(res.status, 401);
      assert.equal((await readJson(res)).reconnect, true, "not a 502: GitHub is fine, the credential is not");
      assert.equal(store.getOAuthToken(store.listTeam("acme")[0].id), null, "the dead credential is forgotten");
    });
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.CAVIX_DEMO;
    delete process.env.CAVIX_GITHUB_CLIENT_ID;
    delete process.env.CAVIX_GITHUB_CLIENT_SECRET;
  }
});

test("a deployment with no GitHub App says so, instead of offering a button that cannot work", async () => {
  process.env.CAVIX_DEMO = "false";
  await withServer(async (base, store) => {
    store.createOrg("acme");
    store.createUser({ email: "u@acme.co", password: "password123", org: "acme", name: "U", role: "owner" });
    const cookie = cookieFrom(await post(base, "/api/auth/login", { email: "u@acme.co", password: "password123" }));
    const res = await fetch(base + "/api/github/installations", { headers: { cookie } });
    assert.equal(res.status, 503);
    const body = await readJson(res);
    assert.equal(body.reconnect, undefined, "there is nothing to reconnect to");
    assert.match(body.error, /CAVIX_GITHUB_CLIENT_ID/, "names the setting that is missing");
  });
  delete process.env.CAVIX_DEMO;
});

test("tokens: demo mode still serves fixtures when there is no credential at all", async () => {
  process.env.CAVIX_DEMO = "true";
  await withServer(async (base, store) => {
    store.createOrg("acme");
    store.createUser({ email: "u@acme.co", password: "password123", org: "acme", name: "U", role: "owner" });
    const cookie = cookieFrom(await post(base, "/api/auth/login", { email: "u@acme.co", password: "password123" }));
    const res = await fetch(base + "/api/github/installations", { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal((await readJson(res)).demo, true);
  });
  delete process.env.CAVIX_DEMO;
});

test("toggle + gatekeeper: enabling a repo makes the internal gate report enabled", async () => {
  process.env.CAVIX_INTERNAL_TOKEN = "gate-tok";
  await withServer(async (base, store) => {
    store.createOrg("acme");
    store.createUser({ email: "o@acme.co", password: "password123", org: "acme", name: "O", role: "owner" });
    const cookie = cookieFrom(await post(base, "/api/auth/login", { email: "o@acme.co", password: "password123" }));
    const gate = (full: string) =>
      readJson(
        fetch(base + `/api/internal/repos/enabled?fullName=${encodeURIComponent(full)}`, {
          headers: { authorization: "Bearer gate-tok" },
        }),
      );

    // before: disabled
    assert.equal((await gate("cavix-labs/payments-api")).enabled, false);

    // enable via the dashboard toggle
    assert.equal((await post(base, "/api/github/repos", { fullName: "cavix-labs/payments-api", private: true }, cookie)).status, 201);
    assert.equal((await gate("cavix-labs/payments-api")).enabled, true);
    assert.ok(store.isRepoEnabled("cavix-labs/payments-api"));

    // disable again
    await fetch(base + "/api/github/repos?fullName=cavix-labs%2Fpayments-api", { method: "DELETE", headers: { cookie } });
    assert.equal((await gate("cavix-labs/payments-api")).enabled, false);
  });
  delete process.env.CAVIX_INTERNAL_TOKEN;
});
