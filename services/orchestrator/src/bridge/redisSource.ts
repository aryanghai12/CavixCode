import { RespClient, type RespValue } from "../redis/resp.ts";
import type { StreamEntry, StreamSource } from "./source.ts";

// RedisStreamSource consumes the Redis Stream the Go edge produces, using a
// consumer group for at-least-once delivery: XREADGROUP hands us new entries,
// XACK confirms them, and a crash mid-review leaves the entry in the group's
// pending list for redelivery. Integration-gated (needs a running Redis); the
// bridge logic itself is unit-tested against FakeStreamSource.

export interface RedisStreamSourceOptions {
  host: string;
  port: number;
  stream: string;
  group: string;
  consumer: string;
}

export class RedisStreamSource implements StreamSource {
  private readonly client: RespClient;
  private readonly opts: RedisStreamSourceOptions;

  private constructor(client: RespClient, opts: RedisStreamSourceOptions) {
    this.client = client;
    this.opts = opts;
  }

  static async create(opts: RedisStreamSourceOptions): Promise<RedisStreamSource> {
    const client = await RespClient.connect(opts.host, opts.port);
    const source = new RedisStreamSource(client, opts);
    await source.ensureGroup();
    return source;
  }

  // Create the consumer group at the stream's start, creating the stream if it
  // does not exist (MKSTREAM). BUSYGROUP just means it already exists — fine.
  private async ensureGroup(): Promise<void> {
    try {
      await this.client.command("XGROUP", "CREATE", this.opts.stream, this.opts.group, "0", "MKSTREAM");
    } catch (err) {
      if (!(err as Error).message.includes("BUSYGROUP")) throw err;
    }
  }

  async read(count: number, blockMs: number): Promise<StreamEntry[]> {
    const reply = await this.client.command(
      "XREADGROUP",
      "GROUP",
      this.opts.group,
      this.opts.consumer,
      "COUNT",
      String(count),
      "BLOCK",
      String(blockMs),
      "STREAMS",
      this.opts.stream,
      ">",
    );
    return parseXReadGroup(reply);
  }

  async ack(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.command("XACK", this.opts.stream, this.opts.group, ...ids);
  }

  async close(): Promise<void> {
    this.client.close();
  }
}

// Reply shape: null (no data) OR [[streamName, [[id, [f1, v1, ...]], ...]]].
export function parseXReadGroup(reply: RespValue): StreamEntry[] {
  if (reply === null || !Array.isArray(reply)) return [];
  const entries: StreamEntry[] = [];
  for (const streamPair of reply) {
    if (!Array.isArray(streamPair) || streamPair.length < 2) continue;
    const items = streamPair[1];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const id = String(item[0]);
      const fields = item[1];
      if (!Array.isArray(fields)) continue;
      const job = fieldValue(fields, "job");
      if (job !== null) entries.push({ id, job });
    }
  }
  return entries;
}

function fieldValue(fields: RespValue[], key: string): string | null {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === key) return String(fields[i + 1]);
  }
  return null;
}
