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

/** One model the caller's API key is actually entitled to use. */
export interface ModelInfo {
  /** The id to send as `model` on a request. */
  id: string;
  /** Human label for the dropdown; falls back to the id. */
  label?: string;
  /** Context window, when the provider reports it. */
  contextWindow?: number;
  /** Max output tokens, when the provider reports it. */
  maxOutputTokens?: number;
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
  /**
   * List the models THIS key may use, newest/most capable first.
   *
   * Providers retire models and gate others by plan or account age, so a
   * hardcoded dropdown eventually offers something the user cannot call — which
   * only shows up as a failed review. Asking the provider is the only reliable
   * answer. Optional: a provider without a listing endpoint simply omits it.
   */
  listModels?(apiKey: string): Promise<ModelInfo[]>;
}
