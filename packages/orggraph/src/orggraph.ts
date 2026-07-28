import { parseUnifiedDiff } from "@cavix/core";
import { extractProviders, type RepoFile } from "./contracts.ts";
import { extractConsumerRefs } from "./consumers.ts";
import {
  nameTokens,
  normalizePath,
  type ConsumerRef,
  type ImpactEdge,
  type ProvidedInterface,
} from "./types.ts";

/**
 * Method names that carry no service identity on their own. Kept in step with
 * the extractor's list in consumers.ts: that one decides what is worth
 * recording, this one decides what a recorded call is allowed to prove.
 */
const GENERIC_METHOD_NAMES = new Set([
  "get", "set", "put", "del", "delete", "add", "has", "list", "query", "exec", "execute",
  "run", "send", "call", "invoke", "close", "end", "connect", "disconnect", "on", "off",
  "emit", "once", "read", "write", "open", "start", "stop", "init", "load", "save",
  "fetch", "request", "do", "next", "then", "catch", "map", "keys", "values",
]);

// The cross-repo impact graph. Repos are ingested once (at onboarding / on push);
// then a PR that changes a provided interface is traced to its consumers.
/**
 * Call sites kept per (repo, interface reference).
 *
 * A monorepo importing one package from four hundred files produced four hundred
 * rows of the same edge, all of which had to be held, persisted and shipped to
 * every review. Nobody reads the four hundredth: the review shows a handful and
 * says how many more there are, so the rest is weight with no reader.
 */
const MAX_SITES_PER_REF = 8;

export class OrgGraph {
  private providers: ProvidedInterface[] = [];
  private consumerRefs = new Map<string, ConsumerRef[]>();

  ingestRepo(repo: string, files: RepoFile[]): void {
    // Replace any prior data for this repo (incremental re-ingest).
    this.providers = this.providers.filter((p) => p.repo !== repo);
    for (const f of files) this.providers.push(...extractProviders(repo, f));
    this.consumerRefs.set(repo, capSites(files.flatMap(extractConsumerRefs)));
  }

  /** Everything this graph knows, as plain data, for persisting between runs. */
  toJSON(): OrgGraphSnapshot {
    return { v: 1, providers: this.providers, consumers: [...this.consumerRefs.entries()] };
  }

  /** Rebuild a graph from a snapshot. Unknown or absent shapes yield an empty graph. */
  static fromJSON(snapshot: unknown): OrgGraph {
    const g = new OrgGraph();
    const s = snapshot as Partial<OrgGraphSnapshot> | null;
    if (!s || s.v !== 1 || !Array.isArray(s.providers) || !Array.isArray(s.consumers)) return g;
    g.providers = s.providers;
    g.consumerRefs = new Map(s.consumers);
    return g;
  }

  /** Repositories this graph has ingested at least once. */
  indexedRepos(): string[] {
    return [...this.consumerRefs.keys()];
  }

  providersOf(repo: string): ProvidedInterface[] {
    return this.providers.filter((p) => p.repo === repo);
  }

  allProviders(): ProvidedInterface[] {
    return [...this.providers];
  }

  /** Walk consumer edges for a set of changed interface ids. */
  impactedBy(changedInterfaceIds: string[]): ImpactEdge[] {
    const edges: ImpactEdge[] = [];
    for (const id of changedInterfaceIds) {
      const iface = this.providers.find((p) => p.id === id);
      if (!iface) continue;
      for (const [repo, refs] of this.consumerRefs) {
        if (repo === iface.repo) continue; // same-repo callers are Stage 4's job
        const matching = refs.filter((r) => matches(r, iface));
        if (matching.length > 0) {
          edges.push({ iface, consumerRepo: repo, callSites: matching.map((r) => ({ file: r.file, line: r.line, snippet: r.snippet })) });
        }
      }
    }
    return edges;
  }

  /**
   * Trace impact from a PR diff on a provider repo: detect which provided
   * interfaces the diff touches (changed/removed paths or RPCs), then walk
   * consumers. This is the "PR changes a public interface" entry point.
   */
  impactFromContractDiff(repo: string, diff: string): ImpactEdge[] {
    const changed = this.changedInterfaceIds(repo, diff);
    return this.impactedBy(changed);
  }

  private changedInterfaceIds(repo: string, diff: string): string[] {
    const files = parseUnifiedDiff(diff);
    const changedPaths = new Set<string>();
    const changedRpcs = new Set<string>();
    const changedFields = new Set<string>();

    for (const f of files) {
      for (const h of f.hunks) {
        // The nearest path key seen so far, from ANY line including context.
        //
        // In a contract file the thing that changes is usually the operation,
        // not the path that owns it: removing an endpoint from an OpenAPI
        // document deletes the `"delete": {}` line while `"/orders/{id}":` sits
        // above it, unchanged, as context. Reading only changed lines therefore
        // saw a method with no path and concluded that nothing had changed,
        // which is the most common contract edit there is.
        let enclosingPath = "";
        for (const l of h.lines) {
          const pathHere = pathKeyIn(l.content);
          if (pathHere) enclosingPath = pathHere;
          if (l.kind === "context") continue; // context locates a change, it is not one

          if (pathHere) changedPaths.add(pathHere);
          else if (enclosingPath && HTTP_METHOD_KEY.test(l.content)) changedPaths.add(enclosingPath);

          const rpc = /rpc\s+(\w+)/.exec(l.content)?.[1];
          if (rpc) changedRpcs.add(rpc.toLowerCase());
          const gqlField = /^[+-]?\s*(\w+)\s*[(:]/.exec(l.content)?.[1];
          if (gqlField) changedFields.add(gqlField.toLowerCase());
        }
      }
    }

    return this.providersOf(repo)
      .filter((p) => {
        if (p.kind === "http") return changedPaths.has(p.id.split(" ")[1]);
        if (p.kind === "grpc") return changedRpcs.has((p.id.split("/").pop() ?? "").toLowerCase());
        if (p.kind === "graphql") return changedFields.has((p.id.split(".").pop() ?? "").toLowerCase());
        return false;
      })
      .map((p) => p.id);
  }
}

/** `"delete": {}`, `delete:`, `- delete` — an operation key inside a path item. */
const HTTP_METHOD_KEY = /^[+\-\s]*"?(get|post|put|patch|delete|head|options)"?\s*:/i;

/**
 * The route a line declares, normalized, or "" if it declares none.
 *
 * Deliberately narrow: a route is a quoted or bare key that starts with a slash
 * and is followed by a colon, which is what OpenAPI, YAML and most routers all
 * look like. Matching any slash-containing token instead pulled `$ref` targets,
 * URLs in descriptions and file paths in comments into the changed set.
 */
function pathKeyIn(content: string): string {
  const m = /^[+\-\s]*["']?(\/[\w{}:.\-/]*)["']?\s*:/.exec(content);
  return m ? normalizePath(m[1]) : "";
}

function matches(ref: ConsumerRef, iface: ProvidedInterface): boolean {
  if (ref.kind !== iface.kind) return false;
  if (iface.kind === "package") return ref.key === iface.id;
  if (iface.kind === "grpc") {
    const method = (iface.id.split("/").pop() ?? "").toLowerCase();
    if (ref.key !== method) return false;
    // The method name matching is necessary and nowhere near sufficient. The
    // receiver has to name the service too, or `redisClient.get()` is a caller of
    // every RPC in the org called Get. A distinctive method name (CancelOrder,
    // not Get) is accepted on its own, because nothing else in a codebase is
    // called that by accident.
    const ifaceTokens = nameTokens(iface.id.split("/")[0] ?? "");
    if (ifaceTokens.length === 0) return true;
    const scope = ref.scope ?? [];
    if (scope.some((t) => ifaceTokens.includes(t))) return true;
    return !GENERIC_METHOD_NAMES.has(method);
  }
  if (iface.kind === "http") {
    const [rm, rp] = splitHttp(ref.key);
    const [im, ip] = splitHttp(iface.id);
    return rm === im && httpPathMatches(rp, ip);
  }
  return false;
}

/**
 * Does a consumer's URL path reach a provider's route?
 *
 * Two things make this more than string equality, and getting either wrong makes
 * the whole stage report nothing:
 *
 * 1. A provider declares a TEMPLATE and a consumer calls a CONCRETE value. The
 *    provider says `/orders/{id}`, normalized to `/orders/*`; the caller writes
 *    `/orders/abc123`. Comparing those as strings never matches, which is the
 *    single most common shape there is.
 * 2. A consumer's URL carries a host and often a base path the provider's route
 *    does not have (`https://orders.internal/api/v2/orders/abc`), so the route
 *    is a SUFFIX of the caller's path, not the whole of it.
 *
 * So: align the two on their tails and compare segment by segment, with `*` on
 * either side matching anything. A provider route made entirely of variables
 * would match every URL in the organisation, so it matches nothing instead.
 */
function httpPathMatches(consumerPath: string, providerPath: string): boolean {
  // Empty segments are dropped before aligning. A suffix match starts partway
  // through the caller's path, so the leading "" that every absolute path splits
  // into would otherwise be compared against a segment in the middle of the URL
  // and fail every time a consumer had a base path.
  const provider = providerPath.split("/").filter((s) => s !== "");
  const consumer = consumerPath.split("/").filter((s) => s !== "");
  if (provider.length === 0 || provider.length > consumer.length) return false;
  // A route made entirely of variables would match every URL in the org.
  if (!provider.some((s) => s !== "*")) return false;

  const offset = consumer.length - provider.length;
  for (let i = 0; i < provider.length; i++) {
    const p = provider[i];
    const c = consumer[offset + i];
    if (p === "*" || c === "*") continue; // a variable on either side
    if (p !== c) return false;
  }
  return true;
}

function splitHttp(id: string): [string, string] {
  const sp = id.indexOf(" ");
  return [id.slice(0, sp), id.slice(sp + 1)];
}

/** A graph as plain JSON, so it can outlive the process that built it. */
export interface OrgGraphSnapshot {
  v: 1;
  providers: ProvidedInterface[];
  consumers: Array<[repo: string, refs: ConsumerRef[]]>;
}

/**
 * Keep at most MAX_SITES_PER_REF call sites per distinct reference.
 *
 * Deduplication is by what the reference IS (kind, key and, for gRPC, the
 * receiver), not by where it appears, so the same import from four hundred files
 * collapses to one reference carrying the first few locations.
 */
function capSites(refs: ConsumerRef[]): ConsumerRef[] {
  const seen = new Map<string, number>();
  const out: ConsumerRef[] = [];
  for (const r of refs) {
    const key = `${r.kind} ${r.key} ${(r.scope ?? []).join(",")}`;
    const n = seen.get(key) ?? 0;
    if (n >= MAX_SITES_PER_REF) continue;
    seen.set(key, n + 1);
    out.push(r);
  }
  return out;
}
