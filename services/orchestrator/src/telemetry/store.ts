import type { BuildRun } from "@cavix/telemetry";
import type { CiStore } from "./ingest.ts";

// CI history, kept in the control-plane and reached over the internal API. Same
// shape and same failure posture as the contract-graph store: an unreachable
// control-plane costs the telemetry section of one review, never the review.

export interface CiStoreOptions {
  url: string;
  token: string;
  /** History changes at CI speed, not review speed, so a cache is safe. */
  cacheMs?: number;
  timeoutMs?: number;
  logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
  fetchImpl?: typeof fetch;
}

const EMPTY = { runs: [] as BuildRun[], fetchedAt: {} as Record<string, string> };

export function makeCiStore(opts: CiStoreOptions): CiStore {
  const base = opts.url.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const cacheMs = opts.cacheMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const cache = new Map<string, { at: number; value: typeof EMPTY }>();

  const call = async (org: string, init: RequestInit): Promise<unknown> => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}/api/internal/orgs/${encodeURIComponent(org)}/telemetry`, {
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
        const body = (await call(org, {})) as typeof EMPTY;
        const value = { runs: body?.runs ?? [], fetchedAt: body?.fetchedAt ?? {} };
        cache.set(org, { at: Date.now(), value });
        return value;
      } catch (err) {
        opts.logger?.warn("could not load CI history", { org, err: (err as Error).message });
        return EMPTY;
      }
    },

    async save(org, repo, runs) {
      await call(org, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, runs }),
      });
      // The cached copy is now the stale one, and the next review would read
      // history missing the runs just ingested.
      cache.delete(org);
    },
  };
}
