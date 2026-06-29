import type { LLMProvider, LLMRequest, LLMResponse } from "../provider.ts";

// SelfHostedProvider speaks the OpenAI-compatible Chat Completions API that local
// model servers (vLLM, Ollama, llama.cpp, TGI) expose. In air-gapped mode the
// baseUrl points at an IN-CLUSTER endpoint and the fetch is wrapped by the
// EgressGuard, so model inference never leaves the cluster. BYOK still applies
// (a local token), and cost accounting flows through the gateway as usual.

export interface SelfHostedOptions {
  /** In-cluster base URL, e.g. http://cavix-model.cavix.svc.cluster.local:8000 */
  baseUrl: string;
  /** Guarded fetch (from createGuardedFetch) — REQUIRED for air-gap safety. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface OpenAIChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class SelfHostedProvider implements LLMProvider {
  readonly name = "selfhosted";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: SelfHostedOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async complete(req: LLMRequest, apiKey: string): Promise<LLMResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const messages = [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ];
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: req.model, messages, max_tokens: req.maxTokens, temperature: req.temperature ?? 0 }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`selfhosted: HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as OpenAIChatResponse;
      const text = data.choices?.[0]?.message?.content ?? "";
      return {
        text,
        model: data.model ?? req.model,
        usage: { inputTokens: data.usage?.prompt_tokens ?? estimate(messages), outputTokens: data.usage?.completion_tokens ?? Math.ceil(text.length / 4) },
        providerRequestId: data.id,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function estimate(messages: Array<{ content: string }>): number {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
}
