import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModelReview, isPermanentFailure } from "@cavix/orchestrator";

// A refusal is not a clean review.
//
// The real failure, from a live pull request: the model answered "I cannot
// review this pull request as the prompt only asks for a general review without
// a specific question. Please ask a specific question about the code." inside a
// well-formed JSON object. Zero findings is a valid review, so Cavix posted
// "Clean pass. Nothing to raise", put a green check on the pull request, and
// spliced the refusal itself into the description as the executive summary.
//
// The reader sees a reviewed, passing pull request. Nothing read a line of it.
// That is the worst output this product can produce, because the green check is
// what somebody merges on.

const refusal = (summary: string) => JSON.stringify({ summary, walkthrough: [], findings: [] });

test("the exact refusal seen in production is rejected", () => {
  assert.throws(
    () =>
      parseModelReview(
        refusal(
          "I cannot review this pull request as the prompt only asks for a general review " +
            "without a specific question. Please ask a specific question about the code.",
        ),
      ),
    /declined to review/,
  );
});

test("common refusal shapes are all caught", () => {
  for (const s of [
    "I cannot review this pull request without more context.",
    "I'm unable to analyze this diff. Please provide more information.",
    "As an AI, I cannot assess this code.",
    "Sorry, but I can't review this change.",
    "Unfortunately I do not have enough information to review this.",
    "Please ask a specific question about the code.",
    "I can't help with that. Please specify a question.",
  ]) {
    assert.throws(() => parseModelReview(refusal(s)), /declined to review/, s);
  }
});

test("the failure names the model's own words, so the cause is not a guess", () => {
  try {
    parseModelReview(refusal("I cannot review this pull request without a specific question."));
    assert.fail("should have thrown");
  } catch (err) {
    assert.match((err as Error).message, /without a specific question/);
  }
});

test("a refusal is permanent: asking the same model again gets the same answer", () => {
  // Retrying three times gets the same refusal three times slower, and every
  // retry is invisible to the person waiting on the pull request.
  assert.equal(isPermanentFailure("the model declined to review this change: I cannot review"), true);
});

// ---------- and now everything that must still get through ----------

test("a genuinely clean review is still a clean review", () => {
  // The whole risk of this check is that it eats real reviews. A clean pass has
  // a walkthrough, because the prompt demands one entry per file.
  const clean = JSON.stringify({
    summary: "Adds a null guard to the refund path so a missing order no longer throws.",
    walkthrough: [{ path: "src/refund.ts", summary: "Guards against a missing order." }],
    findings: [],
  });
  const parsed = parseModelReview(clean);
  assert.equal(parsed.findings.length, 0);
  assert.match(parsed.summary, /null guard/);
});

test("a summary that merely contains the word cannot is not a refusal", () => {
  // "Callers cannot retry safely" is a review, not a refusal. Anchoring the
  // pattern near the start of the sentence is what keeps this working.
  const real = JSON.stringify({
    summary: "Refunds become idempotent. Callers cannot retry safely today, which this fixes.",
    walkthrough: [{ path: "src/refund.ts", summary: "Adds an idempotency key." }],
    findings: [],
  });
  assert.equal(parseModelReview(real).summary.startsWith("Refunds"), true);
});

test("a review with findings is never treated as a refusal, whatever the summary says", () => {
  // If it found something, it looked. That settles it.
  const odd = JSON.stringify({
    summary: "I cannot fully assess the concurrency here.",
    walkthrough: [],
    findings: [
      { path: "src/a.ts", line: 4, severity: "high", title: "Missing await", body: "", confidence: 0.8 },
    ],
  });
  const parsed = parseModelReview(odd);
  assert.equal(parsed.findings.length, 1);
});

test("a walkthrough with no findings is a real clean review, not a refusal", () => {
  const clean = JSON.stringify({
    summary: "I cannot see a problem with this change.",
    walkthrough: [{ path: "a.ts", summary: "Renames a local variable." }],
    findings: [],
  });
  assert.equal(parseModelReview(clean).findings.length, 0);
});

test("an empty summary with nothing else is a different failure, not a refusal", () => {
  // An empty diff or a bare skeleton. Reporting that as "the model refused"
  // would send somebody to change their model over something else entirely.
  const bare = JSON.stringify({ summary: "", walkthrough: [], findings: [] });
  assert.equal(parseModelReview(bare).summary, "");
});
