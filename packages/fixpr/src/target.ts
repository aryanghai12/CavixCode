// Where a fix PR is opened. A platform-agnostic port (GitHub/GitLab/etc. implement
// it). Cavix ALWAYS opens fixes as drafts that require human approval — there is
// deliberately no merge method here.

export interface FixPrRequest {
  repo: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  files: Array<{ path: string; content: string }>;
  /** Always true for Cavix-authored fixes — never auto-merged. */
  draft: boolean;
  labels?: string[];
}

export interface OpenedPr {
  url: string;
  number: number;
  headBranch: string;
  draft: boolean;
}

export interface FixPrTarget {
  readonly name: string;
  createFixPr(req: FixPrRequest): Promise<OpenedPr>;
}

/** In-memory target for tests/demo — records what would be opened. */
export class FakeFixPrTarget implements FixPrTarget {
  readonly name = "fake";
  readonly opened: FixPrRequest[] = [];
  private seq = 0;
  async createFixPr(req: FixPrRequest): Promise<OpenedPr> {
    this.opened.push(req);
    const number = 1000 + ++this.seq;
    return { url: `https://example.test/${req.repo}/pull/${number}`, number, headBranch: req.headBranch, draft: req.draft };
  }
}
