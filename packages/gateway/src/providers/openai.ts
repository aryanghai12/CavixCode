import type { LLMProvider, LLMRequest, LLMResponse, ModelInfo } from "../provider.ts";

// OpenAIProvider calls the Chat Completions API directly over fetch. The wire
// format is the same one SelfHostedProvider speaks (vLLM/Ollama/TGI all emulate
// it); this class exists separately because it is a hosted, keyed, public
// endpoint rather than an in-cluster one, and because the newer model families
// renamed the token-budget parameter.

const DEFAULT_BASE_URL = "https://api.openai.com";

export interface OpenAIOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Azure/OpenAI-compatible gateways sometimes need an org header. */
  organization?: string;
}

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * The GPT-5 and o-series families reject `max_tokens` and require
 * `max_completion_tokens`. Sending the wrong one is a hard 400, so pick by model.
 */
export function tokenBudgetField(model: string): "max_tokens" | "max_completion_tokens" {
  return /^(gpt-5|o\d)/i.test(model) ? "max_completion_tokens" : "max_tokens";
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly organization?: string;

  constructor(opts: OpenAIOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.organization = opts.organization;
  }

  listModels(apiKey: string): Promise<ModelInfo[]> {
    return listOpenAICompatibleModels(apiKey, { baseUrl: this.baseUrl, fetchImpl: this.fetchImpl });
  }

  async complete(req: LLMRequest, apiKey: string): Promise<LLMResponse> {
    if (!apiKey) throw new Error("openai: BYOK api key is empty");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      };
      if (this.organization) headers["openai-organization"] = this.organization;

      const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: req.model,
          messages: [
            ...(req.system ? [{ role: "system", content: req.system }] : []),
            ...req.messages.map((m) => ({ role: m.role, content: m.content })),
          ],
          [tokenBudgetField(req.model)]: req.maxTokens,
          temperature: req.temperature ?? 0,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`openai: HTTP ${res.status} ${res.statusText}: ${truncate(body, 500)}`);
      }

      const data = (await res.json()) as ChatResponse;
      const text = data.choices?.[0]?.message?.content ?? "";
      return {
        text,
        model: data.model ?? req.model,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
        providerRequestId: data.id,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * List models from any OpenAI-compatible `/v1/models` endpoint — OpenAI itself,
 * and self-hosted servers (vLLM, Ollama, TGI) that emulate it. Returns only
 * chat-capable ids; the raw list also contains embeddings, TTS and moderation
 * models that would fail as a review model.
 */
export async function listOpenAICompatibleModels(
  apiKey: string,
  opts: { baseUrl?: string | undefined; fetchImpl?: typeof fetch } = {},
): Promise<ModelInfo[]> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const res = await doFetch(`${baseUrl}/v1/models`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openai: list models HTTP ${res.status} ${res.statusText}: ${truncate(body, 300)}`);
  }
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  return (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => !!id && isChatModel(id))
    .sort()
    .map((id) => ({ id }));
}

/** OpenAI returns every model on the account, most of which cannot chat. */
function isChatModel(id: string): boolean {
  if (/embedding|whisper|tts|dall-e|moderation|audio|realtime|image|transcribe/i.test(id)) return false;
  return /^(gpt|o\d|chatgpt)/i.test(id) || !/^(text-|davinci|babbage|curie|ada)/i.test(id);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
