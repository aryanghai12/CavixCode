import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepoGate } from "../src/byok/gate.ts";
import { resolvePrivateKey } from "../src/config.ts";

// The gate answers two questions: may we review this repo, and which dashboard
// workspace owns it. The second one matters because the job's `org` is the GitHub
// owner login, while the BYOK key is stored under the Cavix workspace name.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const noSleep = async () => {};

test("returns the owning workspace alongside the enabled flag", async () => {
  let seenUrl = "";
  const gate = makeRepoGate({
    url: "https://cavix.example/",
    token: "tok",
    fetchImpl: (async (url: string) => {
      seenUrl = String(url);
      return jsonResponse({ enabled: true, org: "acme-workspace" });
    }) as unknown as typeof fetch,
  });

  assert.deepEqual(await gate("acme/widget"), { enabled: true, org: "acme-workspace" });
  assert.match(seenUrl, /\/api\/internal\/repos\/enabled\?fullName=acme%2Fwidget$/);
});

test("a repo that is not enabled returns enabled:false", async () => {
  const gate = makeRepoGate({
    url: "https://cavix.example",
    token: "tok",
    fetchImpl: (async () => jsonResponse({ enabled: false })) as unknown as typeof fetch,
  });
  assert.deepEqual(await gate("acme/widget"), { enabled: false, org: undefined });
});

test("retries a sleeping control-plane instead of silently skipping the review", async () => {
  let calls = 0;
  const gate = makeRepoGate({
    url: "https://cavix.example",
    token: "tok",
    retryDelayMs: 0,
    sleepImpl: noSleep,
    fetchImpl: (async () => {
      calls++;
      // A free-tier host cold-starting: the first requests fail, then it wakes.
      if (calls < 3) throw new Error("fetch failed");
      return jsonResponse({ enabled: true, org: "acme" });
    }) as unknown as typeof fetch,
  });

  assert.deepEqual(await gate("acme/widget"), { enabled: true, org: "acme" });
  assert.equal(calls, 3);
});

test("gives up fail-closed after exhausting attempts", async () => {
  let calls = 0;
  const gate = makeRepoGate({
    url: "https://cavix.example",
    token: "tok",
    attempts: 2,
    retryDelayMs: 0,
    sleepImpl: noSleep,
    fetchImpl: (async () => { calls++; throw new Error("ETIMEDOUT"); }) as unknown as typeof fetch,
  });

  assert.deepEqual(await gate("acme/widget"), { enabled: false });
  assert.equal(calls, 2);
});

test("failOpen reviews anyway when the control-plane cannot be reached", async () => {
  const gate = makeRepoGate({
    url: "https://cavix.example",
    token: "tok",
    failOpen: true,
    attempts: 1,
    sleepImpl: noSleep,
    fetchImpl: (async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch,
  });
  assert.deepEqual(await gate("acme/widget"), { enabled: true });
});

test("a 401 is a config mistake, not a cold start — no retries", async () => {
  let calls = 0;
  const warnings: string[] = [];
  const gate = makeRepoGate({
    url: "https://cavix.example",
    token: "wrong",
    retryDelayMs: 0,
    sleepImpl: noSleep,
    logger: { warn: (_m, meta) => warnings.push(String(meta?.hint ?? "")) },
    fetchImpl: (async () => { calls++; return jsonResponse({ error: "unauthorized" }, 401); }) as unknown as typeof fetch,
  });

  assert.deepEqual(await gate("acme/widget"), { enabled: false });
  assert.equal(calls, 1, "a bad token will never start working — do not retry");
  assert.match(warnings[0], /CAVIX_INTERNAL_TOKEN differs/);
});

// ---- private key resolution (config.ts) ----
// Render's "Secret Files" preserves a multi-line .pem byte-for-byte where the
// Environment Variables field may not, so reading from a path must work.

test("resolvePrivateKey reads a secret file when CAVIX_APP_PRIVATE_KEY_FILE is set", () => {
  const read = (p: string) => (p === "/etc/secrets/cavix.pem" ? "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----" : "");
  const out = resolvePrivateKey({ CAVIX_APP_PRIVATE_KEY_FILE: "/etc/secrets/cavix.pem" } as NodeJS.ProcessEnv, read);
  assert.match(out, /BEGIN RSA PRIVATE KEY/);
});

test("resolvePrivateKey follows a path pasted into the key variable by mistake", () => {
  const read = (p: string) => (p === "/etc/secrets/k.pem" ? "-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----" : "");
  const out = resolvePrivateKey({ CAVIX_APP_PRIVATE_KEY: "/etc/secrets/k.pem" } as NodeJS.ProcessEnv, read);
  assert.match(out, /BEGIN PRIVATE KEY/);
});

test("resolvePrivateKey leaves a real inline PEM alone", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY-----";
  const out = resolvePrivateKey({ CAVIX_APP_PRIVATE_KEY: pem } as NodeJS.ProcessEnv, () => "should not be read");
  assert.equal(out, pem);
});

// Base64 uses "/" as a character, so a naive "contains a slash" path check would
// try to open a headerless key body as a filename and silently return "".
test("resolvePrivateKey does not mistake a base64 key body for a file path", () => {
  const body = "MIIEowIBAAKCAQEA" + "a/b+c/d+e/f".repeat(20) + "==";
  let opened = "";
  const out = resolvePrivateKey({ CAVIX_APP_PRIVATE_KEY: body } as NodeJS.ProcessEnv, (p) => { opened = p; return ""; });
  assert.equal(opened, "", "must not attempt to read it as a file");
  assert.equal(out, body, "the key material must be passed through untouched");
});

test("resolvePrivateKey recognises real path shapes only", () => {
  const seen: string[] = [];
  const read = (p: string) => { seen.push(p); return ""; };
  for (const v of ["/etc/secrets/k.pem", "./k.pem", "C:\\secrets\\k.pem", "secrets/key.pem"]) {
    resolvePrivateKey({ CAVIX_APP_PRIVATE_KEY: v } as NodeJS.ProcessEnv, read);
  }
  assert.equal(seen.length, 4, "all four should be treated as paths");
});

test("resolvePrivateKey falls back to the inline value when the file is missing", () => {
  const out = resolvePrivateKey(
    { CAVIX_APP_PRIVATE_KEY_FILE: "/nope.pem", CAVIX_APP_PRIVATE_KEY: "inline-value" } as NodeJS.ProcessEnv,
    () => "",
  );
  assert.equal(out, "inline-value");
});
