// Prompt construction for the single-model review pass (Stage 8, single-model in
// Phase 0). The system prompt pins the output to a strict JSON schema so the
// result is machine-parseable, and constrains the model to comment only on lines
// the PR actually changed — Cavix never comments on untouched code.
//
// This is the seam where Cavix's "prove it" philosophy will later inject
// retrieved context (Stage 7) and verification demands (Stage 10). For now it is
// a competent single-pass reviewer.

export interface PromptInput {
  title: string;
  diff: string;
}

export const REVIEW_SYSTEM_PROMPT = `You are Cavix, a precise code reviewer. You review a single pull request diff.

Rules:
- Only report issues you are confident are real: correctness bugs, security
  vulnerabilities, resource/error-handling defects, and clear performance traps.
- Do NOT report style nits, formatting, or speculative concerns.
- Only comment on lines that were ADDED in the diff (lines beginning with '+').
- Use the NEW-file line number for each finding.
- Prefer fewer, higher-signal findings over many low-value ones.

Respond with ONLY a JSON object (no prose, no markdown fences) of the form:
{
  "summary": "<2-4 sentence overview of the change and its risk>",
  "findings": [
    {
      "path": "<file path as in the diff>",
      "line": <integer new-file line number>,
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "category": "security" | "correctness" | "performance" | "reliability" | "other",
      "title": "<short headline>",
      "body": "<explanation of the issue and why it matters>",
      "suggestion": "<optional: corrected code for this line>",
      "confidence": <number between 0 and 1>
    }
  ]
}
If there are no issues, return an empty "findings" array.`;

/** Build the user message: PR title + the unified diff under review. */
export function buildUserMessage(input: PromptInput): string {
  return [
    `Pull request title: ${input.title}`,
    "",
    "Unified diff under review:",
    "```diff",
    input.diff.trimEnd(),
    "```",
  ].join("\n");
}
