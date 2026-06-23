// The StreamSource port abstracts "where review jobs come from" so the bridge
// loop is identical whether it reads a real Redis Stream (production) or an
// in-memory queue (tests). This is the Stage 0 → Stage 1 boundary: the edge
// XADDs jobs; the bridge reads them here and submits to the WorkflowEngine.

export interface StreamEntry {
  /** Broker entry id, used for acking. */
  id: string;
  /** Raw canonical ReviewJob JSON (the edge's "job" field). */
  job: string;
}

export interface StreamSource {
  /** Read up to count entries, blocking up to blockMs for new ones. */
  read(count: number, blockMs: number): Promise<StreamEntry[]>;
  /** Acknowledge processed entries so they are not redelivered. */
  ack(ids: string[]): Promise<void>;
  close(): Promise<void>;
}

/** In-memory StreamSource for hermetic bridge tests. */
export class FakeStreamSource implements StreamSource {
  private queue: StreamEntry[];
  readonly acked: string[] = [];

  constructor(entries: StreamEntry[] = []) {
    this.queue = [...entries];
  }

  push(entry: StreamEntry): void {
    this.queue.push(entry);
  }

  async read(count: number, _blockMs: number): Promise<StreamEntry[]> {
    return this.queue.splice(0, count);
  }

  async ack(ids: string[]): Promise<void> {
    this.acked.push(...ids);
  }

  async close(): Promise<void> {
    /* nothing */
  }
}
