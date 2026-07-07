// Execution gatekeeper: before reviewing a PR, ask the control-plane whether that
// repo is toggled ON in the dashboard. Only enabled repos get reviewed. Configured
// with the same CAVIX_CONTROL_PLANE_URL + CAVIX_INTERNAL_TOKEN as the BYOK resolver.

export interface RepoGateOptions {
  url: string;
  token: string;
  /** On a control-plane error, review anyway? Default false (fail-closed: skip). */
  failOpen?: boolean;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

export type RepoGate = (fullName: string) => Promise<boolean>;

export function makeRepoGate(opts: RepoGateOptions): RepoGate {
  const base = opts.url.replace(/\/$/, "");
  const onError = opts.failOpen ?? false;
  return async (fullName: string): Promise<boolean> => {
    try {
      const res = await fetch(`${base}/api/internal/repos/enabled?fullName=${encodeURIComponent(fullName)}`, {
        headers: { authorization: `Bearer ${opts.token}` },
      });
      if (!res.ok) {
        opts.logger?.warn("repo gate: control-plane returned non-200", { fullName, status: res.status });
        return onError;
      }
      const data = (await res.json()) as { enabled?: boolean };
      return data.enabled === true;
    } catch (err) {
      opts.logger?.warn("repo gate: fetch failed", { fullName, err: (err as Error).message });
      return onError;
    }
  };
}
