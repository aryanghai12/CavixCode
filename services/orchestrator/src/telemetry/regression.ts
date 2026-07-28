import type { Finding } from "@cavix/core";
import { InMemoryTelemetryStore, type BuildTrend } from "@cavix/telemetry";
import type { PullRef } from "../github/client.ts";
import type { CiStore } from "./ingest.ts";

// Stage 6, half two: warning before merge that a pipeline is degrading.
//
// The roadmap calls this the one genuinely empty lane in the competitive set,
// and the reason is that static analysis sees the code and not its consequences.
// A change can be correct, well-tested, well-reviewed, and still be the one that
// takes the build from four minutes to nine. Nobody notices for a month, and by
// then nobody can say which change did it.
//
// ── what this does NOT claim ─────────────────────────────────────────────────
//
// It does not say this pull request caused the slowdown. It cannot: the trend is
// measured on the default branch, over runs that finished before this branch
// existed. What it says is that the pipeline this change is about to join has
// been getting slower, with the numbers, at the moment somebody is already
// looking. That is a true statement and a useful one. Claiming causation from
// the same data would be neither.

/** A pipeline has to slow by this much before it is worth a reviewer's time. */
const MIN_CHANGE_PCT = 20;

/** Below this, a difference is runner noise rather than a trend. */
const MIN_ABSOLUTE_MS = 30_000;

/** Recent failure share above this is worth saying out loud. */
const FLAKY_PIPELINE_RATE = 0.3;

export interface RegressionResult {
  findings: Finding[];
  /** Runs the prediction was computed over. Feeds the Scope module. */
  runsAnalysed: number;
  workflows: number;
}

export type RegressionStep = (input: { org: string; ref: PullRef }) => Promise<RegressionResult>;

export interface RegressionOptions {
  store: CiStore;
  logger?: { info(msg: string, meta?: Record<string, unknown>): void };
}

export function makeRegressionStep(opts: RegressionOptions): RegressionStep {
  return async ({ org, ref }) => {
    const repo = `${ref.owner}/${ref.repo}`;
    const { runs } = await opts.store.load(org);
    const mine = runs.filter((r) => r.repo === repo);
    if (mine.length === 0) return { findings: [], runsAnalysed: 0, workflows: 0 };

    const store = new InMemoryTelemetryStore();
    for (const r of mine) store.recordBuild(r);

    const workflows = store.workflows(repo);
    const findings: Finding[] = [];
    for (const workflow of workflows) {
      const trend = store.buildTrend(repo, workflow);
      if (!trend) continue; // not enough history to say anything

      // A pipeline with no successful recent runs has no duration to compare,
      // and is also the one most worth warning about, so the failure check has
      // to be reachable without a measurable slowdown.
      const measurable =
        trend.changePct !== null && trend.recentMeanMs !== null && trend.baselineMeanMs !== null;
      const slower =
        measurable &&
        trend.changePct! >= MIN_CHANGE_PCT &&
        trend.recentMeanMs! - trend.baselineMeanMs! >= MIN_ABSOLUTE_MS;

      if (slower) findings.push(slowdownFinding(trend));
      else if (trend.failureRate >= FLAKY_PIPELINE_RATE) findings.push(unreliableFinding(trend));
    }

    if (findings.length > 0) {
      opts.logger?.info("CI telemetry raised a warning", {
        repo,
        runs: mine.length,
        workflows: workflows.length,
        findings: findings.length,
      });
    }
    return { findings, runsAnalysed: mine.length, workflows: workflows.length };
  };
}

/** Only called once `measurable` has established both means are present. */
function slowdownFinding(t: BuildTrend): Finding {
  const recent = t.recentMeanMs!;
  const baseline = t.baselineMeanMs!;
  const changePct = t.changePct!;
  return {
    // Anchored to the workflow file, which is where somebody would go to do
    // something about it. It is off the diff, so the detail lands in the review
    // comment's dropdown rather than as an inline comment on unrelated code.
    path: `.github/workflows/${slug(t.workflow)}.yml`,
    line: 1,
    severity: changePct >= 50 ? "medium" : "low",
    category: "performance",
    title: `CI pipeline "${t.workflow}" is ${Math.round(changePct)}% slower than it was`,
    body: [
      `The last ${t.recentRuns} runs of **${t.workflow}** averaged **${duration(recent)}**, against ` +
        `**${duration(baseline)}** across the ${t.baselineRuns} before them. That is ` +
        `${duration(recent - baseline)} added to every run.`,
      "",
      `This is not a claim about this pull request. The measurement is on the default branch, over runs that ` +
        `finished before this branch existed. It is here because you are already looking at this pipeline, and ` +
        `because a slowdown that nobody attributes to anything is one nobody ever fixes.`,
      "",
      `<sub>Measured from completed GitHub Actions runs. Cancelled and timed-out runs are excluded: both are ` +
        `fast or slow for reasons that have nothing to do with the code.</sub>`,
    ].join("\n"),
    source: "telemetry",
    // Measured, not inferred. The uncertainty is whether a reviewer can act on
    // it, not whether the numbers are real.
    confidence: 0.9,
  };
}

function unreliableFinding(t: BuildTrend): Finding {
  return {
    path: `.github/workflows/${slug(t.workflow)}.yml`,
    line: 1,
    severity: "low",
    category: "reliability",
    title: `CI pipeline "${t.workflow}" failed ${Math.round(t.failureRate * 100)}% of its recent runs`,
    body: [
      `${Math.round(t.failureRate * t.recentRuns)} of the last ${t.recentRuns} runs of **${t.workflow}** did not ` +
        `succeed. A pipeline that fails this often stops being a signal: people learn to re-run it, and a real ` +
        `failure gets re-run with the rest.`,
      "",
      `<sub>Measured from completed GitHub Actions runs on the default branch.</sub>`,
    ].join("\n"),
    source: "telemetry",
    confidence: 0.9,
  };
}

/** "4m 12s", or "38s" under a minute. Milliseconds help nobody read a trend. */
function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m}m` : `${m}m ${rest}s`;
}

/** A workflow's display name back to a plausible file name. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workflow";
}
