// EgressGuard — the application-layer enforcement of "nothing leaves the cluster".
// It wraps fetch and rejects any request to a host not on the allowlist. In
// air-gapped mode the allowlist contains only the in-cluster model endpoint (and
// loopback), so every provider/platform/SCM call that would reach the internet
// throws instead. Combined with a deny-all-egress NetworkPolicy at the infra
// layer, this is defense in depth: even a mis-configured URL cannot exfiltrate.

export class EgressBlockedError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`egress blocked: ${host} is not on the air-gap allowlist`);
    this.name = "EgressBlockedError";
    this.host = host;
  }
}

export interface EgressPolicy {
  /** Exact hosts or "*.suffix" patterns that may be reached. */
  allowedHosts: string[];
  /** Allow loopback (127.0.0.1/localhost/::1). Default true (in-pod model). */
  allowLoopback?: boolean;
  /** Allow in-cluster service DNS (*.svc, *.svc.cluster.local). Default true. */
  allowClusterLocal?: boolean;
}

export function hostAllowed(host: string, policy: EgressPolicy): boolean {
  const h = host.toLowerCase();
  if ((policy.allowLoopback ?? true) && (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]")) return true;
  if ((policy.allowClusterLocal ?? true) && (h.endsWith(".svc") || h.endsWith(".svc.cluster.local"))) return true;
  for (const pat of policy.allowedHosts) {
    const p = pat.toLowerCase();
    if (p.startsWith("*.")) {
      if (h === p.slice(2) || h.endsWith(p.slice(1))) return true; // *.x matches x and a.x
    } else if (h === p) {
      return true;
    }
  }
  return false;
}

/** Wrap a fetch so only allowlisted hosts are reachable. */
export function createGuardedFetch(policy: EgressPolicy, fetchImpl: typeof fetch = fetch): typeof fetch {
  const guarded = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    if (!hostAllowed(url.hostname, policy)) throw new EgressBlockedError(url.hostname);
    return fetchImpl(input, init);
  }) as typeof fetch;
  return guarded;
}
