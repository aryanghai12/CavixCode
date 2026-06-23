import type { Gateway } from "@cavix/gateway";
import type { ReviewResult } from "@cavix/core";
import { REVIEW_SYSTEM_PROMPT, buildUserMessage } from "./prompt.ts";
import { parseModelReview } from "./parse.ts";

// Reviewer runs one model pass over a diff and returns structured findings plus
// the usage/cost recorded by the gateway. It is provider-agnostic and BYOK-safe:
// it only knows the org id and asks the gateway to resolve the rest.

export interface ReviewInput {
  org: string;
  title: string;
  diff: string;
  /** Optional model override (e.g. cheaper model for small diffs). */
  model?: string;
}

export interface ReviewerOptions {
  gateway: Gateway;
  maxTokens?: number;
}

export class Reviewer {
  private readonly gateway: Gateway;
  private readonly maxTokens: number;

  constructor(opts: ReviewerOptions) {
    this.gateway = opts.gateway;
    this.maxTokens = opts.maxTokens ?? 4096;
  }

  async review(input: ReviewInput): Promise<ReviewResult> {
    const { response, cost } = await this.gateway.complete(input.org, {
      system: REVIEW_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessage({ title: input.title, diff: input.diff }) }],
      model: input.model,
      maxTokens: this.maxTokens,
      temperature: 0,
    });

    const parsed = parseModelReview(response.text);
    return {
      summary: parsed.summary,
      findings: parsed.findings,
      usage: response.usage,
      costUsd: cost.costUsd,
      model: response.model,
    };
  }
}
