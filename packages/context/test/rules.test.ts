import { test } from "node:test";
import assert from "node:assert/strict";
import { collectRules, parseRuleFile, rulesFor, ruleItems, splitFrontmatter } from "@cavix/context";

// Cavix knew a great deal about the CODE and nothing about the TEAM. It could
// see that a handler builds a SQL string; it could not know that this repository
// decided handlers never touch SQL, wrote it down, and has been enforcing it by
// hand in every review since.

const RULE = `---
name: no-raw-sql-in-handlers
description: HTTP handlers must not build SQL strings; use the query layer.
applies_to: ["services/**/handler/**/*.ts", "services/**/routes/*.ts"]
severity: high
category: architecture
enforcement: blocking
---

Handlers own transport concerns only. Any SQL belongs in \`packages/db/queries\`.
A handler that builds SQL cannot be unit-tested without a database.
`;

test("a rule file is parsed into its parts", () => {
  const rule = parseRuleFile({ path: ".cavix/rules/sql.md", content: RULE }, "repo");
  assert.ok(rule);
  assert.equal(rule.id, "no-raw-sql-in-handlers");
  assert.match(rule.description, /must not build SQL/);
  assert.deepEqual(rule.appliesTo, ["services/**/handler/**/*.ts", "services/**/routes/*.ts"]);
  assert.equal(rule.severity, "high");
  assert.equal(rule.enforcement, "blocking");
  assert.match(rule.body, /packages\/db\/queries/);
});

test("a rule with no frontmatter still counts, repository-wide", () => {
  // A CONTRIBUTING.md written years before Cavix existed is still the team's
  // standard. Requiring frontmatter would mean every customer writes their
  // rules twice and the second copy drifts.
  const rule = parseRuleFile({ path: "CONTRIBUTING.md", content: "# House style\n\nNo `any`, ever." }, "convention-file");
  assert.ok(rule);
  assert.deepEqual(rule.appliesTo, [], "applies everywhere");
  assert.equal(rule.id, "contributing");
  assert.equal(rule.enforcement, "advisory");
});

test("enforcement defaults to advisory, whatever the file says loosely", () => {
  // A rule file landing in a repository must not be able to start holding
  // merges the moment it lands.
  for (const value of ["", "true", "yes", "required", "BLOCKING "]) {
    const rule = parseRuleFile({ path: "r.md", content: `---\nenforcement: ${value}\n---\nbody` }, "repo");
    assert.equal(rule?.enforcement, "advisory", `enforcement: ${value}`);
  }
  const blocking = parseRuleFile({ path: "r.md", content: "---\nenforcement: blocking\n---\nbody" }, "repo");
  assert.equal(blocking?.enforcement, "blocking");
});

test("an empty rule file is not a rule", () => {
  assert.equal(parseRuleFile({ path: ".cavix/rules/x.md", content: "---\nname: x\n---\n\n" }, "repo"), null);
});

test("collectRules finds rule files and convention files, and rule files win", () => {
  const rules = collectRules([
    { path: "src/app.ts", content: "const x = 1;" },
    { path: ".cavix/rules/sql.md", content: RULE },
    { path: "CLAUDE.md", content: "Use tabs." },
    { path: "AGENTS.md", content: "Prefer composition." },
  ]);
  const ids = rules.map((r) => r.id).sort();
  assert.deepEqual(ids, ["agents", "claude", "no-raw-sql-in-handlers"]);
  assert.ok(!rules.some((r) => r.id === "app"), "ordinary source files are not rules");
});

test("a later source replaces an earlier rule with the same id", () => {
  const builtin = {
    id: "no-raw-sql-in-handlers",
    description: "shipped default",
    appliesTo: [],
    severity: "low",
    category: "standards",
    enforcement: "advisory" as const,
    body: "default",
    source: "builtin" as const,
  };
  const rules = collectRules([{ path: ".cavix/rules/sql.md", content: RULE }], [builtin]);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].severity, "high", "the repository's own version wins");
});

test("selection is a glob match and nothing else", () => {
  const rules = collectRules([{ path: ".cavix/rules/sql.md", content: RULE }]);
  assert.equal(rulesFor(rules, ["services/api/handler/refund.ts"]).length, 1);
  assert.equal(rulesFor(rules, ["services/api/routes/refund.ts"]).length, 1);
  assert.equal(rulesFor(rules, ["packages/db/queries/refund.ts"]).length, 0);
  assert.equal(rulesFor(rules, []).length, 0);
});

test("a repository-wide rule applies to any change", () => {
  const rules = collectRules([{ path: "CLAUDE.md", content: "No `any`." }]);
  assert.equal(rulesFor(rules, ["anything/at/all.py"]).length, 1);
});

test("rule items outrank every piece of code context", () => {
  const rules = collectRules([{ path: ".cavix/rules/sql.md", content: RULE }]);
  const items = ruleItems(rules, ["services/api/handler/refund.ts"]);
  assert.equal(items.length, 1);
  // Above callers (80), definitions (70) and embedding neighbours (40); below
  // only the diff itself (100). A change that is correct and against the house
  // standard is still against the house standard.
  assert.equal(items[0].priority, 95);
  assert.equal(items[0].kind, "rule");
  assert.match(items[0].content, /blocking, high/);
  assert.match(items[0].content, /\.cavix\/rules\/sql\.md/, "names the file it came from");
});

test("frontmatter parsing survives a malformed header rather than losing the rule", () => {
  const { meta, body } = splitFrontmatter("---\nthis is not: valid: yaml: really\n---\nthe body");
  assert.equal(body.trim(), "the body");
  assert.ok(typeof meta === "object");
});

test("a file with no frontmatter is all body", () => {
  const { meta, body } = splitFrontmatter("just prose");
  assert.deepEqual(meta, {});
  assert.equal(body, "just prose");
});

test("windows paths and ./ prefixes match the same rules", () => {
  const rules = collectRules([{ path: ".\\.cavix\\rules\\sql.md", content: RULE }]);
  assert.equal(rules.length, 1);
  assert.equal(rulesFor(rules, ["services\\api\\handler\\refund.ts"]).length, 1);
});
