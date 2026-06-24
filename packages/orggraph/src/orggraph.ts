import { parseUnifiedDiff } from "@cavix/core";
import { extractProviders, type RepoFile } from "./contracts.ts";
import { extractConsumerRefs } from "./consumers.ts";
import {
  normalizePath,
  type ConsumerRef,
  type ImpactEdge,
  type ProvidedInterface,
} from "./types.ts";

// The cross-repo impact graph. Repos are ingested once (at onboarding / on push);
// then a PR that changes a provided interface is traced to its consumers.
export class OrgGraph {
  private providers: ProvidedInterface[] = [];
  private consumerRefs = new Map<string, ConsumerRef[]>();

  ingestRepo(repo: string, files: RepoFile[]): void {
    // Replace any prior data for this repo (incremental re-ingest).
    this.providers = this.providers.filter((p) => p.repo !== repo);
    for (const f of files) this.providers.push(...extractProviders(repo, f));
    this.consumerRefs.set(repo, files.flatMap(extractConsumerRefs));
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
        for (const l of h.lines) {
          if (l.kind === "context") continue; // only added/removed lines = the change
          for (const seg of l.content.match(/\/[\w{}:.\-/]+/g) ?? []) changedPaths.add(normalizePath(seg));
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

function matches(ref: ConsumerRef, iface: ProvidedInterface): boolean {
  if (ref.kind !== iface.kind) return false;
  if (iface.kind === "package") return ref.key === iface.id;
  if (iface.kind === "grpc") return iface.id.toLowerCase().endsWith("/" + ref.key);
  if (iface.kind === "http") {
    // Consumer URLs carry a host/base prefix the provider path lacks, so match
    // method + path SUFFIX (provider path is the canonical tail).
    const [rm, rp] = splitHttp(ref.key);
    const [im, ip] = splitHttp(iface.id);
    return rm === im && (rp === ip || rp.endsWith(ip));
  }
  return false;
}

function splitHttp(id: string): [string, string] {
  const sp = id.indexOf(" ");
  return [id.slice(0, sp), id.slice(sp + 1)];
}
