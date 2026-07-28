// Stage 5 — cross-repo / microservice impact graph. Each repo PROVIDES interfaces
// (HTTP endpoints, gRPC methods, GraphQL fields, a published package) and CONSUMES
// others'. When a PR changes a provided interface, we walk consumer edges to other
// repos and report the impacted services + the exact call sites.

export type InterfaceKind = "http" | "grpc" | "graphql" | "package";

export interface ProvidedInterface {
  repo: string;
  kind: InterfaceKind;
  /** Canonical id, e.g. "GET /orders/{id}", "orders.OrderService/Get", "Query.orders", "@acme/orders". */
  id: string;
  sourceFile: string;
}

export interface CallSite {
  file: string;
  line: number;
  snippet: string;
}

// A raw consumer reference extracted from a repo's source, before resolution.
export interface ConsumerRef {
  kind: InterfaceKind;
  /** Match key for resolution (normalized). */
  key: string;
  file: string;
  line: number;
  snippet: string;
  /**
   * Name tokens of the thing the call was made ON, for gRPC: `ordersClient` →
   * ["orders", "order"].
   *
   * This exists because a method name alone is not evidence of anything.
   * Matching on the method by itself reported `redisClient.get(key)` and
   * `dbClient.get(id)` as consumers of `orders.OrderService/Get`, so changing one
   * RPC would have told three unrelated teams their code was about to break.
   * That is precisely the noise this product is supposed to be incapable of.
   */
  scope?: string[];
}

/**
 * Split an identifier into comparable name tokens.
 *
 * `orders.OrderService` and `ordersClient` both reduce to a set containing
 * "order", which is what lets one be recognised as a caller of the other, while
 * `redisClient` reduces to ["redis"] and matches nothing about orders.
 *
 * Words that appear in almost every service or client name carry no information,
 * so they are dropped: keeping "service" would make every `fooServiceClient` a
 * caller of every `BarService`.
 */
const NOISE_TOKENS = new Set([
  "service", "services", "client", "clients", "stub", "api", "apis", "grpc", "rpc",
  "server", "proto", "pb", "v1", "v2", "v3", "svc", "gateway", "conn", "connection",
]);

export function nameTokens(identifier: string): string[] {
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1 && !NOISE_TOKENS.has(w));

  const out = new Set<string>();
  for (const w of words) {
    out.add(w);
    // Crude singular/plural fold, so "orders" and "order" are the same token.
    if (w.endsWith("s") && w.length > 3) out.add(w.slice(0, -1));
    else out.add(`${w}s`);
  }
  return [...out];
}

export interface ImpactEdge {
  iface: ProvidedInterface;
  consumerRepo: string;
  callSites: CallSite[];
}

export function normalizePath(path: string): string {
  // Drop scheme+host if present, keep the path; collapse variable segments to "*".
  let p = path;
  const schemeIdx = p.indexOf("://");
  if (schemeIdx !== -1) {
    const slash = p.indexOf("/", schemeIdx + 3);
    p = slash === -1 ? "/" : p.slice(slash);
  }
  p = p.split("?")[0].replace(/\/$/, "") || "/";
  return p
    .split("/")
    .map((seg) => (isVariableSegment(seg) ? "*" : seg))
    .join("/");
}

function isVariableSegment(seg: string): boolean {
  if (seg === "") return false;
  if (/^\{.*\}$/.test(seg)) return true; // {id}
  if (/^:/.test(seg)) return true; // :id
  if (/\$\{.*\}/.test(seg)) return true; // ${id}
  if (/^\d+$/.test(seg)) return true; // 123
  if (/^[$`'"]/.test(seg)) return true; // template fragment
  return false;
}

export function httpId(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}
