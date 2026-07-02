import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, InMemoryStore } from "@cavix/control-plane";
import { hashPassword, verifyPassword, signSession, verifySession, encryptSecret, decryptSecret, fingerprint } from "@cavix/control-plane";

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

function cookieFrom(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0]; // name=value
}

// ---------- crypto primitives ----------

test("passwords: hash + verify (and reject wrong password)", () => {
  const stored = hashPassword("correct horse battery staple");
  assert.ok(stored.includes(":"));
  assert.equal(verifyPassword("correct horse battery staple", stored), true);
  assert.equal(verifyPassword("wrong", stored), false);
});

test("sessions: sign + verify round-trips; tampering is rejected", () => {
  const token = signSession({ uid: "u1", email: "a@b.co", org: "acme", role: "owner" });
  const decoded = verifySession(token);
  assert.equal(decoded?.uid, "u1");
  assert.equal(decoded?.org, "acme");
  assert.equal(verifySession(token.slice(0, -2) + "xx"), null, "tampered signature rejected");
  assert.equal(verifySession("garbage"), null);
});

test("BYOK: encrypt/decrypt round-trips and fingerprint hides the key", () => {
  const key = "sk-ant-super-secret-key-value";
  const blob = encryptSecret(key);
  assert.notEqual(blob, key);
  assert.equal(decryptSecret(blob), key);
  assert.equal(decryptSecret("not:a:valid:blob"), null);
  const fp = fingerprint(key);
  assert.ok(!fp.includes("super-secret"), "fingerprint must not leak the key");
  assert.ok(fp.endsWith("value)") === false); // fingerprint shows only last 4 + hash
});

// ---------- auth HTTP flow ----------

test("signup: creates first user as owner and sets a session cookie", async () => {
  await withServer(async (base) => {
    const res = await post(base, "/api/auth/signup", { email: "boss@acme.co", password: "password123", org: "acme", name: "Boss" });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.user.role, "owner");
    assert.ok((res.headers.get("set-cookie") ?? "").includes("cavix_session="));
  });
});

test("signup: rejects short passwords and duplicate emails", async () => {
  await withServer(async (base) => {
    assert.equal((await post(base, "/api/auth/signup", { email: "a@b.co", password: "short", org: "x" })).status, 400);
    assert.equal((await post(base, "/api/auth/signup", { email: "dup@b.co", password: "password123", org: "x" })).status, 201);
    assert.equal((await post(base, "/api/auth/signup", { email: "dup@b.co", password: "password123", org: "x" })).status, 409);
  });
});

test("login: valid credentials succeed, invalid fail, /me reflects the session", async () => {
  await withServer(async (base) => {
    await post(base, "/api/auth/signup", { email: "me@acme.co", password: "password123", org: "acme" });
    assert.equal((await post(base, "/api/auth/login", { email: "me@acme.co", password: "nope" })).status, 401);
    const ok = await post(base, "/api/auth/login", { email: "me@acme.co", password: "password123" });
    assert.equal(ok.status, 200);
    const cookie = cookieFrom(ok);
    const me = await fetch(base + "/api/auth/me", { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.email, "me@acme.co");
    // no cookie → 401
    assert.equal((await fetch(base + "/api/auth/me")).status, 401);
  });
});

// ---------- settings / BYOK routes require auth + org match ----------

test("settings: require auth and reject other orgs; BYOK stores fingerprint only", async () => {
  await withServer(async (base) => {
    // unauthenticated → 401
    assert.equal((await fetch(base + "/api/orgs/acme/settings")).status, 401);

    const signup = await post(base, "/api/auth/signup", { email: "o@acme.co", password: "password123", org: "acme" });
    const cookie = cookieFrom(signup);

    // wrong org → 403
    assert.equal((await fetch(base + "/api/orgs/other/settings", { headers: { cookie } })).status, 403);

    // update settings
    const put = await fetch(base + "/api/orgs/acme/settings", { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ llmModel: "claude-opus-4-8", autoReview: false }) });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).llmModel, "claude-opus-4-8");

    // set BYOK key — response exposes only a fingerprint, never the raw key
    const keyRes = await post(base, "/api/orgs/acme/apikey", { apiKey: "sk-ant-topsecret-1234" }, cookie);
    assert.equal(keyRes.status, 200);
    const keyBody = await keyRes.json();
    assert.ok(keyBody.apiKeyFingerprint && !JSON.stringify(keyBody).includes("topsecret"), "raw key must never be returned");

    // the store can still decrypt it for the orchestrator
    // (fetched via the GET settings route, which never includes the raw key)
    const get = await (await fetch(base + "/api/orgs/acme/settings", { headers: { cookie } })).json();
    assert.ok(!JSON.stringify(get).includes("topsecret"));
    assert.ok(get.apiKeyFingerprint);
  });
});

test("stats: aggregates reviews/findings/decisions for the dashboard", async () => {
  await withServer(async (base, store) => {
    store.createOrg("acme");
    store.createUser({ email: "s@acme.co", password: "password123", org: "acme", name: "S", role: "owner" });
    const login = await post(base, "/api/auth/login", { email: "s@acme.co", password: "password123" });
    const cookie = cookieFrom(login);
    await post(base, "/api/reviews", { org: "acme", repo: "r", pr: 1, title: "t", findings: [
      { path: "a.js", line: 1, severity: "critical", category: "security", title: "x", body: "", source: "sast", confidence: 0.9, verified: true },
    ]});
    const stats = await (await fetch(base + "/api/orgs/acme/stats", { headers: { cookie } })).json();
    assert.equal(stats.reviews, 1);
    assert.equal(stats.findings, 1);
    assert.equal(stats.verified, 1);
    assert.equal(stats.bySeverity.critical, 1);
    assert.equal(stats.reviewsLast7Days.length, 7);
    assert.ok(stats.hoursSaved > 0);
  });
});

test("team: role changes require owner/admin", async () => {
  await withServer(async (base, store) => {
    store.createOrg("acme");
    const owner = store.createUser({ email: "own@acme.co", password: "password123", org: "acme", name: "O", role: "owner" });
    const member = store.createUser({ email: "mem@acme.co", password: "password123", org: "acme", name: "M", role: "member" });
    const ownerCookie = cookieFrom(await post(base, "/api/auth/login", { email: "own@acme.co", password: "password123" }));
    const memberCookie = cookieFrom(await post(base, "/api/auth/login", { email: "mem@acme.co", password: "password123" }));

    // member cannot promote anyone
    assert.equal((await post(base, `/api/orgs/acme/team/${member.id}/role`, { role: "admin" }, memberCookie)).status, 403);
    // owner can
    const promote = await post(base, `/api/orgs/acme/team/${member.id}/role`, { role: "admin" }, ownerCookie);
    assert.equal(promote.status, 200);
    assert.equal((await promote.json()).role, "admin");
    void owner;
  });
});

test("static site: marketing, login, and dashboard shell are served", async () => {
  await withServer(async (base) => {
    const home = await fetch(base + "/");
    assert.equal(home.status, 200);
    assert.match(await home.text(), /proves it before it speaks/i);

    const login = await fetch(base + "/login");
    assert.match(await login.text(), /Welcome back|auth-card/);

    const app = await fetch(base + "/app");
    assert.match(await app.text(), /app\.js/);

    const css = await fetch(base + "/styles.css");
    assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  });
});
