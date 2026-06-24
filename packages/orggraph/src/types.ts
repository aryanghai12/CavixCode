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
