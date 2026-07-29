import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runDeterministic,
  detectLanguages,
  toolsForLanguages,
  parseSarif,
  parseSemgrep,
  TOOL_REGISTRY,
} from "@cavix/deterministic";

test("builtins+secrets: catch real bugs in seed-like files (hermetic)", async () => {
  const files = [
    { path: "src/users.js", content: 'const row = db.query("SELECT * FROM u WHERE id = " + id);' },
    { path: "app/ping.py", content: 'import os\nos.system("ping " + host)' },
    { path: "src/config.js", content: 'const apiKey = "AKIAIOSFODNN7EXAMPLE";' },
    { path: "app/auth.py", content: "import hashlib\nhashlib.md5(pw).hexdigest()" },
    { path: "src/render.js", content: 'el.innerHTML = "<b>" + name + "</b>";' },
  ];
  const { findings } = await runDeterministic({ files });
  const rules = new Set(findings.map((f) => f.ruleId));
  assert.ok(rules.has("builtin/sql-injection"), "sql injection caught");
  assert.ok(rules.has("builtin/command-injection-os-system"), "command injection caught");
  assert.ok(rules.has("secret/aws-access-key-id"), "AWS key caught");
  assert.ok(rules.has("builtin/weak-hash"), "md5 caught");
  assert.ok(rules.has("builtin/dom-xss-innerhtml"), "innerHTML xss caught");
  // All deterministic findings carry a droppable-immune source.
  assert.ok(findings.every((f) => f.source === "sast" || f.source === "secret"));
});

test("secrets: EVERY committed key is reported, not just the first in the file", async () => {
  // This was a bare `exec`, which returns one match and stops. A file leaking a
  // key on line 2 and another on line 6 reported the first and said nothing
  // about the second, and the one nobody is told about is the one nobody
  // rotates. For a secret scanner that is the job, not a completeness nicety.
  const files = [
    {
      path: "src/config.js",
      content: [
        "// staging",
        'const staging = "AKIAIOSFODNN7EXAMPLE";',
        "",
        "// production, added in this pull request",
        'const prod = "AKIAJ2K7LMNOPQRSTUVW";',
        "",
        'const slack = "xoxb-1234567890-abcdefghijkl";',
      ].join("\n"),
    },
  ];
  const { findings } = await runDeterministic({ files });
  const aws = findings.filter((f) => f.ruleId === "secret/aws-access-key-id");
  assert.equal(aws.length, 2, "both AWS keys");
  assert.deepEqual(aws.map((f) => f.line).sort((a, b) => a - b), [2, 5]);
  assert.equal(findings.filter((f) => f.ruleId === "secret/slack-token").length, 1);
});

test("secrets: a file full of matches is capped rather than flooding the review", async () => {
  const line = 'const k = "AKIAIOSFODNN7EXAMPLE";';
  const files = [{ path: "fixtures/keys.js", content: Array.from({ length: 50 }, () => line).join("\n") }];
  const { findings } = await runDeterministic({ files });
  assert.equal(findings.length, 20, "capped, because 50 inline comments is a review nobody reads");
});

test("secrets: a shared pattern never carries match position from one file to the next", async () => {
  // The classic global-regex bug: a module-level /g RegExp keeps `lastIndex`
  // between calls, so the second file starts scanning from wherever the first
  // one stopped and the key at its top is missed.
  const content = 'const k = "AKIAIOSFODNN7EXAMPLE";';
  const files = Array.from({ length: 3 }, (_, i) => ({ path: `src/f${i}.js`, content }));
  const { findings } = await runDeterministic({ files });
  assert.equal(findings.filter((f) => f.ruleId === "secret/aws-access-key-id").length, 3);
});

test("ssrf content rule: request var flown into fetch is flagged", async () => {
  const files = [
    {
      path: "src/proxy.js",
      content: ["function proxy(req, res) {", "  const target = req.query.url;", "  fetch(target).then(r => r.text());", "}"].join("\n"),
    },
  ];
  const { findings } = await runDeterministic({ files });
  const ssrf = findings.find((f) => f.ruleId === "builtin/ssrf");
  assert.ok(ssrf, "ssrf flagged");
  assert.equal(ssrf!.line, 3);
});

test("registry knows 20+ tools and selects by language", () => {
  assert.ok(TOOL_REGISTRY.length >= 20, `expected ≥20 tools, got ${TOOL_REGISTRY.length}`);
  const langs = detectLanguages([{ path: "a.go", content: "" }, { path: "b.py", content: "" }]);
  assert.deepEqual([...langs].sort(), ["go", "py"]);
  const picked = toolsForLanguages(langs).map((t) => t.id);
  assert.ok(picked.includes("gosec"), "gosec selected for go");
  assert.ok(picked.includes("bandit"), "bandit selected for py");
  assert.ok(picked.includes("semgrep"), "semgrep (any) always selected");
  assert.ok(!picked.includes("rubocop"), "ruby tool not selected without ruby files");
});

test("external tool path: normalizes SARIF + semgrep output via injected spawn", async () => {
  const sarif = JSON.stringify({
    runs: [{ results: [{ ruleId: "G404", level: "warning", message: { text: "weak rng" }, locations: [{ physicalLocation: { artifactLocation: { uri: "main.go" }, region: { startLine: 7 } } }] }] }],
  });
  const semgrep = JSON.stringify({
    results: [{ check_id: "py.cmd-inject", path: "app.py", start: { line: 4 }, extra: { message: "cmd inject", severity: "ERROR" } }],
  });

  const { findings, toolsRun } = await runDeterministic({
    files: [{ path: "main.go", content: "package main" }, { path: "app.py", content: "x=1" }],
    workspaceDir: "/tmp/ws",
    enableExternalTools: true,
    spawnTool: async (spec) => (spec.format === "semgrep" ? semgrep : sarif),
  });

  assert.ok(toolsRun.includes("gosec"));
  assert.ok(toolsRun.includes("semgrep"));
  const ids = findings.map((f) => f.ruleId);
  assert.ok(ids.includes("gosec/G404"), "SARIF result normalized");
  assert.ok(ids.includes("semgrep/py.cmd-inject"), "semgrep result normalized");
  assert.ok(findings.every((f) => ["sast", "secret", "linter"].includes(f.source)));
});

test("parsers handle empty/edge output without throwing", () => {
  assert.deepEqual(parseSarif(JSON.stringify({ runs: [] }), "x"), []);
  assert.deepEqual(parseSemgrep(JSON.stringify({})), []);
});
