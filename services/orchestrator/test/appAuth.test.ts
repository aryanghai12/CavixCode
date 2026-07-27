import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import {
  GitHubAppTokenProvider,
  canSign,
  createAppJwt,
  describeKeyMaterial,
  normalizePrivateKey,
} from "../src/github/appAuth.ts";

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

// Every one of these is a real shape a .pem takes after a hosting dashboard has
// had its way with it. Each used to produce a service that failed every review.
test("normalizePrivateKey repairs the ways dashboards mangle a PEM", () => {
  const cases: Array<[string, string]> = [
    ["clean PEM", PEM],
    ["escaped newlines (\\n)", PEM.replace(/\n/g, "\\n")],
    ["wrapped in double quotes", `"${PEM}"`],
    ["wrapped in single quotes", `'${PEM}'`],
    ["whole file base64-encoded", Buffer.from(PEM).toString("base64")],
    ["CRLF line endings", PEM.replace(/\n/g, "\r\n")],
    // The big one: a single-line input turns every newline into a space.
    ["newlines flattened to spaces", PEM.replace(/\n/g, " ")],
    // Header/footer lost entirely, leaving only the base64 body.
    ["header and footer stripped", PEM.replace(/-----[^-]*-----/g, "").replace(/\s+/g, "")],
    ["leading/trailing whitespace", `\n\n  ${PEM}  \n\n`],
  ];
  for (const [name, input] of cases) {
    const out = normalizePrivateKey(input);
    assert.ok(out.includes("-----BEGIN"), `${name}: should produce a PEM`);
    assert.ok(canSign(out), `${name}: the result must actually be able to sign`);
  }
});

test("normalizePrivateKey returns empty for input it genuinely cannot use", () => {
  for (const junk of ["", "   ", "not-a-key", "Iv1.0123456789abcdef"]) {
    assert.equal(normalizePrivateKey(junk), "", `should reject: ${JSON.stringify(junk)}`);
  }
});

// Regression: a bad credential used to throw from the constructor, which killed
// the process at boot. The port never opened and Render failed the deploy, so one
// typo took the whole service down instead of just the reviews that needed it.
test("a broken key is recorded, never thrown at construction", () => {
  const p = new GitHubAppTokenProvider({ appId: "1", privateKey: "not-a-key" });
  assert.match(p.configError!, /ENTIRE .pem file/);
  assert.match(p.configError!, /NO BEGIN marker/, "says what it actually got");
});

test("a missing app id is recorded, not thrown", () => {
  const p = new GitHubAppTokenProvider({ appId: "", privateKey: PEM });
  assert.match(p.configError!, /CAVIX_APP_ID is empty/);
});

test("pasting the Client ID instead of the App ID is called out by name", () => {
  const p = new GitHubAppTokenProvider({ appId: "Iv23liABCDEFG", privateKey: PEM });
  assert.match(p.configError!, /numeric "App ID"/);
  assert.match(p.configError!, /Client ID/);
});

test("a recorded config error surfaces per review, so the PR can explain it", async () => {
  const p = new GitHubAppTokenProvider({ appId: "1", privateKey: "not-a-key" });
  await assert.rejects(() => p.token(42), /ENTIRE .pem file/);
});

test("describeKeyMaterial reports shape and never leaks key material", () => {
  const d = describeKeyMaterial(PEM);
  assert.match(d, /has BEGIN marker/);
  assert.match(d, /line\(s\)/);
  assert.ok(!d.includes(PEM.split("\n")[1]), "must not echo any base64 body");
  assert.equal(describeKeyMaterial(""), "empty");
  assert.match(describeKeyMaterial("abc\\ndef"), /contains literal \\n/);
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
