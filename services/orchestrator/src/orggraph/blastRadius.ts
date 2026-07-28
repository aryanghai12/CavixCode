import type { Finding } from "@cavix/core";
import { OrgGraph, type ImpactEdge } from "@cavix/orggraph";
import type { PullRef } from "../github/client.ts";
import type { GraphStore } from "./indexer.ts";

// Stage 5, half two: asking the graph what this pull request breaks elsewhere.
//
// This is the finding no single-repo reviewer can produce. A change to
// `DELETE /orders/{id}` reads as a clean, well-tested diff inside the orders
// service, and the only thing wrong with it lives in a different repository that
// nobody in the pull request has open.

/** Call sites named per impacted repository before the list is summarised. */
const MAX_SITES_SHOWN = 3;

/**
 * Consumers to name before the finding stops being useful. Past this, a list is
 * not telling a reviewer anything they can act on in a pull request.
 */
const MAX_REPOS_SHOWN = 5;

export interface BlastRadiusResult {
  findings: Finding[];
  /** Downstream call sites found in other repositories. Feeds the Scope module. */
  consumers: number;
  /** Repositories the graph knows about, so "no impact" can be distinguished. */
  indexedRepos: number;
}

export type BlastRadiusStep = (input: {
  org: string;
  ref: PullRef;
  diff: string;
}) => Promise<BlastRadiusResult>;

export interface BlastRadiusOptions {
  store: GraphStore;
  logger?: { info(msg: string, meta?: Record<string, unknown>): void };
}

export function makeBlastRadiusStep(opts: BlastRadiusOptions): BlastRadiusStep {
  return async ({ org, ref, diff }) => {
    const stored = await opts.store.load(org);
    const graph = OrgGraph.fromJSON(stored.graph);
    const indexedRepos = graph.indexedRepos().length;
    if (indexedRepos === 0) return { findings: [], consumers: 0, indexedRepos: 0 };

    const repo = `${ref.owner}/${ref.repo}`;
    const edges = graph.impactFromContractDiff(repo, diff);
    if (edges.length === 0) return { findings: [], consumers: 0, indexedRepos };

    // One finding per changed interface, not per consumer. A rename that breaks
    // six services is one decision a reviewer has to make, and six comments
    // saying the same thing is the noise this product exists to not produce.
    const byInterface = new Map<string, ImpactEdge[]>();
    for (const e of edges) {
      const list = byInterface.get(e.iface.id);
      if (list) list.push(e);
      else byInterface.set(e.iface.id, [e]);
    }

    const findings: Finding[] = [];
    let consumers = 0;
    for (const [ifaceId, group] of byInterface) {
      const iface = group[0].iface;
      const repos = [...new Set(group.map((g) => g.consumerRepo))];
      const sites = group.flatMap((g) => g.callSites);
      consumers += sites.length;

      findings.push({
        path: iface.sourceFile,
        line: 1,
        severity: repos.length > 1 ? "high" : "medium",
        category: "api",
        title: `${describe(iface.kind)} is consumed by ${plural(repos.length, "other repository")}`,
        body: renderBody(ifaceId, iface.kind, group, repos),
        source: "llm",
        // Not a model's opinion. Either the graph holds a call site or it does
        // not, so the only uncertainty is whether the extractor read the calling
        // code correctly, which is why this is high rather than certain.
        confidence: 0.85,
      });
    }

    opts.logger?.info("cross-repo impact traced", {
      repo,
      interfaces_changed: byInterface.size,
      consumer_repos: new Set(edges.map((e) => e.consumerRepo)).size,
      call_sites: consumers,
    });
    return { findings, consumers, indexedRepos };
  };
}

function renderBody(ifaceId: string, kind: string, group: ImpactEdge[], repos: string[]): string {
  const lines = [
    `\`${ifaceId}\` is declared here and called from ${plural(repos.length, "repository")} outside this one. ` +
      `Changing or removing it breaks them at deploy time, not at compile time, and nothing in this pull request would show that.`,
    "",
  ];
  for (const repo of repos.slice(0, MAX_REPOS_SHOWN)) {
    const sites = group.filter((g) => g.consumerRepo === repo).flatMap((g) => g.callSites);
    lines.push(`**\`${repo}\`** · ${plural(sites.length, "call site")}`);
    for (const s of sites.slice(0, MAX_SITES_SHOWN)) {
      // A middot, not a dash: `plain()` rewrites a dash between clauses into a
      // comma on the way out, which turns this line into "file.ts:2, await …".
      lines.push(`- \`${s.file}:${s.line}\` · ${trim(s.snippet)}`);
    }
    if (sites.length > MAX_SITES_SHOWN) lines.push(`- <sub>and ${sites.length - MAX_SITES_SHOWN} more in this repository</sub>`);
    lines.push("");
  }
  if (repos.length > MAX_REPOS_SHOWN) {
    lines.push(`<sub>and ${repos.length - MAX_REPOS_SHOWN} more repositories.</sub>`, "");
  }
  lines.push(
    `<sub>Traced through Cavix's contract graph for this workspace, built from the ${kind} definitions in your connected repositories. It reports call sites it can see; a consumer that builds its request dynamically will not appear.</sub>`,
  );
  return lines.join("\n");
}

function describe(kind: string): string {
  if (kind === "http") return "This endpoint";
  if (kind === "grpc") return "This RPC";
  if (kind === "graphql") return "This GraphQL field";
  return "This package";
}

/** Snippets go in a markdown list, so a stray backtick would break the row. */
function trim(snippet: string): string {
  return snippet.replace(/`/g, "'").replace(/\s+/g, " ").trim().slice(0, 100);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : noun.endsWith("y") ? "" : "s"}`.replace(/repositorys?$/, n === 1 ? "repository" : "repositories");
}
