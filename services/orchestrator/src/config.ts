import type { GatewayConfigData } from "@cavix/gateway";

// Orchestrator config from env. Config over hardcode: provider, model, keys,
// thresholds, and infra addresses are all environment-driven so one image runs
// in dev, managed cloud, and air-gapped self-host.
//
// BYOK note: in production the per-org keys come from a secret store, not env.
// For Phase 0 a single-org mapping from env is enough to run the real path.

export interface OrchestratorConfig {
  redis: { host: string; port: number };
  stream: string;
  group: string;
  consumer: string;
  github: { token: string; baseUrl: string };
  gateway: GatewayConfigData;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  const org = env.CAVIX_ORG ?? "default";
  const provider = env.CAVIX_LLM_PROVIDER ?? "anthropic";
  const model = env.CAVIX_LLM_MODEL ?? "claude-sonnet-4-6";
  const apiKey = env.CAVIX_LLM_API_KEY ?? env.ANTHROPIC_API_KEY ?? "";

  return {
    redis: {
      host: env.CAVIX_REDIS_HOST ?? "127.0.0.1",
      port: Number(env.CAVIX_REDIS_PORT ?? "6379"),
    },
    stream: env.CAVIX_STREAM_KEY ?? "cavix:reviewjobs",
    group: env.CAVIX_STREAM_GROUP ?? "cavix-orchestrator",
    consumer: env.CAVIX_CONSUMER_NAME ?? "orchestrator-1",
    github: {
      token: env.CAVIX_GITHUB_TOKEN ?? "",
      baseUrl: env.CAVIX_GITHUB_API ?? "https://api.github.com",
    },
    gateway: {
      orgs: {
        [org]: { provider, apiKey, model },
      },
      // Single-org fallback so any org id resolves in Phase 0.
      fallback: { provider, apiKey, model },
    },
  };
}
