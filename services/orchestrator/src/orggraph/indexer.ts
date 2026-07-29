import { OrgGraph, type RepoFile } from "@cavix/orggraph";
import type { ReviewPlatform, PullRef } from "../github/client.ts";

// Stage 5, half one: building the org's contract graph.
//
// ── where this runs, and why here ────────────────────────────────────────────
//
// Indexing lives in the ORCHESTRATOR and the graph is stored in the
// CONTROL-PLANE. That split is forced by what each service has. Only the
// orchestrator holds GitHub App installation tokens, which are the one
// credential that can read a private repository without borrowing a human's
// OAuth token, so only it can read the files. Only the control-plane has
// Postgres and knows which repositories a workspace has connected, so only it
// can keep the result.
//
// ── when it runs ─────────────────────────────────────────────────────────────
//
// AFTER a review is posted, never during one, and only when this repository's
// slice of the graph has gone stale. A review has to answer while somebody is
// looking at the page; a tree listing plus a dozen file reads does not belong in
// front of that. Running it afterwards means the graph fills in as repositories
// see pull requests, and the first review on a new repository simply has no
// cross-repo data to show, which the Scope module handles by omitting the row.

/** Contract files worth reading. Anything else cannot declare an interface. */
const CONTRACT_FILE = /(^|\/)(openapi|swagger)[\w.-]*\.json$|\.proto$|\.graphqls?$|\.gql$|(^|\/)package\.json$|(^|\/)go\.mod$/i;

/** Source files worth scanning for outbound calls. */
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|go|py|rb|java|kt|cs|php|rs)$/i;

/** Directories whose contents are never anyone's interface or call site. */
const SKIP_DIR = /(^|\/)(node_modules|vendor|dist|build|out|target|\.git|testdata|fixtures|__snapshots__|coverage)\//i;

/**
 * Caps per repository. A tree listing is one call, but every file after it is
 * another, and this runs on somebody else's rate limit.
 */
const MAX_CONTRACT_FILES = 12;
const MAX_SOURCE_FILES = 40;

/** How long a repository's slice of the graph stays fresh. */
export const DEFAULT_STALE_MS = 12 * 3600_000;

export interface IndexResult {
  repo: string;
  providers: number;
  contractFiles: number;
  sourceFiles: number;
}

export type GraphIndexer = (ref: PullRef, org: string) => Promise<IndexResult | null>;

export interface GraphStore {
  /** The workspace's graph, plus when each repo was last indexed. */
  load(org: string): Promise<{ graph: unknown; indexedAt: Record<string, string> }>;
  save(org: string, repo: string, graph: unknown): Promise<void>;
}

export interface IndexerOptions {
  github: ReviewPlatform;
  store: GraphStore;
  staleMs?: number;
  logger?: { info(msg: string, meta?: Record<string, unknown>): void };
}

/**
 * Which files to read, given the repository's full path list.
 *
 * Exported because the selection is the interesting part: everything downstream
 * is bounded by what this returns, and a rule that quietly excluded every
 * `.proto` would look exactly like a graph that found no consumers.
 */
export function selectFiles(paths: string[]): { contracts: string[]; sources: string[] } {
  const usable = paths.filter((p) => !SKIP_DIR.test(p));
  return {
    contracts: usable.filter((p) => CONTRACT_FILE.test(p)).slice(0, MAX_CONTRACT_FILES),
    // Shallowest first: a service's outbound calls live near the top of its
    // source tree far more often than eight directories down, and this list is
    // capped, so the order decides what gets seen.
    sources: usable
      .filter((p) => SOURCE_FILE.test(p) && !/\.(test|spec)\./i.test(p))
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
      .slice(0, MAX_SOURCE_FILES),
  };
}

export function makeGraphIndexer(opts: IndexerOptions): GraphIndexer {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;

  return async (ref: PullRef, org: string): Promise<IndexResult | null> => {
    const repo = `${ref.owner}/${ref.repo}`;
    const stored = await opts.store.load(org);

    const last = stored.indexedAt[repo];
    if (last && Date.now() - Date.parse(last) < staleMs) {
      opts.logger?.info("org graph is fresh for this repo, skipping the re-index", { repo, last });
      return null;
    }

    const tree = await opts.github.listTree(ref);
    if (tree.length === 0) {
      opts.logger?.info("could not list the repository tree, leaving the graph as it was", { repo });
      return null;
    }
    const { contracts, sources } = selectFiles(tree);

    const files: RepoFile[] = [];
    for (const path of [...contracts, ...sources]) {
      try {
        const content = await opts.github.fetchFile(ref, path);
        if (content !== null) files.push({ path, content });
      } catch {
        // One unreadable file must not cost the rest of the map.
      }
    }
    if (files.length === 0) return null;

    // Ingest into the workspace's existing graph rather than a fresh one, so
    // this repository's slice is replaced and every other repository's survives.
    // Rebuilding from scratch here would mean a workspace only ever knew about
    // whichever repository last saw a pull request.
    const graph = OrgGraph.fromJSON(stored.graph);
    graph.ingestRepo(repo, files);
    await opts.store.save(org, repo, graph.toJSON());

    const result: IndexResult = {
      repo,
      providers: graph.providersOf(repo).length,
      contractFiles: contracts.length,
      sourceFiles: sources.length,
    };
    opts.logger?.info("indexed the repository into the org contract graph", {
      ...result,
      org,
      repos_in_graph: graph.indexedRepos().length,
    });
    return result;
  };
}
