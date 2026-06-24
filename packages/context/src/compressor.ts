import type { Gateway } from "@cavix/gateway";
import type { Compressor } from "./types.ts";

// GatewayCompressor: cheap-model compression (Stage 7). It deliberately routes to
// a cheap model (default Haiku) — compression is a high-volume, low-reasoning task
// where frontier models would be wasteful. BYOK/cost accounting flow through the
// gateway like any other call.
export class GatewayCompressor implements Compressor {
  private readonly gateway: Gateway;
  private readonly org: string;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: { gateway: Gateway; org: string; model?: string; maxTokens?: number }) {
    this.gateway = opts.gateway;
    this.org = opts.org;
    this.model = opts.model ?? "claude-haiku-4-5-20251001";
    this.maxTokens = opts.maxTokens ?? 512;
  }

  async compress(text: string, instruction: string): Promise<string> {
    const { response } = await this.gateway.complete(this.org, {
      model: this.model,
      maxTokens: this.maxTokens,
      temperature: 0,
      system: "You compress code/logs into a tight brief that preserves facts a reviewer needs. Be terse.",
      messages: [{ role: "user", content: `${instruction}\n\n---\n${text}` }],
    });
    return response.text.trim();
  }
}

// FakeCompressor: deterministic, no model — keeps the head and notes the elision.
export class FakeCompressor implements Compressor {
  private readonly keepChars: number;
  constructor(keepChars = 200) {
    this.keepChars = keepChars;
  }
  async compress(text: string, _instruction: string): Promise<string> {
    if (text.length <= this.keepChars) return text;
    return text.slice(0, this.keepChars).trimEnd() + ` … [compressed ${text.length} chars]`;
  }
}
