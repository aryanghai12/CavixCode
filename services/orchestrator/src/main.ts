// Production entrypoint for the orchestrator (Stage 1). Wires the REAL backends
// from config: Anthropic via the BYOK gateway, GitHub REST, the Redis Stream the
// edge feeds, and a durable workflow engine. Every backend is swappable behind
// its port (Temporal for BullMQ, Firecracker for the future sandbox, GPT/Gemini
// for Anthropic) without touching the workflow.
//
//   CAVIX_GITHUB_TOKEN=... ANTHROPIC_API_KEY=... node services/orchestrator/src/main.ts

import { AnthropicProvider, FakeProvider, Gateway, type LLMProvider } from "@cavix/gateway";
import { loadConfig } from "./config.ts";
import { RestGitHubClient, StaticTokenProvider } from "./github/rest.ts";
import { Reviewer } from "./reviewer/reviewer.ts";
import { makeReviewHandler } from "./workflow/reviewWorkflow.ts";
import { InlineEngine } from "./workflow/inline.ts";
import { BullMqEngine } from "./workflow/bullmq.ts";
import { RedisStreamSource } from "./bridge/redisSource.ts";
import { runBridge } from "./bridge/bridge.ts";

function log(level: string, msg: string, meta?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, service: "orchestrator", msg, ...meta }));
}

async function main() {
  const cfg = loadConfig();

  // Providers registry — Claude default, fake available for dry runs.
  const providers = new Map<string, LLMProvider>([
    ["anthropic", new AnthropicProvider()],
    ["fake", new FakeProvider(() => '{"summary":"dry run","findings":[]}')],
  ]);
  const gateway = new Gateway({
    providers,
    config: cfg.gateway,
    logger: { info: (m, meta) => log("info", m, meta), warn: (m, meta) => log("warn", m, meta) },
  });

  const github = new RestGitHubClient({
    tokens: new StaticTokenProvider(cfg.github.token),
    baseUrl: cfg.github.baseUrl,
  });
  const reviewer = new Reviewer({ gateway });
  const handler = makeReviewHandler({
    github,
    reviewer,
    logger: { info: (m, meta) => log("info", m, meta), error: (m, meta) => log("error", m, meta) },
  });

  // Durable engine: BullMQ if available, else inline (dev). Same port either way.
  const useBull = (process.env.CAVIX_ENGINE ?? "bullmq") === "bullmq";
  const engine = useBull
    ? new BullMqEngine({ connection: cfg.redis, logger: { info: (m, meta) => log("info", m, meta), error: (m, meta) => log("error", m, meta) } })
    : new InlineEngine({ logger: { info: (m, meta) => log("info", m, meta), error: (m, meta) => log("error", m, meta) } });
  engine.registerWorker(handler);
  if (engine instanceof BullMqEngine) await engine.start();

  const source = await RedisStreamSource.create({
    host: cfg.redis.host,
    port: cfg.redis.port,
    stream: cfg.stream,
    group: cfg.group,
    consumer: cfg.consumer,
  });

  const controller = new AbortController();
  const shutdown = async () => {
    log("info", "shutting down");
    controller.abort();
    await source.close();
    await engine.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log("info", "orchestrator started", { stream: cfg.stream, group: cfg.group, engine: useBull ? "bullmq" : "inline" });
  await runBridge(source, engine, controller.signal, {
    logger: { info: (m, meta) => log("info", m, meta), error: (m, meta) => log("error", m, meta) },
  });
}

main().catch((err) => {
  log("error", "fatal", { err: (err as Error).message });
  process.exit(1);
});
