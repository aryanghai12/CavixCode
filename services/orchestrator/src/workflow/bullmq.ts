import type { ReviewJob } from "@cavix/core";
import type { WorkflowEngine, ReviewHandler, SubmitResult, EngineLogger } from "./engine.ts";

// BullMqEngine is the MVP durable backend: a Redis-backed queue with retries and
// exponential backoff. It implements the same WorkflowEngine port as InlineEngine
// and the future TemporalEngine.
//
// `bullmq` is an OPTIONAL dependency: the lightweight install (and all hermetic
// tests) do not need it. We therefore import it lazily through a non-literal
// specifier so the type checker never requires the package to be present; if an
// operator selects this backend without installing bullmq, construction fails
// with a clear, actionable error instead of a build break.

const BULLMQ = "bullmq";

interface MinimalQueue {
  add(name: string, data: unknown, opts?: unknown): Promise<{ id?: string }>;
  close(): Promise<void>;
}
interface MinimalWorker {
  close(): Promise<void>;
}
interface MinimalBullMq {
  Queue: new (name: string, opts: unknown) => MinimalQueue;
  Worker: new (
    name: string,
    processor: (job: { data: ReviewJob }) => Promise<void>,
    opts: unknown,
  ) => MinimalWorker;
}

export interface BullMqEngineOptions {
  /** Redis connection, e.g. { host: "localhost", port: 6379 }. */
  connection: { host: string; port: number };
  queueName?: string;
  retries?: number;
  backoffMs?: number;
  logger?: EngineLogger;
}

const noopLogger: EngineLogger = { info() {}, error() {} };

export class BullMqEngine implements WorkflowEngine {
  private readonly opts: BullMqEngineOptions;
  private readonly logger: EngineLogger;
  private queue: MinimalQueue | null = null;
  private worker: MinimalWorker | null = null;
  private handler: ReviewHandler | null = null;

  constructor(opts: BullMqEngineOptions) {
    this.opts = opts;
    this.logger = opts.logger ?? noopLogger;
  }

  private async lib(): Promise<MinimalBullMq> {
    try {
      return (await import(BULLMQ)) as unknown as MinimalBullMq;
    } catch {
      throw new Error(
        "BullMqEngine requires the optional dependency 'bullmq'. Install it (npm i bullmq) or use InlineEngine.",
      );
    }
  }

  private get queueName(): string {
    return this.opts.queueName ?? "cavix:reviews";
  }

  registerWorker(handler: ReviewHandler): void {
    this.handler = handler;
  }

  /** Start the worker that drains the queue. Call once after registerWorker. */
  async start(): Promise<void> {
    if (!this.handler) throw new Error("BullMqEngine: no worker registered");
    const { Worker } = await this.lib();
    const handler = this.handler;
    this.worker = new Worker(
      this.queueName,
      async (job: { data: ReviewJob }) => {
        await handler(job.data);
      },
      { connection: this.opts.connection },
    );
    this.logger.info("bullmq worker started", { queue: this.queueName });
  }

  async submit(job: ReviewJob): Promise<SubmitResult> {
    if (!this.queue) {
      const { Queue } = await this.lib();
      this.queue = new Queue(this.queueName, { connection: this.opts.connection });
    }
    const added = await this.queue.add("review", job, {
      attempts: (this.opts.retries ?? 2) + 1,
      backoff: { type: "exponential", delay: this.opts.backoffMs ?? 2000 },
      removeOnComplete: true,
      removeOnFail: 100,
      // Idempotency: BullMQ dedupes jobs that share a jobId.
      jobId: job.idempotency_key,
    });
    return { id: added.id ?? job.idempotency_key };
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
