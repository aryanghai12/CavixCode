import type { GitLabTokenProvider } from "./rest.ts";

// Where a GitLab token comes from.
//
// This is the one place the two platforms genuinely differ on credentials, and
// it is worth being explicit about why. A GitHub App holds a private key and
// mints a short-lived installation token per repository, so the orchestrator
// needs no stored secret at all. GitLab has no such thing: a bot authenticates
// with a long-lived project, group or personal access token that somebody
// pasted, and that token has to live somewhere.
//
// It lives in the control-plane, encrypted at rest with the same AES-GCM path as
// a workspace's BYOK model key, and is fetched per review through the internal
// API. It is NOT held in an environment variable per deployment, because one
// token shared across every workspace would mean one customer's token reading
// another customer's repositories.
//
// Cached briefly for the same reason the review config is: a review makes
// several calls and none of them should each cost a control-plane round trip.

export interface ControlPlaneGitLabTokenOptions {
  url: string;
  /** Shared secret matching the control-plane's CAVIX_INTERNAL_TOKEN. */
  token: string;
  cacheMs?: number;
  timeoutMs?: number;
  logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
  fetchImpl?: typeof fetch;
}

/** Cap on cached workspaces, matching the review-config fetcher's. */
const MAX_CACHED_ORGS = 500;

export function makeControlPlaneGitLabTokens(opts: ControlPlaneGitLabTokenOptions): GitLabTokenProvider {
  const base = opts.url.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const cacheMs = opts.cacheMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const cache = new Map<string, { at: number; token: string }>();

  return {
    async token(org: string): Promise<string> {
      const hit = cache.get(org);
      if (hit && Date.now() - hit.at < cacheMs) return hit.token;

      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const res = await doFetch(
          `${base}/api/internal/orgs/${encodeURIComponent(org)}/gitlab-token`,
          { headers: { authorization: `Bearer ${opts.token}` }, signal: abort.signal },
        );
        if (!res.ok) {
          // Deliberately a THROWN error and not an empty string. Every caller
          // treats an empty token as "not configured" and would carry on to make
          // an unauthenticated request that fails later with a confusing 401 on
          // somebody's merge request.
          throw new Error(
            `gitlab: no token for workspace "${org}" (control-plane answered HTTP ${res.status}). ` +
              "Add a GitLab access token under Integrations in the dashboard.",
          );
        }
        const data = (await res.json()) as { token?: string };
        if (!data.token) {
          throw new Error(
            `gitlab: workspace "${org}" has no GitLab access token saved. ` +
              "Add one under Integrations in the dashboard.",
          );
        }
        if (cache.size >= MAX_CACHED_ORGS && !cache.has(org)) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(org, { at: Date.now(), token: data.token });
        return data.token;
      } catch (err) {
        if (abort.signal.aborted) {
          throw new Error(`gitlab: timed out reading the workspace token after ${timeoutMs}ms`);
        }
        opts.logger?.warn("gitlab token lookup failed", { org, err: (err as Error).message });
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
