// Production entrypoint for the orchestrator (Stage 1). Wires the REAL backends
// from config: Anthropic via the BYOK gateway, GitHub REST, the Redis Stream the
// edge feeds, and a durable workflow engine. Every backend is swappable behind
// its port (Temporal for BullMQ, Firecracker for the future sandbox, GPT/Gemini
// for Anthropic) without touching the workflow.
//
//   CAVIX_GITHUB_TOKEN=... ANTHROPIC_API_KEY=... node services/orchestrator/src/main.ts

import http from "node:http";
import {
  AnthropicProvider,
  FakeProvider,
  Gateway,
  GoogleProvider,
  OpenAIProvider,
  SelfHostedProvider,
  type LLMProvider,
} from "@cavix/gateway";
import { loadConfig } from "./config.ts";
import { RestGitHubClient, StaticTokenProvider } from "./github/rest.ts";
import { GitHubAppTokenProvider } from "./github/appAuth.ts";
import { Reviewer } from "./reviewer/reviewer.ts";
import { makeReviewHandler } from "./workflow/reviewWorkflow.ts";
import { InlineEngine } from "./workflow/inline.ts";
import { BullMqEngine } from "./workflow/bullmq.ts";
import { RedisStreamSource } from "./bridge/redisSource.ts";
import { runBridge } from "./bridge/bridge.ts";
import { GatewayTestGenerator, Verifier } from "@cavix/verifier";
import { selectBackend } from "@cavix/sandbox";
import { makeVerifyStep } from "./verify/verify.ts";
import { makeControlPlaneResolver } from "./byok/resolver.ts";
import { makeRepoGate } from "./byok/gate.ts";
import { makeModelSuggester, makeModelSaver } from "./byok/models.ts";
import { makeReviewConfigFetcher } from "./byok/reviewConfig.ts";
import { makeReviewRecorder } from "./report/recorder.ts";
import { preflight, formatPreflight } from "./preflight.ts";

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

  // Provider registry. EVERY provider offered in the dashboard's AI & BYOK
  // dropdown must be registered here — an org that picks one we did not register
  // gets a failed review on every PR, which is exactly what "unknown provider
  // google" was.
  const providers = new Map<string, LLMProvider>([
    ["anthropic", new AnthropicProvider()],
    ["google", new GoogleProvider()],
    ["openai", new OpenAIProvider()],
    ["fake", new FakeProvider(() => '{"summary":"dry run","findings":[]}')],
  ]);
  // Self-hosted needs an endpoint; only offer it when one is configured.
  const selfHostedUrl = process.env.CAVIX_SELFHOSTED_URL;
  if (selfHostedUrl) {
    providers.set("selfhosted", new SelfHostedProvider({ baseUrl: selfHostedUrl }));
    log("info", "self-hosted model endpoint registered", { url: selfHostedUrl });
  }
  log("info", "providers registered", { providers: [...providers.keys()].join(",") });
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

  // GitHub auth. A GitHub App install (the product's onboarding flow) never gives
  // you a PAT — it gives an App id + private key, which we exchange for short-lived
  // per-installation tokens. The static token is only a local-dev fallback.
  //
  // NOTE: a bad credential must never stop the process. The service binds its
  // port and keeps consuming; broken auth surfaces per review, on the PR.
  let tokens;
  if (cfg.github.appId || cfg.github.privateKey) {
    const app = new GitHubAppTokenProvider({
      appId: cfg.github.appId,
      privateKey: cfg.github.privateKey,
      baseUrl: cfg.github.baseUrl,
      logger: { info: (m, meta) => log("info", m, meta) },
    });
    tokens = app;
    if (app.configError) {
      log("error", app.configError, {
        fix: "Render → cavix-orchestrator → Environment. For the key, use 'Add Secret File' or paste the whole .pem including the BEGIN/END lines.",
      });
      log("warn", "the orchestrator is running, but reviews will fail until the GitHub App credentials are fixed");
    } else {
      log("info", "GitHub auth: App installation tokens", { app_id: cfg.github.appId });
    }
  } else if (cfg.github.token) {
    tokens = new StaticTokenProvider(cfg.github.token);
    log("warn", "GitHub auth: static token (dev mode). Set CAVIX_APP_ID + CAVIX_APP_PRIVATE_KEY for the App path.");
  } else {
    // Fail loudly at boot instead of on every job with "static token is empty".
    log("error", "GitHub auth is NOT configured: set CAVIX_APP_ID and CAVIX_APP_PRIVATE_KEY (from your GitHub App), or CAVIX_GITHUB_TOKEN for local runs. No review can be posted until you do.");
    tokens = new StaticTokenProvider("");
  }

  const github = new RestGitHubClient({
    tokens,
    baseUrl: cfg.github.baseUrl,
  });

  // ONE consolidated check of every dependency, reported together. Each of these
  // used to surface separately, on a pull request, one deploy at a time.
  void preflight({
    whoAmI: () => github.whoAmI(),
    githubConfigError: tokens instanceof GitHubAppTokenProvider ? tokens.configError : null,
    controlPlaneUrl: cpUrl,
    internalToken,
    redisConfigured: !!cfg.redis.host && cfg.redis.host !== "127.0.0.1",
    providers: [...providers.keys()],
  })
    .then((results) => {
      const blocking = results.some((r) => !r.ok && r.required);
      log(blocking ? "error" : "info", formatPreflight(results));
    })
    .catch(() => {
      /* diagnostics only; never block startup */
    });

  const reviewer = new Reviewer({ gateway });

  // Execution gatekeeper: only review repos toggled ON in the dashboard.
  const gate = cpUrl && internalToken
    ? makeRepoGate({ url: cpUrl, token: internalToken, failOpen: process.env.CAVIX_GATE_FAIL_OPEN === "true", logger: { warn: (m, meta) => log("warn", m, meta) } })
    : undefined;
  if (gate) log("info", "execution gatekeeper on: only dashboard-enabled repos are reviewed");

  // Lets a "model retired" failure name real alternatives on the pull request.
  const suggestModels = cpUrl && internalToken
    ? makeModelSuggester({ url: cpUrl, token: internalToken, logger: { warn: (m, meta) => log("warn", m, meta) } })
    : undefined;
  const saveModel = cpUrl && internalToken
    ? makeModelSaver({ url: cpUrl, token: internalToken, logger: { warn: (m, meta) => log("warn", m, meta) } })
    : undefined;
  if (suggestModels) log("info", "model self-heal on: a retired model is replaced automatically");

  // Stage 10 — execution-grounded verification. This is the product's moat, so it
  // is ON unless explicitly disabled: findings get reproduced in a sealed,
  // network-less sandbox before they are posted, and the ones that fail to
  // reproduce are dropped rather than shown. Requires a sandbox backend; if the
  // configured one cannot be constructed we log it and review without proofs
  // rather than refusing to review at all.
  let verify;
  if (process.env.CAVIX_VERIFY !== "off") {
    try {
      const backend = selectBackend(process.env.CAVIX_SANDBOX_BACKEND ?? "docker", (m) =>
        log("warn", m),
      );
      verify = makeVerifyStep({
        github,
        verifier: new Verifier({
          sandbox: backend,
          // The repro/exploit test is written by the org's own model through the
          // BYOK gateway — no Cavix-side key, same cost attribution as the review.
          testGen: new GatewayTestGenerator({ gateway }),
        }),
        logger: { info: (m, meta) => log("info", m, meta) },
      });
      log("info", "verification on: findings are reproduced in a sandbox before posting", {
        backend: backend.name,
      });
    } catch (err) {
      log("warn", "verification disabled: no usable sandbox backend", {
        err: (err as Error).message,
        hint: "Set CAVIX_SANDBOX_BACKEND=local|docker, or CAVIX_VERIFY=off to silence this.",
      });
    }
  } else {
    log("info", "verification off (CAVIX_VERIFY=off): findings post unproven");
  }

  // Every switch the repo owner flipped on the dashboard — verification, summary
  // placement, the pre-merge gate, blocking. Without a control-plane the safe
  // defaults apply, so a self-hosted run with no dashboard still behaves.
  const reviewConfig = cpUrl && internalToken
    ? makeReviewConfigFetcher({ url: cpUrl, token: internalToken, logger: { warn: (m, meta) => log("warn", m, meta) } })
    : undefined;
  if (reviewConfig) log("info", "per-org review settings come from the dashboard");

  // The other half of that conversation: every finished review is written back
  // so the dashboard, the accept/reject learning signal and the proven-catches
  // feed have something to show. Without a control-plane there is nowhere to
  // record to, and reviews simply live on the pull request.
  const recordReview = cpUrl && internalToken
    ? makeReviewRecorder({
        url: cpUrl,
        token: internalToken,
        logger: { info: (m, meta) => log("info", m, meta), warn: (m, meta) => log("warn", m, meta) },
      })
    : undefined;
  if (recordReview) log("info", "reviews are recorded to the dashboard as they are posted");
  else log("warn", "no control-plane configured: reviews will NOT appear on the dashboard", {
    fix: "set CAVIX_CONTROL_PLANE_URL and CAVIX_INTERNAL_TOKEN on the orchestrator",
  });

  const handler = makeReviewHandler({
    github,
    reviewer,
    gate,
    suggestModels,
    saveModel,
    verify,
    reviewConfig,
    recordReview,
    // The summary belongs in the PR description; opt out with =off.
    summaryInDescription: process.env.CAVIX_SUMMARY_IN_DESCRIPTION !== "off",
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
