import { randomUUID } from "node:crypto";
import type { Finding } from "@cavix/core";
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
  createdAt: string;
  findings: StoredFinding[];
}

export interface SaveReviewInput {
  org: string;
  repo: string;
  pr: number;
  title: string;
  findings: Array<Finding & { verified?: boolean }>;
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
  getFinding(id: string): StoredFinding | undefined;
  recordDecision(findingId: string, state: DecisionState, user: string): StoredFinding;
  listDecisions(): Array<{ findingId: string; reviewId: string; state: DecisionState; user: string; at: string; source: string }>;
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
  setOAuthToken(userId: string, token: string): void;
  getOAuthToken(userId: string): string | null;

  // --- BYOK / settings ---
  getSettings(org: string): OrgSettings;
  updateSettings(org: string, patch: Partial<OrgSettings>): OrgSettings;
  setApiKey(org: string, rawKey: string): OrgSettings;
  /** Decrypts and returns the stored BYOK key for the orchestrator to use. */
  getApiKey(org: string): string | null;

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
}

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
  private oauthTokens = new Map<string, string>(); // userId → encrypted provider token

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
      createdAt: new Date().toISOString(),
      findings,
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
    return f;
  }

  listDecisions() {
    const out: Array<{ findingId: string; reviewId: string; state: DecisionState; user: string; at: string; source: string }> = [];
    for (const f of this.findings.values()) {
      if (f.decision) out.push({ findingId: f.id, reviewId: f.reviewId, state: f.decision.state, user: f.decision.user, at: f.decision.at, source: f.source });
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
  setOAuthToken(userId: string, token: string): void {
    this.oauthTokens.set(userId, encryptSecret(token));
  }
  getOAuthToken(userId: string): string | null {
    const blob = this.oauthTokens.get(userId);
    return blob ? decryptSecret(blob) : null;
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
    const defaults = defaultSettings() as Record<string, unknown>;
    const cur = s as unknown as Record<string, unknown>;
    for (const k of Object.keys(defaults)) if (cur[k] === undefined) cur[k] = defaults[k];
    return s;
  }
  updateSettings(org: string, patch: Partial<OrgSettings>): OrgSettings {
    const s = this.getSettings(org);
    // Only allow known, safe fields to be patched (never the fingerprint directly).
    const allowed: (keyof OrgSettings)[] = ["llmProvider", "llmModel", "autoReview", "reviewDraftPRs", "tone", "failOn", "policyEnabled", "airgapped", "verifyFindings", "summaryInDescription", "requestChangesOnFail", "pathFilters", "preMergeChecks", "reviewSections"];
    for (const k of allowed) {
      if (patch[k] !== undefined) (s as Record<string, unknown>)[k] = patch[k];
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
