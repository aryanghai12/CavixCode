import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, InMemoryStore, isPlatformAdmin } from "@cavix/control-plane";
import { readJson } from "./http.ts";

// Who gets founder control of the whole platform.
//
// Three separate problems live here, and all three showed up as the same
// symptom: an admin console that never appeared, with nothing anywhere saying
// why.
//
//   1. An email is not a stable identifier for a GitHub sign-in. A user with
//      "Keep my email addresses private" on is stored under
//      <login>@users.noreply.github.com, so listing their real address in
//      CAVIX_ADMIN_EMAILS matches nothing.
//   2. The guard read the SESSION's email, so listing a GitHub login could never
//      have worked even once logins were understood.
//   3. Unset used to mean "demo@cavix.dev is an admin" everywhere, production
//      included, where sign-up is open and that address is a published default.

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
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const cookieFrom = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

/** Restore whatever the surrounding process had, so tests do not leak into each other. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  const restore = () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  const out = fn();
  if (out instanceof Promise) return out.finally(restore);
  restore();
  return undefined;
}

// ---------- 1. GitHub logins ----------

test("a GitHub login can be named instead of an email", () => {
  withEnv({ CAVIX_ADMIN_EMAILS: "@octocat" }, () => {
    assert.equal(isPlatformAdmin("anything@users.noreply.github.com", "octocat"), true);
    assert.equal(isPlatformAdmin("ANYTHING@x.com", "OCTOCAT"), true, "case-insensitive");
    // The whole point: the email this account is stored under is not the one
    // its owner would think to list, and with a login it does not have to be.
    assert.equal(isPlatformAdmin("octocat@users.noreply.github.com", "someone-else"), false);
  });
});

test("a login entry never matches an email, and an email entry never matches a login", () => {
  withEnv({ CAVIX_ADMIN_EMAILS: "@octocat" }, () => {
    // Somebody whose EMAIL is literally "octocat" is not the GitHub user octocat.
    assert.equal(isPlatformAdmin("octocat", undefined), false);
  });
  withEnv({ CAVIX_ADMIN_EMAILS: "octocat" }, () => {
    assert.equal(isPlatformAdmin("nobody@x.com", "octocat"), false);
    assert.equal(isPlatformAdmin("octocat", undefined), true);
  });
});

test("emails and logins can be mixed in one variable", () => {
  withEnv({ CAVIX_ADMIN_EMAILS: "founder@cavix.dev, @octocat , cofounder@cavix.dev" }, () => {
    assert.equal(isPlatformAdmin("founder@cavix.dev"), true);
    assert.equal(isPlatformAdmin("cofounder@cavix.dev"), true);
    assert.equal(isPlatformAdmin("someone@else.com", "octocat"), true);
    assert.equal(isPlatformAdmin("someone@else.com", "nobody"), false);
  });
});

test("a stray @ on a login in the variable is tolerated", () => {
  // Somebody will write "@@octocat", or paste a login that already has one.
  withEnv({ CAVIX_ADMIN_EMAILS: "@octocat" }, () => {
    assert.equal(isPlatformAdmin("x@y.com", "@octocat"), true);
  });
});

// ---------- 2. The guard resolves the account, not the cookie ----------

test("the real GitHub sign-in shape: noreply email, login is the only stable handle", () => {
  withEnv({ CAVIX_ADMIN_EMAILS: "@octocat" }, () => {
    const store = new InMemoryStore();
    store.createOrg("acme");
    // Exactly what the OAuth callback stores for an account with "Keep my email
    // addresses private" turned on.
    const user = store.upsertOAuthUser({
      email: "octocat@users.noreply.github.com",
      name: "Octo",
      org: "acme",
      provider: "github",
      login: "octocat",
    });

    assert.equal(isPlatformAdmin(user.email, user.githubLogin), true);
    // The session cookie carries only the email, which is why the guard has to
    // resolve the account first. Before it did, listing a login was inert.
    assert.equal(isPlatformAdmin(user.email), false, "the cookie's email alone can never match a login");
  });
});

test("admin API: the console appears for a login-based admin and the API lets them in", async () => {
  await withEnv({ CAVIX_ADMIN_EMAILS: "@founder-login" }, async () => {
    await withServer(async (base, store) => {
      store.createOrg("acme");
      // A password account that also carries a GitHub login, so we can log in
      // through the real endpoint and still exercise the login match.
      store.createUser({
        email: "someone@users.noreply.github.com",
        password: "password123",
        org: "acme",
        name: "F",
        role: "owner",
      });
      const u = store.getUserByEmail("someone@users.noreply.github.com")!;
      u.githubLogin = "founder-login";

      const cookie = cookieFrom(
        await post(base, "/api/auth/login", {
          email: "someone@users.noreply.github.com",
          password: "password123",
        }),
      );

      // The sidebar: /api/auth/me is what unhides the Admin console.
      const me = await readJson(await fetch(base + "/api/auth/me", { headers: { cookie } }));
      assert.equal(me.user.platformAdmin, true, "the console must appear in the sidebar");

      // And the API agrees. These two disagreeing is its own bug: a visible menu
      // item that 403s is worse than no menu item.
      const list = await fetch(base + "/api/admin/orgs", { headers: { cookie } });
      assert.equal(list.status, 200, "the guard must reach the same answer as the sidebar");
    });
  });
});

test("a non-admin is still refused when logins are in use", async () => {
  await withEnv({ CAVIX_ADMIN_EMAILS: "@founder-login" }, async () => {
    await withServer(async (base, store) => {
      store.createOrg("acme");
      store.createUser({ email: "user@acme.co", password: "password123", org: "acme", name: "U", role: "owner" });
      const cookie = cookieFrom(
        await post(base, "/api/auth/login", { email: "user@acme.co", password: "password123" }),
      );
      assert.equal((await fetch(base + "/api/admin/orgs", { headers: { cookie } })).status, 403);
      const me = await readJson(await fetch(base + "/api/auth/me", { headers: { cookie } }));
      assert.equal(me.user.platformAdmin, false);
    });
  });
});

// ---------- 3. Unset fails CLOSED in production ----------

test("unset in production means nobody, not the published demo address", () => {
  // RENDER is what `demoEnabled()` reads to know it is not a dev box. Production
  // starts with an empty store and open sign-up, so a default admin address that
  // is written down in a public repository is a foothold, not a convenience:
  // anyone who registers it owns every org on the platform.
  withEnv({ CAVIX_ADMIN_EMAILS: undefined, RENDER: "true", CAVIX_DEMO: undefined }, () => {
    assert.equal(isPlatformAdmin("demo@cavix.dev"), false);
    assert.equal(isPlatformAdmin("anyone@anywhere.com"), false);
    assert.equal(isPlatformAdmin("x@y.com", "octocat"), false);
  });
});

test("an empty or whitespace-only variable is treated as unset, not as an admin", () => {
  withEnv({ CAVIX_ADMIN_EMAILS: "   ", RENDER: "true", CAVIX_DEMO: undefined }, () => {
    assert.equal(isPlatformAdmin("demo@cavix.dev"), false);
    assert.equal(isPlatformAdmin(""), false);
    assert.equal(isPlatformAdmin(undefined), false);
  });
  // And a variable of only commas cannot open the door either.
  withEnv({ CAVIX_ADMIN_EMAILS: ",, ,", RENDER: "true", CAVIX_DEMO: undefined }, () => {
    assert.equal(isPlatformAdmin("demo@cavix.dev"), false);
    assert.equal(isPlatformAdmin(""), false);
  });
});

test("unset on a dev box still gives the demo owner the console", () => {
  // The convenience is kept exactly where it is safe: a local machine with no
  // database, where the seeded demo account is the only account there is.
  withEnv({ CAVIX_ADMIN_EMAILS: undefined, RENDER: undefined, DATABASE_URL: undefined, CAVIX_DEMO: undefined }, () => {
    assert.equal(isPlatformAdmin("demo@cavix.dev"), true);
    assert.equal(isPlatformAdmin("someone@else.com"), false);
  });
});

test("a database is enough to count as production, without RENDER", () => {
  withEnv({ CAVIX_ADMIN_EMAILS: undefined, RENDER: undefined, DATABASE_URL: "postgres://x", CAVIX_DEMO: undefined }, () => {
    assert.equal(isPlatformAdmin("demo@cavix.dev"), false);
  });
});

test("CAVIX_DEMO=true restores the dev default even on a production host", () => {
  // The escape hatch that already governs demo seeding governs this too, so
  // there is one answer to "is this a demo deployment" rather than two.
  withEnv({ CAVIX_ADMIN_EMAILS: undefined, RENDER: "true", CAVIX_DEMO: "true" }, () => {
    assert.equal(isPlatformAdmin("demo@cavix.dev"), true);
  });
});

test("an explicit variable always wins, in dev and in production alike", () => {
  withEnv({ CAVIX_ADMIN_EMAILS: "real@founder.com", RENDER: undefined, CAVIX_DEMO: undefined }, () => {
    assert.equal(isPlatformAdmin("real@founder.com"), true);
    // Setting it REPLACES the demo default rather than adding to it, so a dev
    // box that names its admins does not quietly keep a second one.
    assert.equal(isPlatformAdmin("demo@cavix.dev"), false);
  });
});
