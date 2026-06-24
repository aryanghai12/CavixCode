// One ReviewPlatform port, many backends. Cavix's review-posting (Stage 11) is
// written against this interface so GitHub / GitLab / Bitbucket (Cloud AND
// Server/Data Center) / Azure DevOps are interchangeable. Each adapter handles
// its own URL shape and BYOK auth; the pipeline never branches on platform.

export interface PullRef {
  /** Project / org / workspace / namespace, per platform. */
  project: string;
  repo: string;
  /** PR / MR id. */
  number: number;
  /** Head commit sha (needed by some inline-comment APIs). */
  commit: string;
  baseCommit?: string;
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

export interface ReviewSubmission {
  summary: string;
  comments: InlineComment[];
  /** Whether to request changes (block) — only used where the org policy gate fired. */
  requestChanges?: boolean;
}

export interface PostedReview {
  id: string;
  url: string;
  /** Number of inline comments the platform accepted. */
  inlinePosted: number;
}

export interface ReviewPlatform {
  readonly name: string;
  fetchDiff(ref: PullRef): Promise<string>;
  postReview(ref: PullRef, review: ReviewSubmission): Promise<PostedReview>;
}

export interface PlatformConfig {
  /** BYOK token / PAT / app password. */
  token: string;
  /** API base URL — set for self-hosted (GitLab CE, Bitbucket DC, Azure DevOps Server). */
  baseUrl?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export async function httpJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  return { status: res.status, body: text ? safeJson(text) : {} };
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
