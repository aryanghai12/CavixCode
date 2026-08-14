import {
  commentableLines,
  isCommandJob,
  parseUnifiedDiff,
  platformOf,
  SEVERITY_RANK,
  type ReviewJob,
  type Severity,
} from "@cavix/core";
import type { ReviewPlatform, PostedReview, PullRef } from "../github/client.ts";
import { CHECK_NAME, refFromJob } from "../github/client.ts";
import type { Reviewer } from "../reviewer/reviewer.ts";
import {
  buildCheckOutput,
  buildPullDescription,
  buildReviewSubmission,
  type ReviewDelta,
} from "../poster/poster.ts";
import { reconcileInlineComments } from "../poster/comments.ts";
import type { VerifyStep } from "../verify/verify.ts";
import { preMergeUnavailable, runPreMergeChecks, type PreMergeResult } from "../policy/preMerge.ts";
import { changedPaths, fetchSources, MAX_SOURCE_FILES } from "../sources.ts";
import {
  DEFAULT_REVIEW_CONFIG,
  type OrgReviewConfig,
  type ReviewConfigFetcher,
} from "../byok/reviewConfig.ts";
import type { ReviewHandler } from "./engine.ts";
import { rankModels, renderSuggestions } from "../byok/models.ts";
import type { ReviewRecorder } from "../report/recorder.ts";
import {
  dispatchCommand,
  isAutomatic,
  isPaused,
  STATUS_MARKER,
  type Dispatch,
  type ReviewMode,
} from "./commands.ts";
import { filterDiff } from "./pathFilter.ts";
import { NOOP_RECORDER, type Recorder } from "@cavix/metrics";
import {
  reconcile,
  openEntries,
  dismissAll,
  scopeFor,
  openInSkippedFiles,
  type ReviewScope,
  HEARTBEAT_EVERY_MS,
  type LedgerEntry,
} from "@cavix/review-session";
import type { LedgerClient } from "../report/ledger.ts";
import type { RunClient } from "../report/runs.ts";
import { makeRetentionCollector } from "../verify/retention.ts";
import type { DeepReviewResult, DeepReviewStep } from "../pipeline/deepReview.ts";
import type { BlastRadiusStep } from "../orggraph/blastRadius.ts";
import type { GraphIndexer } from "../orggraph/indexer.ts";
import type { RegressionStep } from "../telemetry/regression.ts";
import type { CiIngestStep } from "../telemetry/ingest.ts";

/** How many alternative models to try before giving up. Each try is a real call. */
const MAX_HEAL_ATTEMPTS = 5;

// The review workflow body: the durable steps that turn a ReviewJob into a posted
// PR review. Each step is a clean await so a future Temporal port can wrap them as
// activities with their own retries and visibility.
//
// Acknowledgment contract (what a human sees after typing "@cavixcode review"):
//   👀 eyes      the moment Cavix picks the command up
//   🚀 rocket    the review has been posted
//   👍 +1        understood, but there was nothing to do (repo not enabled, etc.)
//   😕 confused  it failed — a reply comment says why
// The reaction lands before any slow work, so silence always means "the webhook
// never arrived", never "it's thinking". That distinction is the whole point.

export interface WorkflowLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** What the repo gate returns: whether to review, and which Cavix org owns the repo. */
export interface GateDecision {
  enabled: boolean;
  /** Dashboard org that enabled the repo — the BYOK key lives under this id. */
  org?: string;
  /**
   * Why not, when the repo IS connected but this review may not run: the
   * workspace is suspended, or it has spent its daily allowance. Absent means
   * the repo was simply never turned on, which is a different message.
   */
  reason?: string;
  /**
   * This pull request specifically has spent its review allowance.
   *
   * Flagged separately from `reason` because it is the one refusal with a rule
   * attached: the Cavix check must be left EXACTLY as the last review set it.
   * Running out of reviews is not a reason to turn a red check green, or a red
   * one greener. If it were, exhausting the quota would be a way to merge past
   * an open finding, and the limit would be a bypass rather than a limit.
   */
  capReached?: boolean;
}

export interface ReviewWorkflowDeps {
  /**
   * The default platform client, and the one every job uses unless `platforms`
   * names another for it.
   *
   * The property is still called `github` because that is what it is on every
   * deployment that has not configured a second host, and renaming it would
   * touch every construction site in the service for no behavioural gain. The
   * TYPE is `ReviewPlatform`, which is the part that has to be right.
   */
  github: ReviewPlatform;
  /**
   * Additional clients by platform name, e.g. `{ gitlab: new RestGitLabClient(...) }`.
   *
   * A job whose platform has no client here is NOT reviewed with the default
   * one. Posting a GitHub-shaped review at a GitLab merge request is worse than
   * not reviewing it, and quietly reviewing the wrong repository is worse still.
   */
  platforms?: Record<string, ReviewPlatform>;
  reviewer: Reviewer;
  logger?: WorkflowLogger;
  /** Execution gatekeeper: return enabled=false to skip (repo not toggled on). */
  gate?: (fullName: string, pr?: number) => Promise<GateDecision>;
  /**
   * The per-pull-request finding ledger: what has been raised on this pull
   * request across every review it has had, and what is still open.
   *
   * This is what makes a re-review a continuation rather than a fresh opinion.
   * Without it the merge verdict is computed from one review's findings alone,
   * so a pull request with three open findings, one fixed and pushed, went green
   * the moment the next pass did not happen to re-report the other two. A model
   * is not a function; the same diff reviewed twice does not reliably produce
   * the same findings, and a verdict built on that is a coin toss.
   *
   * Absent, or failing, degrades to exactly the old behaviour: this review's
   * findings decide this review's verdict. Like every other stage here it must
   * never cost a customer their review.
   */
  ledger?: LedgerClient;
  /**
   * The single in-flight review slot for a pull request.
   *
   * Absent degrades to exactly the old behaviour: every job runs, and a push
   * during a review produces two reviews. Present, it stops the older one before
   * it posts a verdict computed against a commit that no longer exists.
   */
  runs?: RunClient;
  /**
   * Let a re-review read only what the push changed.
   *
   * OFF by default, and the default is the honest one. Narrowing is sound for
   * findings already on the record, because the ledger carries them whether or
   * not their file was re-read. What it gives up is the re-roll: a model asked a
   * second time about untouched code might find something it missed the first
   * time. That is a real trade between cost and recall, so it belongs to the
   * workspace rather than to whoever deployed the service.
   */
  narrowRereviews?: boolean;
  /**
   * Given an org, list the model ids its key can call. Used to enrich the failure
   * comment, and to self-heal when the saved model has been retired.
   */
  suggestModels?: (org: string) => Promise<string[]>;
  /** Persist an auto-selected model so the next review and the dashboard agree. */
  saveModel?: (org: string, model: string) => Promise<boolean>;
  /**
   * Stage 10. Reproduces findings in a sandbox before they are posted, and
   * suppresses the ones it disproves. Absent = post the model's findings as-is
   * (what Phase 0 did), so verification can be rolled out without a code change.
   */
  verify?: VerifyStep;
  /**
   * Stages 3, 4, 7, 8 and 9: deterministic scanners, the call graph, context
   * assembly, the seven-agent ensemble and adjudication.
   *
   * Absent, or failing, falls back to the single-model pass. That fallback is
   * the point: the deep path reads files through the API and fans out to seven
   * models, and neither of those is allowed to cost somebody their review.
   */
  deepReview?: DeepReviewStep;
  /**
   * Stage 5. Traces a changed public interface to its consumers in OTHER
   * repositories. Absent, or failing, means the review simply has no cross-repo
   * section, which is also what happens before anything has been indexed.
   */
  blastRadius?: BlastRadiusStep;
  /**
   * Stage 5's indexer. Runs AFTER the review is posted and only when this
   * repository's slice of the graph has gone stale, so a tree listing and a
   * dozen file reads never sit in front of somebody waiting for a review.
   */
  indexGraph?: GraphIndexer;
  /**
   * Stage 6. Warns before merge that the pipeline this change is joining has
   * been getting slower, or failing too often to be a signal. Absent, or
   * failing, means the review has no telemetry section.
   */
  regression?: RegressionStep;
  /**
   * Stage 6's ingestion. Pulls completed GitHub Actions runs AFTER the review is
   * posted, on the same staleness gate as the contract indexer.
   */
  ingestCi?: CiIngestStep;
  /**
   * Write the summary + walkthrough into the PR description. On by default: the
   * description is where a reviewer looks first, and it does not scroll away
   * under later comments. Set false to keep everything in the review comment.
   *
   * This is the DEPLOYMENT-level switch. The repo owner's dashboard choice is
   * fetched per review and can only narrow it, never widen it.
   */
  summaryInDescription?: boolean;
  /**
   * Render the coloured badge strip at the top of the review.
   *
   * On by default. Turn it off (CAVIX_REVIEW_BADGES=off) for a GitHub Enterprise
   * install behind an air gap: GitHub's image proxy cannot reach shields.io from
   * there, so the badges would render as broken images. The same facts stay in
   * the Review Scope table either way.
   */
  badges?: boolean;
  /**
   * The org's own settings, as chosen on the dashboard: verification on/off,
   * where the summary goes, the pre-merge gate and its rules, and whether Cavix
   * may block a merge. Absent = the safe defaults in DEFAULT_REVIEW_CONFIG.
   */
  reviewConfig?: ReviewConfigFetcher;
  /**
   * Report the finished review to the control-plane so it shows on the
   * dashboard. Best-effort and always last: the review is already on the pull
   * request by then, so nothing here may fail (or retry) the job.
   */
  recordReview?: ReviewRecorder;
  /**
   * Stage 13's observability half. Records stage timings and, above all, the
   * SOFT failures below: every stage here degrades rather than failing, so a
   * stage that has been broken for a week still posts reviews and this is the
   * only place that shows. Absent means nothing is recorded, which is what a
   * deployment with metrics switched off wants.
   */
  metrics?: Recorder;
  /**
   * Answer a free-text question someone asked on the pull request. Absent means
   * "@cavixcode <question>" replies that questions are not enabled here, rather
   * than falling back to a full review, which is what it used to do.
   */
  answer?: (job: ReviewJob, ref: PullRef, org: string, question: string) => Promise<string>;
}

export interface ReviewOutcome {
  posted: PostedReview;
  summary: string;
  findingCount: number;
  inlineCount: number;
  offDiffCount: number;
  /** Findings Cavix reproduced in a sandbox before posting them. */
  verifiedCount: number;
  /** Findings the sandbox disproved. They were never posted. */
  suppressedCount: number;
  /** Did the summary make it into the PR description? */
  descriptionUpdated: boolean;
  /** Pre-merge gate results, when the org enabled it. */
  preMerge?: PreMergeResult;
  /** Was the review posted as REQUEST_CHANGES (the owner's blocking setting)? */
  blocked: boolean;
  /**
   * Findings still open from EARLIER reviews that this one did not re-report.
   *
   * They counted towards the verdict above. Reported here so the handler's log
   * line, and anything reading it, can tell a genuinely clean review apart from
   * one that found nothing new on a pull request that still has open findings.
   */
  carriedCount: number;
  /** Findings from earlier reviews this one cleared: the code moved. */
  resolvedCount: number;
  /** Did this review make it onto the dashboard? False when nothing recorded it. */
  recorded: boolean;
  /**
   * Why no review ran, when none did.
   *
   * Absent on a real review. Present, it is the difference between "Cavix looked
   * and found nothing" and "Cavix never looked", and logging both as `job
   * complete` with zero findings is how a wedged pull request went unnoticed:
   * every line said the review had finished successfully.
   */
  skipped?: string;
  /**
   * The Cavix check run this review completed, or 0 when the deployment could
   * not create one (a PAT, or an App install without `checks: write`).
   */
  checkRunId: number;
  costUsd: number;
  model: string;
}

const noopLogger: WorkflowLogger = { info() {}, error() {} };

/**
 * The Cavix row in the pull request's Checks box, from "reviewing" to a tick or
 * a cross.
 *
 * It exists so a reviewer can see Cavix working before there is anything to
 * read. GitHub shows it next to CI, it turns into a spinner the moment the job
 * is picked up, and it settles into a conclusion when the review is posted.
 *
 * Everything here is best-effort and swallows its own failures. A check run is
 * a GitHub App feature that needs `checks: write`, so plenty of working
 * deployments cannot create one at all, and none of them should lose a review
 * over a missing status row.
 *
 * It is a small object rather than two loose calls because a self-heal retries
 * the whole review against a different model, and a fresh check run per attempt
 * would leave three rows on the PR, two of them spinning forever.
 */
export class ReviewCheck {
  private readonly github: ReviewPlatform;
  private readonly log: WorkflowLogger;
  private id = 0;
  private open = false;

  constructor(github: ReviewPlatform, log: WorkflowLogger = noopLogger) {
    this.github = github;
    this.log = log;
  }

  /** Open the row, or do nothing if it is already open (a heal retry). */
  async begin(ref: PullRef, title = "Reviewing this pull request"): Promise<void> {
    if (this.open) return;
    this.open = true;
    try {
      this.id = await this.github.createCheckRun(ref, {
        status: "in_progress",
        title,
        summary:
          "Cavix is reading the changed lines, and reproducing anything it suspects in a sealed sandbox before it says a word.",
      });
      if (this.id === 0) {
        this.log.info("no check run for this install (needs a GitHub App with checks: write)", {
          repo: `${ref.owner}/${ref.repo}`,
          pr: ref.number,
        });
      }
    } catch (err) {
      this.log.info("could not open the check run (continuing)", { err: (err as Error).message });
    }
  }

  /** Close the row. `conclusion` is what a required check would gate on. */
  async finish(
    ref: PullRef,
    conclusion: "success" | "failure" | "neutral",
    title: string,
    summary: string,
    detailsUrl?: string,
  ): Promise<void> {
    if (this.id === 0) return;
    try {
      await this.github.updateCheckRun(ref, this.id, {
        status: "completed",
        conclusion,
        title,
        summary,
        ...(detailsUrl ? { detailsUrl } : {}),
      });
    } catch (err) {
      this.log.error("could not close the check run", {
        repo: `${ref.owner}/${ref.repo}`,
        pr: ref.number,
        check: CHECK_NAME,
        err: (err as Error).message,
      });
    }
  }

  /** The check run id, or 0 when this deployment could not create one. */
  get runId(): number {
    return this.id;
  }
}

/**
 * React to the comment that triggered this job. Best-effort by design: a failed
 * reaction must never fail the review, and reactions only exist for command jobs.
 */
async function react(
  deps: ReviewWorkflowDeps,
  job: ReviewJob,
  ref: PullRef,
  content: Parameters<ReviewPlatform["addReaction"]>[2],
): Promise<void> {
  // Not attempted where the host has no such concept. Calling and swallowing
  // would work, but it spends a request per acknowledgment on every review to
  // learn something the client already knows.
  if (!deps.github.capabilities.reactions) return;
  if (!isCommandJob(job) || !job.comment_id) return;
  try {
    await deps.github.addReaction(ref, job.comment_id, content);
  } catch (err) {
    deps.logger?.info("could not add reaction (continuing)", {
      repo: job.repo,
      pr: job.pr_number,
      comment_id: job.comment_id,
      reaction: content,
      err: (err as Error).message,
    });
  }
}

/**
 * Post Cavix's status comment, or EDIT the existing one.
 *
 * The queue retries a failed job three times. Creating a comment each attempt
 * produced three identical comments per command, which is what users saw. Now a
 * repeat updates one comment in place, so the PR carries a single, current
 * status no matter how many attempts ran. Best-effort: never fails the job.
 */
async function say(deps: ReviewWorkflowDeps, job: ReviewJob, ref: PullRef, body: string): Promise<void> {
  const withMarker = `${STATUS_MARKER}\n${body}`;
  try {
    const existing = await deps.github.findComment(ref, STATUS_MARKER);
    if (existing) {
      await deps.github.updateComment(ref, existing.id, withMarker);
      return;
    }
    await deps.github.createComment(ref, withMarker);
  } catch (err) {
    deps.logger?.error("could not post status comment", {
      repo: job.repo,
      pr: job.pr_number,
      err: (err as Error).message,
    });
  }
}

/**
 * Is this failure worth retrying?
 *
 * Retrying a bad API key, an exhausted quota or an unregistered provider cannot
 * succeed: it just burns the same quota twice more and delays the answer. Only
 * genuinely transient faults (upstream 5xx, network blips, timeouts) get another
 * attempt. Anything unrecognised is treated as transient, so a real outage still
 * recovers on its own.
 */
export function isPermanentFailure(message: string): boolean {
  return [
    /is not available/i,             // provider not registered for this deployment
    /api key is empty/i,             // nothing saved in the dashboard
    /HTTP 401|HTTP 403/,             // bad credentials / no permission
    /HTTP 404/,                      // app not installed, PR gone
    /HTTP 429|quota|rate.?limit/i,   // out of quota: an instant retry cannot help
    /API_KEY_INVALID|api key not valid/i,
    /CAVIX_APP_ID|\.pem|installation token/i, // our own misconfiguration
    /HTTP 400/,                      // malformed request (wrong model id, etc.)
    // The model declined. Asking the same model the same thing three more times
    // gets the same answer, three times slower, and the retries are invisible to
    // the person waiting.
    /declined to review/i,
  ].some((re) => re.test(message));
}

/** Run the full review workflow for one job and return what was posted. */
export async function runReview(
  job: ReviewJob,
  deps: ReviewWorkflowDeps,
  overrides: {
    org?: string;
    model?: string;
    check?: ReviewCheck;
    /** "summary" rewrites only the description. Set by "@cavixcode summary". */
    mode?: ReviewMode;
    /** Discard Cavix's earlier reviews and inline comments before posting. */
    fresh?: boolean;
  } = {},
): Promise<ReviewOutcome> {
  const log = deps.logger ?? noopLogger;
  const metrics = deps.metrics ?? NOOP_RECORDER;
  const ref = refFromJob(job);
  // Wall-clock for the whole review, reported to the dashboard. Latency per PR is
  // one of the roadmap's product metrics and nothing was measuring it.
  const startedAt = Date.now();

  // Step 0 — command jobs carry no commit (issue_comment has none), so resolve
  // the PR's current head before anything that needs it. Posting a review with an
  // empty commit_id is a 422.
  if (!ref.headSha) {
    const meta = await deps.github.getPull(ref);
    if (!meta.headSha) throw new Error(`could not resolve head commit for ${job.repo}#${job.pr_number}`);
    ref.headSha = meta.headSha;
    if (!job.title) job.title = meta.title;
    log.info("resolved head commit for command job", { repo: job.repo, pr: job.pr_number, head: ref.headSha });
  }
  const base = { repo: job.repo, pr: job.pr_number, head: ref.headSha };

  // Step 0a — take the single in-flight review slot for this pull request.
  //
  // A push while a review is running used to produce TWO reviews, seconds apart.
  // The older one was computed against a commit that no longer exists, so every
  // line number in it points at whatever has since moved into that position, and
  // the two raced to write the ledger: whichever landed last won.
  //
  // The edge already collapses a REDELIVERY of one webhook, and that is a
  // different question. It stops one event producing two jobs; it says nothing
  // about a second, genuinely new event arriving mid-review.
  const runRef = { org: overrides.org || job.org, repo: job.repo, pr: job.pr_number };
  const runId = `${job.idempotency_key || ref.headSha}-${startedAt}`;
  // A person typed "@cavixcode review". Coalescing is for webhooks that arrive
  // twice; it must never turn away somebody who is standing there waiting.
  const humanAsked = isCommandJob(job);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (deps.runs) {
    const outcome = await deps.runs.claim(runRef, {
      runId,
      headSha: ref.headSha,
      ...(job.base_sha ? { baseSha: job.base_sha } : {}),
      ...(humanAsked ? { force: true } : {}),
    });
    if (outcome.decision === "duplicate") {
      log.info("a review of this commit is already running; not starting a second", {
        ...base,
        holder: outcome.active.runId,
      });
      return emptyOutcome(0, "a review of this commit was already running");
    }
    if (outcome.decision === "wait") {
      // Mid-post, and a half-written review is worse than a late one.
      //
      // The job ENDS here rather than being retried. Returning normally is what
      // takes it off the queue, so nothing brings it back on its own, and the
      // message below has to say that honestly: telling somebody "it runs on its
      // own in a moment" when nothing will is a worse failure than the delay.
      log.info("an earlier review of this pull request is still posting; deferring", {
        ...base,
        holder: outcome.active.runId,
      });
      // Say so. A command that produces neither a review nor a word is
      // indistinguishable from a broken product, and the person will just ask
      // again, which is how somebody ends up typing the same command five times.
      if (humanAsked) {
        await sayDeferred(deps, job, ref);
      }
      return emptyOutcome(0, "an earlier review of this pull request was still posting");
    }
    if (outcome.superseded) {
      log.info("this review replaced an earlier one that was still running", {
        ...base,
        replaced: outcome.superseded.runId,
        replaced_head: outcome.superseded.headSha,
        why: outcome.superseded.reason,
      });
    }

    // Report in for as long as this review is working.
    //
    // Without it the claim's timestamp is frozen at the moment it was taken, so
    // "has the holder gone quiet?" really asks "has it been running a while?",
    // which is a different and much less useful question. With it the stale
    // window can be short: a holder whose process was restarted or redeployed
    // frees the pull request in a couple of minutes rather than twenty.
    //
    // It stops itself, two ways, and it has to.
    //
    // A review that THROWS never reaches the clear below. The failure path
    // releases the claim, but if that call is the one that could not reach the
    // control-plane, a timer still beating would keep a dead claim alive for as
    // long as it ran, which is a worse version of the exact wedge this exists to
    // prevent. So the heartbeat also stops the moment the control-plane says the
    // claim is no longer ours: superseded, failed, or taken over. `stillMine`
    // answers TRUE when it cannot reach the control-plane, so an ordinary
    // network blip never kills a live review's claim.
    let beats = 0;
    heartbeat = setInterval(() => {
      if (++beats > MAX_HEARTBEATS) {
        if (heartbeat) clearInterval(heartbeat);
        return;
      }
      // One request, not two: `stillMine` IS the touch, and reads the answer.
      void deps.runs?.stillMine(runRef, runId).then((mine) => {
        if (!mine && heartbeat) clearInterval(heartbeat);
      });
    }, HEARTBEAT_EVERY_MS);
    // Never hold the process open waiting for a heartbeat.
    heartbeat.unref?.();
  }

  // Step 0b — put Cavix in the Checks box before any slow work, so the pull
  // request shows a running check rather than nothing at all while the model and
  // the sandbox do their work. The handler passes its own instance in so a
  // self-heal retry moves the existing row instead of opening a second one.
  const check = overrides.check ?? new ReviewCheck(deps.github, log);
  await check.begin(ref);

  // Step 1 — what did the repo owner ask for? Verification, summary placement,
  // the pre-merge gate, blocking, the writing tone and which paths are in scope
  // are all their call, made on the dashboard.
  //
  // This runs BEFORE the model, not after it, because two of those settings
  // decide what the model is even shown. Fetching the config afterwards is how
  // path filters ended up costing tokens on files the owner had excluded.
  const org = overrides.org || job.org;
  const config = deps.reviewConfig ? await deps.reviewConfig(org) : DEFAULT_REVIEW_CONFIG;
  const mode: ReviewMode = overrides.mode ?? "full";

  // Step 2 — fetch the diff, then cut out the paths the owner excluded.
  const fullDiff = await deps.github.fetchPullDiff(ref);
  // What the host could not hand over. Empty everywhere but Azure DevOps, which
  // returns changed PATHS rather than content, so Cavix builds the diff itself
  // and a file can be too large, too rewritten or binary. Read straight after
  // the fetch, because it describes THAT fetch.
  const diffLimitations = deps.github.diffLimitations(ref);
  if (diffLimitations.length > 0) {
    // Logged, not counted as a stage failure. A vendored file too large to diff
    // is expected behaviour rather than a fault, and filing it under
    // `cavix_stage_failures_total` would blunt the one counter an operator
    // alerts on. The review names the files, which is what has to happen.
    log.info("part of this change could not be diffed exactly; it is named on the review", {
      ...base,
      files: diffLimitations.length,
      first: diffLimitations.slice(0, 5).map((d) => d.path),
    });
  }
  const filtered = filterDiff(fullDiff, config.pathFilters);
  const diff = filtered.diff;
  log.info("fetched diff", {
    ...base,
    bytes: fullDiff.length,
    reviewed_files: filtered.kept.length,
    excluded_files: filtered.dropped.length,
  });
  if (filtered.dropped.length > 0) {
    log.info("path filters excluded files from this review", { ...base, excluded: filtered.dropped.slice(0, 20) });
  }

  // Everything the owner allowed us to look at was excluded, so there is nothing
  // to review. Say so on the check rather than posting an empty review.
  if (filtered.kept.length === 0) {
    await check.finish(
      ref,
      "success",
      "Nothing to review",
      filtered.dropped.length > 0
        ? "Every file in this pull request is excluded by your path filters, under **Review settings**."
        : "This pull request changes no files Cavix can read.",
    );
    log.info("skipped: no reviewable files after path filters", base);
    return emptyOutcome(check.runId);
  }

  // Step 3 — read the change. The org id comes from the gate (the dashboard
  // workspace that enabled this repo), NOT from the GitHub owner login: those are
  // different names, and using the login meant the org's saved API key was never
  // found.
  //
  // Two paths. The deep one runs stages 3 to 9 (deterministic scanners, the call
  // graph, context assembly, seven specialist agents, adjudication) and needs a
  // separate cheap pass for the prose. The shallow one is a single model over the
  // raw diff, which is what shipped in Phase 0 and what every deployment falls
  // back to when the deep path is off or breaks.
  //
  // Summary mode never takes the deep path: nobody typing "@cavixcode summary"
  // wants seven agents billed to produce a paragraph.
  // Step 2c — narrow what the MODEL reads, when the workspace asked for it.
  //
  // Every review reads the whole pull request, `base...head`. On the tenth push
  // of a forty-file pull request that means paying to re-read thirty-nine files
  // nobody has touched, and it gets worse the longer the pull request runs,
  // which is backwards: the later pushes are usually the small ones.
  //
  // Narrowing is only SOUND because the ledger exists. A finding raised three
  // pushes ago is still open, still counted and still holds the merge whether or
  // not this review re-read its file. What is genuinely given up is the re-roll:
  // a model asked a second time about untouched code might have found something
  // it missed the first time. That is a real trade, so it is a SETTING and it is
  // off unless a workspace turns it on.
  //
  // Only the findings pass is narrowed. The prose pass keeps the whole diff,
  // because the description describes the whole change, and a summary written
  // from one file of a forty-file pull request would be worse than none.
  let attentionDiff = diff;
  let narrowedScope: ReviewScope | undefined;
  if (deps.narrowRereviews && deps.ledger && deps.github.fetchCompareDiff && !overrides.fresh) {
    try {
      const prior = await deps.ledger.fetch({ org, repo: job.repo, pr: job.pr_number });
      const lastHead = prior.known ? prior.ledger.lastHeadSha : undefined;
      if (lastHead && lastHead !== ref.headSha) {
        const deltaDiff = await deps.github.fetchCompareDiff(ref, lastHead, ref.headSha);
        const scope = scopeFor({
          verdictDiff: diff,
          deltaDiff,
          ledger: prior.ledger,
          priorHeadSha: lastHead,
          headSha: ref.headSha,
        });
        if (scope.narrowed) {
          const hot = filterDiff(diff, { include: scope.hot, exclude: [] });
          // Only narrow when the filter kept EXACTLY the hot set. A path
          // carrying a glob metacharacter would otherwise be dropped silently,
          // and a file quietly missing from the review is the one outcome this
          // whole feature is not allowed to produce.
          const exact = hot.kept.length === scope.hot.length && scope.hot.every((p) => hot.kept.includes(p));
          if (exact && hot.diff.trim() !== "") {
            attentionDiff = hot.diff;
            narrowedScope = scope;
            log.info("narrowed this re-review to what the push changed", {
              ...base,
              read: scope.hot.length,
              not_re_read: scope.warm.length + scope.cold.length,
            });
          }
        }
      }
    } catch (err) {
      // Reading everything is always correct, so this costs tokens and nothing
      // else. It must never cost coverage.
      log.info("could not narrow this re-review; reading the whole pull request", {
        ...base,
        err: (err as Error).message,
      });
    }
  }

  const modelOverride = overrides.model ? { model: overrides.model } : {};
  const proseInput = { org, title: job.title, diff, tone: config.tone, ...modelOverride };

  // "@cavixcode summary" asked for the description and nothing else. One cheap
  // pass produces it: no findings, no ensemble, no sandbox. Handled before the
  // branch below so it can never fall into the full review path.
  if (mode === "summary") {
    const prose = await deps.reviewer.summarise(proseInput);
    log.info("summary refreshed", { ...base, org, cost_usd: prose.costUsd, model: prose.model });
    return await runSummaryOnly(job, ref, deps, config, prose, diff, check, log);
  }

  const deep = deps.deepReview;
  let signals: DeepReviewResult | undefined;
  let result;

  if (deep) {
    try {
      const [pipeline, prose] = await Promise.all([
        // Stage 12 closes here. The per-category bars this workspace taught
        // Cavix came back on the review-config fetch above, which every review
        // already makes, so feeding them in costs nothing: no extra call, no
        // extra latency, and an empty object when there is nothing learned yet.
        deep({ org, title: job.title, diff: attentionDiff, ref, thresholdByCategory: config.thresholdByCategory }),
        deps.reviewer.summarise(proseInput),
      ]);
      signals = pipeline;
      result = { ...prose, findings: pipeline.findings, costUsd: prose.costUsd + pipeline.costUsd };
    } catch (err) {
      // The deep path reads files through the API and fans out to seven models.
      // Plenty can go wrong there that has nothing to do with this pull request,
      // and none of it is worth the customer's review.
      metrics.stageFailed("deep_review");
      log.error("deep review failed; falling back to the single-model pass", {
        ...base,
        err: (err as Error).message,
      });
    }
  }

  if (!result) result = await deps.reviewer.review(proseInput);

  log.info("review complete", {
    ...base,
    org,
    mode,
    path: signals ? "deep" : "single-model",
    findings: result.findings.length,
    ...(signals
      ? {
          deterministic: signals.deterministicCount,
          agents_reporting: signals.ensembleAgents,
          dropped_by_adjudication: signals.droppedCount,
          calibrated_categories: signals.calibratedCategories,
          ast_symbols: signals.astSymbols,
        }
      : {}),
    cost_usd: result.costUsd,
    model: result.model,
  });

  // Step 3b — Stage 5: what does this change break in OTHER repositories?
  //
  // The finding no single-repo reviewer can produce. A change to a public
  // endpoint reads as a clean, well-tested diff inside its own service, and the
  // only thing wrong with it lives in a repository nobody in the pull request
  // has open. Runs before verification so a cross-repo finding is a first-class
  // candidate for proof rather than an appendix.
  let crossRepoConsumers = 0;
  if (deps.blastRadius) {
    try {
      const impact = await deps.blastRadius({ org, ref, diff });
      if (impact.findings.length > 0) {
        result.findings = [...impact.findings, ...result.findings];
        crossRepoConsumers = impact.consumers;
        log.info("cross-repo impact found", {
          ...base,
          findings: impact.findings.length,
          call_sites: impact.consumers,
          repos_in_graph: impact.indexedRepos,
        });
      }
    } catch (err) {
      metrics.stageFailed("cross_repo");
      log.error("cross-repo impact could not be traced; reviewing this repo alone", {
        ...base,
        err: (err as Error).message,
      });
    }
  }

  // Step 3c — Stage 6: is the pipeline this change joins already degrading?
  //
  // Static analysis sees the code and not its consequences. A change can be
  // correct, well-tested and well-reviewed and still be the one that takes the
  // build from four minutes to nine, which nobody notices for a month and
  // nobody can then attribute to anything.
  let ciRunsAnalysed = 0;
  if (deps.regression) {
    try {
      const ci = await deps.regression({ org, ref });
      ciRunsAnalysed = ci.runsAnalysed;
      // Appended, not prepended: a pipeline trend is context for the reviewer,
      // never more urgent than a defect in the code they are reading.
      if (ci.findings.length > 0) result.findings = [...result.findings, ...ci.findings];
    } catch (err) {
      metrics.stageFailed("ci_telemetry");
      log.error("CI telemetry could not be read; reviewing without it", {
        ...base,
        err: (err as Error).message,
      });
    }
  }

  // Step 2c — the org's pre-merge gate. Deterministic checks over the files this
  // PR changes, compiled from the owner's own plain-English rules. These run
  // before verification because policy findings are facts, not claims: they skip
  // the sandbox entirely and cannot be dropped downstream.
  let preMerge: PreMergeResult | undefined;
  if (config.preMergeChecks.enabled && config.preMergeChecks.rules.length > 0) {
    try {
      const paths = changedPaths(diff);
      // Cavix reads a bounded number of files per review. If this PR touches
      // more than that, the gate can only see part of it — and a check that
      // scanned half a change and reported "pass" is the same silent lie as one
      // that never ran. Say so instead.
      if (paths.length > MAX_SOURCE_FILES) {
        preMerge = preMergeUnavailable(
          config.preMergeChecks.rules,
          `this pull request changes ${paths.length} files, more than the ${MAX_SOURCE_FILES} Cavix reads per review`,
        );
      } else {
        const files = await fetchSources(deps.github, ref, paths);
        // fetchSources swallows per-file failures by design, so "no files" is
        // the likely shape of a broken gate — not an exception.
        preMerge = runPreMergeChecks(
          config.preMergeChecks.rules,
          files,
          commentableLines(parseUnifiedDiff(diff)),
        );
      }
      result.findings = [...preMerge.findings, ...result.findings];
      log.info("pre-merge checks complete", {
        ...base,
        rules: config.preMergeChecks.rules.length,
        passed: preMerge.passed,
        failed: preMerge.failed,
        skipped: preMerge.skipped,
      });
    } catch (err) {
      // A gate that cannot run must not silently pass — that is indistinguishable
      // from a gate that passed. Surface every rule as skipped on the PR so a
      // human sees it, and never claim a failure we did not actually measure.
      const reason = (err as Error).message;
      preMerge = preMergeUnavailable(config.preMergeChecks.rules, reason);
      metrics.stageFailed("pre_merge");
      log.error("pre-merge checks could not run", { ...base, err: reason });
    }
  }

  // Step 3 — Stage 10: prove them. Findings the sandbox reproduces get a receipt
  // attached; ones it DISPROVES are dropped here and never reach the pull
  // request. This is the difference between a reviewer that gets trusted and one
  // that gets muted, so it runs before anything is posted.
  //
  // Stage 13 rides along. One collector per review, created here and thrown
  // away with the review: a collector shared across the orchestrator's
  // concurrent jobs would file one customer's sandboxes under another
  // customer's retention proof.
  let suppressedCount = 0;
  let verifyCost = 0;
  const retention = makeRetentionCollector({ logger: log });
  if (deps.verify && config.verifyFindings && result.findings.length > 0) {
    try {
      // Stage 12 closes on this end too. The same review-config fetch that
      // carried the learned confidence bars into Stage 9 carries, for each
      // category, whether this workspace's own history says proof is worth
      // spending there. Where their accepts and rejects overlap at every
      // confidence level, a threshold cannot help and execution can, so the
      // sandbox runs on findings the default gate would skip; where they accept
      // essentially everything, it stops running on the ones proof would not
      // change. Critical, high and security are proven regardless.
      const outcome = await deps.verify(
        result.findings,
        ref,
        org,
        retention.onTeardown,
        config.verifyByCategory,
      );
      result.findings = outcome.surfaced;
      suppressedCount = outcome.suppressed.length;
      verifyCost = outcome.costUsd;
      for (const s of outcome.suppressed) {
        log.info("finding suppressed by verification", {
          ...base,
          path: s.finding.path,
          line: s.finding.line,
          title: s.finding.title,
          reason: s.reason,
        });
      }
    } catch (err) {
      // Verification is an enhancement, never a gate on posting. A sandbox that
      // is down must not cost the org its review — it costs them the receipts.
      metrics.stageFailed("verify");
      log.error("verification failed; posting unverified findings", {
        ...base,
        err: (err as Error).message,
      });
    }
  }

  // Step 3d — fold this review into what the pull request already knew.
  //
  // The single most important step for anyone who pushes a fix and looks at the
  // check. Everything above computed what THIS review found. This decides what
  // is OPEN, which is a different question and the only one a merge gate should
  // ever be asked.
  //
  // A finding raised two reviews ago is cleared here only if the file it lives
  // in has actually changed since. If the code is byte-identical and the
  // reviewer simply went quiet about it, it is carried forward and it keeps
  // blocking, because nothing about the defect has changed. That is the bug this
  // exists for: pushing a fix for one of three findings used to hand out a green
  // check with the other two still on the page.
  //
  // It runs AFTER verification, so a finding the sandbox disproved never enters
  // the ledger, and BEFORE the verdict, the poster and the check run, all three
  // of which have to agree about what is open.
  let carried: LedgerEntry[] = [];
  let resolvedNow: LedgerEntry[] = [];
  // Starts TRUE, and the distinction it draws is the point of the flag.
  //
  // A deployment with no control-plane has no cross-review memory by
  // configuration, and a review there is as complete a statement as that
  // deployment can make: it should say "clean pass" exactly as it always has.
  // What must never say that is a deployment that HAS a ledger and could not
  // reach it, because there the review genuinely does not know what earlier
  // reviews left open. Only that case sets this false.
  let ledgerKnown = true;
  let historyRewritten = false;
  let reviewDelta: ReviewDelta | undefined;
  let nextLedger: ReturnType<typeof reconcile>["ledger"] | undefined;
  if (deps.ledger) {
    try {
      const state = await deps.ledger.fetch({ org, repo: job.repo, pr: job.pr_number });
      ledgerKnown = state.known;
      const folded = reconcile({
        prior: state.ledger,
        findings: result.findings,
        diff,
        headSha: ref.headSha,
        // The history, so a REBASE is not mistaken for the author fixing
        // everything. After a rebase every hunk differs because the base moved,
        // so on file digests alone every open finding clears at once without a
        // line of anybody's code being fixed.
        ...(job.base_sha ? { baseSha: job.base_sha } : {}),
        ...(state.ledger.lastHeadSha ? { priorHeadSha: state.ledger.lastHeadSha } : {}),
        ...(state.ledger.lastBaseSha ? { priorBaseSha: state.ledger.lastBaseSha } : {}),
      });
      carried = folded.carried;
      resolvedNow = folded.resolved;
      historyRewritten = folded.historyRewritten;
      // "What changed since I last looked" is the reader's real question on any
      // pull request past its first review, and answering it used to mean
      // scrolling back and diffing two Cavix comments by eye.
      if (state.ledger.lastHeadSha && state.ledger.lastHeadSha !== ref.headSha) {
        // What THIS push changed, which is not what the pull request contains.
        //
        // The numbers here used to be derived from the whole `base...head` diff,
        // so on the tenth push of a forty-file pull request the review claimed
        // it had re-read forty files. It had, but "re-read" was then a
        // meaningless word: it says the same thing on every push regardless of
        // what anybody did, which is worse than saying nothing.
        let deltaDiff = "";
        if (deps.github.fetchCompareDiff) {
          try {
            deltaDiff = await deps.github.fetchCompareDiff(ref, state.ledger.lastHeadSha, ref.headSha);
          } catch {
            // Reading everything is always correct, so this costs nothing but a
            // less precise sentence on the pull request.
          }
        }
        // Reuse the scope the narrowing step already computed, when there is
        // one. Recomputing it risks the review SAYING it re-read a different set
        // of files from the one it actually read, and a report that disagrees
        // with the work is worse than no report.
        const scope = narrowedScope ?? scopeFor({
          verdictDiff: diff,
          deltaDiff,
          ledger: folded.ledger,
          priorHeadSha: state.ledger.lastHeadSha,
          headSha: ref.headSha,
          // A rewritten history means earlier reviews were formed against
          // premises that no longer exist, so nothing about them can be relied
          // on to decide what is safe to skip.
          ...(folded.historyRewritten ? { forceFull: "the history was rewritten" } : {}),
          ...(overrides.fresh ? { forceFull: "a fresh review was asked for" } : {}),
        });
        reviewDelta = {
          fromSha: state.ledger.lastHeadSha,
          toSha: ref.headSha,
          filesReread: scope.hot.length,
          // Files in the pull request this push did not touch. Stated because a
          // reviewer has to know what was NOT looked at again, and because it is
          // the row that makes an incremental review trustworthy rather than
          // merely cheap.
          unchangedFiles: scope.warm.length + scope.cold.length,
        };
        if (scope.narrowed) {
          log.info("this push changed part of the pull request", {
            ...base,
            hot: scope.hot.length,
            warm: scope.warm.length,
            cold: scope.cold.length,
            open_in_files_not_re_read: openInSkippedFiles(folded.ledger, scope).length,
          });
        }
      }
      // Written back ONLY when the read succeeded, and this is not a detail.
      //
      // A failed read hands back an EMPTY ledger, because that is the only
      // honest answer to "what came before" when nobody could be asked. Folding
      // this review into that empty prior and saving the result would overwrite
      // a real ledger holding five open findings with one holding this review's,
      // and reset the review counter with it. One unreachable control-plane
      // would silently clear every open finding on the pull request and hand out
      // the green pass this whole feature exists to prevent.
      //
      // So a read failure costs this review its carried findings and NOTHING
      // else. The stored ledger is left exactly as it was, and the next review
      // that can reach the control-plane picks it up intact.
      if (state.known) nextLedger = folded.ledger;
      if (carried.length > 0) {
        log.info("carrying open findings forward from earlier reviews", {
          ...base,
          carried: carried.length,
          resolved: folded.resolved.length,
          repeated: folded.repeated.length,
          fresh: folded.fresh.length,
          reviews_on_this_pr: folded.ledger.reviewsUsed,
          // The ones nobody has acted on for several pushes. Worth seeing in a
          // log: it is the shape of a team that has started ignoring Cavix.
          most_reported: Math.max(0, ...folded.repeated.map((e) => e.timesReported)),
        });
      }
    } catch (err) {
      // Fails soft like every other stage, and the direction matters: no ledger
      // means this review's own findings decide its verdict, which is what every
      // review did before this existed. It never means "green".
      ledgerKnown = false;
      metrics.stageFailed("pr_ledger");
      log.error("could not reconcile the pull request ledger; this review stands alone", {
        ...base,
        err: (err as Error).message,
      });
    }
  }

  // The host as well as the coordinates. Without it every permalink in the
  // review was built against a hardcoded github.com, so a GitLab or Bitbucket
  // reader clicking a finding's line number left for a repository that does not
  // exist, and a GitHub Enterprise reader left their own network.
  const linkRef = {
    owner: ref.owner,
    repo: ref.repo,
    headSha: ref.headSha,
    host: deps.github.webUrl,
    platform: deps.github.platform,
  };

  // Step 4 — the summary goes in the PR DESCRIPTION, where a reviewer reads it
  // first and where it cannot scroll away. Attempted BEFORE the review is posted
  // so that if it fails (fork PRs, revoked permission) the summary can fall back
  // Step 3z — the last chance to stop.
  //
  // Everything above is computation and costs the customer tokens; everything
  // below writes to their pull request. If a newer commit arrived while this was
  // running, this review's findings are anchored to a commit that no longer
  // exists, so posting them would put comments on whatever code has since moved
  // into those line numbers. Throwing the work away is the cheap option.
  if (deps.runs) {
    const mine = await deps.runs.stillMine(runRef, runId);
    if (!mine) {
      log.info("a newer commit replaced this review before it posted; discarding it", {
        ...base,
        run: runId,
      });
      metrics.review("superseded");
      return emptyOutcome(check.runId);
    }
    // From here the run is uninterruptible. A pull request carrying three inline
    // comments and no review body is worse than a late review.
    await deps.runs.beginPosting(runRef, runId);
  }

  // into the review comment instead of being lost.
  let descriptionUpdated = false;
  // With both the summary and the walkthrough switched off there is nothing to
  // put there, and editing someone's description to add a heading is rude.
  const summaryHasContent = config.sections.summary || config.sections.changedFiles;
  if (deps.summaryInDescription !== false && config.summaryInDescription && summaryHasContent) {
    try {
      const meta = await deps.github.getPull(ref);
      const body = buildPullDescription(meta.body ?? "", result, diff, linkRef, config.sections, signals?.trace);
      if (body !== (meta.body ?? "")) await deps.github.updatePullBody(ref, body);
      descriptionUpdated = true;
      log.info("summary written to the PR description", base);
    } catch (err) {
      metrics.stageFailed("description");
      log.error("could not update the PR description; summary stays in the comment", {
        ...base,
        err: (err as Error).message,
      });
    }
  }

  // Step 5 — post the review itself: findings, anchored to their lines.
  //
  // Blocking is the owner's setting AND the platform's ability. Where the host
  // has no bot-blocking review (GitLab has approvals and pipeline status, and
  // nothing a bot can hold the merge button with), the review must not be
  // dressed up as one. `unavailable` carries that to the poster so the comment
  // says it out loud instead of the owner believing a gate is in place.
  //
  // The severities are THIS review's plus everything still open from earlier
  // ones. That union is the whole point: a finding raised three pushes ago, in
  // a file nobody has touched since, holds the merge exactly as firmly as one
  // raised a minute ago. Passing only `result.findings` here is the bug.
  const wantsBlock = shouldRequestChanges(config, preMerge, [
    ...result.findings.map((f) => f.severity),
    ...carried.map((e) => toSeverity(e.severity)),
  ]);
  const requestChanges = wantsBlock && deps.github.capabilities.blockingReview;
  const blockUnavailable = wantsBlock && !deps.github.capabilities.blockingReview;
  if (blockUnavailable) {
    log.info("this platform has no blocking review; posting as a comment and saying so", {
      ...base,
      platform: deps.github.platform,
    });
  }
  const posterOpts = {
    ref: linkRef,
    includeSummary: !descriptionUpdated && summaryHasContent,
    suppressedCount,
    preMerge,
    requestChanges,
    platform: deps.github.platform,
    capabilities: deps.github.capabilities,
    blockUnavailable,
    sections: config.sections,
    // What the host could not give us. Never dropped quietly: a review that
    // skipped two files without saying so claims coverage it does not have.
    ...(diffLimitations.length > 0 ? { diffLimitations } : {}),
    // Still open from earlier reviews, and what this one cleared. Both are
    // rendered, and the second matters as much as the first: a reader who
    // pushed a fix needs to see it land, or the only visible signal is the
    // findings that did NOT clear and Cavix reads as if it never noticed.
    ...(carried.length > 0 ? { carried } : {}),
    ...(resolvedNow.length > 0 ? { resolved: resolvedNow } : {}),
    // What this push changed about the review, on every review after the first.
    ...(reviewDelta ? { delta: reviewDelta } : {}),
    // Nothing cleared, and the reason. Without this the author sees a fix they
    // pushed go unacknowledged and concludes Cavix stopped working; the truth is
    // that the evidence for clearing anything was measured against a history
    // that no longer exists.
    ...(historyRewritten ? { historyRewritten } : {}),
    // How many of THIS review's findings clear the owner's blocking bar. The
    // poster cannot work it out: the bar is `failOn` and only this function
    // reads the config. It uses the number to say where a block came from.
    blockingFindings: countAtOrAbove(config, result.findings.map((f) => f.severity)),
    // Did the ledger actually answer? A review that carried nothing because
    // there was nothing to carry is not the same as one that carried nothing
    // because the control-plane was down, and the second must never render as
    // "nothing open from earlier reviews". The Scope module states measurements,
    // and an unanswered question is not one.
    ledgerKnown,
    // Only used when the description could not be written (a fork PR, a revoked
    // permission), in which case the whole narrative folds into the comment and
    // the diagram goes with it rather than being the one piece that vanishes.
    ...(signals?.trace ? { trace: signals.trace } : {}),
    // What the change can reach, from the graph, with the evidence behind it.
    //
    // Every number here was measured by walking the index; none is inferred from
    // the diff, and the `resolution` decides the sentence under the table. It is
    // "resolved statically" only when EVERY edge walked was exact, and the
    // moment one was a name match the whole claim drops to "resolved by name
    // match". A reach claim is worth exactly its shakiest link, and this is a
    // heuristic parser: a review that says "statically" anyway is inventing
    // precision it does not have.
    ...(signals?.reach && signals.reach.callerSymbols.length > 0
      ? {
          impact: {
            callSites: signals.reach.callerFiles.map((path) => ({ path })),
            ...(crossRepoConsumers > 0 ? { consumers: [`${crossRepoConsumers} other repositories`] } : {}),
            resolution: signals.reach.resolution === "exact" ? ("exact" as const) : ("heuristic" as const),
            depth: 3,
          },
        }
      : {}),
    badges: deps.badges !== false,
    // The Scope module's AST, Deterministic Pass, Ensemble and Blast Radius rows
    // exist for exactly this: real counts from stages that actually ran. Each is
    // assembled independently, because the stages are independent: a deployment
    // with the cross-repo graph and no deep path should still get its Blast
    // Radius row, and a row with no measurement behind it never renders.
    signals: {
      ...(crossRepoConsumers > 0 ? { consumers: crossRepoConsumers } : {}),
      ...(ciRunsAnalysed > 0 ? { ciRuns: ciRunsAnalysed } : {}),
      ...(signals
        ? {
            astSymbols: signals.astSymbols,
            // Only claim a deterministic pass when every changed file was
            // scanned. On a wide PR the scanners saw part of it, and "24 tools
            // run over the change" would be a statement we cannot stand behind.
            ...(signals.fullyScanned ? { tools: signals.toolsRun } : {}),
            agents: signals.ensembleAgents,
          }
        : {}),
    },
  };
  const built = buildReviewSubmission(result, diff, posterOpts);

  // A fresh review replaces the last one instead of piling on top of it. This is
  // what "@cavixcode review" means: look again, and let what you said last time
  // go. Best-effort, and always before the new review is posted, so a reader
  // never sees two Cavix reviews at once.
  if (overrides.fresh) await clearPrevious(deps, ref, log);

  // Reconcile this review's inline comments against what is already on the page.
  //
  // Without this, six pushes on a three-finding pull request leave eighteen
  // inline comments, all saying the same three things, and the only way to tell
  // which are current is to read the timestamps. The ledger can be perfectly
  // correct while the page is nonsense, and the reader believes the page.
  //
  // Skipped entirely on a fresh review, which has just deleted everything, and
  // on any platform that cannot read its own comments back.
  let submission = built.submission;
  if (!overrides.fresh && deps.github.listOwnInlineComments) {
    try {
      const existing = await deps.github.listOwnInlineComments(ref);
      if (existing.length > 0) {
        const plan = reconcileInlineComments({
          existing,
          incoming: submission.comments,
          // Only a finding the ledger CLEARED has its comment removed. Silence
          // is not resolution: deleting on that basis would hide an open finding
          // from the one place a developer actually reads.
          resolved: resolvedNow.map((e) => e.fingerprint),
        });
        submission = { ...submission, comments: plan.post };
        for (const id of plan.remove) {
          try {
            await deps.github.deleteReviewComment(ref, id);
          } catch {
            // A comment we could not remove is clutter, not a wrong verdict.
          }
        }
        log.info("reconciled inline comments with what was already on the pull request", {
          ...base,
          posted_new: plan.post.length,
          left_in_place: plan.keep.length,
          removed: plan.remove.length,
        });
      }
    } catch (err) {
      // Degrade to the old behaviour: post the full set. A duplicate comment is
      // a far smaller failure than a review that did not land.
      log.info("could not reconcile inline comments; posting the full set", {
        ...base,
        err: (err as Error).message,
      });
    }
  }

  const posted = await deps.github.postReview(ref, submission);
  log.info("review posted", {
    ...base,
    review_id: posted.id,
    url: posted.htmlUrl,
    event: built.submission.event,
    inline: built.inlineCount,
    off_diff: built.offDiffCount,
    verified: built.verifiedCount,
    suppressed: suppressedCount,
  });

  // Step 5b — close the check run now the review is on the page. It fails only
  // when the owner turned blocking on AND something they nominated failed: a
  // review Cavix was not asked to gate on always passes, so a team that never
  // opted in never has Cavix standing between them and a merge.
  const output = buildCheckOutput(result, diff, posterOpts);
  await check.finish(
    ref,
    requestChanges ? "failure" : "success",
    output.title,
    output.summary,
    posted.htmlUrl,
  );

  // Step 5b2 — persist the ledger, now the review is actually on the page.
  //
  // Deliberately after the post and never before it. `reviewsUsed` is what the
  // per-pull-request budget counts, and incrementing it for a review that then
  // failed to post would charge somebody for a review they never received.
  // Best-effort in the other direction too: if this does not land, the next
  // review re-raises what this one raised, which is noise rather than a wrong
  // verdict.
  if (deps.ledger && nextLedger) {
    await deps.ledger.save({ org, repo: job.repo, pr: job.pr_number }, nextLedger);
  }

  // Step 5c — refresh this repository's slice of the org contract graph.
  //
  // Deliberately AFTER the review is on the pull request. It is a tree listing
  // and a few dozen file reads, which is nothing next to a model call but is
  // still latency, and none of it changes the review that was just posted. It
  // only runs when this repo's slice has gone stale, so the usual case is one
  // cheap read of a timestamp.
  if (deps.indexGraph) {
    try {
      await deps.indexGraph(ref, org);
    } catch (err) {
      log.info("could not refresh the org contract graph (continuing)", {
        ...base,
        err: (err as Error).message,
      });
    }
  }

  // Step 5d — refresh CI history, on the same terms: after the review, gated on
  // staleness, and never allowed to matter. The base ref is where the trend is
  // measured, because a pipeline's history belongs to the branch it runs on and
  // this pull request's own runs are a handful of points on a branch that will
  // not exist next week.
  if (deps.ingestCi) {
    try {
      // One extra call only when there is ingestion to do, and only after the
      // review is already posted.
      const meta = await deps.github.getPull(ref);
      await deps.ingestCi(ref, org, meta.baseRef || "main");
    } catch (err) {
      log.info("could not refresh CI history (continuing)", { ...base, err: (err as Error).message });
    }
  }

  // Step 5e — Stage 13: close out the retention proof.
  //
  // A violation is logged at error level and does NOT fail the review. The
  // review is already on the pull request and the customer got what they paid
  // for; what has gone wrong is our cleanup, which is our problem to fix and
  // theirs to be told about. It is recorded on the review either way, so the
  // dashboard shows it and an auditor can find it months later.
  const attestation = retention.finish({ org });
  if (retention.violated()) {
    log.error("zero-retention violated: a sandbox survived teardown on this review", {
      ...base,
      sandboxes: attestation.sandboxes,
      backends: [...new Set(attestation.checks.map((c) => c.backend))].join(","),
    });
  } else {
    log.info("retention verified", {
      ...base,
      verdict: attestation.verdict,
      sandboxes: attestation.sandboxes,
    });
  }

  // Step 6 — record it on the dashboard. This is what the org actually looks at
  // between pull requests, and it is where accept/reject decisions (the learning
  // signal) are made. It runs last and swallows its own failures: the review is
  // already published, so a control-plane hiccup must not undo it or make the
  // queue retry a review that succeeded.
  let recorded = false;
  if (deps.recordReview) {
    try {
      recorded = await deps.recordReview({
        org,
        repo: job.repo,
        pr: job.pr_number,
        title: job.title ?? "",
        url: posted.htmlUrl,
        findings: result.findings,
        costUsd: result.costUsd + verifyCost,
        model: result.model,
        durationMs: Date.now() - startedAt,
        verifiedCount: built.verifiedCount,
        suppressedCount,
        // Stage 13. Every sandbox this review provisioned has been destroyed by
        // now (the verifier tears each one down before it returns), so this is
        // the first moment the proof is complete and the last moment before the
        // review leaves this process.
        retention: attestation,
      });
    } catch (err) {
      metrics.stageFailed("record");
      log.error("could not record the review on the dashboard", {
        ...base,
        err: (err as Error).message,
      });
    }
  }

  // The review is on the pull request. Release the slot so the next push can be
  // reviewed straight away rather than waiting for this claim to age out.
  if (heartbeat) clearInterval(heartbeat);
  if (deps.runs) await deps.runs.finish(runRef, runId, "completed");

  // The review-level numbers, recorded once at the end so a review that threw
  // partway is counted as failed by the handler rather than as posted here.
  metrics.review("posted", (Date.now() - startedAt) / 1000);
  metrics.cost(result.costUsd + verifyCost);
  metrics.finding("surfaced", result.findings.length);
  if (suppressedCount > 0) metrics.finding("suppressed", suppressedCount);

  return {
    posted,
    summary: result.summary,
    findingCount: result.findings.length,
    inlineCount: built.inlineCount,
    offDiffCount: built.offDiffCount,
    verifiedCount: built.verifiedCount,
    suppressedCount,
    descriptionUpdated,
    preMerge,
    blocked: requestChanges,
    carriedCount: carried.length,
    resolvedCount: resolvedNow.length,
    recorded,
    checkRunId: check.runId,
    costUsd: result.costUsd + verifyCost,
    model: result.model,
  };
}

/**
 * Close every open finding on this pull request, for "@cavixcode resolve".
 *
 * The entries are marked dismissed rather than deleted, so the pull request
 * keeps its history and `reconcile` never re-opens them. Returns how many were
 * closed, so the reply states a number that was measured.
 */
async function clearLedger(
  deps: ReviewWorkflowDeps,
  ref: { org: string; repo: string; pr: number },
): Promise<number> {
  if (!deps.ledger) return 0;
  const state = await deps.ledger.fetch(ref);
  const open = openEntries(state.ledger);
  if (open.length === 0) return 0;
  const saved = await deps.ledger.save(ref, dismissAll(state.ledger));
  // Reported as 0 when the write did not land. Telling somebody eight findings
  // were closed when the store still has them open is worse than saying nothing:
  // they will see all eight again on the next push and stop believing the reply.
  return saved ? open.length : 0;
}

/**
 * Should an AUTOMATIC review be skipped? Returns the reason, or "" to proceed.
 *
 * These three switches only ever apply to a webhook Cavix reacted to on its own.
 * A human typing "@cavixcode review" has overridden all of them by asking, and
 * silently ignoring that would be the more confusing behaviour by far.
 *
 * All three used to be settings a customer could change on the dashboard with no
 * effect whatsoever on a real pull request.
 */
async function shouldSkipAutomatic(
  deps: ReviewWorkflowDeps,
  ref: PullRef,
  org: string,
  log: WorkflowLogger,
): Promise<string> {
  const config = deps.reviewConfig ? await deps.reviewConfig(org) : DEFAULT_REVIEW_CONFIG;

  if (!config.autoReview) return "automatic reviews are off for this workspace";

  if (!config.reviewDraftPRs) {
    try {
      const meta = await deps.github.getPull(ref);
      if (meta.draft) return "the pull request is a draft and this workspace does not review drafts";
    } catch (err) {
      // Could not tell whether it is a draft. Review it: a missed review is a
      // worse outcome than reviewing a draft the org would rather we skipped.
      log.info("could not read draft state, reviewing anyway", { err: (err as Error).message });
    }
  }

  if (await isPaused(deps.github, ref)) return "Cavix is paused on this pull request";
  return "";
}

/**
 * The outcome shape for a run that decided there was nothing to do. Every count
 * is zero and `posted` carries no url, so a caller cannot mistake it for a review.
 */
function emptyOutcome(checkRunId: number, skipped?: string): ReviewOutcome {
  return {
    ...(skipped ? { skipped } : {}),
    posted: { id: 0, htmlUrl: "" },
    summary: "",
    findingCount: 0,
    inlineCount: 0,
    offDiffCount: 0,
    verifiedCount: 0,
    suppressedCount: 0,
    descriptionUpdated: false,
    blocked: false,
    carriedCount: 0,
    resolvedCount: 0,
    recorded: false,
    checkRunId,
    costUsd: 0,
    model: "",
  };
}

/**
 * "@cavixcode summary": rewrite the description block and stop.
 *
 * The model still reads the diff (a summary of a change cannot be produced any
 * other way), but nothing is posted as a review. Someone asking for a refreshed
 * summary after a rebase does not want a second review comment and a fresh set
 * of inline comments on lines they already dealt with.
 */
async function runSummaryOnly(
  job: ReviewJob,
  ref: PullRef,
  deps: ReviewWorkflowDeps,
  config: OrgReviewConfig,
  result: Awaited<ReturnType<Reviewer["review"]>>,
  diff: string,
  check: ReviewCheck,
  log: WorkflowLogger,
): Promise<ReviewOutcome> {
  // The host as well as the coordinates. Without it every permalink in the
  // review was built against a hardcoded github.com, so a GitLab or Bitbucket
  // reader clicking a finding's line number left for a repository that does not
  // exist, and a GitHub Enterprise reader left their own network.
  const linkRef = {
    owner: ref.owner,
    repo: ref.repo,
    headSha: ref.headSha,
    host: deps.github.webUrl,
    platform: deps.github.platform,
  };
  let descriptionUpdated = false;
  try {
    const meta = await deps.github.getPull(ref);
    // No call-flow diagram here, on purpose. Summary mode never builds the Stage
    // 4 graph, so nothing has measured the flow at this head, and the block is
    // rewritten whole. Carrying the previous diagram forward would republish a
    // picture of the code as it was before the push that prompted the refresh,
    // which is the one thing worse than not having one.
    const body = buildPullDescription(meta.body ?? "", result, diff, linkRef, config.sections);
    if (body !== (meta.body ?? "")) await deps.github.updatePullBody(ref, body);
    descriptionUpdated = true;
  } catch (err) {
    log.error("could not update the PR description for a summary command", {
      repo: job.repo,
      pr: job.pr_number,
      err: (err as Error).message,
    });
  }

  await check.finish(
    ref,
    "success",
    descriptionUpdated ? "Summary refreshed" : "Summary could not be written",
    descriptionUpdated
      ? "The pull request description now describes the current head. No findings were posted, because `@cavixcode summary` asks only for the summary."
      : "Cavix could not write to this pull request's description. On a fork PR that permission does not exist; comment `@cavixcode review` for a full review instead.",
  );

  return {
    ...emptyOutcome(check.runId),
    summary: result.summary,
    descriptionUpdated,
    costUsd: result.costUsd,
    model: result.model,
  };
}

/**
 * How many heartbeats one review may send before the timer gives up on itself.
 *
 * A safety net, not a timeout: at thirty seconds a beat this is two hours, far
 * longer than any real review. It exists because a review that THROWS never
 * reaches the clear on the success path, and a timer left running in a
 * long-lived worker would keep a dead claim alive forever, which is precisely
 * the failure the heartbeat was added to end.
 */
const MAX_HEARTBEATS = 240;

/**
 * Tell somebody their command landed but has to wait.
 *
 * A command that produces neither a review nor a word is indistinguishable from
 * a broken product. The person asks again, gets silence again, and concludes it
 * does not work, which is exactly what happened.
 *
 * Goes through `say`, so it EDITS the single status comment rather than adding
 * another one. Somebody who asks three times while a review is posting should
 * see one current status line, not three identical complaints, which is the
 * whole reason `say` exists.
 */
async function sayDeferred(deps: ReviewWorkflowDeps, job: ReviewJob, ref: PullRef): Promise<void> {
  await say(
    deps,
    job,
    ref,
    "**Not started.** Cavix is still posting an earlier review of this pull request, and interrupting it " +
      "would leave half a review on the page. Comment `@cavixcode review` again in a moment and it will run.",
  );
}

/**
 * Remove what the last Cavix review left on this pull request.
 *
 * What GitHub actually permits is narrower than it sounds. A CHANGES_REQUESTED
 * review can be dismissed, which is the one that matters because it is the one
 * holding the merge button. A COMMENTED review can be neither dismissed nor
 * deleted through the API by anyone, including the account that posted it, so
 * those bodies stay in the conversation and GitHub collapses them as outdated on
 * its own. Inline comments we can and do delete, which is where the real clutter
 * accumulates across re-reviews.
 *
 * Every failure here is swallowed. Tidying up is worth less than the review that
 * follows it.
 */
async function clearPrevious(deps: ReviewWorkflowDeps, ref: PullRef, log: WorkflowLogger): Promise<void> {
  try {
    const mine = await deps.github.listOwnReviews(ref);
    if (mine.length === 0) return;

    let dismissed = 0;
    for (const r of mine) {
      if (r.state !== "CHANGES_REQUESTED") continue;
      await deps.github.dismissReview(ref, r.id, "Superseded by a fresh Cavix review.");
      dismissed++;
    }
    const commentIds = await deps.github.listReviewCommentIds(ref, mine.map((r) => r.id));
    for (const id of commentIds) await deps.github.deleteReviewComment(ref, id);

    log.info("cleared the previous Cavix review", {
      repo: `${ref.owner}/${ref.repo}`,
      pr: ref.number,
      reviews_found: mine.length,
      dismissed,
      comments_deleted: commentIds.length,
    });
  } catch (err) {
    log.info("could not fully clear the previous review (continuing)", {
      repo: `${ref.owner}/${ref.repo}`,
      pr: ref.number,
      err: (err as Error).message,
    });
  }
}

/**
 * Should this review block the merge?
 *
 * Only ever when the owner switched blocking on. Two triggers, both theirs: a
 * failing pre-merge rule, or a finding at/above the severity they nominated.
 * Note that by this point the findings have already been through the sandbox —
 * so nothing that failed to reproduce can block anyone's merge.
 */
/**
 * A severity the gate knows how to rank, or the quietest one.
 *
 * Ledger entries carry their severity as a plain string, because they are
 * restored from a stored payload rather than produced by this process. An
 * unrecognised value must land on "info" and NOT on undefined: `SEVERITY_RANK`
 * of undefined is NaN, every comparison against it is false, and a carried
 * critical finding with a corrupted severity would silently stop blocking.
 */
function toSeverity(s: string): Severity {
  return s === "critical" || s === "high" || s === "medium" || s === "low" || s === "info" ? s : "info";
}

export function shouldRequestChanges(
  config: OrgReviewConfig,
  preMerge: PreMergeResult | undefined,
  severities: Severity[],
): boolean {
  if (!config.requestChangesOnFail) return false;
  if (preMerge && preMerge.failed > 0) return true;
  return countAtOrAbove(config, severities) > 0;
}

/**
 * How many of these severities reach the owner's blocking bar.
 *
 * Split out of `shouldRequestChanges` so the poster can be told where a block
 * came from without re-deriving `failOn` in a second place. Returns 0 when the
 * org nominated nothing recognisable, which is the same "nothing blocks"
 * answer the gate has always given.
 */
export function countAtOrAbove(config: OrgReviewConfig, severities: Severity[]): number {
  const bar = Math.min(
    ...config.failOn
      .map((s) => SEVERITY_RANK[s as Severity])
      .filter((n): n is number => typeof n === "number"),
  );
  if (!Number.isFinite(bar)) return 0;
  return severities.filter((s) => SEVERITY_RANK[s] >= bar).length;
}

/**
 * Swap a retired model for one the org's key can actually call, and persist it.
 * Returns the new model id, or "" if we could not determine a replacement (in
 * which case the caller reports the original failure).
 */
/** The model id the provider rejected, parsed out of its error message. */
export function deadModelFrom(failure: string): string {
  return (
    /models\/([\w.\-]+)/.exec(failure)?.[1] ??
    /`([\w.\-]+)`/.exec(failure)?.[1] ??
    /model[:\s]+"?([\w.\-]{3,})"?/i.exec(failure)?.[1] ??
    ""
  );
}

/**
 * Candidates to try when the saved model is rejected, best first.
 *
 * The failed model is EXCLUDED even though the provider still lists it. Google's
 * models.list is a global catalogue, not a per-key entitlement check: it happily
 * returns `gemini-2.5-flash` while generateContent 404s it for keys created after
 * the cutoff. Leaving it in made the ranker return the dead model as its own
 * replacement, so healing silently gave up — which is exactly what happened.
 */
async function healCandidates(deps: ReviewWorkflowDeps, org: string, failure: string): Promise<string[]> {
  if (!deps.suggestModels) return [];
  try {
    const available = await deps.suggestModels(org);
    const dead = deadModelFrom(failure).toLowerCase();
    const usable = available.filter((m) => m.toLowerCase() !== dead);
    return rankModels(dead, usable);
  } catch {
    // Healing is a best-effort recovery. If we cannot even find out what this key
    // can call, fall back to reporting the ORIGINAL failure — never replace a
    // clear provider error with an unrelated "control-plane unreachable".
    return [];
  }
}

/**
 * The client for the host this job came from.
 *
 * Returns null when the job names a platform this deployment has no client for,
 * which is a refusal and not a fallback: reviewing a GitLab merge request
 * through a GitHub client would call the wrong API against the wrong repository.
 */
export function clientFor(deps: ReviewWorkflowDeps, job: ReviewJob): ReviewPlatform | null {
  const want = platformOf(job);
  if (want === deps.github.platform) return deps.github;
  return deps.platforms?.[want] ?? null;
}

/** Wrap runReview as a WorkflowEngine handler (fire-and-forget per job). */
export function makeReviewHandler(deps: ReviewWorkflowDeps): ReviewHandler {
  const log = deps.logger ?? noopLogger;
  const metrics = deps.metrics ?? NOOP_RECORDER;
  return async (rawJob: ReviewJob) => {
    const job = rawJob;
    const ref = refFromJob(job);

    // Which host is this? Resolved before anything is fetched or posted, so a
    // job for a platform this deployment cannot talk to never reaches an API.
    const client = clientFor(deps, job);
    if (!client) {
      // Nothing to say it on: without a client there is no way to comment on the
      // merge request either. The log is the only honest channel left.
      log.error("no client for this platform; the job was dropped", {
        repo: job.repo,
        pr: job.pr_number,
        platform: platformOf(job),
        fix: "configure a client for this platform on the orchestrator, or stop sending its webhooks",
      });
      return;
    }
    // Every step below, and runReview itself, works through this one client.
    deps = client === deps.github ? deps : { ...deps, github: client };

    // Acknowledge FIRST, before the gate or any model call, so the person who
    // typed the command sees 👀 within seconds.
    await react(deps, job, ref, "eyes");

    let org: string | undefined;
    if (deps.gate) {
      // The pull request number goes with it, so one call answers both the
      // workspace's daily allowance and THIS pull request's own. A pull request
      // pushed to thirty times used to spend a free workspace's entire day, and
      // the customer experienced that as Cavix going down on repositories that
      // had nothing to do with it.
      const decision = await deps.gate(job.repo, job.pr_number);
      org = decision.org;
      if (!decision.enabled) {
        metrics.review("skipped");
        log.info("skipped by the gate", {
          repo: job.repo,
          pr: job.pr_number,
          reason: decision.reason ?? "repository not enabled in the dashboard",
          ...(decision.capReached ? { cap_reached: true } : {}),
        });
        await react(deps, job, ref, "+1");
        // The pull request has spent its reviews.
        //
        // Note what does NOT happen here: the check run is not touched. It is
        // not created, not closed, not turned neutral. Whatever the last review
        // concluded still stands, which is the only safe behaviour — if running
        // out of budget could turn a red check green, exhausting the quota would
        // be a way to merge past an open finding and the limit would be a
        // bypass rather than a limit.
        //
        // Said on every trigger, not only a typed command: a push that silently
        // does nothing is indistinguishable from Cavix being broken.
        if (decision.capReached) {
          await say(
            deps,
            job,
            ref,
            `**Cavix has stopped reviewing this pull request.**\n\n${decision.reason ?? ""}`.trim(),
          );
          return;
        }
        if (isCommandJob(job)) {
          // Two different situations, two different messages. Telling someone
          // whose workspace is over quota to "turn the repo on" sends them to a
          // settings page where the toggle is already green.
          await say(
            deps,
            job,
            ref,
            decision.reason
              ? `**Cavix did not review this pull request.**\n\n${decision.reason}`
              : `**Cavix is not enabled for \`${job.repo}\`.**\n\n` +
                  "Turn it on in the Cavix dashboard under **Repositories**, then comment " +
                  "`@cavixcode review` again.",
          );
        }
        return;
      }
    }

    // May this person tell Cavix what to do?
    //
    // On GitHub the edge already decided, from the association GitHub sends, and
    // this answers true without a request. No other platform sends that: a
    // GitLab note webhook says who commented and nothing about what they may do,
    // so without this any account that can see a merge request could spend a
    // customer's model budget by typing "@cavixcode review" in a loop.
    //
    // Checked BEFORE dispatch, so even the commands that cost nothing (help,
    // pause) cannot be driven by a passer-by.
    if (isCommandJob(job)) {
      const allowed = await client.commandsAllowed(ref, job.author ?? "");
      if (!allowed) {
        log.info("command refused: the author cannot push to this repository", {
          repo: job.repo,
          pr: job.pr_number,
          platform: client.platform,
          author: job.author,
          command: job.command,
        });
        await react(deps, job, ref, "+1");
        await say(
          deps,
          job,
          ref,
          "**Cavix only takes commands from people who can push to this repository.**\n\n" +
            "Ask someone with Developer access or above to run it, or ask them to grant you access.",
        );
        return;
      }
    }

    // What did this trigger actually ask for? Seven of the eight commands are
    // repository operations that must never reach a model, and until this
    // dispatch existed every one of them ran a full, billable review: typing
    // "@cavixcode help" posted a review, and "@cavixcode pause" started one.
    let dispatch: Dispatch;
    try {
      dispatch = await dispatchCommand(job, ref, {
        github: deps.github,
        say: (body) => say(deps, job, ref, body),
        logger: log,
        ...(deps.answer ? { ask: (q: string) => deps.answer!(job, ref, org ?? job.org, q) } : {}),
        ...(deps.ledger
          ? {
              clearLedger: () =>
                clearLedger(deps, { org: org ?? job.org, repo: job.repo, pr: job.pr_number }),
            }
          : {}),
      });
    } catch (err) {
      log.error("command failed", { repo: job.repo, pr: job.pr_number, command: job.command, err: (err as Error).message });
      await react(deps, job, ref, "confused");
      return;
    }
    if (!dispatch.review) {
      log.info("command handled without a review", { repo: job.repo, pr: job.pr_number, command: job.command });
      await react(deps, job, ref, "rocket");
      return;
    }

    // Automatic triggers, and only automatic ones, answer to the owner's
    // auto-review and draft settings and to a pause someone set on this PR. An
    // explicit "@cavixcode review" always runs: a human asking for a review by
    // name is a clearer signal than any default.
    if (isAutomatic(job)) {
      const skip = await shouldSkipAutomatic(deps, ref, org ?? job.org, log);
      if (skip !== "") {
        log.info(`skipped: ${skip}`, { repo: job.repo, pr: job.pr_number });
        return;
      }
    }

    // One check run for the whole job, handed to every attempt. A self-heal
    // retries the review against a different model, and without this each retry
    // would open its own row: the PR would end up with three Cavix checks, two of
    // them spinning until GitHub times them out.
    const check = new ReviewCheck(deps.github, log);
    const modes = { mode: dispatch.mode, fresh: dispatch.fresh };

    let healedTo = "";
    try {
      let outcome;
      try {
        outcome = await runReview(job, deps, { org, check, ...modes });
      } catch (err) {
        // SELF-HEAL: providers retire models, so a model saved months ago can stop
        // working with no change on our side. Rather than fail and wait for a
        // human, switch to one this key can actually call and finish the review
        // now. Anything that is not a model problem still throws.
        if (!shouldTryAnotherModel((err as Error).message)) throw err;

        const orgId = org ?? job.org;
        // Try candidates in rank order: the provider's catalogue is global, so a
        // listed model may also turn out to be closed to this key. Bounded, because
        // each attempt is a real (billable) call.
        const candidates = (await healCandidates(deps, orgId, (err as Error).message)).slice(0, MAX_HEAL_ATTEMPTS);
        let lastErr = err;
        for (const candidate of candidates) {
          try {
            outcome = await runReview(job, deps, { org, model: candidate, check, ...modes });
            healedTo = candidate;
            const saved = deps.saveModel ? await deps.saveModel(orgId, candidate) : false;
            log.info("auto-healed an unavailable model", {
              org: orgId, from: deadModelFrom((err as Error).message), to: candidate, persisted: saved,
            });
            break;
          } catch (retryErr) {
            lastErr = retryErr;
            // Keep walking only while the reason is model-specific. A real rate
            // limit or a bad key affects every candidate equally, so stop there
            // rather than burning quota proving it.
            if (!shouldTryAnotherModel((retryErr as Error).message)) throw retryErr;
            log.info("healing candidate unusable for this key, trying the next", {
              org: orgId, candidate, err: (retryErr as Error).message.slice(0, 120),
            });
          }
        }
        if (!outcome) throw lastErr;
      }
      await react(deps, job, ref, "rocket");
      if (healedTo && isCommandJob(job)) {
        await say(
          deps,
          job,
          ref,
          `**Review posted.** The model this workspace had saved is no longer available from your ` +
            `provider, so Cavix switched to \`${healedTo}\` and carried on. Change it any time under ` +
            `**AI & BYOK**.`,
        );
      }
      // "job complete" for a job that never ran is the log line that hides a
      // wedged pull request: every field reads like a successful empty review.
      if (outcome.skipped) {
        // Counted, not silent. Without this the throughput counter under-reports
        // every coalesced duplicate and every deferral, so a pull request that
        // stopped being reviewed looks identical to one nobody pushed to.
        metrics.review("skipped");
        log.info("job skipped", { repo: job.repo, pr: job.pr_number, why: outcome.skipped });
        return;
      }
      log.info("job complete", {
        repo: job.repo,
        pr: job.pr_number,
        findings: outcome.findingCount,
        // Both reported, because "0 findings" on its own is the log line that
        // used to hide the bug: a review that found nothing new on a pull
        // request with two open findings looked identical to a clean one.
        carried: outcome.carriedCount,
        resolved: outcome.resolvedCount,
        blocked: outcome.blocked,
        verified: outcome.verifiedCount,
        suppressed: outcome.suppressedCount,
        description_updated: outcome.descriptionUpdated,
        recorded: outcome.recorded,
        url: outcome.posted.htmlUrl,
        check_run: outcome.checkRunId,
        ...(healedTo ? { healed_model: healedTo } : {}),
      });
    } catch (err) {
      const message = (err as Error).message;
      const permanent = isPermanentFailure(message);
      metrics.review("failed");
      // Give the slot back. Without this a failed review holds this pull request
      // for the whole stale window, so the retry that would have fixed it is
      // turned away as a duplicate and the pull request silently stops being
      // reviewed. Keyed on the commit, so a newer review that superseded this
      // one keeps its claim.
      if (deps.runs && ref.headSha) {
        await deps.runs.failForHead(
          { org: org ?? job.org, repo: job.repo, pr: job.pr_number },
          ref.headSha,
          message,
        );
      }
      log.error("review failed", {
        repo: job.repo,
        pr: job.pr_number,
        permanent,
        retrying: !permanent,
        err: message,
      });
      await react(deps, job, ref, "confused");

      // Close the check run rather than leaving a spinner on the PR forever.
      //
      // NEUTRAL, not failure. GitHub counts neutral as passing for a required
      // check, and that is the point: Cavix being unable to run is our problem,
      // not a reason to freeze somebody's merges. A red cross here would mean an
      // expired API key silently blocks every merge in the org. The title says
      // plainly that no review happened, so nobody mistakes it for a pass.
      await check.finish(
        ref,
        "neutral",
        "Review could not be completed",
        `${explain(message)}\n\n<details><summary>Technical detail</summary>\n\n\`\`\`\n${cleanUp(message)}\n\`\`\`\n\n</details>`,
      );

      if (isCommandJob(job)) {
        // A retired model is the one failure where we can name the fix exactly,
        // so fetch the org's real options instead of pointing at the dashboard.
        let extra = "";
        if (isModelUnavailable(message) && deps.suggestModels) {
          try {
            const all = await deps.suggestModels(org ?? job.org);
            const dead = deadModelFrom(message).toLowerCase();
            // Never suggest the model that just failed — it is still in the
            // provider's catalogue, but it demonstrably does not work here.
            extra = renderSuggestions(all.filter((mm) => mm.toLowerCase() !== dead));
          } catch {
            /* diagnostics only — never turn this into a second failure */
          }
        }
        await say(
          deps,
          job,
          ref,
          `**Cavix could not finish this review.**\n\n${explain(message)}${extra}\n\n` +
            `<details><summary>Technical detail</summary>\n\n\`\`\`\n${cleanUp(message)}\n\`\`\`\n\n</details>`,
        );
      }
      // Permanent faults are reported and closed out. Rethrowing would make the
      // queue retry twice more, re-running the same doomed call and (before the
      // status comment became an edit) posting the same message three times.
      if (permanent) return;
      throw err; // transient: let the engine retry with backoff
    }
  };
}

/**
 * Providers return their error as a wall of raw JSON. Pull the human sentence out
 * of it so the PR shows one readable line instead of a truncated blob.
 */
export function cleanUp(message: string): string {
  const jsonStart = message.indexOf("{");
  if (jsonStart === -1) return message.slice(0, 400);

  const prefix = message.slice(0, jsonStart).trim();
  const blob = message.slice(jsonStart);

  const finish = (inner: string) =>
    // Keep the first line only: the rest is quota tables and doc links.
    `${prefix} ${inner.split("\\n")[0].split("\n")[0].trim()}`.trim().slice(0, 400);

  try {
    const parsed = JSON.parse(blob) as { error?: { message?: string } | string };
    const inner = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (inner) return finish(inner);
  } catch {
    // Very often the blob is TRUNCATED (we cap provider errors at 500 chars), so
    // it will never parse. Pull the message field out textually instead — that is
    // the whole point of this function, and the truncated case is the common one.
    const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(blob);
    if (m) return finish(m[1]);
  }
  return message.slice(0, 400);
}

/**
 * Did the provider reject the MODEL (retired, gated, or misspelled) rather than
 * the request?
 *
 * Deliberately scoped to provider-prefixed errors: GitHub also returns 404, and
 * conflating the two once told a user their App was not installed when really
 * their Gemini model had been retired.
 */
export function isModelUnavailable(message: string): boolean {
  if (/^github:/.test(message)) return false;
  if (!/^(google|openai|anthropic|selfhosted):/.test(message)) return false;
  return (
    /HTTP 404/.test(message) ||
    /no longer available|does not exist|not found|NOT_FOUND|unknown model|invalid model/i.test(message)
  );
}

/**
 * Does this model have NO quota at all for this key, as opposed to the key
 * having gone too fast?
 *
 * `limit: 0` is granted PER MODEL, not per account: a free Gemini key can hold
 * 20 requests/day on 2.5-flash and exactly 0 on 2.5-pro. So this is not a
 * "wait and retry" condition, it means this particular model is unusable here
 * and healing should move on to the next candidate. A normal 429 (a real rate
 * limit) does apply account-wide and must stop the walk.
 */
export function isZeroQuota(message: string): boolean {
  return /limit:\s*0\b/.test(message) || /quota.*\blimit\W+0\b/i.test(message);
}

/** Reasons to try a different model rather than give up. */
function shouldTryAnotherModel(message: string): boolean {
  return isModelUnavailable(message) || isZeroQuota(message);
}

/**
 * Turn the failure into something a non-engineer can act on. These are the
 * misconfigurations that actually happen in practice.
 */
function explain(message: string): string {
  if (/is not available/i.test(message)) {
    return (
      "The AI provider selected for this workspace is not enabled on this Cavix deployment. " +
      "Pick one of the listed providers in the dashboard under **AI & BYOK**, then comment " +
      "`@cavixcode review` again."
    );
  }
  if (/api key is empty|BYOK/i.test(message)) {
    return "It looks like this workspace has no AI key saved. Add one in the dashboard under **AI & BYOK**.";
  }
  if (/google: HTTP 400|API_KEY_INVALID|api key not valid/i.test(message)) {
    return "Google rejected the API key. Check the key saved under **AI & BYOK** is a valid Gemini API key from Google AI Studio.";
  }
  if (/HTTP 429|quota|rate.?limit/i.test(message)) {
    // "limit: 0" means the key has no free-tier allowance for that model at all,
    // which is a different problem from "you are going too fast".
    if (/limit:\s*0\b/.test(message)) {
      return (
        "Your Google API key has **no quota for this model** (the free tier reports `limit: 0`), so waiting will not help. " +
        "Either enable billing on the Google Cloud project behind the key, or switch to a model your key can use, " +
        "under **AI & BYOK** in the dashboard. `gemini-2.5-flash` has the most generous free allowance."
      );
    }
    return "Your AI provider rate-limited you or ran out of quota. Wait a minute, or check the quota and billing on your provider account, then comment `@cavixcode review` again.";
  }
  if (/returned no content/i.test(message)) {
    return "The model returned nothing, usually a safety filter on the diff. Try `@cavixcode review` again, or switch model under **AI & BYOK**.";
  }
  if (/declined to review/i.test(message)) {
    // Reported honestly instead of being dressed up as a clean pass. A refusal
    // with a green check beside it is worse than no review at all, because the
    // green check is what somebody merges on.
    return (
      "**The model refused to review this change**, so Cavix has not reported a result. " +
      "It did not find zero problems; it did not look.\n\n" +
      "This is almost always the model, not the code. Smaller or instruction-tuned models " +
      "sometimes answer a review request with a question instead of following the output format. " +
      "Switch to a stronger model under **AI & BYOK** in the dashboard, then comment " +
      "`@cavixcode review` again."
    );
  }
  if (isModelUnavailable(message)) {
    return (
      "The AI model saved for this workspace is not available to your API key. Providers retire models and " +
      "restrict others to existing users, so a model that worked before can stop working. " +
      "Open **AI & BYOK** in the dashboard and pick a model from the list, it now shows only the models your " +
      "key can actually call."
    );
  }
  if (/installation token|static token is empty|installation id/i.test(message)) {
    return "That is a GitHub App credential problem. Check `CAVIX_APP_ID` and `CAVIX_APP_PRIVATE_KEY` on the orchestrator service, and that the Cavix App is installed on this repository.";
  }
  if (/^github:/.test(message) && /HTTP 401|HTTP 403/.test(message)) {
    return "Cavix was not allowed to read or write on this repository. Re-check the App's permissions (Pull requests: Read & write, Contents: Read).";
  }
  if (/^github:/.test(message) && /HTTP 404/.test(message)) {
    return "Cavix could not see that pull request. The App may not be installed on this repository.";
  }
  if (/HTTP 401|HTTP 403/.test(message)) {
    return "Your AI provider rejected the API key. Re-paste it under **AI & BYOK** in the dashboard.";
  }
  return "Check the orchestrator service logs for the full error.";
}
