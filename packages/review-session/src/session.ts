import { createHash } from "node:crypto";
import type { Finding } from "@cavix/core";

// Review session: the per-PR memory that makes "@cavix review" behave like a real
// reviewer. It knows what Cavix already posted, so it can:
//   - run a FRESH review on demand: dismiss its stale reviews, delete stale
//     inline comments, and clear the cache, then review from scratch;
//   - run an INCREMENTAL review on new commits without reposting the same finding;
//   - honor pause/resume.

export interface PrState {
  repo: string;
  pr: number;
  lastReviewedSha?: string;
  postedReviewIds: number[];
  postedCommentIds: number[];
  /** Fingerprints of findings already posted (so we never repost duplicates). */
  fingerprints: string[];
  paused: boolean;
}

export interface ReviewStateStore {
  get(repo: string, pr: number): PrState | undefined;
  set(state: PrState): void;
}

export class InMemoryReviewStateStore implements ReviewStateStore {
  private m = new Map<string, PrState>();
  private key(repo: string, pr: number) {
    return `${repo}#${pr}`;
  }
  get(repo: string, pr: number): PrState | undefined {
    return this.m.get(this.key(repo, pr));
  }
  set(state: PrState): void {
    this.m.set(this.key(state.repo, state.pr), state);
  }
}

// Structural interface satisfied by GitHubPlatform (and the others). Generic over
// the platform's ref type so this package doesn't depend on @cavix/platforms.
export interface ReviewManager<Ref> {
  dismissReview(ref: Ref, reviewId: number, message: string): Promise<void>;
  deleteReviewComment(ref: Ref, commentId: number): Promise<void>;
}

export type ReviewMode = "fresh" | "incremental" | "skip-paused";

export interface PlanInput {
  repo: string;
  pr: number;
  headSha: string;
  forceFresh: boolean;
  command?: string; // review|resume|pause|…
}

/** Decide how to review, given prior state + the trigger. */
export function planReview(state: PrState | undefined, input: PlanInput): ReviewMode {
  if (state?.paused && !input.forceFresh && input.command !== "resume") return "skip-paused";
  if (input.forceFresh) return "fresh";
  if (!state || !state.lastReviewedSha) return "fresh"; // first time
  return "incremental";
}

export function fingerprint(f: Finding): string {
  return createHash("sha1").update(`${f.path}|${f.line}|${f.ruleId ?? f.title}`).digest("hex").slice(0, 16);
}

export interface BeginResult {
  mode: ReviewMode;
  dismissedReviews: number[];
  deletedComments: number[];
}

export class ReviewSession<Ref> {
  private readonly store: ReviewStateStore;
  private readonly manager: ReviewManager<Ref>;
  constructor(store: ReviewStateStore, manager: ReviewManager<Ref>) {
    this.store = store;
    this.manager = manager;
  }

  /** Begin a review: for a FRESH run, dismiss stale reviews + delete stale
   *  comments + clear the cache. Returns the mode and what was cleaned up. */
  async begin(ref: Ref, input: PlanInput): Promise<BeginResult> {
    const state = this.store.get(input.repo, input.pr);
    const mode = planReview(state, input);
    if (mode !== "fresh") return { mode, dismissedReviews: [], deletedComments: [] };

    const dismissedReviews: number[] = [];
    const deletedComments: number[] = [];
    if (state) {
      for (const id of state.postedReviewIds) {
        await this.manager.dismissReview(ref, id, "Superseded by a fresh Cavix review.");
        dismissedReviews.push(id);
      }
      for (const id of state.postedCommentIds) {
        await this.manager.deleteReviewComment(ref, id);
        deletedComments.push(id);
      }
    }
    // Bust the cache: forget prior fingerprints/ids so the fresh review is full.
    this.store.set({ repo: input.repo, pr: input.pr, postedReviewIds: [], postedCommentIds: [], fingerprints: [], paused: state?.paused ?? false });
    return { mode, dismissedReviews, deletedComments };
  }

  /** Incremental: drop findings already posted so we never duplicate a comment. */
  filterNewFindings(repo: string, pr: number, findings: Finding[]): Finding[] {
    const seen = new Set(this.store.get(repo, pr)?.fingerprints ?? []);
    return findings.filter((f) => !seen.has(fingerprint(f)));
  }

  /** Record what was just posted so the next review is incremental/deduped. */
  recordPosted(repo: string, pr: number, headSha: string, postedReviewId: number, commentIds: number[], findings: Finding[]): void {
    const prev = this.store.get(repo, pr);
    this.store.set({
      repo,
      pr,
      lastReviewedSha: headSha,
      postedReviewIds: [...(prev?.postedReviewIds ?? []), postedReviewId],
      postedCommentIds: [...(prev?.postedCommentIds ?? []), ...commentIds],
      fingerprints: [...new Set([...(prev?.fingerprints ?? []), ...findings.map(fingerprint)])],
      paused: prev?.paused ?? false,
    });
  }

  setPaused(repo: string, pr: number, paused: boolean): void {
    const prev = this.store.get(repo, pr);
    this.store.set({ repo, pr, postedReviewIds: prev?.postedReviewIds ?? [], postedCommentIds: prev?.postedCommentIds ?? [], fingerprints: prev?.fingerprints ?? [], lastReviewedSha: prev?.lastReviewedSha, paused });
  }
}
