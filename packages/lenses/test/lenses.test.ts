import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSpec } from "@cavix/agents";
import { calibrate } from "@cavix/learning";
import { LensRegistry, type LensManifest } from "@cavix/lenses";

const fintechAgent: AgentSpec = { id: "pci-compliance", category: "security", tier: "frontier", mission: "PCI-DSS: card data handling, storage, and logging violations." };

const orgCalibration = calibrate([
  { category: "standards", agent: "standards", source: "llm", confidence: 0.6, accepted: false },
  { category: "security", agent: "security", source: "llm", confidence: 0.8, accepted: true },
]);

function fintechLens(): LensManifest {
  return {
    id: "fintech-pci",
    name: "Fintech / PCI lens",
    version: "1.2.0",
    author: "community",
    rules: ["flag any endpoint without an auth check", "make the code prettier"],
    agents: [fintechAgent],
    calibration: orgCalibration,
  };
}

test("install: compiles English rules, surfaces uncompilable ones, bundles agents + calibration", () => {
  const reg = new LensRegistry();
  const lens = reg.install(fintechLens());
  assert.equal(lens.compiledRules.length, 1, "the auth rule compiled");
  assert.equal(lens.warnings.length, 1, "the vibe rule could not compile");
  assert.equal(lens.manifest.agents?.[0].id, "pci-compliance");
});

test("compose: merges rules + agents + per-org calibration across installed lenses (deduped)", () => {
  const reg = new LensRegistry();
  reg.install(fintechLens());
  reg.install({ id: "secrets-plus", name: "Extra secrets", version: "0.1.0", author: "acme", rules: ["disallow console.log"], agents: [fintechAgent] });

  const composed = reg.compose();
  assert.ok(composed.rules.length >= 2, "rules from both lenses");
  assert.equal(composed.agents.length, 1, "duplicate agent id deduped");
  assert.equal(composed.calibrations.length, 1);
  assert.equal(composed.calibrations[0].lensId, "fintech-pci");
  // The bundled per-org confidence model is intact.
  assert.ok(composed.calibrations[0].calibration.categoryAcceptRate.security > 0.5);
});

test("validation: duplicate install and bad version are rejected", () => {
  const reg = new LensRegistry();
  reg.install(fintechLens());
  assert.throws(() => reg.install(fintechLens()), /already installed/);
  assert.throws(() => reg.install({ id: "x", name: "x", version: "bad", author: "a" }), /semver/);
});

test("uninstall removes a lens from composition", () => {
  const reg = new LensRegistry();
  reg.install(fintechLens());
  reg.uninstall("fintech-pci");
  assert.equal(reg.list().length, 0);
  assert.equal(reg.compose().rules.length, 0);
});
