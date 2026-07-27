import type { LLMProvider, LLMRequest, LLMResponse } from "../provider.ts";

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

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
