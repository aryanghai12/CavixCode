import { compileEnglishRule, type PolicyRule } from "@cavix/policy";
import type { AgentSpec } from "@cavix/agents";
import type { OrgCalibration } from "@cavix/learning";

// A "review lens" is a shareable pack: org/community-authored policy rules (plain
// English or direct), extra specialized agents, and an optional per-org confidence
// model (calibration). The registry validates and composes installed lenses into
// the rules/agents/calibration the pipeline consumes. This is the marketplace
// substrate — a lens is just data + compiled checks, so it's safe to share.

export interface LensManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  description?: string;
  /** Plain-English rules, compiled to deterministic checks on install. */
  rules?: string[];
  /** Pre-built policy rules. */
  policyRules?: PolicyRule[];
  /** Additional Stage 8 agents this lens contributes. */
  agents?: AgentSpec[];
  /** A fine-tuned per-org confidence model bundled with the lens. */
  calibration?: OrgCalibration;
}

export interface InstalledLens {
  manifest: LensManifest;
  compiledRules: PolicyRule[];
  warnings: string[];
}

export interface ComposedReview {
  rules: PolicyRule[];
  agents: AgentSpec[];
  calibrations: Array<{ lensId: string; calibration: OrgCalibration }>;
}

const SEMVER = /^\d+\.\d+\.\d+/;

export class LensRegistry {
  private installed = new Map<string, InstalledLens>();

  install(manifest: LensManifest): InstalledLens {
    if (!manifest.id || !manifest.name) throw new Error("lens manifest needs id and name");
    if (!SEMVER.test(manifest.version ?? "")) throw new Error(`lens ${manifest.id}: version must be semver`);
    if (this.installed.has(manifest.id)) throw new Error(`lens "${manifest.id}" already installed`);

    const compiledRules: PolicyRule[] = [...(manifest.policyRules ?? [])];
    const warnings: string[] = [];
    for (const text of manifest.rules ?? []) {
      const r = compileEnglishRule(text);
      if (r.ok) compiledRules.push(r.rule);
      else warnings.push(`could not compile rule "${text}": ${r.error}`);
    }
    const lens: InstalledLens = { manifest, compiledRules, warnings };
    this.installed.set(manifest.id, lens);
    return lens;
  }

  uninstall(id: string): void {
    this.installed.delete(id);
  }
  get(id: string): InstalledLens | undefined {
    return this.installed.get(id);
  }
  list(): InstalledLens[] {
    return [...this.installed.values()];
  }

  /** Merge all installed lenses, de-duplicating rules/agents by id. */
  compose(): ComposedReview {
    const rules = new Map<string, PolicyRule>();
    const agents = new Map<string, AgentSpec>();
    const calibrations: ComposedReview["calibrations"] = [];
    for (const lens of this.installed.values()) {
      for (const r of lens.compiledRules) rules.set(r.id, r);
      for (const a of lens.manifest.agents ?? []) agents.set(a.id, a);
      if (lens.manifest.calibration) calibrations.push({ lensId: lens.manifest.id, calibration: lens.manifest.calibration });
    }
    return { rules: [...rules.values()], agents: [...agents.values()], calibrations };
  }
}
