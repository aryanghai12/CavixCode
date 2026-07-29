import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, InMemoryStore } from "@cavix/control-plane";
import { readJson, readList } from "./http.ts";

// The settings a repo owner flips on the dashboard have to reach the thing that
// runs the review. These tests cover that contract end to end: what the store
// defaults to, what the API lets an owner change, and what the orchestrator is
// told when it asks.

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
const put = (base: string, path: string, body: unknown, cookie: string) =>
  fetch(base + path, { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
const cookieFrom = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

async function signedIn(base: string, org = "acme") {
  await post(base, "/api/auth/signup", { email: "owner@acme.dev", password: "password123", name: "O", org });
  return cookieFrom(await post(base, "/api/auth/login", { email: "owner@acme.dev", password: "password123" }));
}

// ---------- defaults ----------

test("a new org gets proof on, summary in the description, and blocking OFF", () => {
  const store = new InMemoryStore();
  store.createOrg("acme");
  const s = store.getSettings("acme");
  assert.equal(s.verifyFindings, true, "findings are proven before posting");
  assert.equal(s.summaryInDescription, true);
  assert.equal(s.requestChangesOnFail, false, "Cavix never blocks merges uninvited");
  assert.equal(s.preMergeChecks.enabled, false, "the gate ships off");
});

// A snapshot written before these fields existed must not read as "everything
// off" — that would silently disable verification for every existing customer.
test("settings restored from an older snapshot gain the new fields, not undefined", () => {
  const store = new InMemoryStore();
  store.createOrg("acme");
  const legacy = store.getSettings("acme") as unknown as Record<string, unknown>;
  delete legacy.verifyFindings;
  delete legacy.summaryInDescription;
  delete legacy.requestChangesOnFail;

  const s = store.getSettings("acme");
  assert.equal(s.verifyFindings, true);
  assert.equal(s.summaryInDescription, true);
  assert.equal(s.requestChangesOnFail, false);
});

// ---------- the owner changes them ----------

test("an owner can turn verification off and blocking on from the dashboard API", async () => {
  await withServer(async (base) => {
    const cookie = await signedIn(base);
    const res = await put(base, "/api/orgs/acme/settings", {
      verifyFindings: false,
      summaryInDescription: false,
      requestChangesOnFail: true,
      failOn: ["critical", "high"],
    }, cookie);
    assert.equal(res.status, 200);
    const s = await readJson(res);
    assert.equal(s.verifyFindings, false);
    assert.equal(s.summaryInDescription, false);
    assert.equal(s.requestChangesOnFail, true);
    assert.deepEqual(s.failOn, ["critical", "high"]);
  });
});

test("another org's settings are not reachable", async () => {
  await withServer(async (base) => {
    const cookie = await signedIn(base);
    const res = await put(base, "/api/orgs/someone-else/settings", { verifyFindings: false }, cookie);
    assert.equal(res.status, 403);
  });
});

// ---------- the orchestrator reads them ----------

test("the internal review-config endpoint reports exactly what the owner chose", async () => {
  process.env.CAVIX_INTERNAL_TOKEN = "internal-secret";
  await withServer(async (base) => {
    const cookie = await signedIn(base);
    await put(base, "/api/orgs/acme/settings", {
      verifyFindings: false,
      requestChangesOnFail: true,
      preMergeChecks: { enabled: true, rules: ["Disallow calls to console.log"] },
    }, cookie);

    const res = await fetch(`${base}/api/internal/orgs/acme/review-config`, {
      headers: { authorization: "Bearer internal-secret" },
    });
    assert.equal(res.status, 200);
    const cfg = await readJson(res);
    assert.equal(cfg.verifyFindings, false);
    assert.equal(cfg.requestChangesOnFail, true);
    assert.equal(cfg.preMergeChecks.enabled, true);
    assert.deepEqual(cfg.preMergeChecks.rules, ["Disallow calls to console.log"]);
  });
  delete process.env.CAVIX_INTERNAL_TOKEN;
});

test("review-config needs the shared internal token", async () => {
  process.env.CAVIX_INTERNAL_TOKEN = "internal-secret";
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/internal/orgs/acme/review-config`, {
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(res.status, 401);
  });
  delete process.env.CAVIX_INTERNAL_TOKEN;
});

// ---------- rule compilation ----------

// A rule that never compiles is a gate that silently protects nothing, so the
// dashboard has to be able to say which sentences became real checks.
test("the compile endpoint reports which plain-English rules became real checks", async () => {
  await withServer(async (base) => {
    const cookie = await signedIn(base);
    const res = await post(base, "/api/orgs/acme/policy/compile", {
      rules: ["Disallow calls to console.log", "please be nice to the code"],
    }, cookie);
    assert.equal(res.status, 200);
    const [good, bad] = await readList(res);
    assert.equal(good.ok, true);
    assert.match(good.ruleId, /no-call/);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /could not compile/i);
  });
});
