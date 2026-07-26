import type {
  GitHubClient,
  PullRef,
  PostedReview,
  PullMeta,
  ReactionContent,
  ReviewSubmission,
} from "./client.ts";

// FakeGitHubClient serves a canned diff and captures every review submitted to
// it. It is what makes the full posting path runnable and assertable offline:
// the captured submission is the exact payload that RestGitHubClient would send
// to GitHub, so the e2e test and the demo log a real review object.

export interface FakeGitHubOptions {
  /** Diff returned by fetchPullDiff for any ref. */
  diff: string;
  /** Head SHA reported by getPull (what a command job resolves to). */
  headSha?: string;
  /** PR title reported by getPull. */
  title?: string;
}

export class FakeGitHubClient implements GitHubClient {
  private readonly diff: string;
  private readonly headSha: string;
  private readonly title: string;
  readonly submissions: Array<{ ref: PullRef; review: ReviewSubmission }> = [];
  /** Every reaction added, in order — the acknowledgment trail under test. */
  readonly reactions: Array<{ commentId: number; content: ReactionContent }> = [];
  /** Every conversation comment posted (status / error explanations). */
  readonly comments: string[] = [];
  private seq = 0;

  constructor(opts: FakeGitHubOptions) {
    this.diff = opts.diff;
    this.headSha = opts.headSha ?? "resolvedheadsha";
    this.title = opts.title ?? "Fake pull request";
  }

  async fetchPullDiff(_ref: PullRef): Promise<string> {
    return this.diff;
  }

  async getPull(_ref: PullRef): Promise<PullMeta> {
    return { headSha: this.headSha, baseSha: "basesha", title: this.title, draft: false, state: "open" };
  }

  async addReaction(_ref: PullRef, commentId: number, content: ReactionContent): Promise<void> {
    this.reactions.push({ commentId, content });
  }

  async createComment(ref: PullRef, body: string): Promise<{ id: number; htmlUrl: string }> {
    this.comments.push(body);
    const id = 5000 + this.comments.length;
    return { id, htmlUrl: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}#issuecomment-${id}` };
  }

  async postReview(ref: PullRef, review: ReviewSubmission): Promise<PostedReview> {
    this.seq++;
    this.submissions.push({ ref, review });
    return {
      id: 1000 + this.seq,
      htmlUrl: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}#pullrequestreview-${1000 + this.seq}`,
    };
  }

  /** The most recently posted review, for assertions / demo logging. */
  lastReview(): ReviewSubmission | undefined {
    return this.submissions.at(-1)?.review;
  }
}
