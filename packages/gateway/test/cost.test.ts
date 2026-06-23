import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCostUsd } from "@cavix/gateway";

test("computeCostUsd: priced model", () => {
  // Sonnet default: $3/MTok in, $15/MTok out.
  const c = computeCostUsd("claude-sonnet-4-6", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(c, 18);
});

test("computeCostUsd: partial tokens round to sub-cent", () => {
  const c = computeCostUsd("claude-haiku-4-5-20251001", { inputTokens: 1234, outputTokens: 567 });
  // (1234/1e6)*1 + (567/1e6)*5 = 0.001234 + 0.002835 = 0.004069
  assert.equal(c, 0.004069);
});

test("computeCostUsd: unknown model costs 0 (never fabricates spend)", () => {
  const c = computeCostUsd("mystery-model", { inputTokens: 9_999, outputTokens: 9_999 });
  assert.equal(c, 0);
});

test("computeCostUsd: custom pricing overrides defaults (config over hardcode)", () => {
  const c = computeCostUsd(
    "claude-sonnet-4-6",
    { inputTokens: 1_000_000, outputTokens: 0 },
    { "claude-sonnet-4-6": { inputPerMTok: 2.4, outputPerMTok: 12 } },
  );
  assert.equal(c, 2.4);
});
