import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRepoConfig, shouldReviewPath, isAgentEnabled, matchGlob, parseSimpleYaml, DEFAULT_CONFIG } from "@cavix/repoconfig";

const YAML = `# team config
autoReview: false
tone: detailed
policy:
  enabled: true
pathFilters:
  include:
    - "src/**"
  exclude:
    - "src/generated/**"
agents:
  disabled:
    - standards
    - test-coverage
failOn:
  - critical
  - high
`;

test("parseSimpleYaml: nested maps + lists + scalar coercion", () => {
  const o = parseSimpleYaml(YAML) as Record<string, unknown>;
  assert.equal(o.autoReview, false);
  assert.equal(o.tone, "detailed");
  assert.deepEqual((o.pathFilters as Record<string, unknown>).include, ["src/**"]);
  assert.deepEqual((o.agents as Record<string, unknown>).disabled, ["standards", "test-coverage"]);
});

test("loadRepoConfig: merges .cavix.yaml onto safe defaults", () => {
  const { config, source } = loadRepoConfig([{ path: ".cavix.yaml", content: YAML }]);
  assert.equal(source, ".cavix.yaml");
  assert.equal(config.autoReview, false);
  assert.equal(config.tone, "detailed");
  assert.equal(config.policy.enabled, true);
  assert.deepEqual(config.failOn, ["critical", "high"]);
});

test("loadRepoConfig: supports .cavix.json too", () => {
  const { config } = loadRepoConfig([{ path: "repo/.cavix.json", content: JSON.stringify({ autoReview: false, agents: { disabled: ["performance"] } }) }]);
  assert.equal(config.autoReview, false);
  assert.equal(isAgentEnabled("performance", config), false);
  assert.equal(isAgentEnabled("security", config), true);
});

test("loadRepoConfig: no config file → defaults", () => {
  const { config, source } = loadRepoConfig([{ path: "README.md", content: "# hi" }]);
  assert.equal(source, null);
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test("shouldReviewPath: include + exclude globs", () => {
  const { config } = loadRepoConfig([{ path: ".cavix.yaml", content: YAML }]);
  assert.equal(shouldReviewPath("src/app.ts", config), true);
  assert.equal(shouldReviewPath("src/generated/api.ts", config), false, "excluded");
  assert.equal(shouldReviewPath("docs/readme.md", config), false, "not in include set");
});

test("default excludes vendored/build artifacts", () => {
  assert.equal(shouldReviewPath("node_modules/x/index.js", DEFAULT_CONFIG), false);
  assert.equal(shouldReviewPath("dist/bundle.min.js", DEFAULT_CONFIG), false);
  assert.equal(shouldReviewPath("src/real.ts", DEFAULT_CONFIG), true);
});

test("matchGlob basics", () => {
  assert.equal(matchGlob("src/a/b.ts", "src/**"), true);
  assert.equal(matchGlob("src/a.ts", "src/*.ts"), true);
  assert.equal(matchGlob("src/a/b.ts", "src/*.ts"), false); // * doesn't cross /
});
