// Public surface of the orchestrator package — the ports, implementations, and
// workflow used by the runnable entrypoint, the demo, the eval harness, and tests.
export * from "./github/client.ts";
export { RestGitHubClient, StaticTokenProvider, type TokenProvider } from "./github/rest.ts";
export { FakeGitHubClient } from "./github/fake.ts";
export {
  RestGitLabClient,
  StaticGitLabToken,
  GITLAB_CAPABILITIES,
  type GitLabTokenProvider,
  type RestGitLabOptions,
} from "./gitlab/rest.ts";
export { makeControlPlaneTokens, type ControlPlaneTokenOptions, type TokenPlatform } from "./gitlab/tokens.ts";
export { RestBitbucketClient, StaticBitbucketToken, BITBUCKET_CAPABILITIES, type BitbucketTokenProvider, type RestBitbucketOptions } from "./bitbucket/rest.ts";
export {
  RestBitbucketServerClient,
  BITBUCKET_SERVER_CAPABILITIES,
  type RestBitbucketServerOptions,
} from "./bitbucket/server.ts";
export {
  RestAzureClient,
  AZURE_CAPABILITIES,
  type AzureTokenProvider,
  type RestAzureOptions,
} from "./azure/rest.ts";

export { Reviewer, type ReviewInput, type AskInput, type AskResult } from "./reviewer/reviewer.ts";
export { parseModelReview, extractJsonObject } from "./reviewer/parse.ts";
export { REVIEW_SYSTEM_PROMPT, buildUserMessage } from "./reviewer/prompt.ts";

export {
  buildReviewSubmission,
  buildPullDescription,
  buildCheckOutput,
  plain,
  SUMMARY_START,
  SUMMARY_END,
  type BuiltReview,
  type CheckOutput,
  type PosterOptions,
  type ReviewLinkRef,
  type ScopeSignals,
} from "./poster/poster.ts";

export {
  makeReviewRecorder,
  toWireFinding,
  type RecordReviewInput,
  type ReviewRecorder,
  type RecorderOptions,
} from "./report/recorder.ts";

export {
  makeLedgerClient,
  type LedgerClient,
  type LedgerClientOptions,
  type LedgerFetcher,
  type LedgerRef,
  type LedgerSaver,
  type LedgerState,
} from "./report/ledger.ts";

export {
  makeVerifyStep,
  type VerifyStep,
  type VerifyStepOptions,
  type VerifyStepResult,
} from "./verify/verify.ts";

export {
  makeDeepReviewStep,
  type DeepReviewStep,
  type DeepReviewInput,
  type DeepReviewResult,
  type DeepReviewOptions,
} from "./pipeline/deepReview.ts";

export {
  makeGraphIndexer,
  selectFiles,
  DEFAULT_STALE_MS,
  type GraphIndexer,
  type GraphStore,
  type IndexResult,
} from "./orggraph/indexer.ts";
export { makeBlastRadiusStep, type BlastRadiusStep, type BlastRadiusResult } from "./orggraph/blastRadius.ts";
export { makeGraphStore, type GraphStoreOptions } from "./orggraph/store.ts";

export {
  makeCiIngestStep,
  DEFAULT_CI_STALE_MS,
  type CiIngestStep,
  type CiIngestResult,
  type CiStore,
} from "./telemetry/ingest.ts";
export { makeRegressionStep, type RegressionStep, type RegressionResult } from "./telemetry/regression.ts";
export { makeCiStore, type CiStoreOptions } from "./telemetry/store.ts";

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

export {
  dispatchCommand,
  commandOf,
  isAutomatic,
  isPaused,
  PAUSED_MARKER,
  STATUS_MARKER,
  type CommandName,
  type Dispatch,
  type ReviewMode,
} from "./workflow/commands.ts";
export { filterDiff, allowsPath, NO_FILTERS, type PathFilters } from "./workflow/pathFilter.ts";

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
  ReviewCheck,
  type ReviewOutcome,
  type ReviewWorkflowDeps,
  type GateDecision,
} from "./workflow/reviewWorkflow.ts";

export { FakeStreamSource, type StreamSource, type StreamEntry } from "./bridge/source.ts";
export { RedisStreamSource } from "./bridge/redisSource.ts";
export { pumpOnce, runBridge } from "./bridge/bridge.ts";

export { loadConfig, type OrchestratorConfig } from "./config.ts";
export { makeModelSuggester, makeModelSaver, pickBestModel, rankModels, renderSuggestions, type ModelSuggester } from "./byok/models.ts";
