import { Registry, type Counter, type Gauge, type Histogram } from "./registry.ts";

// The metrics Cavix actually exposes, and the argument for each one.
//
// A metrics endpoint that exposes everything is a metrics endpoint nobody reads,
// so this is a short list and each entry has to answer a question an operator
// cannot answer today.
//
// WHAT IS DELIBERATELY NOT HERE
//
//   • Any label carrying a repository, organisation, path, branch, commit,
//     finding title or model id. Three of those are customer data in a store
//     that is scraped, retained for a year and usually less protected than the
//     database. All of them are unbounded, which is a cardinality outage in the
//     monitoring system. The per-customer view already exists and is the
//     dashboard, which is authenticated and scoped.
//   • Per-finding counters. That is the customer's question, not the operator's.
//   • A "reviews per org" gauge, however useful it sounds. It is the same leak
//     wearing a different hat.
//
// The rule: this endpoint answers "is Cavix healthy", never "what is customer X
// doing". If a metric would let a scraper reconstruct a customer's activity, it
// does not belong here.

export interface CavixMetrics {
  registry: Registry;

  /**
   * Reviews by outcome: posted, failed, skipped.
   *
   * The base rate. Everything else is a refinement of "is it working at all",
   * and a deployment whose `failed` line goes flat-to-vertical is the first
   * thing anyone wants to see.
   */
  reviews: Counter;

  /** End-to-end review latency. Answers "is it getting slower". */
  reviewDuration: Histogram;

  /**
   * Per-stage latency. Answers the question the review-level number cannot:
   * WHICH part got slower.
   *
   * A review that went from 40s to 90s tells an operator nothing actionable. The
   * same change attributed to `stage="verify"` tells them the sandbox host is
   * struggling, and to `stage="deep_review"` tells them a model provider is.
   */
  stageDuration: Histogram;

  /**
   * Stage failures, by stage.
   *
   * THE MOST IMPORTANT METRIC IN THIS FILE, and the reason the item exists.
   * Every stage in Cavix fails soft on purpose: a broken cross-repo graph, a
   * dead sandbox, an unreachable control-plane all degrade the review instead of
   * failing it. That is the right behaviour and it means a stage can be failing
   * one hundred per cent of the time for a week while every review still posts
   * and nothing anywhere says so. This is the only surface on which that is
   * visible.
   */
  stageFailures: Counter;

  /**
   * Jobs waiting on the stream. Answers "is it falling behind", which is not
   * derivable from latency: a queue can be an hour deep while every individual
   * review is fast.
   */
  queueDepth: Gauge;

  /** Model spend, so an operator sees a runaway before the invoice does. */
  modelCostUsd: Counter;

  /**
   * Findings by what happened to them: surfaced or suppressed.
   *
   * A proxy for whether verification is still doing its job. Cavix's entire
   * pitch is that it drops what it cannot reproduce, so `suppressed` going to
   * zero and staying there means verification has silently stopped running, and
   * the reviews still look fine.
   */
  findings: Counter;

  /** Always 1. Carries the version as a label, which is how Prometheus does it. */
  buildInfo: Gauge;
}

/** Stages that report timing and failures. A closed set: see the cardinality note. */
export type StageName =
  | "diff"
  | "config"
  | "deep_review"
  | "cross_repo"
  | "ci_telemetry"
  | "pre_merge"
  | "verify"
  | "description"
  | "post"
  | "record"
  | "retention"
  /**
   * Reconciling this review against what earlier reviews of the same pull
   * request left open.
   *
   * Worth its own name rather than folding into `record`, because the two fail
   * differently and only one of them is a correctness problem. A failed
   * `record` costs a dashboard row. A failed `pr_ledger` costs a merge gate its
   * memory: the review still posts, but its verdict is computed from one run of
   * a model instead of from everything still open, which is the shape of the
   * bug this stage exists to prevent.
   */
  | "pr_ledger";

export function createMetrics(version = "dev"): CavixMetrics {
  const registry = new Registry();
  const m: CavixMetrics = {
    registry,
    reviews: registry.counter("cavix_reviews_total", "Reviews by outcome (posted, failed, skipped)."),
    reviewDuration: registry.histogram("cavix_review_duration_seconds", "End-to-end review wall clock."),
    stageDuration: registry.histogram("cavix_stage_duration_seconds", "Per-stage wall clock."),
    stageFailures: registry.counter(
      "cavix_stage_failures_total",
      "Stages that failed and were degraded past. Every stage fails soft, so this is the only place a persistently broken one is visible.",
    ),
    queueDepth: registry.gauge("cavix_queue_depth", "Review jobs waiting on the stream."),
    modelCostUsd: registry.counter("cavix_model_cost_usd_total", "Model spend in USD across all reviews."),
    findings: registry.counter("cavix_findings_total", "Findings by outcome (surfaced, suppressed)."),
    buildInfo: registry.gauge("cavix_build_info", "Always 1. The version is the label."),
  };
  m.buildInfo.set(1, { version });
  return m;
}

/**
 * A metrics recorder that cannot throw.
 *
 * Every call site is on the review path, and a metric is worth strictly less
 * than the review it is measuring. Wrapping here rather than at each of the
 * dozen call sites means there is no call site that can forget.
 */
export interface Recorder {
  review(outcome: "posted" | "failed" | "skipped", seconds?: number): void;
  stage(stage: StageName, seconds: number): void;
  stageFailed(stage: StageName): void;
  cost(usd: number): void;
  finding(outcome: "surfaced" | "suppressed", count: number): void;
  queue(depth: number): void;
  /** The Prometheus text body, built only when something scrapes. */
  render(): string;
}

/** A recorder that does nothing, for tests and for metrics being switched off. */
export const NOOP_RECORDER: Recorder = {
  review() {},
  stage() {},
  stageFailed() {},
  cost() {},
  finding() {},
  queue() {},
  render: () => "",
};

export function makeRecorder(metrics: CavixMetrics): Recorder {
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* a metric never costs a review */
    }
  };
  return {
    review(outcome, seconds) {
      guard(() => {
        metrics.reviews.inc({ outcome });
        if (typeof seconds === "number") metrics.reviewDuration.observe(seconds);
      });
    },
    stage(stage, seconds) {
      guard(() => metrics.stageDuration.observe(seconds, { stage }));
    },
    stageFailed(stage) {
      guard(() => metrics.stageFailures.inc({ stage }));
    },
    cost(usd) {
      guard(() => metrics.modelCostUsd.inc({}, usd));
    },
    finding(outcome, count) {
      guard(() => metrics.findings.inc({ outcome }, count));
    },
    queue(depth) {
      guard(() => metrics.queueDepth.set(depth));
    },
    render() {
      try {
        return metrics.registry.render();
      } catch {
        return "";
      }
    },
  };
}

/**
 * Time an operation and record it, whether it succeeds or not.
 *
 * A failing stage's duration is still worth having: a verify step that takes
 * ninety seconds and then throws is a different problem from one that throws
 * immediately, and the histogram is the only place that difference shows.
 */
export async function timed<T>(rec: Recorder, stage: StageName, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } catch (err) {
    rec.stageFailed(stage);
    throw err;
  } finally {
    rec.stage(stage, (Date.now() - started) / 1000);
  }
}
