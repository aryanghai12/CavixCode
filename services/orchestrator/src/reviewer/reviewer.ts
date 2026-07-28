import type { Gateway } from "@cavix/gateway";
import type { ReviewResult } from "@cavix/core";
import {
  ASK_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  buildAskMessage,
  buildUserMessage,
  toneRule,
} from "./prompt.ts";
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
  /** How the org asked Cavix to write, chosen on the dashboard. */
  tone?: string;
}

export interface AskInput {
  org: string;
  title: string;
  diff: string;
  /** The question a human typed after "@cavixcode". */
  question: string;
  model?: string;
  tone?: string;
}

export interface AskResult {
  answer: string;
  costUsd: number;
  model: string;
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
      system: REVIEW_SYSTEM_PROMPT + toneRule(input.tone),
      messages: [{ role: "user", content: buildUserMessage({ title: input.title, diff: input.diff }) }],
      model: input.model,
      maxTokens: this.maxTokens,
      temperature: 0,
    });

    const parsed = parseModelReview(response.text);
    return {
      summary: parsed.summary,
      findings: parsed.findings,
      walkthrough: parsed.walkthrough,
      effort: parsed.effort,
      usage: response.usage,
      costUsd: cost.costUsd,
      model: response.model,
    };
  }

  /**
   * The prose half of a review: summary, walkthrough and effort, no findings.
   *
   * Used when the deep pipeline produced the findings, so this is the only pass
   * that has to describe the change. It reuses the review parser, which already
   * tolerates a missing `findings` array, so there is one JSON shape to maintain
   * rather than two.
   */
  async summarise(input: ReviewInput): Promise<ReviewResult> {
    const { response, cost } = await this.gateway.complete(input.org, {
      system: SUMMARY_SYSTEM_PROMPT + toneRule(input.tone),
      messages: [{ role: "user", content: buildUserMessage({ title: input.title, diff: input.diff }) }],
      model: input.model,
      maxTokens: this.maxTokens,
      temperature: 0,
    });
    const parsed = parseModelReview(response.text);
    return {
      summary: parsed.summary,
      // Belt and braces: the prompt forbids findings, but a model that returns
      // them anyway must not have them reach a pull request unadjudicated.
      findings: [],
      walkthrough: parsed.walkthrough,
      effort: parsed.effort,
      usage: response.usage,
      costUsd: cost.costUsd,
      model: response.model,
    };
  }

  /**
   * Answer a question someone typed on the pull request ("@cavixcode does this
   * handle a retry?").
   *
   * A separate, cheaper path from review(): it returns prose rather than the
   * finding schema, and it must never invent a finding. Before this existed,
   * every non-command mention ran a full review, which meant asking Cavix a
   * question posted a second review on the pull request and billed for it.
   */
  async ask(input: AskInput): Promise<AskResult> {
    const { response, cost } = await this.gateway.complete(input.org, {
      system: ASK_SYSTEM_PROMPT + toneRule(input.tone),
      messages: [
        { role: "user", content: buildAskMessage({ title: input.title, diff: input.diff, question: input.question }) },
      ],
      model: input.model,
      maxTokens: this.maxTokens,
      temperature: 0,
    });
    return { answer: response.text.trim(), costUsd: cost.costUsd, model: response.model };
  }
}
