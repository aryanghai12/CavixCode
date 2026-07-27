import type { LLMProvider, LLMRequest, LLMResponse } from "../provider.ts";

// GoogleProvider calls the Gemini generateContent API directly over fetch — no
// SDK, matching the Anthropic provider and the repo's dependency-free stance.
//
// Gemini differs from the other providers in three ways that all have to be
// handled here rather than leaking upstream:
//   • the assistant role is called "model", not "assistant";
//   • the system prompt is a separate `systemInstruction`, not a message;
//   • the API key goes in the x-goog-api-key header (a ?key= query param also
//     works but would end up in logs and proxy access records).

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";

export interface GoogleOptions {
  baseUrl?: string;
  /** Per-call timeout in ms; guards against a hung upstream. */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
  responseId?: string;
  promptFeedback?: { blockReason?: string };
}

export class GoogleProvider implements LLMProvider {
  readonly name = "google";
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GoogleOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(req: LLMRequest, apiKey: string): Promise<LLMResponse> {
    if (!apiKey) throw new Error("google: BYOK api key is empty");

    // Accept "models/gemini-x" or a bare id; the path always needs the bare id.
    const model = req.model.replace(/^models\//, "");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/${API_VERSION}/models/${model}:generateContent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // BYOK: the caller-supplied key, nothing ambient. Header rather than
          // ?key= so the secret never lands in a URL.
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: req.messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
          ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
          generationConfig: {
            maxOutputTokens: req.maxTokens,
            temperature: req.temperature ?? 0,
          },
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // Never echo headers (they carry the key).
        throw new Error(`google: HTTP ${res.status} ${res.statusText}: ${truncate(body, 500)}`);
      }

      const data = (await res.json()) as GeminiResponse;

      // A safety filter returns 200 with no candidates. Without this the caller
      // would see an empty review and assume the model found nothing.
      if (!data.candidates?.length) {
        const reason = data.promptFeedback?.blockReason ?? "no candidates returned";
        throw new Error(`google: the model returned no content (${reason})`);
      }

      const text = (data.candidates[0].content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");

      return {
        text,
        model: data.modelVersion ?? model,
        usage: {
          inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        },
        providerRequestId: data.responseId,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
