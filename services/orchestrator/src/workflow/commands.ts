import { isCommandJob, type ReviewJob } from "@cavix/core";
import type { ReviewPlatform, PullRef } from "../github/client.ts";

// What "@cavixcode <something>" actually does.
//
// The Go edge recognises eight commands and turns every one of them into a job on
// the queue. For a long time the orchestrator did not look at `job.command` at
// all, so all eight ran a complete review: typing "@cavixcode help" made a
// frontier-model call, ran the sandbox and posted a full review comment, and
// "@cavixcode pause" did the exact opposite of pausing. This module is the
// missing dispatch.
//
// Only two commands are worth a model call:
//   review   the whole thing
//   summary  the model reads the diff, but only the description is rewritten
//   ask      one question, answered in prose, no findings
// The rest are pure repository operations and cost nothing.

/** The canonical command names the edge emits (see edge/internal/webhook/command.go). */
export type CommandName =
  | "review"
  | "summary"
  | "ask"
  | "resolve"
  | "pause"
  | "resume"
  | "help"
  | "configure";

/**
 * Hidden marker that means "a human asked Cavix to stop reviewing this PR".
 *
 * The pause lives in a comment on the pull request rather than in a database.
 * That is deliberate: the orchestrator is a restartable, horizontally scaled
 * worker, so anything held in its memory is lost on the next deploy and invisible
 * to its siblings. GitHub is already the shared, durable store both of them can
 * see, and a reader can tell the PR is paused by looking at it.
 */
export const PAUSED_MARKER = "<!-- cavix:paused -->";

/** Cavix's own status comment, which carries the pause marker when set. */
export const STATUS_MARKER = "<!-- cavix:status -->";

/** How runReview should behave for this trigger. */
export type ReviewMode = "full" | "summary";

export interface Dispatch {
  /** Run a review? False means this command was fully handled without one. */
  review: boolean;
  /** Full review, or refresh the description summary only. */
  mode: ReviewMode;
  /** Discard stale Cavix reviews and inline comments before posting. */
  fresh: boolean;
}

const REVIEW_DISPATCH: Dispatch = { review: true, mode: "full", fresh: false };

/**
 * Is this an automatic (pull_request) trigger rather than something a human
 * typed? Those are the ones the auto-review and draft settings can suppress.
 */
export function isAutomatic(job: ReviewJob): boolean {
  return !isCommandJob(job);
}

export function commandOf(job: ReviewJob): CommandName | null {
  if (!isCommandJob(job)) return null;
  const name = (job.command ?? "").toLowerCase();
  return name === "" ? "help" : (name as CommandName);
}

export interface CommandDeps {
  github: ReviewPlatform;
  /** Answer a free-text question about the PR. Absent = "ask" replies politely. */
  ask?: (question: string) => Promise<string>;
  /** Post or edit Cavix's single status comment on the PR. */
  say: (body: string) => Promise<void>;
  logger?: { info(msg: string, meta?: Record<string, unknown>): void };
}

/**
 * Handle everything that is not a review, and say what the caller should do next.
 *
 * Returns `review: false` when the command is already dealt with, so the caller
 * never reaches the model. That is the whole point: seven of the eight commands
 * should cost nothing.
 */
export async function dispatchCommand(
  job: ReviewJob,
  ref: PullRef,
  deps: CommandDeps,
): Promise<Dispatch> {
  const command = commandOf(job);
  if (command === null) return REVIEW_DISPATCH; // an automatic pull_request job

  switch (command) {
    case "review":
      // An explicit re-review always starts clean, and always overrides a pause:
      // asking for a review is the clearest possible statement of intent.
      await setPaused(deps, ref, false);
      return { review: true, mode: "full", fresh: true };

    case "summary":
      return { review: true, mode: "summary", fresh: false };

    case "ask":
      await answer(job, deps);
      return noReview();

    case "resolve":
      await resolve(deps, ref);
      return noReview();

    case "pause":
      await setPaused(deps, ref, true);
      return noReview();

    case "resume":
      await setPaused(deps, ref, false);
      return noReview();

    case "configure":
      await deps.say(
        "**Cavix is configured from the dashboard**, not from a pull request comment.\n\n" +
          "Open **Review settings** to change what the review includes, its tone, which " +
          "paths are reviewed, and whether Cavix may request changes. Changes apply to " +
          "the next review, with no redeploy.",
      );
      return noReview();

    case "help":
    default:
      await deps.say(HELP);
      return noReview();
  }
}

function noReview(): Dispatch {
  return { review: false, mode: "full", fresh: false };
}

/**
 * Clear what Cavix left behind: dismiss its blocking reviews and delete its
 * inline comments.
 *
 * What GitHub allows here is narrower than it looks, and the message says so
 * rather than implying a clean slate. A review in CHANGES_REQUESTED state can be
 * dismissed, which is the case that matters because that is the one holding up
 * the merge button. A plain COMMENTED review can be neither dismissed nor
 * deleted through the API by anyone, including its author.
 */
async function resolve(deps: CommandDeps, ref: PullRef): Promise<void> {
  const mine = await deps.github.listOwnReviews(ref);
  const blocking = mine.filter((r) => r.state === "CHANGES_REQUESTED");
  for (const r of blocking) {
    await deps.github.dismissReview(ref, r.id, "Resolved on request by a reviewer.");
  }
  const commentIds = await deps.github.listReviewCommentIds(ref, mine.map((r) => r.id));
  for (const id of commentIds) await deps.github.deleteReviewComment(ref, id);

  deps.logger?.info("resolved Cavix's own review artifacts", {
    repo: `${ref.owner}/${ref.repo}`,
    pr: ref.number,
    dismissed: blocking.length,
    comments_deleted: commentIds.length,
  });

  const parts: string[] = [];
  if (blocking.length > 0) parts.push(`dismissed ${plural(blocking.length, "blocking review")}`);
  if (commentIds.length > 0) parts.push(`removed ${plural(commentIds.length, "inline comment")}`);
  await deps.say(
    parts.length > 0
      ? `**Resolved.** Cavix ${parts.join(" and ")}. Comment \`@cavixcode review\` for a fresh look.`
      : "**Nothing to resolve.** Cavix has no blocking review or inline comments left on this pull request.",
  );
}

async function answer(job: ReviewJob, deps: CommandDeps): Promise<void> {
  const question = (job.command_args ?? "").trim();
  if (question === "") {
    await deps.say(HELP);
    return;
  }
  if (!deps.ask) {
    await deps.say(
      "**Questions are not enabled on this deployment.** Comment `@cavixcode review` for a full review.",
    );
    return;
  }
  const reply = await deps.ask(question);
  await deps.say(`> ${question.replace(/\r?\n/g, "\n> ")}\n\n${reply}`);
}

/**
 * Set or clear the pause, by rewriting Cavix's status comment.
 *
 * The marker and the sentence explaining it are written in ONE call, not a set
 * followed by a say(). say() edits the status comment in place, so a second call
 * would immediately overwrite the marker it had just written and the pause would
 * silently not take.
 *
 * Idempotent in both directions, because a human can type `pause` twice and a
 * queue can deliver the same command twice.
 */
async function setPaused(deps: CommandDeps, ref: PullRef, paused: boolean): Promise<void> {
  if (paused) {
    const existing = await deps.github.findComment(ref, STATUS_MARKER);
    const body =
      `${STATUS_MARKER}\n${PAUSED_MARKER}\n` +
      "**Cavix is paused on this pull request.** It will not review new pushes here until " +
      "someone comments `@cavixcode resume`. An explicit `@cavixcode review` still runs.";
    if (existing) await deps.github.updateComment(ref, existing.id, body);
    else await deps.github.createComment(ref, body);
    return;
  }
  // Clearing looks for the PAUSE marker, not the status comment. Every
  // "@cavixcode review" clears the pause, and almost none of them were paused,
  // so keying off the status comment would rewrite it on every single review for
  // no reason. Nothing paused means nothing to do.
  const wasPaused = await deps.github.findComment(ref, PAUSED_MARKER);
  if (!wasPaused) return;
  await deps.github.updateComment(
    ref,
    wasPaused.id,
    `${STATUS_MARKER}\n**Cavix is active on this pull request.** It will review the next push.`,
  );
}

/** Has someone paused Cavix on this pull request? */
export async function isPaused(github: ReviewPlatform, ref: PullRef): Promise<boolean> {
  try {
    return (await github.findComment(ref, PAUSED_MARKER)) !== null;
  } catch {
    // A failed lookup must not silently mean "paused": that would turn one API
    // blip into a pull request Cavix quietly stops reviewing.
    return false;
  }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

const HELP = `### ◈ Cavix

Mention Cavix on any pull request to run one of these.

| Command | What it does |
| :--- | :--- |
| \`@cavixcode review\` | Full review of the current head. Clears Cavix's earlier comments first, and un-pauses. |
| \`@cavixcode summary\` | Rewrites just the summary in the pull request description. No findings, no inline comments. |
| \`@cavixcode <question>\` | Answers a question about this change, for example \`@cavixcode does this handle a webhook retry?\` |
| \`@cavixcode resolve\` | Dismisses Cavix's blocking review and removes its inline comments. |
| \`@cavixcode pause\` | Stops automatic reviews on this pull request. |
| \`@cavixcode resume\` | Starts them again. |
| \`@cavixcode configure\` | Where the settings live. |
| \`@cavixcode help\` | This table. |

<sub>Only people with write access to the repository can run these. Everything else is configured from the Cavix dashboard under **Review settings**.</sub>`;
