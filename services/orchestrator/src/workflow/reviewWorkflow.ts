import { isCommandJob, type ReviewJob } from "@cavix/core";
import type { GitHubClient, PostedReview, PullRef } from "../github/client.ts";
import { refFromJob } from "../github/client.ts";
import type { Reviewer } from "../reviewer/reviewer.ts";
import { buildReviewSubmission } from "../poster/poster.ts";
import type { ReviewHandler } from "./engine.ts";
import { rankModels, renderSuggestions } from "../byok/models.ts";

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
}

export interface ReviewWorkflowDeps {
  github: GitHubClient;
  reviewer: Reviewer;
  logger?: WorkflowLogger;
  /** Execution gatekeeper: return enabled=false to skip (repo not toggled on). */
  gate?: (fullName: string) => Promise<GateDecision>;
  /**
   * Given an org, list the model ids its key can call. Used to enrich the failure
   * comment, and to self-heal when the saved model has been retired.
   */
  suggestModels?: (org: string) => Promise<string[]>;
  /** Persist an auto-selected model so the next review and the dashboard agree. */
  saveModel?: (org: string, model: string) => Promise<boolean>;
}

export interface ReviewOutcome {
  posted: PostedReview;
  summary: string;
  findingCount: number;
  inlineCount: number;
  offDiffCount: number;
  costUsd: number;
  model: string;
}

const noopLogger: WorkflowLogger = { info() {}, error() {} };

/**
 * React to the comment that triggered this job. Best-effort by design: a failed
 * reaction must never fail the review, and reactions only exist for command jobs.
 */
async function react(
  deps: ReviewWorkflowDeps,
  job: ReviewJob,
  ref: PullRef,
  content: Parameters<GitHubClient["addReaction"]>[2],
): Promise<void> {
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
 * Hidden marker identifying Cavix's own status comment on a PR. GitHub renders
 * HTML comments as nothing, so this is invisible to readers but lets us find the
 * comment again.
 */
const STATUS_MARKER = "<!-- cavix:status -->";

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
  ].some((re) => re.test(message));
}

/** Run the full review workflow for one job and return what was posted. */
export async function runReview(
  job: ReviewJob,
  deps: ReviewWorkflowDeps,
  overrides: { org?: string; model?: string } = {},
): Promise<ReviewOutcome> {
  const log = deps.logger ?? noopLogger;
  const ref = refFromJob(job);

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

  // Step 1 — fetch the diff.
  const diff = await deps.github.fetchPullDiff(ref);
  log.info("fetched diff", { ...base, bytes: diff.length });

  // Step 2 — single-model review pass through the BYOK gateway. The org id comes
  // from the gate (the dashboard workspace that enabled this repo), NOT from the
  // GitHub owner login — those are different names, and using the login meant the
  // org's saved API key was never found.
  const org = overrides.org || job.org;
  const result = await deps.reviewer.review({
    org,
    title: job.title,
    diff,
    // Explicit override: the gateway caches org config briefly, so a model we
    // just auto-healed to would otherwise lose to the stale cached value.
    ...(overrides.model ? { model: overrides.model } : {}),
  });
  log.info("review complete", {
    ...base,
    org,
    findings: result.findings.length,
    cost_usd: result.costUsd,
    model: result.model,
  });

  // Step 3 — synthesize and post the review.
  const built = buildReviewSubmission(result, diff);
  const posted = await deps.github.postReview(ref, built.submission);
  log.info("review posted", {
    ...base,
    review_id: posted.id,
    url: posted.htmlUrl,
    inline: built.inlineCount,
    off_diff: built.offDiffCount,
  });

  return {
    posted,
    summary: result.summary,
    findingCount: result.findings.length,
    inlineCount: built.inlineCount,
    offDiffCount: built.offDiffCount,
    costUsd: result.costUsd,
    model: result.model,
  };
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

/** Wrap runReview as a WorkflowEngine handler (fire-and-forget per job). */
export function makeReviewHandler(deps: ReviewWorkflowDeps): ReviewHandler {
  const log = deps.logger ?? noopLogger;
  return async (job: ReviewJob) => {
    const ref = refFromJob(job);

    // Acknowledge FIRST, before the gate or any model call, so the person who
    // typed the command sees 👀 within seconds.
    await react(deps, job, ref, "eyes");

    let org: string | undefined;
    if (deps.gate) {
      const decision = await deps.gate(job.repo);
      org = decision.org;
      if (!decision.enabled) {
        log.info("skipped: repository not enabled in the dashboard", { repo: job.repo, pr: job.pr_number });
        await react(deps, job, ref, "+1");
        if (isCommandJob(job)) {
          await say(
            deps,
            job,
            ref,
            `**Cavix is not enabled for \`${job.repo}\`.**\n\n` +
              "Turn it on in the Cavix dashboard under **Repositories**, then comment " +
              "`@cavixcode review` again.",
          );
        }
        return;
      }
    }

    let healedTo = "";
    try {
      let outcome;
      try {
        outcome = await runReview(job, deps, { org });
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
            outcome = await runReview(job, deps, { org, model: candidate });
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
      log.info("job complete", {
        repo: job.repo,
        pr: job.pr_number,
        findings: outcome.findingCount,
        url: outcome.posted.htmlUrl,
        ...(healedTo ? { healed_model: healedTo } : {}),
      });
    } catch (err) {
      const message = (err as Error).message;
      const permanent = isPermanentFailure(message);
      log.error("review failed", {
        repo: job.repo,
        pr: job.pr_number,
        permanent,
        retrying: !permanent,
        err: message,
      });
      await react(deps, job, ref, "confused");
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
