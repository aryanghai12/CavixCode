import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { GitHubAppTokenProvider, createAppJwt, normalizePrivateKey } from "../src/github/appAuth.ts";

// A GitHub App install never yields a PAT — it yields an App id + private key that
// must be exchanged for short-lived installation tokens. The orchestrator used to
// have no way to do that, so every job failed with "static token is empty".

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

test("createAppJwt signs a verifiable RS256 JWT with the app id as issuer", () => {
  const jwt = createAppJwt("123456", PEM, 1_800_000_000_000);
  const [header, payload, signature] = jwt.split(".");

  assert.deepEqual(JSON.parse(b64urlToBuf(header).toString()), { alg: "RS256", typ: "JWT" });

  const claims = JSON.parse(b64urlToBuf(payload).toString()) as { iss: string; iat: number; exp: number };
  assert.equal(claims.iss, "123456");
  // Backdated 60s against clock skew, and inside GitHub's 10-minute ceiling.
  assert.equal(claims.iat, 1_800_000_000 - 60);
  assert.ok(claims.exp - claims.iat <= 600, "JWT must not exceed GitHub's 10-minute limit");

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  assert.ok(verifier.verify(publicKey, b64urlToBuf(signature)), "signature must verify against the public key");
});

test("normalizePrivateKey accepts escaped newlines, quotes, and base64 PEMs", () => {
  assert.ok(normalizePrivateKey(PEM).includes("-----BEGIN"));
  // Pasted as one line with literal backslash-n (very common in host dashboards).
  assert.equal(normalizePrivateKey(PEM.replace(/\n/g, "\\n")).trim(), PEM.trim());
  // Wrapped in quotes by the dashboard.
  assert.equal(normalizePrivateKey(`"${PEM}"`).trim(), PEM.trim());
  // Whole file base64-encoded.
  assert.equal(normalizePrivateKey(Buffer.from(PEM).toString("base64")).trim(), PEM.trim());
});

test("constructor rejects a key that is not a PEM, with an actionable message", () => {
  assert.throws(
    () => new GitHubAppTokenProvider({ appId: "1", privateKey: "not-a-key" }),
    /paste the whole .pem file contents/,
  );
  assert.throws(() => new GitHubAppTokenProvider({ appId: "", privateKey: PEM }), /CAVIX_APP_ID is empty/);
});

test("token() exchanges the JWT for an installation token and caches it", async () => {
  let calls = 0;
  let sawAuth = "";
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls++;
    sawAuth = String((init?.headers as Record<string, string>).authorization);
    assert.match(String(url), /\/app\/installations\/42\/access_tokens$/);
    return new Response(
      JSON.stringify({ token: "ghs_installation_token", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const provider = new GitHubAppTokenProvider({ appId: "123456", privateKey: PEM, fetchImpl });

  assert.equal(await provider.token(42), "ghs_installation_token");
  assert.match(sawAuth, /^Bearer eyJ/, "the App JWT authenticates the exchange");

  assert.equal(await provider.token(42), "ghs_installation_token");
  assert.equal(calls, 1, "a still-valid token is reused, not re-minted");
});

test("token() makes one request when many jobs start at once", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return new Response(
      JSON.stringify({ token: "ghs_x", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const provider = new GitHubAppTokenProvider({ appId: "1", privateKey: PEM, fetchImpl });
  const tokens = await Promise.all([1, 2, 3, 4].map(() => provider.token(7)));
  assert.deepEqual(tokens, ["ghs_x", "ghs_x", "ghs_x", "ghs_x"]);
  assert.equal(calls, 1, "parallel callers share one in-flight mint");
});

test("a mismatched app id / key pair explains itself instead of leaking a bare 401", async () => {
  const fetchImpl = (async () =>
    new Response('{"message":"A JSON web token could not be decoded"}', { status: 401 })) as unknown as typeof fetch;
  const provider = new GitHubAppTokenProvider({ appId: "1", privateKey: PEM, fetchImpl });
  await assert.rejects(() => provider.token(7), /SAME GitHub App/);
});

test("a missing installation id names the real cause", async () => {
  const provider = new GitHubAppTokenProvider({ appId: "1", privateKey: PEM });
  await assert.rejects(() => provider.token(0), /is the Cavix App installed on this repository/i);
});
