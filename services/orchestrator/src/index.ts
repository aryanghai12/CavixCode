// Public surface of the orchestrator package — the ports, implementations, and
// workflow used by the runnable entrypoint, the demo, the eval harness, and tests.
export * from "./github/client.ts";
export { RestGitHubClient, StaticTokenProvider, type TokenProvider } from "./github/rest.ts";
export { FakeGitHubClient } from "./github/fake.ts";

export { Reviewer, type ReviewInput } from "./reviewer/reviewer.ts";
export { parseModelReview, extractJsonObject } from "./reviewer/parse.ts";
export { REVIEW_SYSTEM_PROMPT, buildUserMessage } from "./reviewer/prompt.ts";

export {
  buildReviewSubmission,
  buildPullDescription,
  SUMMARY_START,
  SUMMARY_END,
  type BuiltReview,
  type PosterOptions,
  type ReviewLinkRef,
} from "./poster/poster.ts";

export {
  makeVerifyStep,
  type VerifyStep,
  type VerifyStepOptions,
  type VerifyStepResult,
} from "./verify/verify.ts";

export {
  runPreMergeChecks,
  type CheckStatus,
  type PreMergeCheck,
  type PreMergeResult,
} from "./policy/preMerge.ts";

export {
  makeReviewConfigFetcher,
  DEFAULT_REVIEW_CONFIG,
  ALL_SECTIONS,
  type OrgReviewConfig,
  type ReviewConfigFetcher,
  type ReviewSections,
} from "./byok/reviewConfig.ts";

export { fetchSources, changedPaths, type SourceFile } from "./sources.ts";

export type { WorkflowEngine, ReviewHandler } from "./workflow/engine.ts";
export { InlineEngine } from "./workflow/inline.ts";
export { BullMqEngine } from "./workflow/bullmq.ts";
export {
  runReview,
  makeReviewHandler,
  shouldRequestChanges,
  isPermanentFailure,
  isModelUnavailable,
  isZeroQuota,
  deadModelFrom,
  cleanUp,
  type ReviewOutcome,
  type ReviewWorkflowDeps,
  type GateDecision,
} from "./workflow/reviewWorkflow.ts";

export { FakeStreamSource, type StreamSource, type StreamEntry } from "./bridge/source.ts";
export { RedisStreamSource } from "./bridge/redisSource.ts";
export { pumpOnce, runBridge } from "./bridge/bridge.ts";

export { loadConfig, type OrchestratorConfig } from "./config.ts";
export { makeModelSuggester, makeModelSaver, pickBestModel, rankModels, renderSuggestions, type ModelSuggester } from "./byok/models.ts";
