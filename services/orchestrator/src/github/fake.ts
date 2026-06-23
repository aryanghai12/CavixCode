import type {
  GitHubClient,
  PullRef,
  PostedReview,
  ReviewSubmission,
} from "./client.ts";

// FakeGitHubClient serves a canned diff and captures every review submitted to
// it. It is what makes the full posting path runnable and assertable offline:
// the captured submission is the exact payload that RestGitHubClient would send
// to GitHub, so the e2e test and the demo log a real review object.

export interface FakeGitHubOptions {
  /** Diff returned by fetchPullDiff for any ref. */
  diff: string;
}

export class FakeGitHubClient implements GitHubClient {
  private readonly diff: string;
  readonly submissions: Array<{ ref: PullRef; review: ReviewSubmission }> = [];
  private seq = 0;

  constructor(opts: FakeGitHubOptions) {
    this.diff = opts.diff;
  }

  async fetchPullDiff(_ref: PullRef): Promise<string> {
    return this.diff;
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
