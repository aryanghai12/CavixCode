import type { ReviewJob } from "@cavix/core";

// The WorkflowEngine port. Stage 1 must be durable: survive restarts, retry
// transient failures, and run work off the request path. We program the review
// against THIS interface, not a specific broker, so the production swap to
// Temporal is a single new implementation with zero changes to the workflow,
// the reviewer, or the poster.
//
// Two implementations ship in Phase 0:
//   - InlineEngine: runs synchronously in-process (tests, eval, demo).
//   - BullMqEngine: Redis-backed durable queue with retries/backoff (MVP).
// TemporalEngine will implement the same three methods later.

export type ReviewHandler = (job: ReviewJob) => Promise<void>;

export interface SubmitResult {
  id: string;
}

export interface WorkflowEngine {
  /** Set the function that processes each job. Call before submit/run. */
  registerWorker(handler: ReviewHandler): void;
  /** Durably enqueue a job for processing. */
  submit(job: ReviewJob): Promise<SubmitResult>;
  /** Release resources (connections, workers). */
  close(): Promise<void>;
}

export interface EngineLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
