import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AppTokenProvider, GitHubPlatform, type PullRef } from "@cavix/platforms";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIV = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const ref: PullRef = { project: "acme", repo: "widget", number: 42, commit: "abc123" };

function recorder(bodyForUrl: (url: string) => unknown = () => ({})) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    return new Response(JSON.stringify(bodyForUrl(u)), { status: 201 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test("AppTokenProvider: mints a valid RS256 JWT (iss=appId, verifiable signature)", () => {
  const provider = new AppTokenProvider({ appId: 12345, privateKeyPem: PRIV });
  const jwt = provider.mintJwt();
  const [h, p, s] = jwt.split(".");
  assert.ok(h && p && s, "three JWT segments");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(payload.iss, "12345");
  assert.ok(payload.exp > payload.iat);
  // The signature verifies against the App public key.
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"));
  assert.equal(ok, true);
});

test("AppTokenProvider: exchanges the JWT for an installation token and caches it", async () => {
  let now = 1_000_000_000_000;
  const { calls, fetchImpl } = recorder(() => ({ token: "ghs_installtoken", expires_at: new Date(now + 3600_000).toISOString() }));
  const provider = new AppTokenProvider({ appId: 1, privateKeyPem: PRIV, fetchImpl, now: () => now });

  const t1 = await provider.token(999);
  assert.equal(t1, "ghs_installtoken");
  assert.match(calls[0].url, /\/app\/installations\/999\/access_tokens$/);
  assert.match((calls[0].init.headers as Record<string, string>).authorization, /^Bearer .+\..+\..+$/);

  // Within expiry → served from cache, no second call.
  now += 60_000;
  const t2 = await provider.token(999);
  assert.equal(t2, "ghs_installtoken");
  assert.equal(calls.length, 1, "cached — no re-fetch");
});

test("GitHubPlatform: creates a Check Run bound to the head sha", async () => {
  const { calls, fetchImpl } = recorder(() => ({ id: 7 }));
  const gh = new GitHubPlatform({ token: "t", fetchImpl });
  const r = await gh.createCheckRun(ref, { name: "cavix", status: "completed", conclusion: "success", title: "0 verified issues", summary: "clean" });
  assert.equal(r.id, 7);
  assert.match(calls[0].url, /\/repos\/acme\/widget\/check-runs$/);
  const b = JSON.parse(calls[0].init.body as string);
  assert.equal(b.head_sha, "abc123");
  assert.equal(b.conclusion, "success");
});

test("GitHubPlatform: dismisses a stale review and deletes a stale comment", async () => {
  const { calls, fetchImpl } = recorder();
  const gh = new GitHubPlatform({ token: "t", fetchImpl });
  await gh.dismissReview(ref, 555, "superseded by a fresh Cavix review");
  await gh.deleteReviewComment(ref, 888);
  assert.match(calls[0].url, /\/pulls\/42\/reviews\/555\/dismissals$/);
  assert.equal(calls[0].init.method, "PUT");
  assert.match(JSON.parse(calls[0].init.body as string).event, /DISMISS/);
  assert.match(calls[1].url, /\/pulls\/comments\/888$/);
  assert.equal(calls[1].init.method, "DELETE");
});

test("GitHubPlatform: listOwnReviews filters to the bot's reviews", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify([
      { id: 1, state: "COMMENTED", user: { login: "cavix[bot]" } },
      { id: 2, state: "APPROVED", user: { login: "alice" } },
      { id: 3, state: "COMMENTED", user: { login: "cavix[bot]" } },
    ]), { status: 200 })) as unknown as typeof fetch;
  const gh = new GitHubPlatform({ token: "t", fetchImpl });
  const own = await gh.listOwnReviews(ref, "cavix[bot]");
  assert.deepEqual(own.map((r) => r.id), [1, 3]);
});
