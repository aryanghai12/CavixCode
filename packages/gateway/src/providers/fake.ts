import type { LLMProvider, LLMRequest, LLMResponse } from "../provider.ts";

// FakeProvider is a deterministic in-process provider for tests and the eval
// harness — no network, no key needed to be valid. It also RECORDS the apiKey it
// was handed, which is what lets a test prove the BYOK path routes the right
// org's key to the model call.

export type FakeResponder = (req: LLMRequest, apiKey: string) => string;

export class FakeProvider implements LLMProvider {
  readonly name = "fake";
  /** Keys seen, in call order — used by BYOK tests to assert routing. */
  readonly seenKeys: string[] = [];
  /** Full requests seen, for assertions in tests. */
  readonly seenRequests: LLMRequest[] = [];

  // The responder turns a request into the model's text output. Default echoes
  // a trivial reply; tests/eval inject a responder that returns findings JSON.
  private readonly responder: FakeResponder;

  constructor(responder: FakeResponder = () => "ok") {
    this.responder = responder;
  }

  async complete(req: LLMRequest, apiKey: string): Promise<LLMResponse> {
    this.seenKeys.push(apiKey);
    this.seenRequests.push(req);
    const text = this.responder(req, apiKey);
    // Deterministic, cheap token estimate (~4 chars/token) so cost accounting
    // produces stable, non-zero-shaped numbers in tests without a tokenizer.
    const inputChars = (req.system ?? "").length + req.messages.reduce((n, m) => n + m.content.length, 0);
    return {
      text,
      model: req.model,
      usage: {
        inputTokens: Math.ceil(inputChars / 4),
        outputTokens: Math.ceil(text.length / 4),
      },
      providerRequestId: `fake-${this.seenKeys.length}`,
    };
  }
}
