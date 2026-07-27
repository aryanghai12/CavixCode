import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleProvider, OpenAIProvider, tokenBudgetField, Gateway, FakeProvider } from "@cavix/gateway";

// The dashboard's AI & BYOK dropdown offers Anthropic, Google, OpenAI and
// self-hosted. Anything offered there must actually work, or the org picks it and
// every review fails with "provider is not available".

interface Captured { url: string; headers: Record<string, string>; body: any }

function capture(respond: (c: Captured) => Response) {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const c = {
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    return respond(c);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

const geminiOk = () =>
  json({
    candidates: [{ content: { parts: [{ text: '{"summary":"ok","findings":[]}' }] } }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40 },
    modelVersion: "gemini-2.5-pro",
    responseId: "resp-1",
  });

// ---------- Google ----------

test("google: posts to generateContent with the key in a header, not the URL", async () => {
  const { fetchImpl, calls } = capture(geminiOk);
  const p = new GoogleProvider({ fetchImpl });
  await p.complete({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "hi" }], maxTokens: 64 }, "AIza-secret");

  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
  assert.equal(calls[0].headers["x-goog-api-key"], "AIza-secret");
  assert.ok(!calls[0].url.includes("AIza-secret"), "the key must never appear in a URL");
});

test("google: maps the assistant role to 'model' and lifts system out as systemInstruction", async () => {
  const { fetchImpl, calls } = capture(geminiOk);
  const p = new GoogleProvider({ fetchImpl });
  await p.complete(
    {
      model: "gemini-2.5-pro",
      system: "You are a reviewer.",
      messages: [
        { role: "user", content: "review this" },
        { role: "assistant", content: "ok" },
      ],
      maxTokens: 128,
      temperature: 0,
    },
    "k",
  );

  const b = calls[0].body;
  // Gemini rejects role "assistant" and has no system message type.
  assert.deepEqual(b.contents.map((c: any) => c.role), ["user", "model"]);
  assert.equal(b.systemInstruction.parts[0].text, "You are a reviewer.");
  assert.equal(b.generationConfig.maxOutputTokens, 128);
  assert.ok(!("system" in b), "system must not be sent as a top-level field");
});

test("google: returns text, usage and model", async () => {
  const { fetchImpl } = capture(geminiOk);
  const p = new GoogleProvider({ fetchImpl });
  const res = await p.complete({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "x" }], maxTokens: 8 }, "k");

  assert.match(res.text, /"summary":"ok"/);
  assert.equal(res.model, "gemini-2.5-pro");
  assert.deepEqual(res.usage, { inputTokens: 120, outputTokens: 40 });
});

test("google: a 'models/' prefixed id still resolves to the right path", async () => {
  const { fetchImpl, calls } = capture(geminiOk);
  await new GoogleProvider({ fetchImpl }).complete(
    { model: "models/gemini-2.5-flash", messages: [{ role: "user", content: "x" }], maxTokens: 8 }, "k");
  assert.match(calls[0].url, /models\/gemini-2\.5-flash:generateContent$/);
});

// A safety block returns HTTP 200 with zero candidates. Treating that as success
// would post an empty review and look like "the model found nothing".
test("google: a safety-blocked response is an error, not an empty review", async () => {
  const { fetchImpl } = capture(() => json({ candidates: [], promptFeedback: { blockReason: "SAFETY" } }));
  const p = new GoogleProvider({ fetchImpl });
  await assert.rejects(
    () => p.complete({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "x" }], maxTokens: 8 }, "k"),
    /no content \(SAFETY\)/,
  );
});

test("google: an HTTP error surfaces the status without echoing the key", async () => {
  const { fetchImpl } = capture(() => new Response('{"error":{"message":"API key not valid"}}', { status: 400 }));
  const p = new GoogleProvider({ fetchImpl });
  await assert.rejects(
    () => p.complete({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "x" }], maxTokens: 8 }, "sekret"),
    (err: Error) => /HTTP 400/.test(err.message) && !err.message.includes("sekret"),
  );
});

test("google: an empty BYOK key fails before any network call", async () => {
  let called = false;
  const { fetchImpl } = capture(() => { called = true; return geminiOk(); });
  await assert.rejects(
    () => new GoogleProvider({ fetchImpl }).complete({ model: "g", messages: [], maxTokens: 1 }, ""),
    /api key is empty/,
  );
  assert.equal(called, false);
});

// ---------- OpenAI ----------

const chatOk = () =>
  json({
    id: "chatcmpl-1",
    model: "gpt-5",
    choices: [{ message: { content: '{"summary":"ok","findings":[]}' } }],
    usage: { prompt_tokens: 90, completion_tokens: 20 },
  });

test("openai: posts chat completions with a bearer key and a system message", async () => {
  const { fetchImpl, calls } = capture(chatOk);
  const p = new OpenAIProvider({ fetchImpl });
  const res = await p.complete(
    { model: "gpt-4.1", system: "sys", messages: [{ role: "user", content: "hi" }], maxTokens: 32 }, "sk-test");

  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls[0].headers.authorization, "Bearer sk-test");
  assert.deepEqual(calls[0].body.messages[0], { role: "system", content: "sys" });
  assert.deepEqual(res.usage, { inputTokens: 90, outputTokens: 20 });
});

// GPT-5 / o-series reject `max_tokens` outright — a 400 on every single review.
test("openai: picks the token-budget field the model family accepts", () => {
  assert.equal(tokenBudgetField("gpt-5"), "max_completion_tokens");
  assert.equal(tokenBudgetField("gpt-5-mini"), "max_completion_tokens");
  assert.equal(tokenBudgetField("o4-mini"), "max_completion_tokens");
  assert.equal(tokenBudgetField("gpt-4.1"), "max_tokens");
  assert.equal(tokenBudgetField("gpt-4o"), "max_tokens");
});

test("openai: sends max_completion_tokens for gpt-5 and max_tokens for gpt-4o", async () => {
  const { fetchImpl, calls } = capture(chatOk);
  const p = new OpenAIProvider({ fetchImpl });
  await p.complete({ model: "gpt-5", messages: [{ role: "user", content: "x" }], maxTokens: 16 }, "k");
  await p.complete({ model: "gpt-4o", messages: [{ role: "user", content: "x" }], maxTokens: 16 }, "k");

  assert.equal(calls[0].body.max_completion_tokens, 16);
  assert.ok(!("max_tokens" in calls[0].body));
  assert.equal(calls[1].body.max_tokens, 16);
  assert.ok(!("max_completion_tokens" in calls[1].body));
});

// ---------- registry ----------

test("gateway: an unavailable provider names the ones that ARE available", async () => {
  const gw = new Gateway({
    providers: new Map([["anthropic", new FakeProvider(() => "x")], ["google", new FakeProvider(() => "x")]]),
    config: { orgs: { acme: { provider: "mistral", apiKey: "k", model: "m" } } },
  });
  await assert.rejects(
    () => gw.complete("acme", { messages: [{ role: "user", content: "x" }] }),
    /"mistral" is not available.*Available: anthropic, google/s,
  );
});
