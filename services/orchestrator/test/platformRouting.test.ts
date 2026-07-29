import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewJob } from "@cavix/core";
import { Gateway, FakeProvider, type GatewayConfigData } from "@cavix/gateway";
import { FakeGitHubClient, Reviewer, makeReviewHandler, refFromJob, runReview } from "@cavix/orchestrator";
import { GITLAB_CAPABILITIES } from "../src/gitlab/rest.ts";
import { ALL_SECTIONS, DEFAULT_REVIEW_CONFIG } from "../src/byok/reviewConfig.ts";

// The seam. A job names its platform, the handler picks the client, and the
// workflow does not branch on platform anywhere else. What these tests are
// really guarding is the thing that would be hardest to notice: a GitLab job
// reviewed through the GitHub client would call the right-looking API against
// the wrong repository and post a review nobody asked for.

const DIFF = `diff --git a/src/auth.js b/src/auth.js
--- a/src/auth.js
+++ b/src/auth.js
@@ -10,3 +10,4 @@ function login(user) {
   const token = sign(user);
+  db.query("SELECT * FROM u WHERE id = " + user.id);
 }
`;

function job(over: Partial<ReviewJob> = {}): ReviewJob {
  return {
    schema_version: "1",
    idempotency_key: "idem-1",
    delivery_id: "d-1",
    org: "acme",
    repo: "acme/widget",
    repo_id: 1,
    pr_number: 42,
    action: "opened",
    head_sha: "headsha",
    base_sha: "basesha",
    installation_id: 9,
    priority: 100,
    title: "Add DB lookup on login",
    author: "octocat",
    enqueued_at: "2026-07-01T00:00:00Z",
    ...over,
  };
}

function wire(
  opts: {
    platform?: "github" | "gitlab" | "bitbucket" | "bitbucket-server" | "azure-devops";
    capabilities?: typeof GITLAB_CAPABILITIES;
    webUrl?: string;
  } = {},
) {
  const provider = new FakeProvider(() =>
    JSON.stringify({
      summary: "Adds a DB lookup.",
      effort: 2,
      findings: [
        {
          path: "src/auth.js",
          line: 11,
          severity: "critical",
          category: "security",
          title: "SQL injection",
          body: "concatenated",
          confidence: 0.95,
        },
      ],
    }),
  );
  const config: GatewayConfigData = {
    orgs: { acme: { provider: "fake", apiKey: "k", model: "m" } },
  };
  const gateway = new Gateway({ providers: new Map([["fake", provider]]), config });
  const github = new FakeGitHubClient({
    diff: DIFF,
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    ...(opts.webUrl ? { webUrl: opts.webUrl } : {}),
  });
  return { github, reviewer: new Reviewer({ gateway }) };
}

const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => logs.push({ msg, meta }),
  error: (msg: string, meta?: Record<string, unknown>) => logs.push({ msg, meta }),
};

// ── refFromJob ──────────────────────────────────────────────────────────────

test("a nested GitLab namespace survives refFromJob intact", () => {
  // Splitting at the FIRST slash gave owner "acme" and repo "platform", silently
  // dropping the project: every API call would then name a repository that is
  // not the one under review.
  const ref = refFromJob(job({ repo: "acme/platform/billing" }));
  assert.equal(ref.owner, "acme/platform");
  assert.equal(ref.repo, "billing");
});

test("a GitHub full name is unchanged by that", () => {
  const ref = refFromJob(job({ repo: "acme/widget" }));
  assert.equal(ref.owner, "acme");
  assert.equal(ref.repo, "widget");
});

// ── routing ─────────────────────────────────────────────────────────────────

test("a job with no platform is GitHub, so queued jobs from an older deploy still run", async () => {
  const { github, reviewer } = wire();
  const handler = makeReviewHandler({ github, reviewer, logger });
  await handler(job());
  assert.equal(github.submissions.length, 1);
});

test("a GitLab job is reviewed through the GitLab client, not the GitHub one", async () => {
  const gh = wire();
  const gl = wire({ platform: "gitlab", capabilities: GITLAB_CAPABILITIES });
  const handler = makeReviewHandler({
    github: gh.github,
    platforms: { gitlab: gl.github },
    reviewer: gh.reviewer,
    logger,
  });

  await handler(job({ platform: "gitlab", repo: "acme/platform/billing" }));

  assert.equal(gl.github.submissions.length, 1, "the GitLab client posted it");
  assert.equal(gh.github.submissions.length, 0, "and the GitHub client was never touched");
  const ref = gl.github.submissions[0].ref;
  assert.equal(ref.owner, "acme/platform");
  assert.equal(ref.repo, "billing");
});

test("a job for a platform with no client is dropped, never reviewed with the default", async () => {
  // The dangerous alternative is falling back: a GitHub client pointed at a
  // GitLab path would either 404 or, worse, find a same-named GitHub repo and
  // post a review on a stranger's pull request.
  logs.length = 0;
  const { github, reviewer } = wire();
  const handler = makeReviewHandler({ github, reviewer, logger });
  await handler(job({ platform: "gitlab" }));

  assert.equal(github.submissions.length, 0);
  assert.ok(
    logs.some((l) => l.msg.includes("no client for this platform")),
    "and it says so, because there is nowhere else to say it",
  );
});

test("all four platforms route to their own client, and none to anybody else's", async () => {
  // The seam, proven at the width it now has. A job reviewed through the wrong
  // client would call the right-looking API against the wrong repository.
  const gh = wire();
  const gl = wire({ platform: "gitlab", capabilities: GITLAB_CAPABILITIES });
  const bb = wire({ platform: "bitbucket" });
  const bs = wire({ platform: "bitbucket-server" });
  const az = wire({ platform: "azure-devops" });
  const handler = makeReviewHandler({
    github: gh.github,
    platforms: {
      gitlab: gl.github,
      bitbucket: bb.github,
      "bitbucket-server": bs.github,
      "azure-devops": az.github,
    },
    reviewer: gh.reviewer,
    logger,
  });

  await handler(job());
  await handler(job({ platform: "gitlab", repo: "acme/platform/billing" }));
  await handler(job({ platform: "bitbucket" }));
  await handler(job({ platform: "bitbucket-server", repo: "PAY/billing" }));
  await handler(job({ platform: "azure-devops", repo: "acme/payments/billing-api" }));

  for (const [name, c] of [
    ["github", gh],
    ["gitlab", gl],
    ["bitbucket", bb],
    ["bitbucket-server", bs],
    ["azure-devops", az],
  ] as const) {
    assert.equal(c.github.submissions.length, 1, `${name} posted exactly its own review`);
  }
  // Azure's "organization/project" namespace survives refFromJob the same way a
  // nested GitLab group does.
  assert.equal(az.github.submissions[0].ref.owner, "acme/payments");
  assert.equal(az.github.submissions[0].ref.repo, "billing-api");
});

// ── the review names the host it is going to ────────────────────────────────

test("permalinks are built for the host the review is going to, on every platform", async () => {
  // Every permalink used to be built against a hardcoded github.com, so a reader
  // on any other host clicked a finding's line number and left for a repository
  // that does not exist.
  const cases = [
    { platform: "gitlab" as const, webUrl: "https://gitlab.acme.com", expect: /gitlab\.acme\.com\/acme\/widget\/-\/blob\// },
    { platform: "bitbucket" as const, webUrl: "https://bitbucket.org", expect: /bitbucket\.org\/acme\/widget\/src\// },
    {
      platform: "azure-devops" as const,
      webUrl: "https://dev.azure.com",
      expect: /dev\.azure\.com\/acme\/_git\/widget\?path=/,
    },
  ];
  for (const c of cases) {
    const { github, reviewer } = wire({ platform: c.platform, webUrl: c.webUrl });
    await runReview(job({ platform: c.platform }), {
      github,
      platforms: { [c.platform]: github },
      reviewer,
      logger,
      reviewConfig: async () => ({ ...DEFAULT_REVIEW_CONFIG, verifyFindings: false, sections: ALL_SECTIONS }),
    });
    const body = github.lastReview()!.body;
    assert.match(body, c.expect, `${c.platform} links at its own host`);
    assert.doesNotMatch(body, /github\.com\/acme\/widget/, `${c.platform} never links at github.com`);
  }
});

test("files the host could not diff are NAMED on the review, never dropped quietly", async () => {
  // Azure returns changed PATHS and no content, so Cavix builds the diff itself
  // and a file can be too large, too rewritten or binary. A review that skipped
  // two files without saying so claims coverage it does not have.
  const { github, reviewer } = wire({ platform: "azure-devops" });
  github.limitations = [
    { path: "vendor/bundle.min.js", reason: "40200 lines, over the 20000 Cavix diffs in one file" },
    { path: "assets/logo.png", reason: "binary file, not reviewable line by line" },
  ];
  await runReview(job({ platform: "azure-devops" }), {
    github,
    platforms: { "azure-devops": github },
    reviewer,
    logger,
    reviewConfig: async () => ({ ...DEFAULT_REVIEW_CONFIG, verifyFindings: false, sections: ALL_SECTIONS }),
  });

  const body = github.lastReview()!.body;
  assert.match(body, /### Not Reviewed/);
  assert.match(body, /vendor\/bundle\.min\.js/);
  assert.match(body, /assets\/logo\.png/);
  assert.match(body, /binary file, not reviewable line by line/);
  // ...and the Scope module qualifies everything under it, rather than letting a
  // clean security row read as a clean read of the whole change.
  assert.match(body, /Diff Coverage.*2 files could not be diffed exactly/);
});

test("a host that hands over the whole diff says nothing about coverage", async () => {
  const { github, reviewer } = wire();
  await runReview(job(), {
    github,
    reviewer,
    logger,
    reviewConfig: async () => ({ ...DEFAULT_REVIEW_CONFIG, verifyFindings: false, sections: ALL_SECTIONS }),
  });
  const body = github.lastReview()!.body;
  assert.doesNotMatch(body, /Not Reviewed/);
  assert.doesNotMatch(body, /Diff Coverage/);
});

// ── capabilities ────────────────────────────────────────────────────────────

test("no reactions on a platform without them, and no wasted request either", async () => {
  const { github, reviewer } = wire({
    platform: "gitlab",
    capabilities: { ...GITLAB_CAPABILITIES, reactions: false },
  });
  const handler = makeReviewHandler({
    github,
    platforms: { gitlab: github },
    reviewer,
    logger,
  });
  await handler(job({ platform: "gitlab", trigger: "command", command: "review", comment_id: 5 }));
  assert.equal(github.reactions.length, 0);
  assert.equal(github.submissions.length, 1, "the review still happens");
});

test("blocking asked for on a platform that cannot block posts a comment AND says so", async () => {
  // The failure this prevents: an owner turns blocking on, sees no error, and
  // believes there is a gate in front of their default branch that is not there.
  const { github, reviewer } = wire({ platform: "gitlab", capabilities: GITLAB_CAPABILITIES });
  const outcome = await runReview(job({ platform: "gitlab" }), {
    github,
    reviewer,
    logger,
    reviewConfig: async () => ({
      ...DEFAULT_REVIEW_CONFIG,
      verifyFindings: false,
      requestChangesOnFail: true,
      failOn: ["critical"],
      sections: ALL_SECTIONS,
    }),
  });

  assert.equal(outcome.blocked, false, "nothing is gated, so nothing claims to be");
  const body = github.lastReview()!.body;
  assert.match(body, /GitLab has no review a bot can hold a merge with/);
  assert.match(body, /nothing is gated/);
  assert.match(body, /Cavix Review` status on the commit/, "and it names what CAN gate a merge here");
  assert.equal(github.submissions[0].review.event, "COMMENT");
});

test("the same settings on GitHub still block, exactly as before", async () => {
  const { github, reviewer } = wire();
  const outcome = await runReview(job(), {
    github,
    reviewer,
    logger,
    reviewConfig: async () => ({
      ...DEFAULT_REVIEW_CONFIG,
      verifyFindings: false,
      requestChangesOnFail: true,
      failOn: ["critical"],
      sections: ALL_SECTIONS,
    }),
  });

  assert.equal(outcome.blocked, true);
  assert.equal(github.submissions[0].review.event, "REQUEST_CHANGES");
  assert.doesNotMatch(github.lastReview()!.body, /no review a bot can hold/);
});

test("a platform that cannot block, on a workspace that did not ask to, says nothing about it", async () => {
  // The note only appears where it is relevant. A team that never turned
  // blocking on does not need a paragraph about a feature they did not want.
  const { github, reviewer } = wire({ platform: "gitlab", capabilities: GITLAB_CAPABILITIES });
  await runReview(job({ platform: "gitlab" }), {
    github,
    reviewer,
    logger,
    reviewConfig: async () => ({ ...DEFAULT_REVIEW_CONFIG, verifyFindings: false, sections: ALL_SECTIONS }),
  });
  assert.doesNotMatch(github.lastReview()!.body, /no review a bot can hold/);
});

// ── who may tell Cavix what to do ───────────────────────────────────────────

function commandJob(over: Partial<ReviewJob> = {}): ReviewJob {
  return job({
    trigger: "command",
    command: "review",
    comment_id: 5,
    author: "passerby",
    author_association: "GITLAB_UNVERIFIED",
    ...over,
  });
}

test("a GitLab command from someone who cannot push is refused before any model call", async () => {
  // The hole this closes: GitLab's note webhook says WHO commented and nothing
  // about what they may do, so the edge cannot refuse a passer-by the way it can
  // on GitHub. Without this check anyone who can see a merge request could spend
  // a customer's model budget by typing "@cavixcode review" in a loop.
  const { github, reviewer } = wire({ platform: "gitlab", capabilities: GITLAB_CAPABILITIES });
  github.commandAuthors = (u) => u === "maintainer";

  const handler = makeReviewHandler({ github, platforms: { gitlab: github }, reviewer, logger });
  await handler(commandJob({ platform: "gitlab" }));

  assert.equal(github.submissions.length, 0, "no review, so no tokens spent");
  assert.match(github.comments.join("\n"), /only takes commands from people who can push/);
});

test("...and honoured from someone who can", async () => {
  const { github, reviewer } = wire({ platform: "gitlab", capabilities: GITLAB_CAPABILITIES });
  github.commandAuthors = (u) => u === "maintainer";

  const handler = makeReviewHandler({ github, platforms: { gitlab: github }, reviewer, logger });
  await handler(commandJob({ platform: "gitlab", author: "maintainer" }));

  assert.equal(github.submissions.length, 1);
});

test("even a free command is refused, not just the billable one", async () => {
  // "help" and "pause" cost nothing to run and are still repository operations.
  // A passer-by who can pause Cavix on a merge request has turned the reviewer
  // off for the people who do have access.
  const { github, reviewer } = wire({ platform: "gitlab", capabilities: GITLAB_CAPABILITIES });
  github.commandAuthors = () => false;

  const handler = makeReviewHandler({ github, platforms: { gitlab: github }, reviewer, logger });
  await handler(commandJob({ platform: "gitlab", command: "pause" }));

  assert.match(github.comments.join("\n"), /only takes commands from people who can push/);
});

test("GitHub commands are unaffected: the edge already decided", async () => {
  // Asking the API again would be a second request per command to re-derive an
  // answer GitHub handed the edge for free in `author_association`.
  const { github, reviewer } = wire();
  const handler = makeReviewHandler({ github, reviewer, logger });
  await handler(job({ trigger: "command", command: "review", comment_id: 5, author: "anyone" }));
  assert.equal(github.submissions.length, 1);
});

test("an automatic review is not a command, and is never gated by this", async () => {
  const { github, reviewer } = wire({ platform: "gitlab", capabilities: GITLAB_CAPABILITIES });
  github.commandAuthors = () => false;
  const handler = makeReviewHandler({ github, platforms: { gitlab: github }, reviewer, logger });
  await handler(job({ platform: "gitlab" }));
  assert.equal(github.submissions.length, 1, "a push is authorized by having been pushed");
});
