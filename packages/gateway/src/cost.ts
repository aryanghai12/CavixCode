import type { LLMUsage } from "./provider.ts";

// Cost accounting (Stage 13) starts here. Prices are USD per 1,000,000 tokens.
//
// IMPORTANT: these are *configurable defaults*, not ground truth. List prices
// change and BYOK customers may have negotiated rates, so operators override
// this table via gateway config. Logic never bakes in a number — it always
// reads from a ModelPrice map. Unknown models cost 0 here but still log token
// counts, so spend is never silently fabricated.
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  // Claude family (default routing: Opus reason / Sonnet build / Haiku compress).
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  // Sonnet 5 list price. An introductory $2/$10 runs through 2026-08-31; we bill
  // the list rate so an org is never under-quoted when the promo ends.
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
  // Google Gemini.
  "gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  "gemini-2.0-flash": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  // OpenAI.
  "gpt-5": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "gpt-5-mini": { inputPerMTok: 0.25, outputPerMTok: 2 },
  "gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8 },
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
  "o4-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  // Deterministic test provider — free.
  "fake-model": { inputPerMTok: 0, outputPerMTok: 0 },
};

/** computeCostUsd converts a usage record into dollars under a pricing table. */
export function computeCostUsd(
  model: string,
  usage: LLMUsage,
  pricing: Record<string, ModelPrice> = DEFAULT_PRICING,
): number {
  const p = pricing[model];
  if (!p) return 0;
  const cost =
    (usage.inputTokens / 1_000_000) * p.inputPerMTok +
    (usage.outputTokens / 1_000_000) * p.outputPerMTok;
  // Round to 6 decimals (sub-cent precision) to keep ledgers tidy.
  return Math.round(cost * 1e6) / 1e6;
}
