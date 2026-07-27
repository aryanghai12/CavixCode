import { test } from "node:test";
import assert from "node:assert/strict";
import { Gateway, GoogleProvider, type GatewayConfigData } from "@cavix/gateway";
import { Reviewer, FakeGitHubClient, makeReviewHandler } from "@cavix/orchestrator";
import type { ReviewJob } from "@cavix/core";

// Regression for a live failure: a workspace that picked Google in the dashboard
// got "unknown provider \"google\"" on every review, because the AI & BYOK
// dropdown offered four providers while the orchestrator registered only
// Anthropic. This walks the whole command path on a Google workspace.

const DIFF = `diff --git a/src/A.java b/src/A.java
--- a/src/A.java
+++ b/src/A.java
@@ -1,2 +1,3 @@
 class A {
+  String q = "SELECT * FROM u WHERE id=" + id;
 }
`;

test("END TO END: '@cavixcode review' on a Google/Gemini workspace posts a review", async () => {
  // Stub Gemini, shaped exactly like the real generateContent response.
  const fetchImpl = (async (url: string) => {
    assert.match(String(url), /generativelanguage\.googleapis\.com.*gemini-2\.5-pro:generateContent/);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        summary: "Adds a concatenated SQL string.",
        findings: [{ path: "src/A.java", line: 2, severity: "high", category: "security",
                     title: "SQL injection", body: "Concatenated query.", confidence: 0.9 }],
      }) }] } }],
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 60 },
      modelVersion: "gemini-2.5-pro",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const config: GatewayConfigData = {
    orgs: { "aryanghai12": { provider: "google", apiKey: "AIza-test", model: "gemini-2.5-pro" } },
  };
  const gateway = new Gateway({ providers: new Map([["google", new GoogleProvider({ fetchImpl })]]), config });
  const github = new FakeGitHubClient({ diff: DIFF, headSha: "b344358" });

  const job: ReviewJob = {
    schema_version: "1", idempotency_key: "k", delivery_id: "d",
    org: "aryanghai12", repo: "aryanghai12/Java-Workshop-Notes", repo_id: 1, pr_number: 2,
    action: "command", head_sha: "", base_sha: "", installation_id: 9, priority: 90,
    title: "notes", author: "aryanghai12", enqueued_at: "2026-07-27T00:00:00Z",
    trigger: "command", command: "review", comment_id: 4242, author_association: "OWNER", force_fresh: true,
  };

  const handler = makeReviewHandler({
    github, reviewer: new Reviewer({ gateway }),
    gate: async () => ({ enabled: true, org: "aryanghai12" }),
  });
  await handler(job);

  assert.deepEqual(github.reactions.map(r => r.content), ["eyes", "rocket"], "acknowledged then completed");
  assert.equal(github.comments.length, 0, "no failure comment");
  assert.equal(github.submissions.length, 1, "a review was posted");
  const review = github.lastReview()!;
  assert.match(review.body, /SQL injection|1 finding/);
  assert.equal(review.comments[0].path, "src/A.java");
  assert.equal(gateway.costLog()[0].provider, "google");
});
