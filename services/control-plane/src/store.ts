import { randomUUID } from "node:crypto";
import type { Finding } from "@cavix/core";

// The control-plane store. In-memory for Phase 1; the same port backs Postgres in
// production. It records orgs, repos, reviews, and — the bit that matters for the
// Phase 2 learning loop — per-finding accept/reject DECISIONS.

export type DecisionState = "accepted" | "rejected";

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

export interface Store {
  createOrg(name: string, opts?: { tier?: OrgTier; provenFeedOptIn?: boolean }): Org;
  createRepo(org: string, name: string, opts?: { visibility?: "public" | "private" }): Repo;
  getOrg(name: string): Org | undefined;
  setProvenFeedOptIn(org: string, optIn: boolean): void;
  listOrgs(): Org[];
  saveReview(input: SaveReviewInput): ReviewRecord;
  listReviews(org?: string, limit?: number): ReviewRecord[];
  reviewCountSince(org: string, sinceMs: number): number;
  getFinding(id: string): StoredFinding | undefined;
  recordDecision(findingId: string, state: DecisionState, user: string): StoredFinding;
  listDecisions(): Array<{ findingId: string; reviewId: string; state: DecisionState; user: string; at: string; source: string }>;
  provenFeed(limit?: number): ProvenCatch[];
}

export class InMemoryStore implements Store {
  private orgs = new Map<string, Org>();
  private repos = new Map<string, Repo>();
  private reviews: ReviewRecord[] = [];
  private findings = new Map<string, StoredFinding>();
  private feed: ProvenCatch[] = [];

  createOrg(name: string, opts: { tier?: OrgTier; provenFeedOptIn?: boolean } = {}): Org {
    const org: Org = { id: id8("org"), name, tier: opts.tier ?? "paid", provenFeedOptIn: opts.provenFeedOptIn ?? false };
    this.orgs.set(name, org);
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
    // Free tier onboards PUBLIC repos only — paid unlocks private.
    if (o?.tier === "free" && visibility !== "public") {
      throw new Error("free tier supports public repositories only; upgrade for private repos");
    }
    const repo: Repo = { id: id8("repo"), org, name, visibility };
    this.repos.set(`${org}/${name}`, repo);
    return repo;
  }
  listOrgs(): Org[] {
    return [...this.orgs.values()];
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
}

function id8(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}
