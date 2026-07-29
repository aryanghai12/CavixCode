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

/**
 * How many redirects a guarded request will follow before giving up. The same
 * cap browsers use, and it bounds a redirect loop into an error.
 */
const MAX_REDIRECTS = 5;

/**
 * Wrap a fetch so only allowlisted hosts are reachable.
 *
 * REDIRECTS ARE FOLLOWED BY HAND, and that is the whole difference between this
 * and a one-line host check. Left to `fetch`, a redirect is followed without
 * asking anybody: an allowed host answering `307 Location: https://evil.example`
 * makes the runtime RE-SEND the request, body and all, to a host the policy
 * forbids. The check would have passed, the packet would have left, and nothing
 * in the process would know. So each hop is checked before it is taken.
 *
 * What this does NOT prove, stated so nobody mistakes it for more: it is an
 * application-layer control inside one process. A dependency that reaches for a
 * raw socket, or for the unwrapped global `fetch`, goes around it entirely. That
 * is why the NetworkPolicy exists and why it is described as the kernel half:
 * this layer catches the mistake, and that one catches the malice.
 */
export function createGuardedFetch(policy: EgressPolicy, fetchImpl: typeof fetch = fetch): typeof fetch {
  const guarded = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const start = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    let url = new URL(start);
    // A caller that asked for manual redirects gets exactly that: it has said it
    // will inspect the Location itself, and one check per hop is this function's
    // only job either way.
    const manual = init?.redirect === "manual" || init?.redirect === "error";
    let request: Parameters<typeof fetch>[1] = manual ? init : { ...init, redirect: "manual" };

    for (let hop = 0; ; hop++) {
      if (!hostAllowed(url.hostname, policy)) throw new EgressBlockedError(url.hostname);
      const res = await fetchImpl(url.href, request);
      if (manual || !isRedirect(res.status)) return res;

      const location = res.headers.get("location");
      // A redirect with nowhere to go is the server's answer, not a hop.
      if (!location) return res;
      if (hop >= MAX_REDIRECTS) throw new Error(`egress: more than ${MAX_REDIRECTS} redirects from ${start}`);

      url = new URL(location, url);
      request = nextHop(request, res.status);
    }
  }) as typeof fetch;
  return guarded;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * The request for the next hop.
 *
 * 307 and 308 preserve the method and the body by definition. 303 always
 * becomes a GET. 301 and 302 are specified to preserve the method but every
 * agent in existence turns a POST into a GET, so that is what happens here:
 * matching the runtime that would otherwise have done this is the point.
 */
function nextHop(
  request: Parameters<typeof fetch>[1],
  status: number,
): Parameters<typeof fetch>[1] {
  if (status === 307 || status === 308) return request;
  const method = (request?.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return request;
  const { body: _body, ...rest } = request ?? {};
  return { ...rest, method: "GET" };
}
