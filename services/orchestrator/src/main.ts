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
import type { ReviewPlatform } from "./github/client.ts";
import { GitHubAppTokenProvider } from "./github/appAuth.ts";
import { RestGitLabClient } from "./gitlab/rest.ts";
import { RestBitbucketClient } from "./bitbucket/rest.ts";
import { RestBitbucketServerClient } from "./bitbucket/server.ts";
import { RestAzureClient } from "./azure/rest.ts";
import { makeControlPlaneTokens } from "./gitlab/tokens.ts";
import { Reviewer } from "./reviewer/reviewer.ts";
import { makeReviewHandler } from "./workflow/reviewWorkflow.ts";
import { InlineEngine } from "./workflow/inline.ts";
import { BullMqEngine } from "./workflow/bullmq.ts";
import { RedisStreamSource } from "./bridge/redisSource.ts";
import { runBridge } from "./bridge/bridge.ts";
import { GatewayTestGenerator, Verifier } from "@cavix/verifier";
import { selectBackend } from "@cavix/sandbox";
import { makeVerifyStep } from "./verify/verify.ts";
import { makeDeepReviewStep } from "./pipeline/deepReview.ts";
import { makeGraphStore } from "./orggraph/store.ts";
import { makeGraphIndexer } from "./orggraph/indexer.ts";
import { makeBlastRadiusStep } from "./orggraph/blastRadius.ts";
import { makeCiStore } from "./telemetry/store.ts";
import { makeCiIngestStep } from "./telemetry/ingest.ts";
import { makeRegressionStep } from "./telemetry/regression.ts";
import { makeControlPlaneResolver } from "./byok/resolver.ts";
import { makeRepoGate } from "./byok/gate.ts";
import { makeModelSuggester, makeModelSaver } from "./byok/models.ts";
import { makeReviewConfigFetcher } from "./byok/reviewConfig.ts";
import { makeReviewRecorder } from "./report/recorder.ts";
import { makeLedgerClient } from "./report/ledger.ts";
import { makeRunClient } from "./report/runs.ts";
import { preflight, formatPreflight } from "./preflight.ts";
import { createMetrics, makeRecorder, NOOP_RECORDER, type Recorder } from "@cavix/metrics";

function log(level: string, msg: string, meta?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, service: "orchestrator", msg, ...meta }));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A tiny always-on HTTP server so the orchestrator can run on a free "web service"
// host (Render/Railway/Fly), which requires an open port and kills processes that
// don't bind one. Also gives you a real /healthz to watch. Binds $PORT when set.
function startHealthServer(status: { redis: string }, metrics: Recorder): void {
  if (process.env.CAVIX_HEALTH_SERVER === "off") return;
  const port = Number(process.env.PORT ?? process.env.CAVIX_HEALTH_PORT ?? "8080");
  http
    .createServer((req, res) => {
      if (req.url === "/healthz" || req.url === "/") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", service: "orchestrator", redis: status.redis }));
      } else if (req.url === "/metrics") {
        // Stage 13's observability half, on the port that is already open.
        //
        // Prometheus text, pull-based, on a port the operator already exposes:
        // an air-gapped install cannot ship telemetry anywhere, so anything
        // push-based would be a feature that does not exist for the customers
        // who most need it. Nothing is computed until this line runs, which is
        // the other half of the requirement: metrics cost nothing when nobody
        // is scraping.
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
        res.end(metrics.render());
      } else {
        res.writeHead(404);
        res.end();
      }
    })
    .listen(port, "0.0.0.0", () => log("info", "health server listening", { port, metrics: "/metrics" }));
}

async function main() {
  const cfg = loadConfig();

  // Metrics are ON unless switched off. They are in-process counters behind a
  // pull endpoint, so they add no dependency, no egress and no work until
  // something scrapes; the reason to turn them off is policy, not cost.
  const metrics: Recorder =
    process.env.CAVIX_METRICS === "off"
      ? NOOP_RECORDER
      : makeRecorder(createMetrics(process.env.CAVIX_VERSION ?? "dev"));

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

  // Stages 3, 4, 7, 8 and 9 — the deep review path: deterministic scanners, the
  // call graph over the changed files, context assembly, seven specialist agents
  // in parallel, then adjudication over all of it.
  //
  // ON unless disabled. The eval scores this path at 95.7% F1 against 81.8% for
  // the single-model pass it replaces, and it fails soft: any error inside it
  // falls back to that single pass rather than costing anybody their review.
  // Turn it off with CAVIX_DEEP_REVIEW=off to halve the model spend per PR.
  let deepReview;
  if (process.env.CAVIX_DEEP_REVIEW !== "off") {
    deepReview = makeDeepReviewStep({
      gateway,
      github,
      logger: { info: (m, meta) => log("info", m, meta) },
    });
    log("info", "deep review on: 7-agent ensemble over a call graph, adjudicated");
  } else {
    log("info", "deep review off: reviewing with a single model pass over the diff");
  }

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

  // Stage 5 — the cross-repo contract graph. Two halves: a query that runs
  // during a review and an indexer that runs after one. Both need the
  // control-plane, because the graph has to outlive this process and be shared
  // by every worker; without one, reviews simply have no cross-repo section.
  let blastRadius;
  let indexGraph;
  if (cpUrl && internalToken && process.env.CAVIX_CROSS_REPO !== "off") {
    const graphStore = makeGraphStore({
      url: cpUrl,
      token: internalToken,
      logger: { warn: (m, meta) => log("warn", m, meta) },
    });
    blastRadius = makeBlastRadiusStep({ store: graphStore, logger: { info: (m, meta) => log("info", m, meta) } });
    indexGraph = makeGraphIndexer({
      github,
      store: graphStore,
      logger: { info: (m, meta) => log("info", m, meta) },
    });
    log("info", "cross-repo impact on: a changed interface is traced to its consumers in other repos");
  }

  // Stage 6 — CI telemetry. Same two-half shape and the same storage split: pull
  // completed Actions runs after a review, warn during the next one when the
  // pipeline this change joins has been getting slower.
  let regression;
  let ingestCi;
  if (cpUrl && internalToken && process.env.CAVIX_CI_TELEMETRY !== "off") {
    const ciStore = makeCiStore({
      url: cpUrl,
      token: internalToken,
      logger: { warn: (m, meta) => log("warn", m, meta) },
    });
    regression = makeRegressionStep({ store: ciStore, logger: { info: (m, meta) => log("info", m, meta) } });
    ingestCi = makeCiIngestStep({ github, store: ciStore, logger: { info: (m, meta) => log("info", m, meta) } });
    log("info", "CI telemetry on: build-time regressions are warned about before merge");
  }

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

  // The per-pull-request finding ledger: what every review of a pull request has
  // raised, and what is still open.
  //
  // Without it each review's verdict is computed from its own findings alone, so
  // a pull request with three open findings, one of them fixed and pushed, goes
  // green the moment the next pass does not happen to re-report the other two.
  // A model is not a function, and a merge gate built on one run of it is a coin
  // toss. Warned about loudly for that reason: this is a correctness difference,
  // not a missing dashboard row.
  const ledger = cpUrl && internalToken
    ? makeLedgerClient({
        url: cpUrl,
        token: internalToken,
        logger: { info: (m, meta) => log("info", m, meta), warn: (m, meta) => log("warn", m, meta) },
      })
    : undefined;
  if (ledger) log("info", "findings are tracked across every review of a pull request");
  else log("warn", "no control-plane configured: each review's verdict stands alone", {
    effect: "a re-review that does not re-report an open finding will not carry it forward",
    fix: "set CAVIX_CONTROL_PLANE_URL and CAVIX_INTERNAL_TOKEN on the orchestrator",
  });

  // At most one review of a pull request in flight.
  //
  // A push while a review is running used to produce TWO reviews, seconds apart.
  // The older one was computed against a commit that no longer exists, so its
  // line numbers point at whatever has since moved into those positions, and the
  // two raced to write the ledger.
  const runs = cpUrl && internalToken
    ? makeRunClient({
        url: cpUrl,
        token: internalToken,
        worker: process.env.RENDER_INSTANCE_ID ?? process.env.HOSTNAME ?? "orchestrator",
        logger: { info: (m, meta) => log("info", m, meta), warn: (m, meta) => log("warn", m, meta) },
      })
    : undefined;
  if (runs) log("info", "a push during a review supersedes it instead of posting twice");
  else log("warn", "no control-plane configured: reviews are not deduplicated per pull request", {
    effect: "a push while a review is running will post two reviews, the older one against a commit that no longer exists",
    fix: "set CAVIX_CONTROL_PLANE_URL and CAVIX_INTERNAL_TOKEN on the orchestrator",
  });

  // Stage 11 — the second live platform.
  //
  // On unless it has nothing to authenticate with. GitLab holds no per-install
  // credential the way a GitHub App does, so a workspace's token comes from the
  // control-plane per review, and without a control-plane there is nowhere to
  // read one from: the client would exist and fail on its first call. A
  // deployment with no GitLab configured simply drops GitLab jobs, which it will
  // never receive anyway because the edge rejects them without its own secret.
  const platforms: Record<string, ReviewPlatform> = {};
  if (cpUrl && internalToken && process.env.CAVIX_GITLAB !== "off") {
    platforms.gitlab = new RestGitLabClient({
      tokens: makeControlPlaneTokens({
        url: cpUrl,
        token: internalToken,
        logger: { warn: (m, meta) => log("warn", m, meta) },
      }),
      baseUrl: process.env.CAVIX_GITLAB_URL,
      logger: { info: (m, meta) => log("info", m, meta) },
    });
    log("info", "gitlab reviews on: merge requests are reviewed through the same workflow", {
      instance: process.env.CAVIX_GITLAB_URL ?? "https://gitlab.com",
    });
  }

  // Bitbucket Cloud, on the same terms as GitLab: a workspace token from the
  // control-plane, so without one there is nowhere to authenticate from.
  if (cpUrl && internalToken && process.env.CAVIX_BITBUCKET !== "off") {
    platforms.bitbucket = new RestBitbucketClient({
      tokens: makeControlPlaneTokens({
        url: cpUrl,
        token: internalToken,
        platform: "bitbucket",
        logger: { warn: (m, meta) => log("warn", m, meta) },
      }),
      logger: { info: (m, meta) => log("info", m, meta) },
    });
    log("info", "bitbucket reviews on: pull request events only, no chat commands", {
      why: "authorizing an arbitrary commenter needs workspace-admin scope a review bot should not hold",
    });
  }

  // Bitbucket Server / Data Center. A separate REST surface from Cloud, so a
  // separate client, and it needs the instance URL: unlike Cloud there is no
  // default host because every install has its own.
  const bbServerUrl = process.env.CAVIX_BITBUCKET_SERVER_URL;
  if (cpUrl && internalToken && bbServerUrl) {
    platforms["bitbucket-server"] = new RestBitbucketServerClient({
      tokens: makeControlPlaneTokens({
        url: cpUrl,
        token: internalToken,
        platform: "bitbucket-server",
        logger: { warn: (m, meta) => log("warn", m, meta) },
      }),
      baseUrl: bbServerUrl,
      logger: { info: (m, meta) => log("info", m, meta) },
    });
    log("info", "bitbucket data center reviews on: pull request events only, no chat commands", {
      instance: bbServerUrl,
    });
  }

  // Azure DevOps, on the same terms. The one platform whose diff Cavix computes
  // itself, because `diffs/commits` returns changed PATHS and no content: see
  // the note at the top of azure/rest.ts, and `diffLimitations`, which is how a
  // file that could not be diffed exactly reaches the reader instead of being
  // dropped.
  if (cpUrl && internalToken && process.env.CAVIX_AZURE !== "off") {
    platforms["azure-devops"] = new RestAzureClient({
      tokens: makeControlPlaneTokens({
        url: cpUrl,
        token: internalToken,
        platform: "azure",
        logger: { warn: (m, meta) => log("warn", m, meta) },
      }),
      baseUrl: process.env.CAVIX_AZURE_URL,
      logger: { info: (m, meta) => log("info", m, meta) },
    });
    log("info", "azure devops reviews on: the diff is computed locally, files it cannot diff are named on the review", {
      instance: process.env.CAVIX_AZURE_URL ?? "https://dev.azure.com",
      commands: "off (an arbitrary commenter's push permission cannot be checked without org-level scopes)",
    });
  }

  const handler = makeReviewHandler({
    github,
    platforms,
    reviewer,
    gate,
    suggestModels,
    saveModel,
    deepReview,
    blastRadius,
    indexGraph,
    regression,
    ingestCi,
    verify,
    reviewConfig,
    recordReview,
    ledger,
    runs,
    metrics,
    // "@cavixcode <question>" answers in prose instead of running a review.
    answer: async (job, ref, orgId, question) => {
      const diff = await github.fetchPullDiff(ref);
      const { answer } = await reviewer.ask({ org: orgId, title: job.title ?? "", diff, question });
      return answer;
    },
    // The summary belongs in the PR description; opt out with =off.
    summaryInDescription: process.env.CAVIX_SUMMARY_IN_DESCRIPTION !== "off",
    // Coloured badges on the review header. Turn off for air-gapped GitHub
    // Enterprise, where the image proxy cannot reach shields.io.
    badges: process.env.CAVIX_REVIEW_BADGES !== "off",
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
  startHealthServer(health, metrics);

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
        metrics,
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
