import type { OrgConfigResolver, OrgLLMConfig } from "@cavix/gateway";

// Fetches an org's BYOK config (provider + model + key) from the control-plane's
// internal endpoint, so real reviews use the key each org configured on the SITE
// rather than an env var. Returns null on any problem so the gateway falls back to
// its static/env config. The gateway caches the result briefly, so a review's many
// model calls trigger at most one fetch.

export interface ControlPlaneResolverOptions {
  /** Base URL of the control-plane, e.g. https://cavix.onrender.com */
  url: string;
  /** Shared secret matching the control-plane's CAVIX_INTERNAL_TOKEN. */
  token: string;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/** Sensible default model per provider, used only when an org saved none. */
export function defaultModelFor(provider: string): string {
  switch (provider) {
    case "google":
      return "gemini-2.5-pro";
    case "openai":
      return "gpt-5";
    case "selfhosted":
      return "qwen2.5-coder-32b";
    default:
      return "claude-opus-5";
  }
}

export function makeControlPlaneResolver(opts: ControlPlaneResolverOptions): OrgConfigResolver {
  const base = opts.url.replace(/\/$/, "");
  return async (org: string): Promise<OrgLLMConfig | null> => {
    try {
      const res = await fetch(`${base}/api/internal/orgs/${encodeURIComponent(org)}/llm`, {
        headers: { authorization: `Bearer ${opts.token}` },
      });
      if (!res.ok) {
        opts.logger?.warn("byok resolver: control-plane returned non-200", { org, status: res.status });
        return null;
      }
      const data = (await res.json()) as { provider?: string; model?: string; apiKey?: string };
      if (!data.apiKey) return null; // org hasn't set a key yet → fall back
      const provider = data.provider || "anthropic";
      return {
        provider,
        // The default MUST follow the provider. A blank model used to fall back to
        // a Claude id regardless, so a Google org would ask Gemini for
        // "claude-opus-5" and get a 404 it could not explain.
        model: data.model || defaultModelFor(provider),
        apiKey: data.apiKey,
      };
    } catch (err) {
      opts.logger?.warn("byok resolver: fetch failed", { org, err: (err as Error).message });
      return null;
    }
  };
}
