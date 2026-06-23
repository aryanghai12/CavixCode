// Public surface of the orchestrator package — the ports, implementations, and
// workflow used by the runnable entrypoint, the demo, the eval harness, and tests.
export * from "./github/client.ts";
export { RestGitHubClient, StaticTokenProvider, type TokenProvider } from "./github/rest.ts";
export { FakeGitHubClient } from "./github/fake.ts";

export { Reviewer, type ReviewInput } from "./reviewer/reviewer.ts";
export { parseModelReview, extractJsonObject } from "./reviewer/parse.ts";
export { REVIEW_SYSTEM_PROMPT, buildUserMessage } from "./reviewer/prompt.ts";

export { buildReviewSubmission, type BuiltReview } from "./poster/poster.ts";

export type { WorkflowEngine, ReviewHandler } from "./workflow/engine.ts";
export { InlineEngine } from "./workflow/inline.ts";
export { BullMqEngine } from "./workflow/bullmq.ts";
export { runReview, makeReviewHandler, type ReviewOutcome, type ReviewWorkflowDeps } from "./workflow/reviewWorkflow.ts";

export { FakeStreamSource, type StreamSource, type StreamEntry } from "./bridge/source.ts";
export { RedisStreamSource } from "./bridge/redisSource.ts";
export { pumpOnce, runBridge } from "./bridge/bridge.ts";

export { loadConfig, type OrchestratorConfig } from "./config.ts";
