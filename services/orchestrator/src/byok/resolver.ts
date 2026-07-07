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
      return {
        provider: data.provider || "anthropic",
        model: data.model || "claude-sonnet-4-6",
        apiKey: data.apiKey,
      };
    } catch (err) {
      opts.logger?.warn("byok resolver: fetch failed", { org, err: (err as Error).message });
      return null;
    }
  };
}
