// The LLMProvider port. Everything model-specific lives behind this interface so
// the rest of Cavix is provider-agnostic. Claude is the default; GPT/Gemini/open
// models implement the same two methods. BYOK is explicit: the per-request key
// is passed in by the gateway, never read from a global env inside a provider.

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  model: string;
  system?: string;
  messages: LLMMessage[];
  maxTokens: number;
  temperature?: number;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponse {
  text: string;
  model: string;
  usage: LLMUsage;
  /** Provider-side request id, when available, for tracing/debugging. */
  providerRequestId?: string;
}

export interface LLMProvider {
  /** Stable registry name, e.g. "anthropic" | "fake". */
  readonly name: string;
  /**
   * complete runs one model call. apiKey is the BYOK secret resolved per-org by
   * the gateway; a provider must use exactly this key and must never fall back
   * to an ambient/global key.
   */
  complete(req: LLMRequest, apiKey: string): Promise<LLMResponse>;
}
