import { test } from "node:test";
import assert from "node:assert/strict";
import type { CallTrace } from "@cavix/analyzer";
import { labelPaths, mermaidText, renderSequenceDiagram } from "../src/poster/mermaid.ts";

// GitHub parses ```mermaid natively, which is the whole reason this feature is
// worth having and also its only real risk: a syntax error is not a missing
// diagram, it is a red error box sitting in a customer's pull request under
// Cavix's name. These tests are mostly about that.

const step = (fromPath: string, fromSymbol: string, toPath: string, toSymbol: string, line = 1) => ({
  fromPath,
  fromSymbol,
  toPath,
  toSymbol,
  line,
});

const TRACE: CallTrace = {
  participants: ["src/webhook.ts", "src/refund.ts", "src/audit.ts"],
  steps: [
    step("src/webhook.ts", "onWebhook", "src/refund.ts", "issueRefund", 8),
    step("src/refund.ts", "issueRefund", "src/audit.ts", "writeAudit", 6),
  ],
  entryPoints: ["onWebhook"],
  truncated: false,
};

test("renders a fenced mermaid block GitHub will parse", () => {
  const out = renderSequenceDiagram(TRACE).join("\n");
  assert.match(out, /```mermaid\nsequenceDiagram\n/);
  assert.match(out, /participant P0 as webhook\.ts/);
  assert.match(out, /P0->>P1: issueRefund\(\)/);
  assert.match(out, /P1->>P2: writeAudit\(\)/);
  const fences = out.split("\n").filter((l) => l.startsWith("```"));
  assert.deepEqual(fences, ["```mermaid", "```"], "opened once, closed once");
});

test("the caption says what the diagram is OF, and never more", () => {
  const out = renderSequenceDiagram(TRACE).join("\n");
  assert.match(out, /Traced from `onWebhook`, across 3 files, from the resolved call graph\./);
  assert.doesNotMatch(out, /Longer paths/, "nothing was cut, so nothing claims it was");

  const cut = renderSequenceDiagram({ ...TRACE, truncated: true }).join("\n");
  assert.match(cut, /Longer paths exist/, "and when it was cut, it says so");
});

test("nothing to draw renders nothing at all, never an empty diagram", () => {
  // An empty section reads as a broken feature; an absent one reads as "not
  // relevant here", which is the truth for most pull requests.
  assert.deepEqual(renderSequenceDiagram(undefined), []);
  assert.deepEqual(renderSequenceDiagram({ ...TRACE, steps: [] }), []);
  assert.deepEqual(renderSequenceDiagram({ ...TRACE, participants: ["src/only.ts"] }), []);
});

// ── the red-box guards ───────────────────────────────────────────────────────

test("Mermaid's own metacharacters never reach the block", () => {
  // Each of these ends a statement, starts an entity code, or opens markup, and
  // any one of them turns the whole block into a red error box.
  for (const hostile of ["a;b", "a#35;b", "a: b", "a<b>c", "a\nb", "a`b`", "a-->>b", 'say "hi"']) {
    const text = mermaidText(hostile);
    assert.doesNotMatch(text, /[;#:<>`"\n]/, `${JSON.stringify(hostile)} survived as ${JSON.stringify(text)}`);
  }
});

test("a file named after a Mermaid keyword cannot become an identifier", () => {
  // Aliases are generated (P0, P1). A file called `end.ts` or `loop.js` would
  // otherwise emit a keyword where a participant id belongs.
  const out = renderSequenceDiagram({
    participants: ["src/end.ts", "src/loop.js"],
    steps: [step("src/end.ts", "end", "src/loop.js", "loop")],
    entryPoints: ["end"],
    truncated: false,
  }).join("\n");
  assert.match(out, /participant P0 as end\.ts/);
  assert.match(out, /P0->>P1: loop\(\)/);
  assert.doesNotMatch(out, /^\s*(end|loop)->>/m, "no bare keyword in an identifier position");
});

test("a non-ASCII identifier is kept, not mangled into a different name", () => {
  // Stripping the umlaut turns über() into ber(), which is not a sanitised
  // label but a wrong one: the reader cannot find `ber` in their own file.
  assert.equal(mermaidText("über()"), "über()");
  assert.equal(mermaidText("处理请求()"), "处理请求()");
  assert.equal(mermaidText("naïve_helper"), "naïve_helper");
});

test("a very long name is truncated rather than made into a very wide diagram", () => {
  const long = mermaidText(`${"averyLongFunctionName".repeat(4)}()`);
  assert.ok(long.length <= 44, `${long.length} characters is wider than the page`);
  assert.match(long, /\.\.\.$/);
});

test("text that sanitises to nothing still yields a label", () => {
  // An empty label after the `as` is a parse error, not an empty participant.
  assert.equal(mermaidText("###"), "?");
  assert.equal(mermaidText("   "), "?");
});

// ── labels ───────────────────────────────────────────────────────────────────

test("two files with the same basename are disambiguated, never both shown as index.ts", () => {
  // The failure mode is not ugliness. It is a reader believing an arrow points
  // at a file it does not point at.
  const labels = labelPaths(["src/user/index.ts", "src/order/index.ts", "src/util.ts"]);
  assert.equal(labels.get("src/util.ts"), "util.ts");
  assert.notEqual(labels.get("src/user/index.ts"), labels.get("src/order/index.ts"));
  assert.equal(labels.get("src/user/index.ts"), "user/index.ts");
});

test("when even the parent collides, the whole path is used", () => {
  const labels = labelPaths(["apps/web/api/index.ts", "apps/admin/api/index.ts"]);
  assert.equal(labels.get("apps/web/api/index.ts"), "apps/web/api/index.ts");
  assert.notEqual(labels.get("apps/web/api/index.ts"), labels.get("apps/admin/api/index.ts"));
});

test("a step whose participant was never admitted is dropped, not drawn to nowhere", () => {
  const out = renderSequenceDiagram({
    ...TRACE,
    steps: [...TRACE.steps, step("src/webhook.ts", "onWebhook", "src/never-admitted.ts", "ghost")],
  }).join("\n");
  assert.doesNotMatch(out, /ghost/);
  assert.doesNotMatch(out, /->>undefined/);
});
