import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GoogleProvider, OpenAIProvider, tokenBudgetField, Gateway, FakeProvider,
  listGoogleModels, listAnthropicModels, listOpenAICompatibleModels,
} from "@cavix/gateway";

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

// ---------- live model discovery ----------
//
// A hardcoded dropdown drifts: providers retire models and gate others by plan
// or account age. Offering one the key cannot call only surfaces later as a
// failed review ("this model is no longer available to new users"), so the list
// has to come from the provider.

test("google: lists only models that can actually generate content", async () => {
  const { fetchImpl, calls } = capture(() =>
    json({
      models: [
        { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro",
          supportedGenerationMethods: ["generateContent", "countTokens"],
          inputTokenLimit: 1048576, outputTokenLimit: 65536 },
        // Embedding models appear in the same list and would fail as a reviewer.
        { name: "models/text-embedding-004", displayName: "Embedding",
          supportedGenerationMethods: ["embedContent"] },
        { name: "models/gemini-2.0-flash", supportedGenerationMethods: ["generateContent"] },
      ],
    }),
  );
  const models = await listGoogleModels("AIza-key", { fetchImpl });

  assert.deepEqual(models.map((m) => m.id), ["gemini-2.5-pro", "gemini-2.0-flash"]);
  assert.equal(models[0].label, "Gemini 2.5 Pro");
  assert.equal(models[0].contextWindow, 1048576);
  assert.equal(calls[0].headers["x-goog-api-key"], "AIza-key");
  assert.ok(!calls[0].url.includes("AIza-key"), "the key must not appear in the URL");
});

test("google: follows nextPageToken", async () => {
  let n = 0;
  const { fetchImpl, calls } = capture(() => {
    n++;
    return n === 1
      ? json({ models: [{ name: "models/a", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "tok2" })
      : json({ models: [{ name: "models/b", supportedGenerationMethods: ["generateContent"] }] });
  });
  const models = await listGoogleModels("k", { fetchImpl });
  assert.deepEqual(models.map((m) => m.id), ["a", "b"]);
  assert.match(calls[1].url, /pageToken=tok2/);
});

test("anthropic: lists models and follows has_more pagination", async () => {
  let n = 0;
  const { fetchImpl, calls } = capture(() => {
    n++;
    return n === 1
      ? json({ data: [{ id: "claude-opus-5", display_name: "Claude Opus 5", max_input_tokens: 1000000, max_tokens: 128000 }],
               has_more: true, last_id: "claude-opus-5" })
      : json({ data: [{ id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" }], has_more: false });
  });
  const models = await listAnthropicModels("sk-ant-key", { fetchImpl });

  assert.deepEqual(models.map((m) => m.id), ["claude-opus-5", "claude-haiku-4-5"]);
  assert.equal(models[0].contextWindow, 1000000);
  assert.equal(calls[0].headers["x-api-key"], "sk-ant-key");
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  assert.match(calls[1].url, /after_id=claude-opus-5/);
});

test("openai: filters out models that cannot chat", async () => {
  const { fetchImpl, calls } = capture(() =>
    json({
      data: [
        { id: "gpt-5" }, { id: "gpt-4o" },
        { id: "text-embedding-3-large" }, { id: "whisper-1" },
        { id: "dall-e-3" }, { id: "tts-1" }, { id: "omni-moderation-latest" },
      ],
    }),
  );
  const models = await listOpenAICompatibleModels("sk-test", { fetchImpl });

  assert.deepEqual(models.map((m) => m.id), ["gpt-4o", "gpt-5"]);
  assert.equal(calls[0].headers.authorization, "Bearer sk-test");
});

test("listing surfaces a bad key clearly, without echoing it", async () => {
  const { fetchImpl } = capture(() => new Response('{"error":{"message":"API key not valid"}}', { status: 400 }));
  await assert.rejects(
    () => listGoogleModels("bad-secret", { fetchImpl }),
    (err: Error) => /list models HTTP 400/.test(err.message) && !err.message.includes("bad-secret"),
  );
});
