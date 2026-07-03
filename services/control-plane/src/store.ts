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
}

export interface Repo {
  id: string;
  org: string;
  name: string;
  visibility: "public" | "private";
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
  createRepo(org: string, name: string, opts?: { visibility?: "public" | "private" }): Repo;
  getOrg(name: string): Org | undefined;
  setProvenFeedOptIn(org: string, optIn: boolean): void;
  listOrgs(): Org[];
  listRepos(org: string): Repo[];
  removeRepo(org: string, name: string): boolean;
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
}

function defaultSettings(): OrgSettings {
  return {
    llmProvider: process.env.CAVIX_LLM_PROVIDER ?? "anthropic",
    llmModel: process.env.CAVIX_LLM_MODEL ?? "claude-sonnet-4-6",
    autoReview: true,
    reviewDraftPRs: false,
    tone: "concise",
    failOn: ["critical"],
    policyEnabled: false,
    airgapped: process.env.CAVIX_AIRGAPPED === "true",
    pathFilters: { include: [], exclude: ["**/*.min.js", "**/generated/**", "**/vendor/**"] },
    preMergeChecks: { enabled: false, rules: [] },
    reviewSections: { summary: true, changedFiles: true, sequenceDiagram: true, reviewEffort: true, relatedIssues: true, inlineFindings: true, proof: true },
  };
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
  createRepo(org: string, name: string, opts: { visibility?: "public" | "private" } = {}): Repo {
    const visibility = opts.visibility ?? "private";
    const o = this.orgs.get(org);
    // Free tier onboards PUBLIC repos only — paid (or an active trial) unlocks private.
    const onTrial = !!o?.trialEndsAt && Date.parse(o.trialEndsAt) > Date.now();
    if (o?.tier === "free" && !onTrial && visibility !== "public") {
      throw new Error("free tier supports public repositories only; upgrade or start a trial for private repos");
    }
    const repo: Repo = { id: id8("repo"), org, name, visibility };
    this.repos.set(`${org}/${name}`, repo);
    return repo;
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
    }
    return s;
  }
  updateSettings(org: string, patch: Partial<OrgSettings>): OrgSettings {
    const s = this.getSettings(org);
    // Only allow known, safe fields to be patched (never the fingerprint directly).
    const allowed: (keyof OrgSettings)[] = ["llmProvider", "llmModel", "autoReview", "reviewDraftPRs", "tone", "failOn", "policyEnabled", "airgapped", "pathFilters", "preMergeChecks", "reviewSections"];
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
    const now = Date.now();
    const reviewsLast7Days = Array.from({ length: 7 }, (_, i) => {
      const dayStart = now - (6 - i) * 86_400_000;
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
    return [...this.orgs.values()].map((o) => ({
      ...o,
      members: this.listTeam(o.name).length,
      repos: this.listRepos(o.name).length,
      reviews: this.reviews.filter((r) => r.org === o.name).length,
      effectiveReviewsPerDay: this.effectiveReviewsPerDay(o.name),
      trialActive: !!o.trialEndsAt && Date.parse(o.trialEndsAt) > Date.now(),
    }));
  }
}

function toPublic(u: User): PublicUser {
  return { id: u.id, email: u.email, name: u.name, org: u.org, role: u.role, createdAt: u.createdAt, provider: u.provider, githubLogin: u.githubLogin };
}

function id8(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}
