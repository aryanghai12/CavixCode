import { test } from "node:test";
import assert from "node:assert/strict";
import { createGuardedFetch, hostAllowed, EgressBlockedError, SelfHostedProvider, createAirgappedGateway } from "@cavix/gateway";

const MODEL = "http://cavix-model.cavix.svc.cluster.local:8000";

function okFetch(record: string[]) {
  return (async (url: string | URL | Request) => {
    record.push(new URL(String(url)).hostname);
    return new Response(
      JSON.stringify({ id: "x", model: "llama-3", choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

test("egress guard: allowlist host + loopback + cluster-local pass; cloud is blocked", () => {
  const policy = { allowedHosts: ["cavix-model.cavix.svc.cluster.local"] };
  assert.equal(hostAllowed("cavix-model.cavix.svc.cluster.local", policy), true);
  assert.equal(hostAllowed("127.0.0.1", policy), true);
  assert.equal(hostAllowed("qdrant.cavix.svc", policy), true);
  assert.equal(hostAllowed("api.anthropic.com", policy), false);
  assert.equal(hostAllowed("api.openai.com", policy), false);
  assert.equal(hostAllowed("evil.example.com", policy), false);
});

test("guarded fetch throws EgressBlockedError for a non-allowlisted host", async () => {
  const seen: string[] = [];
  const guarded = createGuardedFetch({ allowedHosts: ["cavix-model.cavix.svc.cluster.local"] }, okFetch(seen));
  await assert.rejects(() => guarded("https://api.anthropic.com/v1/messages"), EgressBlockedError);
  assert.equal(seen.length, 0, "the underlying fetch was never reached");
});

test("self-hosted provider speaks the OpenAI chat API over guarded fetch", async () => {
  const seen: string[] = [];
  const guarded = createGuardedFetch({ allowedHosts: ["cavix-model.cavix.svc.cluster.local"] }, okFetch(seen));
  const provider = new SelfHostedProvider({ baseUrl: MODEL, fetchImpl: guarded });
  const res = await provider.complete({ model: "llama-3", messages: [{ role: "user", content: "hi" }], maxTokens: 64 }, "local");
  assert.match(res.text, /"ok":true/);
  assert.equal(res.usage.inputTokens, 5);
  assert.deepEqual(seen, ["cavix-model.cavix.svc.cluster.local"], "only the in-cluster model was contacted");
});

test("a redirect off the allowlist is refused, not followed", async () => {
  // The hole this closes, and the reason redirects are followed by hand. Left to
  // `fetch`, an allowed host answering `307 Location: https://evil.example`
  // makes the runtime RE-SEND the request, body and all, to a host the policy
  // forbids: the guard's one check passed, and the prompt left the cluster.
  const reached: string[] = [];
  const redirector = (async (url: string | URL) => {
    const host = new URL(String(url)).hostname;
    reached.push(host);
    if (host === "cavix-model.cavix.svc.cluster.local") {
      return new Response("", { status: 307, headers: { location: "https://evil.example/collect" } });
    }
    return new Response("captured", { status: 200 });
  }) as unknown as typeof fetch;

  const guarded = createGuardedFetch({ allowedHosts: ["cavix-model.cavix.svc.cluster.local"] }, redirector);
  await assert.rejects(
    () => guarded(`${MODEL}/v1/chat/completions`, { method: "POST", body: '{"prompt":"customer source code"}' }),
    EgressBlockedError,
  );
  assert.deepEqual(reached, ["cavix-model.cavix.svc.cluster.local"], "evil.example was never contacted");
});

test("a redirect that stays on the allowlist is still followed", async () => {
  // The guard checks each hop; it does not ban redirection. An in-cluster
  // ingress that redirects is ordinary and must keep working.
  const reached: string[] = [];
  const redirector = (async (url: string | URL) => {
    const u = new URL(String(url));
    reached.push(u.pathname);
    if (u.pathname === "/old") return new Response("", { status: 308, headers: { location: "/new" } });
    return new Response("arrived", { status: 200 });
  }) as unknown as typeof fetch;

  const guarded = createGuardedFetch({ allowedHosts: ["cavix-model.cavix.svc.cluster.local"] }, redirector);
  const res = await guarded(`${MODEL}/old`);
  assert.equal(await res.text(), "arrived");
  assert.deepEqual(reached, ["/old", "/new"]);
});

test("a redirect loop ends in an error rather than spinning", async () => {
  const loop = (async () =>
    new Response("", { status: 302, headers: { location: "/again" } })) as unknown as typeof fetch;
  const guarded = createGuardedFetch({ allowedHosts: ["cavix-model.cavix.svc.cluster.local"] }, loop);
  await assert.rejects(() => guarded(`${MODEL}/start`), /more than 5 redirects/);
});

test("air-gapped gateway: inference reaches only the in-cluster model; cloud is impossible", async () => {
  const seen: string[] = [];
  const { gateway, guardedFetch } = createAirgappedGateway({ modelBaseUrl: MODEL, model: "llama-3", fetchImpl: okFetch(seen) });

  // A normal review call routes to the self-hosted model (no key, no cloud).
  const { response, cost } = await gateway.complete("any-org", { messages: [{ role: "user", content: "review" }] });
  assert.match(response.text, /ok/);
  assert.equal(cost.costUsd, 0, "local compute → no per-token cost");
  assert.deepEqual([...new Set(seen)], ["cavix-model.cavix.svc.cluster.local"]);

  // PROOF: the same guarded fetch used everywhere refuses any external host.
  await assert.rejects(() => guardedFetch("https://api.anthropic.com/v1/messages"), EgressBlockedError);
  await assert.rejects(() => guardedFetch("https://github.com/repo"), EgressBlockedError);
  assert.deepEqual([...new Set(seen)], ["cavix-model.cavix.svc.cluster.local"], "no external host ever contacted");
});
