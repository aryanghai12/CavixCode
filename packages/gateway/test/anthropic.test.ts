import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "@cavix/gateway";

// Hermetic test of the real provider via an injected fetch — proves the wire
// contract (endpoint, BYOK header, body shape) and response parsing without a
// network call or a real key.

test("AnthropicProvider: sends BYOK key + parses Messages API response", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const body = {
      id: "msg_123",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hello world" }],
      usage: { input_tokens: 11, output_tokens: 3 },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const provider = new AnthropicProvider({ fetchImpl: fakeFetch });
  const res = await provider.complete(
    { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }], maxTokens: 64 },
    "sk-byok-key",
  );

  assert.equal(res.text, "hello world");
  assert.equal(res.usage.inputTokens, 11);
  assert.equal(res.usage.outputTokens, 3);
  assert.equal(res.providerRequestId, "msg_123");

  // Wire assertions
  assert.equal(calls.length, 1, "fetch was called once");
  const captured = calls[0];
  assert.match(captured.url, /\/v1\/messages$/);
  const headers = captured.init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "sk-byok-key");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  const sentBody = JSON.parse(captured.init.body as string);
  assert.equal(sentBody.model, "claude-sonnet-4-6");
  assert.equal(sentBody.max_tokens, 64);
});

test("AnthropicProvider: surfaces HTTP errors without leaking the key", async () => {
  const fakeFetch = (async () =>
    new Response("rate limited", { status: 429, statusText: "Too Many Requests" })) as unknown as typeof fetch;

  const provider = new AnthropicProvider({ fetchImpl: fakeFetch });
  await assert.rejects(
    () =>
      provider.complete(
        { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }], maxTokens: 16 },
        "sk-should-not-leak",
      ),
    (err: Error) => {
      assert.match(err.message, /HTTP 429/);
      assert.ok(!err.message.includes("sk-should-not-leak"), "key must not appear in error");
      return true;
    },
  );
});

test("AnthropicProvider: empty key fails closed", async () => {
  const provider = new AnthropicProvider();
  await assert.rejects(
    () => provider.complete({ model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 1 }, ""),
    /api key is empty/,
  );
});
