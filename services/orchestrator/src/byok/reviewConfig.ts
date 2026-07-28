// The per-org review configuration, as the repo owner set it on the dashboard.
//
// Every switch here belongs to the owner, not to us: whether findings are proven
// before posting, where the summary goes, whether Cavix may block a merge, and
// which plain-English rules run as a pre-merge gate. The orchestrator reads them
// once per review from the control-plane and obeys.
//
// If the control-plane cannot be reached we fall back to SAFE defaults rather
// than to "off": an unreachable dashboard must never silently downgrade a
// customer's review, and it must never silently start blocking their merges
// either. So: verify on, summary in the description, blocking off.

export interface PreMergeConfig {
  enabled: boolean;
  /** Plain-English rules the owner typed. Compiled to deterministic checks. */
  rules: string[];
}

/**
 * Which parts of the review get posted. Every one of these is a switch on the
 * dashboard's "Review comment structure" panel, so a toggle there has to change
 * what actually lands on the pull request.
 */
export interface ReviewSections {
  summary: boolean;
  changedFiles: boolean;
  reviewEffort: boolean;
  inlineFindings: boolean;
  proof: boolean;
}

/** Which files Cavix may review. Empty include means "everything not excluded". */
export interface PathFilterConfig {
  include: string[];
  exclude: string[];
}

export interface OrgReviewConfig {
  verifyFindings: boolean;
  summaryInDescription: boolean;
  /** May Cavix escalate from a comment to REQUEST_CHANGES? Off unless chosen. */
  requestChangesOnFail: boolean;
  /** Severities that count as a failure when blocking is on. */
  failOn: string[];
  preMergeChecks: PreMergeConfig;
  sections: ReviewSections;
  /**
   * Review automatically on open and on every push. Off means Cavix only runs
   * when a human types "@cavixcode review", which is how a team dials the cost
   * and the noise down without turning the product off.
   */
  autoReview: boolean;
  /** Review draft pull requests too. Off by default: a draft is not ready. */
  reviewDraftPRs: boolean;
  /** The org's chosen writing voice for everything the model produces. */
  tone: string;
  pathFilters: PathFilterConfig;
}

export const ALL_SECTIONS: ReviewSections = {
  summary: true,
  changedFiles: true,
  reviewEffort: true,
  inlineFindings: true,
  proof: true,
};

export const DEFAULT_REVIEW_CONFIG: OrgReviewConfig = {
  verifyFindings: true,
  summaryInDescription: true,
  requestChangesOnFail: false,
  failOn: ["critical"],
  preMergeChecks: { enabled: false, rules: [] },
  sections: ALL_SECTIONS,
  autoReview: true,
  reviewDraftPRs: false,
  tone: "concise",
  pathFilters: { include: [], exclude: [] },
};

export type ReviewConfigFetcher = (org: string) => Promise<OrgReviewConfig>;

export interface ReviewConfigOptions {
  url: string;
  token: string;
  /** Config changes mid-flight are rare; a short cache saves a hop per review. */
  cacheMs?: number;
  /** Give up on an unresponsive control-plane rather than stalling the review. */
  timeoutMs?: number;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  fetchImpl?: typeof fetch;
}

/**
 * Cap on cached orgs. A hosted deployment sees an unbounded set of workspace
 * ids over time, and this map would otherwise only ever grow. Entries are cheap
 * and short-lived, so the oldest is simply evicted.
 */
const MAX_CACHED_ORGS = 500;

export function makeReviewConfigFetcher(opts: ReviewConfigOptions): ReviewConfigFetcher {
  const base = opts.url.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const cacheMs = opts.cacheMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const cache = new Map<string, { at: number; config: OrgReviewConfig }>();

  return async (org: string): Promise<OrgReviewConfig> => {
    const hit = cache.get(org);
    if (hit && Date.now() - hit.at < cacheMs) return hit.config;

    // A control-plane that accepts the connection and then never answers would
    // otherwise stall every review behind it indefinitely.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}/api/internal/orgs/${encodeURIComponent(org)}/review-config`, {
        headers: { authorization: `Bearer ${opts.token}` },
        signal: abort.signal,
      });
      if (!res.ok) {
        opts.logger?.warn("review config: control-plane rejected the request, using defaults", {
          org,
          status: res.status,
        });
        return DEFAULT_REVIEW_CONFIG;
      }
      const config = coerce(await res.json());
      if (cache.size >= MAX_CACHED_ORGS && !cache.has(org)) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(org, { at: Date.now(), config });
      return config;
    } catch (err) {
      opts.logger?.warn("review config: control-plane unreachable, using defaults", {
        org,
        err: abort.signal.aborted ? `timed out after ${timeoutMs}ms` : (err as Error).message,
      });
      return DEFAULT_REVIEW_CONFIG;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Narrow an untrusted payload. A missing field takes the SAFE default, never
 * `undefined`-as-false — an older control-plane that does not know about
 * verification yet must not turn it off for everyone.
 */
export function coerce(value: unknown): OrgReviewConfig {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const pm = (typeof v.preMergeChecks === "object" && v.preMergeChecks !== null
    ? v.preMergeChecks
    : {}) as Record<string, unknown>;
  const rs = (typeof v.reviewSections === "object" && v.reviewSections !== null
    ? v.reviewSections
    : {}) as Record<string, unknown>;
  const pf = (typeof v.pathFilters === "object" && v.pathFilters !== null
    ? v.pathFilters
    : {}) as Record<string, unknown>;
  const globs = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(String).filter((g) => g.trim() !== "") : [];
  return {
    verifyFindings: v.verifyFindings !== false,
    summaryInDescription: v.summaryInDescription !== false,
    requestChangesOnFail: v.requestChangesOnFail === true,
    failOn: Array.isArray(v.failOn) ? v.failOn.map(String) : DEFAULT_REVIEW_CONFIG.failOn,
    preMergeChecks: {
      enabled: pm.enabled === true,
      rules: Array.isArray(pm.rules) ? pm.rules.map(String).filter((r) => r.trim() !== "") : [],
    },
    sections: {
      summary: rs.summary !== false,
      changedFiles: rs.changedFiles !== false,
      reviewEffort: rs.reviewEffort !== false,
      inlineFindings: rs.inlineFindings !== false,
      proof: rs.proof !== false,
    },
    // Absent means the safe default, never `undefined`-as-false. An older
    // control-plane that does not send autoReview must not stop reviewing for
    // everyone the moment the orchestrator learns the field exists.
    autoReview: v.autoReview !== false,
    reviewDraftPRs: v.reviewDraftPRs === true,
    tone: typeof v.tone === "string" && v.tone.trim() !== "" ? v.tone : DEFAULT_REVIEW_CONFIG.tone,
    pathFilters: { include: globs(pf.include), exclude: globs(pf.exclude) },
  };
}
