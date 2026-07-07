import { createHash } from "node:crypto";

// BYOK configuration. Each org brings its own provider + key + model choice.
// In production these resolve from a secret store (Vault/KMS) per request; the
// shape is identical, so swapping the source does not touch the gateway.

export interface OrgLLMConfig {
  /** Registry name of the provider to use, e.g. "anthropic" | "fake". */
  provider: string;
  /** The org's own API key (BYOK). Never logged; only its fingerprint is. */
  apiKey: string;
  /** Default model for this org (config over hardcode). */
  model: string;
  /** Optional per-org output cap. */
  maxTokens?: number;
}

export interface GatewayConfigData {
  orgs: Record<string, OrgLLMConfig>;
  /** Fallback used when an org has no explicit entry (e.g. trials). */
  fallback?: OrgLLMConfig;
}

/**
 * Resolve an org's BYOK config from an external source (e.g. the control-plane's
 * secret store) at call time. Return null if the org isn't found there, so the
 * gateway can fall through to static config / fallback. This is the "resolve from a
 * secret store per request" path — the site is the source of truth for keys.
 */
export type OrgConfigResolver = (org: string) => Promise<OrgLLMConfig | null>;

/** Resolve the BYOK config for an org, falling back if configured. */
export function resolveOrgConfig(
  config: GatewayConfigData,
  org: string,
): OrgLLMConfig {
  const c = config.orgs[org] ?? config.fallback;
  if (!c) {
    throw new Error(`no LLM config for org "${org}" and no fallback configured`);
  }
  if (!c.apiKey) {
    throw new Error(`BYOK key missing for org "${org}"`);
  }
  return c;
}

/**
 * keyFingerprint is a short, non-reversible tag for a key, used for cost
 * attribution and logs. We log this — never the key itself — so a leaked log
 * cannot leak a credential. Distinct keys yield distinct fingerprints, which is
 * exactly what the BYOK billing path needs to prove "which key was billed".
 */
export function keyFingerprint(apiKey: string): string {
  if (!apiKey) return "none";
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
}
