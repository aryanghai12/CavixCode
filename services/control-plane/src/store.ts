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
  decision?: Decision;
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
  findings: Finding[];
}

export interface Store {
  createOrg(name: string): { id: string; name: string };
  createRepo(org: string, name: string): { id: string; org: string; name: string };
  listOrgs(): Array<{ id: string; name: string }>;
  saveReview(input: SaveReviewInput): ReviewRecord;
  listReviews(org?: string, limit?: number): ReviewRecord[];
  getFinding(id: string): StoredFinding | undefined;
  recordDecision(findingId: string, state: DecisionState, user: string): StoredFinding;
  listDecisions(): Array<{ findingId: string; reviewId: string; state: DecisionState; user: string; at: string; source: string }>;
}

export class InMemoryStore implements Store {
  private orgs = new Map<string, { id: string; name: string }>();
  private repos = new Map<string, { id: string; org: string; name: string }>();
  private reviews: ReviewRecord[] = [];
  private findings = new Map<string, StoredFinding>();

  createOrg(name: string) {
    const org = { id: id8("org"), name };
    this.orgs.set(name, org);
    return org;
  }
  createRepo(org: string, name: string) {
    const repo = { id: id8("repo"), org, name };
    this.repos.set(`${org}/${name}`, repo);
    return repo;
  }
  listOrgs() {
    return [...this.orgs.values()];
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
    return record;
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
