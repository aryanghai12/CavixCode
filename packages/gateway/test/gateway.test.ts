import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Gateway,
  FakeProvider,
  keyFingerprint,
  type GatewayConfigData,
} from "@cavix/gateway";

function makeGateway(config: GatewayConfigData) {
  const fake = new FakeProvider((req) => `echo:${req.model}`);
  const gw = new Gateway({
    providers: new Map([["fake", fake]]),
    config,
  });
  return { gw, fake };
}

test("BYOK: each org's own key is the one routed to the provider and billed", async () => {
  const config: GatewayConfigData = {
    orgs: {
      acme: { provider: "fake", apiKey: "key-acme-AAA", model: "fake-model" },
      globex: { provider: "fake", apiKey: "key-globex-BBB", model: "fake-model" },
    },
  };
  const { gw, fake } = makeGateway(config);

  const a = await gw.complete("acme", { messages: [{ role: "user", content: "hi" }] });
  const b = await gw.complete("globex", { messages: [{ role: "user", content: "hi" }] });

  // The provider received each org's own key, in order.
  assert.deepEqual(fake.seenKeys, ["key-acme-AAA", "key-globex-BBB"]);

  // The cost ledger attributes each call to the right org + key fingerprint.
  assert.equal(a.cost.org, "acme");
  assert.equal(a.cost.keyFingerprint, keyFingerprint("key-acme-AAA"));
  assert.equal(b.cost.org, "globex");
  assert.equal(b.cost.keyFingerprint, keyFingerprint("key-globex-BBB"));
  assert.notEqual(a.cost.keyFingerprint, b.cost.keyFingerprint);
});

test("BYOK: swapping an org's key changes which key is billed (acceptance gate)", async () => {
  const before: GatewayConfigData = {
    orgs: { acme: { provider: "fake", apiKey: "OLD-KEY", model: "fake-model" } },
  };
  const g1 = makeGateway(before);
  const r1 = await g1.gw.complete("acme", { messages: [{ role: "user", content: "x" }] });
  assert.equal(g1.fake.seenKeys[0], "OLD-KEY");
  assert.equal(r1.cost.keyFingerprint, keyFingerprint("OLD-KEY"));

  // Operator rotates the org's BYOK key in config.
  const after: GatewayConfigData = {
    orgs: { acme: { provider: "fake", apiKey: "NEW-KEY", model: "fake-model" } },
  };
  const g2 = makeGateway(after);
  const r2 = await g2.gw.complete("acme", { messages: [{ role: "user", content: "x" }] });
  assert.equal(g2.fake.seenKeys[0], "NEW-KEY");
  assert.equal(r2.cost.keyFingerprint, keyFingerprint("NEW-KEY"));

  assert.notEqual(r1.cost.keyFingerprint, r2.cost.keyFingerprint);
});

test("gateway never leaks the api key into the structured log", async () => {
  const logged: Array<Record<string, unknown>> = [];
  const fake = new FakeProvider(() => "ok");
  const gw = new Gateway({
    providers: new Map([["fake", fake]]),
    config: { orgs: { acme: { provider: "fake", apiKey: "sk-super-secret-123", model: "fake-model" } } },
    logger: { info: (_m, meta) => logged.push(meta ?? {}), warn: () => {} },
  });
  await gw.complete("acme", { messages: [{ role: "user", content: "hi" }] });

  const serialized = JSON.stringify(logged);
  assert.ok(!serialized.includes("sk-super-secret-123"), "raw key must never appear in logs");
  assert.ok(serialized.includes(keyFingerprint("sk-super-secret-123")), "fingerprint should appear");
});

test("gateway: per-call model override (cheap triage vs default)", async () => {
  const { gw, fake } = makeGateway({
    orgs: { acme: { provider: "fake", apiKey: "k", model: "claude-sonnet-4-6" } },
  });
  await gw.complete("acme", { messages: [{ role: "user", content: "x" }], model: "claude-haiku-4-5-20251001" });
  assert.equal(fake.seenRequests[0].model, "claude-haiku-4-5-20251001");
});

test("gateway: total cost accumulates across calls", async () => {
  const { gw } = makeGateway({
    orgs: { acme: { provider: "fake", apiKey: "k", model: "claude-sonnet-4-6" } },
  });
  await gw.complete("acme", { messages: [{ role: "user", content: "a".repeat(4000) }] });
  await gw.complete("acme", { messages: [{ role: "user", content: "b".repeat(4000) }] });
  assert.equal(gw.costLog().length, 2);
  assert.ok(gw.totalCostUsd() > 0, "sonnet calls should cost > 0");
});

test("gateway: unknown provider and missing key fail loudly", async () => {
  const gwBadProvider = new Gateway({
    providers: new Map(),
    config: { orgs: { acme: { provider: "ghost", apiKey: "k", model: "m" } } },
  });
  await assert.rejects(
    () => gwBadProvider.complete("acme", { messages: [{ role: "user", content: "x" }] }),
    /unknown provider/,
  );

  const gwNoKey = new Gateway({
    providers: new Map([["fake", new FakeProvider()]]),
    config: { orgs: { acme: { provider: "fake", apiKey: "", model: "m" } } },
  });
  await assert.rejects(
    () => gwNoKey.complete("acme", { messages: [{ role: "user", content: "x" }] }),
    /BYOK key missing/,
  );
});
