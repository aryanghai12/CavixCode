import type { ReviewJob } from "@cavix/core";
import type { WorkflowEngine, ReviewHandler, SubmitResult, EngineLogger } from "./engine.ts";

// InlineEngine runs the handler synchronously in the calling process, with the
// same retry/backoff semantics a durable broker would apply. It exists so the
// full review path is exercised in tests/eval/demo without a broker — and it
// makes the retry policy itself testable in isolation.

export interface InlineEngineOptions {
  /** Retries AFTER the first attempt. 2 → up to 3 total attempts. */
  retries?: number;
  /** Base backoff in ms; attempt N waits backoffMs * N. */
  backoffMs?: number;
  logger?: EngineLogger;
  /** Injectable sleep for deterministic tests (default: real timer). */
  sleep?: (ms: number) => Promise<void>;
}

const noopLogger: EngineLogger = { info() {}, error() {} };

export class InlineEngine implements WorkflowEngine {
  private handler: ReviewHandler | null = null;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly logger: EngineLogger;
  private readonly sleep: (ms: number) => Promise<void>;
  private seq = 0;

  constructor(opts: InlineEngineOptions = {}) {
    this.retries = opts.retries ?? 2;
    this.backoffMs = opts.backoffMs ?? 0;
    this.logger = opts.logger ?? noopLogger;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  registerWorker(handler: ReviewHandler): void {
    this.handler = handler;
  }

  async submit(job: ReviewJob): Promise<SubmitResult> {
    if (!this.handler) throw new Error("InlineEngine: no worker registered");
    const id = `inline-${++this.seq}`;
    const attempts = this.retries + 1;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.handler(job);
        return { id };
      } catch (err) {
        lastErr = err;
        this.logger.error("review attempt failed", {
          id,
          repo: job.repo,
          pr: job.pr_number,
          attempt,
          attempts,
          err: (err as Error).message,
        });
        if (attempt < attempts && this.backoffMs > 0) {
          await this.sleep(this.backoffMs * attempt);
        }
      }
    }
    // Exhausted: surface so the caller (or a dead-letter path) can record it.
    throw lastErr;
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
