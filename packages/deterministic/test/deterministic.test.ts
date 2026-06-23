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
