import type { LLMProvider, LLMRequest, LLMResponse, ModelInfo } from "../provider.ts";

// AnthropicProvider calls the Claude Messages API directly over fetch (built
// into Node) — no SDK dependency, consistent with the edge's zero-dep stance and
// friendlier to air-gapped/proxy deployments. The base URL is configurable so a
// self-hosted gateway/proxy (or a different Anthropic-compatible endpoint) can
// be slotted in without code changes.

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicOptions {
  baseUrl?: string;
  /** Per-call timeout in ms; guards against a hung upstream. */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface AnthropicMessageResponse {
  id: string;
  model: string;
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AnthropicOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  listModels(apiKey: string): Promise<ModelInfo[]> {
    return listAnthropicModels(apiKey, { baseUrl: this.baseUrl, fetchImpl: this.fetchImpl });
  }

  async complete(req: LLMRequest, apiKey: string): Promise<LLMResponse> {
    if (!apiKey) throw new Error("anthropic: BYOK api key is empty");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // BYOK: the caller-supplied key, nothing ambient.
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          temperature: req.temperature ?? 0,
          system: req.system,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // Never echo headers (they carry the key). Body may include a request id.
        throw new Error(`anthropic: HTTP ${res.status} ${res.statusText}: ${truncate(body, 500)}`);
      }

      const data = (await res.json()) as AnthropicMessageResponse;
      const text = data.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");

      return {
        text,
        model: data.model,
        usage: {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
        },
        providerRequestId: data.id,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * List the Claude models this key can call. `GET /v1/models` paginates with
 * `after_id` + `has_more`, and returns newest-first.
 */
export async function listAnthropicModels(
  apiKey: string,
  opts: { baseUrl?: string | undefined; fetchImpl?: typeof fetch } = {},
): Promise<ModelInfo[]> {
  if (!apiKey) throw new Error("anthropic: BYOK api key is empty");
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;

  const out: ModelInfo[] = [];
  let afterId = "";
  for (let page = 0; page < 10; page++) {
    const url = `${baseUrl}/v1/models?limit=100${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ""}`;
    const res = await doFetch(url, {
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`anthropic: list models HTTP ${res.status} ${res.statusText}: ${truncate(body, 300)}`);
    }
    const data = (await res.json()) as {
      data?: Array<{ id?: string; display_name?: string; max_input_tokens?: number; max_tokens?: number }>;
      has_more?: boolean;
      last_id?: string;
    };
    for (const m of data.data ?? []) {
      if (!m.id) continue;
      out.push({
        id: m.id,
        label: m.display_name,
        contextWindow: m.max_input_tokens,
        maxOutputTokens: m.max_tokens,
      });
    }
    if (!data.has_more || !data.last_id) break;
    afterId = data.last_id;
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
