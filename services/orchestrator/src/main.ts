// Production entrypoint for the orchestrator (Stage 1). Wires the REAL backends
// from config: Anthropic via the BYOK gateway, GitHub REST, the Redis Stream the
// edge feeds, and a durable workflow engine. Every backend is swappable behind
// its port (Temporal for BullMQ, Firecracker for the future sandbox, GPT/Gemini
// for Anthropic) without touching the workflow.
//
//   CAVIX_GITHUB_TOKEN=... ANTHROPIC_API_KEY=... node services/orchestrator/src/main.ts

import http from "node:http";
import { AnthropicProvider, FakeProvider, Gateway, type LLMProvider } from "@cavix/gateway";
import { loadConfig } from "./config.ts";
import { RestGitHubClient, StaticTokenProvider } from "./github/rest.ts";
import { Reviewer } from "./reviewer/reviewer.ts";
import { makeReviewHandler } from "./workflow/reviewWorkflow.ts";
import { InlineEngine } from "./workflow/inline.ts";
import { BullMqEngine } from "./workflow/bullmq.ts";
import { RedisStreamSource } from "./bridge/redisSource.ts";
import { runBridge } from "./bridge/bridge.ts";
import { makeControlPlaneResolver } from "./byok/resolver.ts";
import { makeRepoGate } from "./byok/gate.ts";

function log(level: string, msg: string, meta?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, service: "orchestrator", msg, ...meta }));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A tiny always-on HTTP server so the orchestrator can run on a free "web service"
// host (Render/Railway/Fly), which requires an open port and kills processes that
// don't bind one. Also gives you a real /healthz to watch. Binds $PORT when set.
function startHealthServer(status: { redis: string }): void {
  if (process.env.CAVIX_HEALTH_SERVER === "off") return;
  const port = Number(process.env.PORT ?? process.env.CAVIX_HEALTH_PORT ?? "8080");
  http
    .createServer((req, res) => {
      if (req.url === "/healthz" || req.url === "/") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", service: "orchestrator", redis: status.redis }));
      } else {
        res.writeHead(404);
        res.end();
      }
    })
    .listen(port, "0.0.0.0", () => log("info", "health server listening", { port }));
}

async function main() {
  const cfg = loadConfig();

  // Providers registry — Claude default, fake available for dry runs.
  const providers = new Map<string, LLMProvider>([
    ["anthropic", new AnthropicProvider()],
    ["fake", new FakeProvider(() => '{"summary":"dry run","findings":[]}')],
  ]);
  // BYOK from the site: if pointed at the control-plane, each review uses the org's
  // own key/model chosen on the dashboard (falls back to env config otherwise).
  const cpUrl = process.env.CAVIX_CONTROL_PLANE_URL;
  const internalToken = process.env.CAVIX_INTERNAL_TOKEN;
  const resolver = cpUrl && internalToken
    ? makeControlPlaneResolver({ url: cpUrl, token: internalToken, logger: { warn: (m, meta) => log("warn", m, meta) } })
    : undefined;
  if (resolver) log("info", "BYOK: resolving org keys from the control-plane", { url: cpUrl });

  const gateway = new Gateway({
    providers,
    config: cfg.gateway,
    resolver,
    logger: { info: (m, meta) => log("info", m, meta), warn: (m, meta) => log("warn", m, meta) },
  });

  const github = new RestGitHubClient({
    tokens: new StaticTokenProvider(cfg.github.token),
    baseUrl: cfg.github.baseUrl,
  });
  const reviewer = new Reviewer({ gateway });

  // Execution gatekeeper: only review repos toggled ON in the dashboard.
  const gate = cpUrl && internalToken
    ? makeRepoGate({ url: cpUrl, token: internalToken, failOpen: process.env.CAVIX_GATE_FAIL_OPEN === "true", logger: { warn: (m, meta) => log("warn", m, meta) } })
    : undefined;
  if (gate) log("info", "execution gatekeeper on: only dashboard-enabled repos are reviewed");

  const handler = makeReviewHandler({
    github,
    reviewer,
    gate,
    logger: { info: (m, meta) => log("info", m, meta), error: (m, meta) => log("error", m, meta) },
  });

  // ioredis (BullMQ) wants `tls` as an options object, not a boolean.
  const bullConnection = {
    host: cfg.redis.host,
    port: cfg.redis.port,
    username: cfg.redis.username,
    password: cfg.redis.password,
    ...(cfg.redis.tls ? { tls: {} } : {}),
  };

  // Health server first, so the port is open immediately (keeps free web hosts happy
  // even while we wait for Redis to become reachable).
  const health = { redis: "connecting" };
  startHealthServer(health);

  // Durable engine: BullMQ if available, else inline (dev). Same port either way.
  const useBull = (process.env.CAVIX_ENGINE ?? "bullmq") === "bullmq";
  const engine = useBull
    ? new BullMqEngine({ connection: bullConnection, logger: { info: (m, meta) => log("info", m, meta), error: (m, meta) => log("error", m, meta) } })
    : new InlineEngine({ logger: { info: (m, meta) => log("info", m, meta), error: (m, meta) => log("error", m, meta) } });
  engine.registerWorker(handler);
  if (engine instanceof BullMqEngine) await engine.start();

  const controller = new AbortController();
  let currentSource: RedisStreamSource | null = null;
  const shutdown = async () => {
    log("info", "shutting down");
    controller.abort();
    await currentSource?.close();
    await engine.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log("info", "orchestrator started", { stream: cfg.stream, group: cfg.group, engine: useBull ? "bullmq" : "inline" });

  // Resilient connect loop: if Redis isn't reachable yet (managed Redis still
  // provisioning, misconfigured URL, cold start), log and retry instead of exiting.
  // The health server stays up throughout, so the deploy reports healthy and heals
  // itself once Redis is available.
  const retryMs = Number(process.env.CAVIX_REDIS_RETRY_MS ?? "10000");
  while (!controller.signal.aborted) {
    try {
      const source = await RedisStreamSource.create({
        host: cfg.redis.host,
        port: cfg.redis.port,
        username: cfg.redis.username,
        password: cfg.redis.password,
        tls: cfg.redis.tls,
        stream: cfg.stream,
        group: cfg.group,
        consumer: cfg.consumer,
      });
      currentSource = source;
      health.redis = "connected";
      log("info", "connected to redis; consuming review jobs", { host: cfg.redis.host, tls: !!cfg.redis.tls });
      await runBridge(source, engine, controller.signal, {
        logger: { info: (m, meta) => log("info", m, meta), error: (m, meta) => log("error", m, meta) },
      });
      return; // bridge returned (clean shutdown)
    } catch (err) {
      const msg = (err as Error).message;
      if (!/ECONNREFUSED|:6379|redis|AUTH|timeout|ENOTFOUND|ETIMEDOUT/i.test(msg)) throw err;
      health.redis = "unreachable";
      log("warn", "Redis not reachable yet; the service stays live and will retry", {
        err: msg,
        retryInMs: retryMs,
        hint: "Set CAVIX_REDIS_URL to your managed Redis (e.g. rediss://default:PASSWORD@host:6380). Local: docker run -p 6379:6379 redis.",
      });
      await sleep(retryMs);
    }
  }
}

main().catch((err) => {
  // Redis reachability is handled by the resilient loop above (it retries, never
  // exits). Anything reaching here is a genuine fatal (bad config, code bug).
  log("error", "fatal", { err: (err as Error).message });
  process.exit(1);
});
