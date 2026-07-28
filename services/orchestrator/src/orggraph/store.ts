import type { GraphStore } from "./indexer.ts";

// The contract graph, kept in the control-plane and reached over the internal
// API. Same shape and same failure posture as the review-config fetcher: a
// control-plane that cannot be reached costs the cross-repo section of one
// review, never the review.

export interface GraphStoreOptions {
  url: string;
  token: string;
  /** The graph changes at indexing speed, not review speed, so a cache is safe. */
  cacheMs?: number;
  timeoutMs?: number;
  logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
  fetchImpl?: typeof fetch;
}

const EMPTY = { graph: null as unknown, indexedAt: {} as Record<string, string> };

export function makeGraphStore(opts: GraphStoreOptions): GraphStore {
  const base = opts.url.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const cacheMs = opts.cacheMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const cache = new Map<string, { at: number; value: typeof EMPTY }>();

  const call = async (path: string, init: RequestInit): Promise<unknown> => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${opts.token}` },
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async load(org) {
      const hit = cache.get(org);
      if (hit && Date.now() - hit.at < cacheMs) return hit.value;
      try {
        const body = (await call(`/api/internal/orgs/${encodeURIComponent(org)}/graph`, {})) as typeof EMPTY;
        const value = { graph: body?.graph ?? null, indexedAt: body?.indexedAt ?? {} };
        cache.set(org, { at: Date.now(), value });
        return value;
      } catch (err) {
        opts.logger?.warn("could not load the org contract graph", { org, err: (err as Error).message });
        return EMPTY;
      }
    },

    async save(org, repo, graph) {
      await call(`/api/internal/orgs/${encodeURIComponent(org)}/graph`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, graph }),
      });
      // The cached copy is now the stale one, and the next review would otherwise
      // read a graph missing the repository that was just indexed.
      cache.delete(org);
    },
  };
}
