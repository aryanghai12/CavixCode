import type { AgentSpec } from "./types.ts";

// The seven specialized reviewers. Breadth + abstention is the design: each agent
// is narrow and is told to stay silent outside its lane and when unsure.
export const AGENTS: AgentSpec[] = [
  { id: "correctness", category: "correctness", tier: "frontier",
    mission: "Logic bugs: off-by-one, null/undefined/nil dereferences, wrong conditionals, missing await on async calls, unhandled errors, incorrect return values." },
  { id: "security", category: "security", tier: "frontier",
    mission: "Vulnerabilities: injection (SQL/command), broken authz, SSRF, XSS, path traversal, weak crypto, secrets, unsafe deserialization." },
  { id: "concurrency", category: "concurrency", tier: "frontier",
    mission: "Concurrency defects: data races, unsynchronized shared state, deadlocks, missing locks/atomics, goroutine/promise leaks." },
  { id: "performance", category: "performance", tier: "cheap",
    mission: "Performance traps: N+1 queries, accidental O(n^2), unbounded allocations, blocking I/O on hot paths, missing pagination." },
  { id: "api-breaking", category: "api-breaking", tier: "frontier",
    mission: "Breaking changes: a changed function signature/contract/return shape that the provided CALLERS (possibly in other files) would break on. Cite the affected caller." },
  { id: "standards", category: "standards", tier: "cheap",
    mission: "Maintainability: dead code, confusing naming, copy-paste, missing input validation at boundaries. Only flag clear issues." },
  { id: "test-coverage", category: "test-coverage", tier: "cheap",
    mission: "Test gaps: new or changed behavior with no accompanying test, especially error paths and the cross-file callers shown in context." },
];

export function buildSystemPrompt(spec: AgentSpec): string {
  return `You are the Cavix "${spec.id}" review agent. Mission: ${spec.mission}

You are given the diff under review plus assembled context that may include CROSS-FILE callers, definitions, and past discussions. Use the cross-file context: a change can be wrong only in light of how another file uses it.

Rules:
- Stay strictly in your lane (${spec.id}); ignore issues other agents handle.
- ABSTAIN if you find nothing solid in your lane. Do not invent issues to seem useful.
- Only comment on lines ADDED in the diff. Use the new-file line number.
- Cite evidence; when the reason involves another file, include it in "evidence" with its path and line.

Respond with ONLY this JSON (no prose, no fences):
{
  "abstain": <true|false>,
  "findings": [
    {
      "path": "<file>", "line": <int>, "severity": "critical|high|medium|low|info",
      "category": "${spec.category}", "title": "<headline>", "body": "<why it matters>",
      "confidence": <0..1>, "suggestion": "<optional fixed code>",
      "evidence": [ { "path": "<file>", "line": <int>, "note": "<what this proves>" } ]
    }
  ]
}
If abstaining, set "abstain": true and "findings": [].`;
}

export function buildUserPrompt(title: string, diff: string, contextPrompt: string): string {
  return [
    `Pull request: ${title}`,
    "",
    "## Assembled context",
    contextPrompt || "_(none)_",
    "",
    "## Diff under review",
    "```diff",
    diff.trimEnd(),
    "```",
  ].join("\n");
}
