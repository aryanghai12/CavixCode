import { parseReviewJob } from "@cavix/core";
import type { WorkflowEngine } from "../workflow/engine.ts";
import type { StreamSource } from "./source.ts";

// The bridge pumps jobs from the StreamSource (Stage 0 output) into the
// WorkflowEngine (Stage 1). It is the only component that reads the stream, so
// the engine swap (BullMQ → Temporal) and the source swap (Redis → other) are
// independent.
//
// Delivery semantics:
//   - A successfully submitted job is acked (won't be redelivered).
//   - A POISON job (unparseable JSON / schema skew) is acked and logged: it can
//     never succeed, so redelivering it forever would wedge the consumer.
//   - A job whose submit throws (engine retries exhausted) is left UNACKED so it
//     stays in the pending list for later recovery rather than being lost.

export interface BridgeLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface BridgeOptions {
  batch?: number;
  blockMs?: number;
  logger?: BridgeLogger;
}

const noopLogger: BridgeLogger = { info() {}, error() {} };

/** Process one batch from the source. Returns the number of entries read. */
export async function pumpOnce(
  source: StreamSource,
  engine: WorkflowEngine,
  opts: BridgeOptions = {},
): Promise<number> {
  const log = opts.logger ?? noopLogger;
  const batch = opts.batch ?? 16;
  const blockMs = opts.blockMs ?? 5000;

  const entries = await source.read(batch, blockMs);
  for (const entry of entries) {
    let job;
    try {
      job = parseReviewJob(JSON.parse(entry.job));
    } catch (err) {
      // Poison message — ack so it stops redelivering, but record it loudly.
      log.error("poison stream entry dropped", { id: entry.id, err: (err as Error).message });
      await source.ack([entry.id]);
      continue;
    }
    try {
      const res = await engine.submit(job);
      await source.ack([entry.id]);
      log.info("job submitted to workflow", {
        id: entry.id,
        submit_id: res.id,
        repo: job.repo,
        pr: job.pr_number,
      });
    } catch (err) {
      // Leave UNACKED: stays pending for recovery, not dropped.
      log.error("submit failed; leaving entry pending", {
        id: entry.id,
        repo: job.repo,
        pr: job.pr_number,
        err: (err as Error).message,
      });
    }
  }
  return entries.length;
}

/** Run the bridge until the AbortSignal fires. */
export async function runBridge(
  source: StreamSource,
  engine: WorkflowEngine,
  signal: AbortSignal,
  opts: BridgeOptions = {},
): Promise<void> {
  while (!signal.aborted) {
    await pumpOnce(source, engine, opts);
  }
}
