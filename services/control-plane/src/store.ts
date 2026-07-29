import { randomUUID } from "node:crypto";
import type { Finding, Severity } from "@cavix/core";
import { computeOrgRollup, InMemoryAnalyticsStore, type ReviewEvent } from "@cavix/analytics";
import { calibrate, type DecisionRecord, type OrgCalibration } from "@cavix/learning";
import type { RetentionAttestation } from "@cavix/zero-retention";
import { hashPassword, verifyPassword, encryptSecret, decryptSecret, fingerprint } from "./auth.ts";

// The control-plane store. In-memory for Phase 1; the same port backs Postgres in
// production. It records orgs, repos, reviews, per-finding accept/reject DECISIONS
// (the learning-loop signal), plus the things a real dashboard needs: user accounts,
// team membership, and per-org BYOK / review settings.

export type DecisionState = "accepted" | "rejected";

export type Role = "owner" | "admin" | "reviewer" | "member";

export interface User {
  id: string;
  email: string;
  name: string;
  org: string;
  role: Role;
  passwordHash: string;
  createdAt: string;
  provider?: "password" | "github" | "gitlab";
  githubLogin?: string;
}

/** What the API returns for a user — never the password hash. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  org: string;
  role: Role;
  createdAt: string;
  provider?: "password" | "github" | "gitlab";
  githubLogin?: string;
}

export type Tone = "concise" | "detailed" | "educational" | "assertive" | "chill";

/** Per-org BYOK + review configuration, editable from the dashboard Settings page. */
export interface OrgSettings {
  llmProvider: string;   // anthropic | openai | google | selfhosted
  llmModel: string;
  autoReview: boolean;
  reviewDraftPRs: boolean;
  tone: Tone;
  failOn: string[];      // severities that fail the check run
  policyEnabled: boolean;
  airgapped: boolean;
  /**
   * Stage 10. When on (the default), a finding is reproduced in a sandbox before
   * it is posted and dropped if it cannot be. Owners can turn it off to trade
   * proof for speed and cost.
   */
  verifyFindings: boolean;
  /** Write the summary + walkthrough into the PR description instead of the comment. */
  summaryInDescription: boolean;
  /**
   * Escalate the review from a comment to REQUEST_CHANGES when `failOn`
   * severities are found or a pre-merge rule fails. OFF by default — blocking a
   * team's merges is never something a tool should switch on for them.
   */
  requestChangesOnFail: boolean;
  /** Optional path filters (like .cavix.yaml). Empty include = review everything. */
  pathFilters: { include: string[]; exclude: string[] };
  /** Optional pre-merge gate (OFF by default). Owner writes plain-English rules. */
  preMergeChecks: { enabled: boolean; rules: string[] };
  /** Which sections the posted PR review comment includes (structure control). */
  reviewSections: {
    summary: boolean;
    changedFiles: boolean;
    sequenceDiagram: boolean;
    reviewEffort: boolean;
    relatedIssues: boolean;
    inlineFindings: boolean;
    proof: boolean;
  };
  /** Set once a BYOK key is stored. The raw key is AES-GCM encrypted and never returned. */
  apiKeyFingerprint?: string;
  apiKeySetAt?: string;
}

/**
 * A provider sign-in credential. GitHub App user tokens expire after 8 hours and
 * come with a refresh token, so the refresh half has to be stored or the user is
 * signed out of their own repositories every working day.
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Absent means the token does not expire (classic OAuth App). */
  expiresAt?: number;
}

export interface Decision {
  state: DecisionState;
  user: string;
  at: string;
}

export interface StoredFinding {
  id: string;
  reviewId: string;
  path: string;
  line: number;
  severity: string;
  category: string;
  title: string;
  source: string;
  /**
   * The confidence this finding carried when it was posted.
   *
   * The orchestrator has always sent it and this row always threw it away, which
   * broke Stage 12 in a way nothing surfaced: a confidence threshold learned
   * from decisions is only derivable if you know what confidence each decided
   * finding had. Optional because rows written before this existed do not carry
   * one, and a decision with no confidence informs the accept rates and nothing
   * else. See `calibration()`.
   */
  confidence?: number;
  immutable: boolean;
  agent?: string;
  /** Execution-verified (Stage 10) — eligible for the public proven-catches feed. */
  verified: boolean;
  decision?: Decision;
}

export type OrgTier = "free" | "paid";

export interface Org {
  id: string;
  name: string;
  tier: OrgTier;
  /** Opt-in to publish VERIFIED findings on public repos to the proven feed. */
  provenFeedOptIn: boolean;
  createdAt: string;
  /** ISO date a paid trial ends; while active the org gets paid-tier limits. */
  trialEndsAt?: string;
  /** Founder override of reviews/day for this specific org (beats the tier default). */
  reviewsPerDayOverride?: number;
  /** When true, reviews are blocked (limit 0) — used to pause abusive/expired orgs. */
  suspended?: boolean;
}

/** An org plus computed operator fields, for the founder/admin console. */
export interface OrgAdminView extends Org {
  members: number;
  repos: number;
  reviews: number;
  effectiveReviewsPerDay: number;
  trialActive: boolean;
  /** Days until the trial ends; negative once expired, undefined with no trial. */
  trialDaysLeft?: number;
  /** Reviews in the last 24h, and that as a percentage of the daily limit. */
  reviewsToday: number;
  usagePct: number;
  /** When this org last had a review — the honest "are they actually using it" signal. */
  lastActivityAt?: string;
  /** Has a BYOK key been saved? Without one, every review fails — the #1 support case. */
  apiKeySet: boolean;
  /** Are findings being proven before posting for this org? */
  verifyFindings: boolean;
}

/**
 * Platform-wide numbers for the founder console: who is signed up, who is
 * actually using it, whose trial is about to end, and what that is worth.
 */
export interface PlatformStats {
  generatedAt: string;
  users: { total: number; new7d: number; new30d: number; withGithub: number };
  orgs: {
    total: number;
    free: number;
    paid: number;
    trialActive: number;
    trialExpiring7d: number;
    trialExpired: number;
    suspended: number;
    new7d: number;
    activeLast7d: number;
    withApiKey: number;
  };
  repos: { total: number; enabled: number; public: number; private: number };
  reviews: { total: number; last24h: number; last7d: number; perDay14: number[] };
  findings: { total: number; verified: number; accepted: number; rejected: number; bySeverity: Record<string, number> };
  /**
   * Estimated, not billed. Seats are members of paid orgs at the configured
   * per-seat price; trial seats are the same sum for orgs still in trial, which
   * is the pipeline if they convert. Labelled as an estimate everywhere it shows.
   */
  revenue: { pricePerSeat: number; paidSeats: number; estimatedMrr: number; trialSeats: number; pipelineMrr: number };
}

export interface Repo {
  id: string;
  org: string;
  name: string;
  visibility: "public" | "private";
  /** Whether Cavix reviews this repo. The execution gatekeeper reviews only if true. */
  enabled: boolean;
}

export interface ProvenCatch {
  org: string;
  repo: string;
  title: string;
  category: string;
  severity: string;
  at: string;
}

export interface ReviewRecord {
  id: string;
  org: string;
  repo: string;
  pr: number;
  title: string;
  /** Link to the posted review, so a dashboard row opens the pull request. */
  url?: string;
  createdAt: string;
  findings: StoredFinding[];
  /**
   * What this review cost and how it ran. The orchestrator has known all of it
   * since Phase 0 and simply never sent it, so the dashboard could show what
   * Cavix found and never what it cost to find, which is half of the question
   * anyone renewing a budget is actually asking.
   */
  costUsd?: number;
  model?: string;
  durationMs?: number;
  /** Findings reproduced in the sandbox before posting. */
  verifiedCount?: number;
  /** Findings the sandbox DISPROVED, which were never posted. */
  suppressedCount?: number;
  /**
   * Stage 13. Proof that every sandbox this review provisioned was destroyed.
   *
   * Retained deliberately and for a long time: a regulated buyer's auditor asks
   * about a review from four months ago, and a proof that expires with the
   * dashboard's default retention is a proof they cannot use. It is safe to keep
   * because it names no code, no path and no commit.
   */
  retention?: RetentionAttestation;
}

export interface SaveReviewInput {
  org: string;
  repo: string;
  pr: number;
  title: string;
  url?: string;
  findings: Array<Finding & { verified?: boolean }>;
  costUsd?: number;
  model?: string;
  durationMs?: number;
  verifiedCount?: number;
  suppressedCount?: number;
  retention?: RetentionAttestation;
}

/**
 * A workspace turning Cavix off, in whole or in part.
 *
 * The roadmap calls this "your single most important leading indicator of
 * churn", and nothing was recording it. A repo toggled off, or a pull request
 * paused, is the moment a customer starts leaving, and it is invisible in a
 * findings table.
 */
export interface MuteEvent {
  org: string;
  /** "repo" (toggled off in the dashboard) or "pr" ("@cavixcode pause"). */
  scope: "repo" | "pr";
  target: string;
  /** True when Cavix was turned back on. */
  restored: boolean;
  at: string;
}

/** One day of the trend series. Dates are YYYY-MM-DD in UTC. */
export interface DayPoint {
  date: string;
  reviews: number;
  findings: number;
  verified: number;
  accepted: number;
  rejected: number;
  costUsd: number;
}

/** One repository's contribution, for the per-repo rollup. */
export interface RepoRollup {
  repo: string;
  reviews: number;
  findings: number;
  verified: number;
  actionRate: number;
  hoursSaved: number;
  costUsd: number;
}

/**
 * Everything the Reports page needs, computed once.
 *
 * The ROI numbers come from `@cavix/analytics`, not from a second model written
 * here: the package already owns an explicit, tunable minutes-per-severity model
 * and having two of them is how a dashboard and a sales deck end up quoting
 * different hours for the same month.
 */
export interface OrgAnalytics {
  days: DayPoint[];
  repos: RepoRollup[];
  totalFindings: number;
  actionRate: number;
  defectsCaught: number;
  reviewerHoursSaved: number;
  /** Mean cost of a review over the window, in USD. 0 when nothing reported it. */
  costPerReview: number;
  totalCostUsd: number;
  /** Verified findings as a share of all findings posted. */
  verifiedShare: number;
  /** Cavix switched off somewhere in the window. The churn signal. */
  muteEvents: MuteEvent[];
  /**
   * Action rate over the first half of the window versus the second, as a
   * percentage-point change. Negative means the team is acting on fewer of
   * Cavix's comments than it was, which is the earliest sign of a workspace on
   * its way out.
   */
  actionRateTrend: number;
}

/** Aggregate numbers for the dashboard Overview page. */
export interface OrgStats {
  reviews: number;
  findings: number;
  verified: number;
  accepted: number;
  rejected: number;
  actionRate: number;      // accepted / (accepted+rejected)
  falsePositiveRate: number;
  reposConnected: number;
  bySeverity: Record<string, number>;
  reviewsLast7Days: number[]; // oldest → newest
  hoursSaved: number;
}

export interface Store {
  createOrg(name: string, opts?: { tier?: OrgTier; provenFeedOptIn?: boolean }): Org;
  createRepo(org: string, name: string, opts?: { visibility?: "public" | "private"; enabled?: boolean }): Repo;
  getOrg(name: string): Org | undefined;
  setProvenFeedOptIn(org: string, optIn: boolean): void;
  listOrgs(): Org[];
  listRepos(org: string): Repo[];
  removeRepo(org: string, name: string): boolean;
  /** Enable/disable Cavix for a repo (upserts on enable; no-op create on disable). */
  setRepoEnabled(org: string, name: string, enabled: boolean, visibility?: "public" | "private"): Repo | null;
  /** Gatekeeper: is this "owner/name" repo enabled in any workspace? */
  isRepoEnabled(fullName: string): boolean;
  /** Gatekeeper detail: the enabled row plus the workspace that owns it (for BYOK). */
  lookupRepo(fullName: string): { org: string; repo: Repo } | null;
  saveReview(input: SaveReviewInput): ReviewRecord;
  listReviews(org?: string, limit?: number): ReviewRecord[];
  getReview(id: string): ReviewRecord | undefined;
  reviewCountSince(org: string, sinceMs: number): number;
  /** Record Cavix being switched off (or back on) somewhere. See MuteEvent. */
  recordMute(e: Omit<MuteEvent, "at">): void;
  listMutes(org: string, sinceMs?: number): MuteEvent[];
  /** Stage 5's contract graph for a workspace, or null before anything indexed it. */
  orgGraph(org: string): StoredOrgGraph | null;
  /** Replace the graph and mark `repo` as indexed now. */
  saveOrgGraph(org: string, repo: string, graph: unknown): StoredOrgGraph;
  /** Stage 6's CI run history for a workspace. Empty before anything ingested it. */
  ciHistory(org: string): StoredCiHistory;
  /** Replace one repository's runs and mark it fetched now. */
  saveCiHistory(org: string, repo: string, runs: unknown[]): StoredCiHistory;
  /** Trends, ROI and the per-repo rollup for the Reports page. */
  analytics(org: string, days?: number): OrgAnalytics;
  getFinding(id: string): StoredFinding | undefined;
  recordDecision(findingId: string, state: DecisionState, user: string): StoredFinding;
  listDecisions(): Array<{ findingId: string; reviewId: string; state: DecisionState; user: string; at: string; source: string }>;
  /** Stage 12. The confidence bars this workspace's own decisions have earned. */
  calibration(org: string): OrgCalibration;
  provenFeed(limit?: number): ProvenCatch[];

  // --- accounts & team ---
  createUser(input: { email: string; name: string; password: string; org: string; role?: Role }): PublicUser;
  getUserByEmail(email: string): User | undefined;
  getUser(id: string): User | undefined;
  verifyLogin(email: string, password: string): PublicUser | null;
  listTeam(org: string): PublicUser[];
  setRole(org: string, userId: string, role: Role): PublicUser;
  /** Create or update a user signed in via an OAuth provider (GitHub/GitLab). */
  upsertOAuthUser(input: { email: string; name: string; org: string; provider: "github" | "gitlab"; login: string }): PublicUser;
  setOAuthToken(userId: string, tokens: OAuthTokens): void;
  getOAuthToken(userId: string): OAuthTokens | null;
  /** Forget a dead credential, so the UI stops pretending the user is connected. */
  clearOAuthToken(userId: string): void;

  // --- BYOK / settings ---
  getSettings(org: string): OrgSettings;
  updateSettings(org: string, patch: Partial<OrgSettings>): OrgSettings;
  setApiKey(org: string, rawKey: string): OrgSettings;
  /** Decrypts and returns the stored BYOK key for the orchestrator to use. */
  getApiKey(org: string): string | null;
  /**
   * Store this workspace's GitLab access token, encrypted.
   *
   * GitHub needs nothing here: an App mints its own short-lived token per
   * install. GitLab has no equivalent, so a bot authenticates with a token
   * somebody pasted, and it is held per workspace rather than per deployment
   * because one shared token would read every customer's repositories.
   */
  setGitLabToken(org: string, rawToken: string): void;
  getGitLabToken(org: string): string | null;
  /** Forget it, so the dashboard offers "Connect" again. */
  clearGitLabToken(org: string): void;
  /** The same, for Bitbucket Cloud. Same reasoning: no per-install token exists. */
  setBitbucketToken(org: string, rawToken: string): void;
  getBitbucketToken(org: string): string | null;
  clearBitbucketToken(org: string): void;

  // --- dashboard ---
  stats(org: string): OrgStats;

  // --- founder / platform admin ---
  /** The effective reviews/day for an org (suspended→0, override, trial→paid, else tier). */
  effectiveReviewsPerDay(org: string): number;
  setTier(org: string, tier: OrgTier): Org;
  startTrial(org: string, days: number): Org;
  endTrial(org: string): Org;
  setReviewLimitOverride(org: string, reviewsPerDay: number | null): Org;
  setSuspended(org: string, suspended: boolean): Org;
  /** Every org with computed operator fields (members, repos, reviews, effective limit). */
  listOrgsAdmin(): OrgAdminView[];
  /** Platform-wide totals for the founder console. */
  platformStats(): PlatformStats;
}

function defaultSettings(): OrgSettings {
  return {
    llmProvider: process.env.CAVIX_LLM_PROVIDER ?? "anthropic",
    llmModel: process.env.CAVIX_LLM_MODEL ?? "claude-opus-5",
    autoReview: true,
    reviewDraftPRs: false,
    tone: "concise",
    failOn: ["critical"],
    policyEnabled: false,
    airgapped: process.env.CAVIX_AIRGAPPED === "true",
    verifyFindings: true,
    summaryInDescription: true,
    requestChangesOnFail: false,
    pathFilters: { include: [], exclude: ["**/*.min.js", "**/generated/**", "**/vendor/**"] },
    preMergeChecks: { enabled: false, rules: [] },
    reviewSections: { summary: true, changedFiles: true, sequenceDiagram: true, reviewEffort: true, relatedIssues: true, inlineFindings: true, proof: true },
  };
}

/** A full serializable dump of the store, used to persist to Postgres and reload. */
export interface StoreSnapshot {
  v: 1;
  orgs: Org[];
  repos: Repo[];
  reviews: ReviewRecord[];
  feed: ProvenCatch[];
  users: User[];
  settings: Array<[string, OrgSettings]>;
  apiKeys: Array<[string, string]>;
  oauthTokens: Array<[string, string]>;
  /** Optional so a snapshot written before GitLab support still restores. */
  gitlabTokens?: Array<[string, string]>;
  bitbucketTokens?: Array<[string, string]>;
  /** Optional so a snapshot written before these existed still restores. */
  mutes?: MuteEvent[];
  /** Stage 5's cross-repo contract graph, per workspace. See `orgGraph`. */
  orgGraphs?: Array<[org: string, graph: StoredOrgGraph]>;
  /** Stage 6’s CI run history, per workspace. */
  ciRuns?: Array<[org: string, history: StoredCiHistory]>;
}

/**
 * A workspace's contract graph as stored: the JSON the orggraph package
 * serialises, plus when each repository was last indexed.
 *
 * The per-repo timestamps are what make indexing incremental. Without them the
 * only options are re-indexing an entire organisation on every push or never
 * refreshing at all, and the second one is how a graph quietly starts describing
 * a codebase that no longer exists.
 */
export interface StoredOrgGraph {
  graph: unknown;
  indexedAt: Record<string, string>;
}

/**
 * A workspace's CI run history, and when each repository was last refreshed.
 *
 * Capped per repository, oldest out first. A build time from four months ago is
 * not evidence about a pipeline that has been rewritten twice since, and an
 * append-only list on a busy repository grows until the process dies.
 */
export interface StoredCiHistory {
  runs: unknown[];
  fetchedAt: Record<string, string>;
}

/** CI runs kept per repository. Roughly a month on a busy pipeline. */
const MAX_CI_RUNS_PER_REPO = 400;

export class InMemoryStore implements Store {
  private orgs = new Map<string, Org>();
  private repos = new Map<string, Repo>();
  private reviews: ReviewRecord[] = [];
  private findings = new Map<string, StoredFinding>();
  private feed: ProvenCatch[] = [];
  private users = new Map<string, User>();      // by id
  private usersByEmail = new Map<string, User>();
  private settings = new Map<string, OrgSettings>();
  private apiKeys = new Map<string, string>();  // org → encrypted key blob
  /** org → encrypted GitLab access token. See setGitLabToken. */
  private gitlabTokens = new Map<string, string>();
  /** org -> encrypted Bitbucket access token. See setBitbucketToken. */
  private bitbucketTokens = new Map<string, string>();
  private oauthTokens = new Map<string, string>(); // userId → encrypted provider token
  private mutes: MuteEvent[] = [];
  private orgGraphs = new Map<string, StoredOrgGraph>();
  private ciRuns = new Map<string, StoredCiHistory>();
  /**
   * Stage 12's derived thresholds, per workspace. Never persisted: it is a pure
   * function of the decisions, so a snapshot of it could only ever disagree with
   * them, and recomputing costs one pass over a workspace's decided findings.
   */
  private calibrations = new Map<string, OrgCalibration>();

  createOrg(name: string, opts: { tier?: OrgTier; provenFeedOptIn?: boolean } = {}): Org {
    const org: Org = { id: id8("org"), name, tier: opts.tier ?? "paid", provenFeedOptIn: opts.provenFeedOptIn ?? false, createdAt: new Date().toISOString() };
    this.orgs.set(name, org);
    if (!this.settings.has(name)) this.settings.set(name, defaultSettings());
    return org;
  }
  getOrg(name: string): Org | undefined {
    return this.orgs.get(name);
  }
  setProvenFeedOptIn(org: string, optIn: boolean): void {
    const o = this.orgs.get(org);
    if (!o) throw new Error(`no such org: ${org}`);
    o.provenFeedOptIn = optIn;
  }
  createRepo(org: string, name: string, opts: { visibility?: "public" | "private"; enabled?: boolean } = {}): Repo {
    const visibility = opts.visibility ?? "private";
    const o = this.orgs.get(org);
    // Free tier onboards PUBLIC repos only — paid (or an active trial) unlocks private.
    const onTrial = !!o?.trialEndsAt && Date.parse(o.trialEndsAt) > Date.now();
    if (o?.tier === "free" && !onTrial && visibility !== "public") {
      throw new Error("free tier supports public repositories only; upgrade or start a trial for private repos");
    }
    const repo: Repo = { id: id8("repo"), org, name, visibility, enabled: opts.enabled ?? true };
    this.repos.set(`${org}/${name}`, repo);
    return repo;
  }
  setRepoEnabled(org: string, name: string, enabled: boolean, visibility: "public" | "private" = "private"): Repo | null {
    const repo = this.repos.get(`${org}/${name}`);
    if (!repo) {
      // Disabling a repo we never tracked is a no-op; enabling creates the row.
      return enabled ? this.createRepo(org, name, { visibility, enabled: true }) : null;
    }
    repo.enabled = enabled;
    return repo;
  }
  isRepoEnabled(fullName: string): boolean {
    return this.lookupRepo(fullName) !== null;
  }
  /**
   * Find the enabled row for "owner/name" and the workspace that owns it.
   * The orchestrator needs the owning org to load that workspace's BYOK key —
   * the GitHub owner login is a different name and must not be used for it.
   */
  lookupRepo(fullName: string): { org: string; repo: Repo } | null {
    for (const r of this.repos.values()) {
      if (r.name === fullName && r.enabled !== false) return { org: r.org, repo: r };
    }
    return null;
  }
  listOrgs(): Org[] {
    return [...this.orgs.values()];
  }
  listRepos(org: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.org === org);
  }
  removeRepo(org: string, name: string): boolean {
    return this.repos.delete(`${org}/${name}`);
  }

  reviewCountSince(org: string, sinceMs: number): number {
    const cutoff = Date.now() - sinceMs;
    return this.reviews.filter((r) => r.org === org && Date.parse(r.createdAt) >= cutoff).length;
  }

  saveReview(input: SaveReviewInput): ReviewRecord {
    const reviewId = id8("rev");
    const findings: StoredFinding[] = input.findings.map((f) => {
      const sf: StoredFinding = {
        id: id8("f"),
        reviewId,
        path: f.path,
        line: f.line,
        severity: f.severity,
        category: f.category,
        title: f.title,
        source: f.source,
        ...(typeof f.confidence === "number" && Number.isFinite(f.confidence)
          ? { confidence: f.confidence }
          : {}),
        immutable: f.immutable === true,
        agent: f.agent,
        verified: f.verified === true,
      };
      this.findings.set(sf.id, sf);
      return sf;
    });
    const record: ReviewRecord = {
      id: reviewId,
      org: input.org,
      repo: input.repo,
      pr: input.pr,
      title: input.title,
      ...(input.url ? { url: input.url } : {}),
      createdAt: new Date().toISOString(),
      findings,
      ...(typeof input.costUsd === "number" ? { costUsd: input.costUsd } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(typeof input.durationMs === "number" ? { durationMs: input.durationMs } : {}),
      ...(typeof input.verifiedCount === "number" ? { verifiedCount: input.verifiedCount } : {}),
      ...(typeof input.suppressedCount === "number" ? { suppressedCount: input.suppressedCount } : {}),
      // Stamped with the review id we just minted. The orchestrator cannot send
      // one: its only candidate would be "owner/repo#12@sha", which puts a
      // repository name inside the artefact built to carry nothing about the
      // customer's code.
      ...(input.retention ? { retention: { ...input.retention, reviewId } } : {}),
    };
    this.reviews.unshift(record); // newest first

    // Proven-catches feed: only VERIFIED findings, only if the org opted in AND
    // the repo is public. Never leak private-repo data.
    const org = this.orgs.get(input.org);
    const repo = this.repos.get(`${input.org}/${input.repo}`);
    if (org?.provenFeedOptIn && repo?.visibility === "public") {
      for (const f of findings) {
        if (f.verified) this.feed.unshift({ org: input.org, repo: input.repo, title: f.title, category: f.category, severity: f.severity, at: record.createdAt });
      }
    }
    return record;
  }

  provenFeed(limit = 100): ProvenCatch[] {
    return this.feed.slice(0, limit);
  }

  listReviews(org?: string, limit = 50): ReviewRecord[] {
    const filtered = org ? this.reviews.filter((r) => r.org === org) : this.reviews;
    return filtered.slice(0, limit);
  }
  getReview(id: string): ReviewRecord | undefined {
    return this.reviews.find((r) => r.id === id);
  }

  getFinding(id: string): StoredFinding | undefined {
    return this.findings.get(id);
  }

  recordDecision(findingId: string, state: DecisionState, user: string): StoredFinding {
    const f = this.findings.get(findingId);
    if (!f) throw new Error(`no such finding: ${findingId}`);
    // Immutable policy findings can be acknowledged but their PRESENCE is a fact;
    // we still record the human decision (signal for the org), but the finding is
    // never removed from the review by it.
    f.decision = { state, user, at: new Date().toISOString() };
    // This is the one event that changes a workspace's calibration, so it is the
    // one place the cache has to be dropped. Clicking Accept and then seeing the
    // Learnings page report the old bar for thirty seconds is exactly the kind of
    // thing that makes a customer stop believing the page.
    this.calibrations.delete(this.orgOfReview(f.reviewId));
    return f;
  }

  /** Which workspace a review belongs to, or "" if it has been dropped. */
  private orgOfReview(reviewId: string): string {
    return this.reviews.find((r) => r.id === reviewId)?.org ?? "";
  }

  listDecisions() {
    // Carries what the decision was ABOUT, not just its id.
    //
    // This used to return the finding id and nothing else, so the Learnings page
    // rendered a column of hashes. The page exists to show a customer that Cavix
    // is being tuned to their bar, and "f_3b91c204 · rejected" demonstrates
    // nothing to anyone.
    const out: Array<{
      findingId: string;
      reviewId: string;
      state: DecisionState;
      user: string;
      at: string;
      source: string;
      title: string;
      path: string;
      line: number;
      severity: string;
      category: string;
      verified: boolean;
      repo: string;
      // The two fields Stage 12's calibration is derived from. Both were sent by
      // the orchestrator and dropped here, so the learning package's inputs were
      // unreachable from the only real source of decisions in the product.
      confidence?: number;
      agent?: string;
    }> = [];
    const repoOf = new Map(this.reviews.map((r) => [r.id, r.repo]));
    for (const f of this.findings.values()) {
      if (!f.decision) continue;
      out.push({
        findingId: f.id,
        reviewId: f.reviewId,
        state: f.decision.state,
        user: f.decision.user,
        at: f.decision.at,
        source: f.source,
        title: f.title,
        path: f.path,
        line: f.line,
        severity: f.severity,
        category: f.category,
        verified: f.verified === true,
        repo: repoOf.get(f.reviewId) ?? "",
        ...(typeof f.confidence === "number" ? { confidence: f.confidence } : {}),
        ...(f.agent ? { agent: f.agent } : {}),
      });
    }
    return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  /**
   * What one workspace has taught Cavix, as the confidence bars Stage 9 will use.
   *
   * Computed HERE rather than in the orchestrator, for the same reason the
   * contract graph and the CI history are stored here: this is the process that
   * owns the decisions. The alternative is shipping every decision a workspace
   * has ever made over the wire on every pull request so a stateless worker can
   * reduce them to a dozen numbers, which is both slower and a wider blast
   * radius on the one endpoint that already crosses a trust boundary.
   *
   * Cached until the next decision, because that is the only thing that changes
   * it. Reviews come and go without touching it: a posted finding nobody has
   * ruled on teaches nothing.
   */
  calibration(org: string): OrgCalibration {
    const hit = this.calibrations.get(org);
    if (hit) return hit;
    const computed = calibrate(this.decisionRecords(org));
    this.calibrations.set(org, computed);
    return computed;
  }

  /** This workspace's decisions, in the shape the learning package consumes. */
  private decisionRecords(org: string): DecisionRecord[] {
    const mine = new Set(this.reviews.filter((r) => r.org === org).map((r) => r.id));
    const out: DecisionRecord[] = [];
    for (const f of this.findings.values()) {
      if (!f.decision || !mine.has(f.reviewId)) continue;
      out.push({
        category: f.category,
        source: f.source,
        accepted: f.decision.state === "accepted",
        at: f.decision.at,
        ...(typeof f.confidence === "number" ? { confidence: f.confidence } : {}),
        ...(f.agent ? { agent: f.agent } : {}),
      });
    }
    return out;
  }

  // ---------- accounts & team ----------

  createUser(input: { email: string; name: string; password: string; org: string; role?: Role }): PublicUser {
    const email = input.email.trim().toLowerCase();
    if (this.usersByEmail.has(email)) throw new Error("an account with this email already exists");
    // First user of an org becomes the owner; the org is created on demand.
    if (!this.orgs.has(input.org)) this.createOrg(input.org, { tier: "free" });
    const isFirst = this.listTeam(input.org).length === 0;
    const user: User = {
      id: id8("usr"),
      email,
      name: input.name.trim() || email.split("@")[0],
      org: input.org,
      role: input.role ?? (isFirst ? "owner" : "member"),
      passwordHash: hashPassword(input.password),
      createdAt: new Date().toISOString(),
    };
    this.users.set(user.id, user);
    this.usersByEmail.set(email, user);
    return toPublic(user);
  }
  getUserByEmail(email: string): User | undefined {
    return this.usersByEmail.get(email.trim().toLowerCase());
  }
  getUser(id: string): User | undefined {
    return this.users.get(id);
  }
  verifyLogin(email: string, password: string): PublicUser | null {
    const user = this.getUserByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) return null;
    return toPublic(user);
  }
  listTeam(org: string): PublicUser[] {
    return [...this.users.values()].filter((u) => u.org === org).map(toPublic);
  }
  setRole(org: string, userId: string, role: Role): PublicUser {
    const u = this.users.get(userId);
    if (!u || u.org !== org) throw new Error("no such user in this org");
    u.role = role;
    return toPublic(u);
  }
  upsertOAuthUser(input: { email: string; name: string; org: string; provider: "github" | "gitlab"; login: string }): PublicUser {
    const email = input.email.trim().toLowerCase();
    const existing = this.usersByEmail.get(email);
    if (existing) {
      existing.provider = input.provider;
      existing.githubLogin = input.login;
      if (input.name) existing.name = input.name;
      return toPublic(existing);
    }
    if (!this.orgs.has(input.org)) this.createOrg(input.org, { tier: "free" });
    const isFirst = this.listTeam(input.org).length === 0;
    const user: User = {
      id: id8("usr"),
      email,
      name: input.name || input.login,
      org: input.org,
      role: isFirst ? "owner" : "member",
      passwordHash: hashPassword(randomUUID()), // unusable password; login is via OAuth
      createdAt: new Date().toISOString(),
      provider: input.provider,
      githubLogin: input.login,
    };
    this.users.set(user.id, user);
    this.usersByEmail.set(email, user);
    return toPublic(user);
  }
  setOAuthToken(userId: string, tokens: OAuthTokens): void {
    this.oauthTokens.set(userId, encryptSecret(JSON.stringify(tokens)));
  }
  getOAuthToken(userId: string): OAuthTokens | null {
    const blob = this.oauthTokens.get(userId);
    if (!blob) return null;
    const plain = decryptSecret(blob);
    // Null means the blob will not decrypt, which in practice means
    // CAVIX_SECRET_KEY changed between deploys. Treat it as "no credential" so
    // the user is asked to reconnect, rather than as a hard error on every page.
    if (!plain) return null;
    try {
      const parsed = JSON.parse(plain) as OAuthTokens;
      return parsed.accessToken ? parsed : null;
    } catch {
      // Tokens saved before refresh support were a bare access-token string.
      // They still work until they expire, and the next refresh upgrades them.
      return { accessToken: plain };
    }
  }
  clearOAuthToken(userId: string): void {
    this.oauthTokens.delete(userId);
  }

  // ---------- BYOK / settings ----------

  getSettings(org: string): OrgSettings {
    let s = this.settings.get(org);
    if (!s) {
      s = defaultSettings();
      this.settings.set(org, s);
      return s;
    }
    // Fill in keys added since this org's settings were written. Snapshots
    // restored from Postgres predate every new field, and a missing toggle read
    // as `undefined` would silently mean "off" — turning verification off for
    // every existing org the moment it shipped. Patch in place so the object
    // identity (and updateSettings' mutation) still works.
    const defaults = defaultSettings() as unknown as Record<string, unknown>;
    const cur = s as unknown as Record<string, unknown>;
    for (const k of Object.keys(defaults)) if (cur[k] === undefined) cur[k] = defaults[k];
    // Air-gap is a property of the DEPLOYMENT, never of a workspace. It is
    // enforced by the gateway's EgressGuard and a Kubernetes NetworkPolicy, both
    // process-wide, and neither of them has ever read this field. Storing a
    // per-org copy meant the dashboard could show a security control as ON while
    // the process it describes was making outbound calls, which is the worst
    // possible thing for a page like that to be wrong about. Derived on read so
    // it always states what the deployment is actually doing.
    s.airgapped = process.env.CAVIX_AIRGAPPED === "true";
    return s;
  }
  updateSettings(org: string, patch: Partial<OrgSettings>): OrgSettings {
    const s = this.getSettings(org);
    // Only allow known, safe fields to be patched (never the fingerprint directly).
    // `airgapped` is deliberately NOT patchable: see getSettings. A dashboard
    // that can set it can lie about it.
    const allowed: (keyof OrgSettings)[] = ["llmProvider", "llmModel", "autoReview", "reviewDraftPRs", "tone", "failOn", "policyEnabled", "verifyFindings", "summaryInDescription", "requestChangesOnFail", "pathFilters", "preMergeChecks", "reviewSections"];
    for (const k of allowed) {
      if (patch[k] !== undefined) (s as unknown as Record<string, unknown>)[k] = patch[k];
    }
    this.settings.set(org, s);
    return s;
  }
  setApiKey(org: string, rawKey: string): OrgSettings {
    const key = rawKey.trim();
    if (!key) throw new Error("api key is empty");
    this.apiKeys.set(org, encryptSecret(key));
    const s = this.getSettings(org);
    s.apiKeyFingerprint = fingerprint(key);
    s.apiKeySetAt = new Date().toISOString();
    return s;
  }
  getApiKey(org: string): string | null {
    const blob = this.apiKeys.get(org);
    return blob ? decryptSecret(blob) : null;
  }

  setGitLabToken(org: string, rawToken: string): void {
    const t = rawToken.trim();
    if (!t) throw new Error("gitlab token is empty");
    this.gitlabTokens.set(org, encryptSecret(t));
  }
  getGitLabToken(org: string): string | null {
    const blob = this.gitlabTokens.get(org);
    // Null when the blob will not decrypt, which in practice means
    // CAVIX_SECRET_KEY changed between deploys. Treated as "no credential" so
    // the owner is asked to re-paste it, exactly as for an OAuth token.
    return blob ? decryptSecret(blob) : null;
  }
  clearGitLabToken(org: string): void {
    this.gitlabTokens.delete(org);
  }

  setBitbucketToken(org: string, rawToken: string): void {
    const t = rawToken.trim();
    if (!t) throw new Error("bitbucket token is empty");
    this.bitbucketTokens.set(org, encryptSecret(t));
  }
  getBitbucketToken(org: string): string | null {
    const blob = this.bitbucketTokens.get(org);
    return blob ? decryptSecret(blob) : null;
  }
  clearBitbucketToken(org: string): void {
    this.bitbucketTokens.delete(org);
  }

  // ---------- dashboard stats ----------

  stats(org: string): OrgStats {
    const reviews = this.reviews.filter((r) => r.org === org);
    const findings = reviews.flatMap((r) => r.findings);
    const bySeverity: Record<string, number> = {};
    let verified = 0, accepted = 0, rejected = 0;
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      if (f.verified) verified++;
      if (f.decision?.state === "accepted") accepted++;
      if (f.decision?.state === "rejected") rejected++;
    }
    const decided = accepted + rejected;
    // Reviewer-hours saved model: weight by severity (critical/high cost more to
    // find + fix by hand). Mirrors the analytics package's rollup.
    const weight: Record<string, number> = { critical: 0.75, high: 0.5, medium: 0.25, low: 0.1 };
    const hoursSaved = Math.round(findings.reduce((sum, f) => sum + (weight[f.severity] ?? 0.1), 0) * 10) / 10;

    // Reviews per day for the last 7 days (oldest → newest) for the sparkline.
    // The last bucket ends at `now` — see the note in platformStats().
    const now = Date.now();
    const reviewsLast7Days = Array.from({ length: 7 }, (_, i) => {
      const dayStart = now - (7 - i) * 86_400_000;
      const dayEnd = dayStart + 86_400_000;
      return reviews.filter((r) => {
        const t = Date.parse(r.createdAt);
        return t >= dayStart && t < dayEnd;
      }).length;
    });

    return {
      reviews: reviews.length,
      findings: findings.length,
      verified,
      accepted,
      rejected,
      actionRate: decided ? Math.round((accepted / decided) * 100) / 100 : 0,
      falsePositiveRate: decided ? Math.round((rejected / decided) * 100) / 100 : 0,
      reposConnected: this.listRepos(org).length,
      bySeverity,
      reviewsLast7Days,
      hoursSaved,
    };
  }

  // ---------- mute tracking + analytics ----------

  recordMute(e: Omit<MuteEvent, "at">): void {
    this.mutes.push({ ...e, at: new Date().toISOString() });
  }

  listMutes(org: string, sinceMs?: number): MuteEvent[] {
    const cutoff = sinceMs ? Date.now() - sinceMs : 0;
    return this.mutes.filter((m) => m.org === org && (!sinceMs || Date.parse(m.at) >= cutoff));
  }

  orgGraph(org: string): StoredOrgGraph | null {
    return this.orgGraphs.get(org) ?? null;
  }

  saveOrgGraph(org: string, repo: string, graph: unknown): StoredOrgGraph {
    const prev = this.orgGraphs.get(org);
    const next: StoredOrgGraph = {
      graph,
      indexedAt: { ...(prev?.indexedAt ?? {}), [repo]: new Date().toISOString() },
    };
    this.orgGraphs.set(org, next);
    return next;
  }

  ciHistory(org: string): StoredCiHistory {
    return this.ciRuns.get(org) ?? { runs: [], fetchedAt: {} };
  }

  saveCiHistory(org: string, repo: string, runs: unknown[]): StoredCiHistory {
    const prev = this.ciHistory(org);
    // Replace this repository's runs wholesale and leave every other
    // repository's alone. The orchestrator sends the merged list it built, so
    // appending here would double every run on the second refresh.
    const others = prev.runs.filter((r) => (r as { repo?: string }).repo !== repo);
    const mine = runs.slice(-MAX_CI_RUNS_PER_REPO);
    const next: StoredCiHistory = {
      runs: [...others, ...mine],
      fetchedAt: { ...prev.fetchedAt, [repo]: new Date().toISOString() },
    };
    this.ciRuns.set(org, next);
    return next;
  }

  analytics(org: string, days = 30): OrgAnalytics {
    const windowMs = days * 86_400_000;
    const cutoff = Date.now() - windowMs;
    const reviews = this.reviews.filter((r) => r.org === org && Date.parse(r.createdAt) >= cutoff);

    // ROI comes from the analytics package. One event per posted finding, keyed
    // by repo so "team" in its vocabulary is a repository here.
    const events: ReviewEvent[] = reviews.flatMap((r) =>
      r.findings.map((f) => ({
        team: r.repo,
        repo: r.repo,
        reviewId: r.id,
        findingId: f.id,
        // Narrowed, not asserted. `StoredFinding.severity` is a bare string (it
        // comes off the wire), and the ROI model looks its minutes up by
        // severity: one unrecognised value made `reviewerHoursSaved` NaN for the
        // whole workspace, which the Reports page would have rendered as "NaN
        // hours saved". Anything unknown counts as the least-claiming bucket.
        severity: toSeverity(f.severity),
        source: f.source,
        ...(f.agent ? { agent: f.agent } : {}),
        verified: f.verified === true,
        // The fix-PR agent is a Phase 4 package that does not run in this
        // deployment yet, so this is honestly false rather than optimistically
        // derived from something else.
        fixPrOpened: false,
        decision: (f.decision?.state ?? "none") as "accepted" | "rejected" | "none",
        at: r.createdAt,
      })),
    );

    const analyticsStore = new InMemoryAnalyticsStore();
    for (const e of events) analyticsStore.ingest(e);
    const rollup = computeOrgRollup(analyticsStore);

    // Daily buckets, oldest first, keyed on the UTC date so a chart's x-axis
    // labels and its data cannot disagree about which day a point belongs to.
    const byDay = new Map<string, DayPoint>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      byDay.set(d, { date: d, reviews: 0, findings: 0, verified: 0, accepted: 0, rejected: 0, costUsd: 0 });
    }
    for (const r of reviews) {
      const point = byDay.get(r.createdAt.slice(0, 10));
      if (!point) continue;
      point.reviews++;
      point.findings += r.findings.length;
      point.costUsd += r.costUsd ?? 0;
      for (const f of r.findings) {
        if (f.verified) point.verified++;
        if (f.decision?.state === "accepted") point.accepted++;
        if (f.decision?.state === "rejected") point.rejected++;
      }
    }
    const series = [...byDay.values()];

    const priced = reviews.filter((r) => typeof r.costUsd === "number");
    const totalCostUsd = priced.reduce((n, r) => n + (r.costUsd ?? 0), 0);
    const findings = reviews.flatMap((r) => r.findings);
    const verified = findings.filter((f) => f.verified).length;

    return {
      days: series,
      repos: rollup.teams
        .map((t) => {
          const forRepo = reviews.filter((r) => r.repo === t.team);
          return {
            repo: t.team,
            reviews: forRepo.length,
            findings: t.totalFindings,
            verified: t.defectsCaught,
            actionRate: t.actionRate,
            hoursSaved: t.reviewerHoursSaved,
            costUsd: round2(forRepo.reduce((n, r) => n + (r.costUsd ?? 0), 0)),
          };
        })
        .sort((a, b) => b.findings - a.findings),
      totalFindings: rollup.totalFindings,
      actionRate: rollup.actionRate,
      defectsCaught: rollup.defectsCaught,
      reviewerHoursSaved: rollup.reviewerHoursSaved,
      costPerReview: priced.length ? round4(totalCostUsd / priced.length) : 0,
      totalCostUsd: round4(totalCostUsd),
      verifiedShare: findings.length ? round2(verified / findings.length) : 0,
      muteEvents: this.listMutes(org, windowMs),
      actionRateTrend: halfOverHalfActionRate(series),
    };
  }

  // ---------- founder / platform admin ----------

  effectiveReviewsPerDay(org: string): number {
    const o = this.orgs.get(org);
    if (!o) return Number(process.env.CAVIX_PAID_REVIEWS_PER_DAY ?? "1000000");
    if (o.suspended) return 0;
    if (typeof o.reviewsPerDayOverride === "number") return o.reviewsPerDayOverride;
    const onTrial = !!o.trialEndsAt && Date.parse(o.trialEndsAt) > Date.now();
    const tier: OrgTier = onTrial ? "paid" : o.tier;
    return tier === "free"
      ? Number(process.env.CAVIX_FREE_REVIEWS_PER_DAY ?? "25")
      : Number(process.env.CAVIX_PAID_REVIEWS_PER_DAY ?? "1000000");
  }
  private mustOrg(org: string): Org {
    const o = this.orgs.get(org);
    if (!o) throw new Error(`no such org: ${org}`);
    return o;
  }
  setTier(org: string, tier: OrgTier): Org {
    const o = this.mustOrg(org);
    o.tier = tier;
    return o;
  }
  startTrial(org: string, days: number): Org {
    const o = this.mustOrg(org);
    o.trialEndsAt = new Date(Date.now() + days * 86_400_000).toISOString();
    return o;
  }
  endTrial(org: string): Org {
    const o = this.mustOrg(org);
    delete o.trialEndsAt;
    return o;
  }
  setReviewLimitOverride(org: string, reviewsPerDay: number | null): Org {
    const o = this.mustOrg(org);
    if (reviewsPerDay === null) delete o.reviewsPerDayOverride;
    else o.reviewsPerDayOverride = reviewsPerDay;
    return o;
  }
  setSuspended(org: string, suspended: boolean): Org {
    const o = this.mustOrg(org);
    o.suspended = suspended;
    return o;
  }
  listOrgsAdmin(): OrgAdminView[] {
    const now = Date.now();
    return [...this.orgs.values()].map((o) => {
      const reviews = this.reviews.filter((r) => r.org === o.name);
      const limit = this.effectiveReviewsPerDay(o.name);
      const reviewsToday = this.reviewCountSince(o.name, 86_400_000);
      const trialEnds = o.trialEndsAt ? Date.parse(o.trialEndsAt) : undefined;
      return {
        ...o,
        members: this.listTeam(o.name).length,
        repos: this.listRepos(o.name).length,
        reviews: reviews.length,
        effectiveReviewsPerDay: limit,
        trialActive: trialEnds !== undefined && trialEnds > now,
        trialDaysLeft: trialEnds === undefined ? undefined : Math.ceil((trialEnds - now) / 86_400_000),
        reviewsToday,
        usagePct: limit > 0 ? Math.min(100, Math.round((reviewsToday / limit) * 100)) : 0,
        // reviews are newest-first, so the head is the most recent activity.
        lastActivityAt: reviews[0]?.createdAt,
        apiKeySet: this.apiKeys.has(o.name),
        verifyFindings: this.getSettings(o.name).verifyFindings,
      };
    });
  }

  platformStats(): PlatformStats {
    const now = Date.now();
    const day = 86_400_000;
    const since = (ms: number, iso?: string) => !!iso && now - Date.parse(iso) <= ms;
    const users = [...this.users.values()];
    const orgs = [...this.orgs.values()];
    const repos = [...this.repos.values()];

    const activeOrgs = new Set(
      this.reviews.filter((r) => now - Date.parse(r.createdAt) <= 7 * day).map((r) => r.org),
    );
    const trialEnd = (o: Org) => (o.trialEndsAt ? Date.parse(o.trialEndsAt) : undefined);

    const findings = this.reviews.flatMap((r) => r.findings);
    const bySeverity: Record<string, number> = {};
    let verified = 0, accepted = 0, rejected = 0;
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      if (f.verified) verified++;
      if (f.decision?.state === "accepted") accepted++;
      if (f.decision?.state === "rejected") rejected++;
    }

    // Estimated only — Cavix does not charge here. Seats are members, priced at
    // the Team BYOK rate unless the deployment overrides it.
    const pricePerSeat = Number(process.env.CAVIX_PRICE_PER_SEAT ?? "12");
    const seatsIn = (pick: (o: Org) => boolean) =>
      orgs.filter(pick).reduce((sum, o) => sum + this.listTeam(o.name).length, 0);
    const onTrial = (o: Org) => (trialEnd(o) ?? 0) > now;
    const paidSeats = seatsIn((o) => o.tier === "paid" && !o.suspended && !onTrial(o));
    // Suspended orgs are excluded here for the same reason as paidSeats: they
    // are not running reviews, so counting them as pipeline overstates it.
    const trialSeats = seatsIn((o) => onTrial(o) && !o.suspended);

    return {
      generatedAt: new Date().toISOString(),
      users: {
        total: users.length,
        new7d: users.filter((u) => since(7 * day, u.createdAt)).length,
        new30d: users.filter((u) => since(30 * day, u.createdAt)).length,
        withGithub: users.filter((u) => !!u.githubLogin).length,
      },
      orgs: {
        total: orgs.length,
        free: orgs.filter((o) => o.tier === "free").length,
        paid: orgs.filter((o) => o.tier === "paid").length,
        trialActive: orgs.filter(onTrial).length,
        trialExpiring7d: orgs.filter((o) => {
          const t = trialEnd(o);
          return t !== undefined && t > now && t - now <= 7 * day;
        }).length,
        trialExpired: orgs.filter((o) => {
          const t = trialEnd(o);
          return t !== undefined && t <= now;
        }).length,
        suspended: orgs.filter((o) => o.suspended === true).length,
        new7d: orgs.filter((o) => since(7 * day, o.createdAt)).length,
        activeLast7d: activeOrgs.size,
        withApiKey: orgs.filter((o) => this.apiKeys.has(o.name)).length,
      },
      repos: {
        total: repos.length,
        enabled: repos.filter((r) => r.enabled !== false).length,
        public: repos.filter((r) => r.visibility === "public").length,
        private: repos.filter((r) => r.visibility === "private").length,
      },
      reviews: {
        total: this.reviews.length,
        last24h: this.reviews.filter((r) => now - Date.parse(r.createdAt) <= day).length,
        last7d: this.reviews.filter((r) => now - Date.parse(r.createdAt) <= 7 * day).length,
        // Buckets END at `now`, so the last one is the trailing 24h. Anchoring
        // them to start at `now` instead puts today's reviews in yesterday's bar
        // and leaves the final bar permanently empty.
        perDay14: Array.from({ length: 14 }, (_, i) => {
          const start = now - (14 - i) * day;
          return this.reviews.filter((r) => {
            const t = Date.parse(r.createdAt);
            return t >= start && t < start + day;
          }).length;
        }),
      },
      findings: { total: findings.length, verified, accepted, rejected, bySeverity },
      revenue: {
        pricePerSeat,
        paidSeats,
        estimatedMrr: paidSeats * pricePerSeat,
        trialSeats,
        pipelineMrr: trialSeats * pricePerSeat,
      },
    };
  }

  // ---------- persistence (snapshot / restore whole state) ----------

  /** Serialize the entire store to a plain object (safe to JSON.stringify → Postgres). */
  snapshot(): StoreSnapshot {
    return {
      v: 1,
      orgs: [...this.orgs.values()],
      repos: [...this.repos.values()],
      reviews: this.reviews,       // findings are inline here
      feed: this.feed,
      users: [...this.users.values()],
      settings: [...this.settings.entries()],
      apiKeys: [...this.apiKeys.entries()],
      oauthTokens: [...this.oauthTokens.entries()],
      gitlabTokens: [...this.gitlabTokens.entries()],
      bitbucketTokens: [...this.bitbucketTokens.entries()],
      mutes: this.mutes,
      orgGraphs: [...this.orgGraphs.entries()],
      ciRuns: [...this.ciRuns.entries()],
    };
  }

  /** Replace all state from a snapshot (rebuilds derived indexes + shared refs). */
  restore(s: StoreSnapshot): void {
    this.orgs = new Map((s.orgs ?? []).map((o) => [o.name, o]));
    this.repos = new Map((s.repos ?? []).map((r) => [`${r.org}/${r.name}`, r]));
    this.reviews = s.reviews ?? [];
    // Rebuild the findings index from the reviews so both point at the SAME object
    // (decisions mutate the shared finding and must show in listReviews).
    this.findings = new Map();
    for (const rev of this.reviews) for (const f of rev.findings) this.findings.set(f.id, f);
    this.feed = s.feed ?? [];
    this.users = new Map((s.users ?? []).map((u) => [u.id, u]));
    this.usersByEmail = new Map((s.users ?? []).map((u) => [u.email, u]));
    this.settings = new Map(s.settings ?? []);
    this.apiKeys = new Map(s.apiKeys ?? []);
    this.oauthTokens = new Map(s.oauthTokens ?? []);
    this.gitlabTokens = new Map(s.gitlabTokens ?? []);
    this.bitbucketTokens = new Map(s.bitbucketTokens ?? []);
    // Both default to empty rather than being left alone, so a restore replaces
    // every field. Skipping them left the previous process's mutes and graph
    // sitting in memory beside freshly loaded orgs they no longer belonged to.
    this.mutes = s.mutes ?? [];
    this.orgGraphs = new Map(s.orgGraphs ?? []);
    this.ciRuns = new Map(s.ciRuns ?? []);
    // Derived from the decisions that were just replaced, so anything cached
    // from the previous state now describes a workspace that is no longer here.
    this.calibrations.clear();
  }

  /** True when the store has no data yet (used to decide whether to seed). */
  isEmpty(): boolean {
    return this.orgs.size === 0 && this.users.size === 0;
  }
}

function toPublic(u: User): PublicUser {
  return { id: u.id, email: u.email, name: u.name, org: u.org, role: u.role, createdAt: u.createdAt, provider: u.provider, githubLogin: u.githubLogin };
}

function id8(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/** A severity the ROI model knows how to price, or the quietest one. */
function toSeverity(s: string): Severity {
  return s === "critical" || s === "high" || s === "medium" || s === "low" || s === "info" ? s : "info";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Action rate over the first half of the window against the second, in
 * percentage points.
 *
 * A single action rate says how a team feels about Cavix; the DIRECTION says
 * whether they are on their way out. The roadmap is explicit that a falling
 * action rate is the earliest churn signal there is, so the number that matters
 * is the change, not the level.
 *
 * Returns 0 when either half decided nothing: a team that made no decisions is
 * not trending anywhere, and reporting a swing from an empty denominator would
 * fire the alarm on a quiet fortnight.
 */
function halfOverHalfActionRate(days: DayPoint[]): number {
  const mid = Math.floor(days.length / 2);
  const rate = (slice: DayPoint[]): number | null => {
    const accepted = slice.reduce((n, d) => n + d.accepted, 0);
    const decided = accepted + slice.reduce((n, d) => n + d.rejected, 0);
    return decided === 0 ? null : accepted / decided;
  };
  const before = rate(days.slice(0, mid));
  const after = rate(days.slice(mid));
  if (before === null || after === null) return 0;
  return Math.round((after - before) * 1000) / 10;
}
