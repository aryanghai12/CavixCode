import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModelReview, extractJsonObject } from "@cavix/orchestrator";

test("extractJsonObject: pulls JSON out of prose + code fences", () => {
  const text = 'Sure, here is the review:\n```json\n{"summary":"ok","findings":[]}\n```\nThanks!';
  assert.equal(extractJsonObject(text), '{"summary":"ok","findings":[]}');
});

test("extractJsonObject: handles braces inside strings", () => {
  const text = '{"summary":"use {curly} carefully","findings":[]}';
  assert.equal(extractJsonObject(text), text);
});

test("parseModelReview: coerces a valid finding and tags source=llm", () => {
  const text = JSON.stringify({
    summary: "Adds a query.",
    findings: [
      {
        path: "src/auth.js",
        line: 13,
        severity: "high",
        category: "security",
        title: "SQL injection",
        body: "User id concatenated into SQL.",
        suggestion: "db.query('... WHERE id = ?', [user.id])",
        confidence: 0.9,
      },
    ],
  });
  const parsed = parseModelReview(text);
  assert.equal(parsed.summary, "Adds a query.");
  assert.equal(parsed.findings.length, 1);
  const f = parsed.findings[0];
  assert.equal(f.source, "llm");
  assert.equal(f.severity, "high");
  assert.equal(f.line, 13);
});

test("parseModelReview: drops malformed findings but keeps good ones", () => {
  const text = JSON.stringify({
    summary: "mixed",
    findings: [
      { path: "", line: 1, title: "no path" }, // invalid → dropped
      { path: "a.js", line: 0, title: "bad line" }, // invalid → dropped
      { path: "a.js", line: 5, title: "good", severity: "weird", confidence: 7 }, // kept, coerced
    ],
  });
  const parsed = parseModelReview(text);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].severity, "info"); // unknown severity → info
  assert.equal(parsed.findings[0].confidence, 1); // clamped to [0,1]
});

test("parseModelReview: throws on totally non-JSON reply", () => {
  assert.throws(() => parseModelReview("I could not analyze this."), /no JSON object/);
});
