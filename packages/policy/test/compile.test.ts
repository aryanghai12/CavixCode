import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileEnglishRule,
  compileStandards,
  engineWithStandards,
  mergeRepoOverride,
  PolicyEngine,
  type OrgPolicyConfig,
} from "@cavix/policy";

test("compile: a custom English rule becomes a deterministic check and is enforced", () => {
  const r = compileEnglishRule("disallow console.log in committed code");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.matcher, "forbidden-call");

  const engine = new PolicyEngine([r.rule]);
  const config: OrgPolicyConfig = { enabled: true, rules: { [r.rule.id]: { enabled: true } } };
  const findings = engine.evaluate(
    { files: [{ path: "src/a.js", content: "function f(){\n  console.log('debug');\n}\n" }] },
    config,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].source, "policy");
  assert.equal(findings[0].immutable, true);
  assert.equal(findings[0].line, 2);
});

test("compile: recognizes endpoint-auth, banned module, markers, file length, license header", () => {
  assert.equal(compileEnglishRule("flag any endpoint without an auth check").ok, true);
  assert.equal((compileEnglishRule("ban the import of moment") as { matcher: string }).matcher, "banned-module");
  assert.equal((compileEnglishRule("no TODO comments") as { matcher: string }).matcher, "forbidden-marker");
  assert.equal((compileEnglishRule("files must be under 300 lines") as { matcher: string }).matcher, "max-file-length");
  assert.equal((compileEnglishRule("every file must have a license header") as { matcher: string }).matcher, "require-license-header");
});

test("compile: an unrecognized rule reports an error (route to LLM compiler)", () => {
  const r = compileEnglishRule("make the code more elegant please");
  assert.equal(r.ok, false);
});

test("STANDARDS.md: compiles a bullet list; enforces; reports uncompilable lines", () => {
  const md = `# Engineering Standards

## Rules
- disallow console.log
- ban the import of moment
- files must be under 200 lines
- be nice to future maintainers
`;
  const compiled = compileStandards(md);
  assert.equal(compiled.rules.length, 3);
  assert.equal(compiled.errors.length, 1, "the vibe rule cannot compile");

  const engine = engineWithStandards(compiled);
  const findings = engine.evaluate(
    { files: [{ path: "x.js", content: "import moment from 'moment';\nconsole.log(1);\n" }] },
    compiled.config,
  );
  const ids = findings.map((f) => f.ruleId);
  assert.ok(ids.some((i) => i?.includes("banned-import")));
  assert.ok(ids.some((i) => i?.includes("no-call")));
});

test("per-repo override: a repo can disable a specific org rule", () => {
  const compiled = compileStandards("- disallow console.log\n- no TODO comments");
  const effective = mergeRepoOverride(compiled.config, { disableRules: ["custom/no-call/console-log"] });
  const engine = engineWithStandards(compiled);
  const findings = engine.evaluate(
    { files: [{ path: "x.js", content: "console.log(1); // TODO fix\n" }] },
    effective,
  );
  // console.log rule disabled for this repo → only the TODO marker fires.
  assert.ok(findings.every((f) => !f.ruleId?.includes("no-call")));
  assert.ok(findings.some((f) => f.ruleId?.includes("no-marker")));
});

test("still off by default: compiled standards with enabled:false emit nothing", () => {
  const compiled = compileStandards("- disallow console.log", { enabled: false });
  const engine = engineWithStandards(compiled);
  const findings = engine.evaluate({ files: [{ path: "x.js", content: "console.log(1)\n" }] }, compiled.config);
  assert.equal(findings.length, 0);
});
