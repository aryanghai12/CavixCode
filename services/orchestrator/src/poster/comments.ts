import type { InlineComment } from "../github/client.ts";
import { fingerprintFromComment } from "./poster.ts";

// Reconciling THIS review's inline comments against the ones already on the pull
// request.
//
// Without this the ledger can be perfectly correct while the pull request shows
// six copies of the same comment, and the reader believes the page. Across six
// pushes a three-finding pull request accumulated eighteen inline comments, all
// saying the same three things, and the only way to tell which were current was
// to read the timestamps.
//
// The alternative Cavix already had is `clearPrevious`, which deletes every
// inline comment it ever left and posts a fresh set. That works, and it throws
// away every reply anybody wrote underneath them. A comment thread where a
// developer asked "why?" and a colleague answered is worth more than the comment
// that started it, so that path is reserved for an explicit "@cavixcode review
// fresh" and this one is used everywhere else.
//
// Identity comes from the hidden fingerprint the poster stamps into each body.
// A comment with no fingerprint is one Cavix did not write, or wrote before
// fingerprints existed, and is never touched: adopting somebody else's comment
// and then deleting it is the worst thing this module could do.

/** An inline comment already on the pull request. */
export interface ExistingInlineComment {
  id: number;
  body: string;
  path?: string;
  line?: number;
}

export interface ReconcileCommentsInput {
  /** Cavix's own inline comments currently on the pull request. */
  existing: readonly ExistingInlineComment[];
  /** What this review would post if nothing were already there. */
  incoming: readonly InlineComment[];
  /**
   * Fingerprints of findings this review CLEARED.
   *
   * Their comments are removed, because a comment describing a defect that has
   * been fixed is worse than no comment: it is read as an open problem.
   */
  resolved?: readonly string[];
}

export interface ReconcileCommentsResult {
  /** Genuinely new: post these. */
  post: InlineComment[];
  /**
   * Already on the page and still current: leave them exactly as they are.
   *
   * Deliberately not "update in place". A finding that is still open and whose
   * text has not changed does not need to be rewritten, and rewriting it bumps
   * the comment's timestamp, re-notifies everybody subscribed, and moves it in
   * the conversation as though something happened. Nothing happened.
   */
  keep: number[];
  /** Comment ids to delete: their finding is resolved. */
  remove: number[];
  /** Fingerprints seen on the page that this review did not raise again. */
  stale: string[];
}

/**
 * Decide what to post, keep and remove. Pure.
 *
 * The default for anything unrecognised is LEAVE IT ALONE. A comment this cannot
 * identify is not deleted and not counted, which means the worst outcome of a
 * fingerprint that fails to parse is a duplicate comment rather than a deleted
 * conversation.
 */
export function reconcileInlineComments(input: ReconcileCommentsInput): ReconcileCommentsResult {
  const resolved = new Set(input.resolved ?? []);

  // Fingerprint -> the ids carrying it. A list, not a single id: a earlier bug,
  // or two reviews racing, can leave two comments for one finding, and both have
  // to be reachable or the duplicate is immortal.
  const onPage = new Map<string, number[]>();
  for (const c of input.existing) {
    const fp = fingerprintFromComment(c.body);
    if (!fp) continue; // not ours, or older than fingerprints: never touched
    const ids = onPage.get(fp);
    if (ids) ids.push(c.id);
    else onPage.set(fp, [c.id]);
  }

  const post: InlineComment[] = [];
  const keep: number[] = [];
  const remove: number[] = [];
  const raisedNow = new Set<string>();

  for (const comment of input.incoming) {
    const fp = fingerprintFromComment(comment.body);
    if (!fp) {
      // No fingerprint to match on, so it cannot be deduplicated. Post it: a
      // duplicate comment is a far smaller failure than a silently dropped one.
      post.push(comment);
      continue;
    }
    raisedNow.add(fp);
    const ids = onPage.get(fp);
    if (!ids || ids.length === 0) {
      post.push(comment);
      continue;
    }
    // Already there. Keep the first and remove any extras, so a pull request
    // that somehow accumulated two comments for one finding converges on one.
    keep.push(ids[0]);
    remove.push(...ids.slice(1));
  }

  const stale: string[] = [];
  for (const [fp, ids] of onPage) {
    if (raisedNow.has(fp)) continue;
    stale.push(fp);
    // Only a finding the ledger says was RESOLVED has its comment removed.
    //
    // Silence is not resolution, and that rule is the same one the ledger is
    // built on: a reviewer going quiet about a defect in code nobody touched is
    // a statement about the reviewer, not about the code. Deleting the comment
    // on that basis would hide an open finding from the one place a developer
    // actually reads.
    if (resolved.has(fp)) remove.push(...ids);
  }

  return { post, keep, remove, stale };
}
