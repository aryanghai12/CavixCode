import { readFileSync } from "node:fs";
import type { GatewayConfigData } from "@cavix/gateway";

// Orchestrator config from env. Config over hardcode: provider, model, keys,
// thresholds, and infra addresses are all environment-driven so one image runs
// in dev, managed cloud, and air-gapped self-host.
//
// BYOK note: in production the per-org keys come from a secret store, not env.
// For Phase 0 a single-org mapping from env is enough to run the real path.

/**
 * Default model when an org hasn't chosen one on the dashboard. Opus 5 is the
 * current flagship — reviews are the product, so capability wins over cost here,
 * and BYOK means the org pays their own provider directly either way.
 */
export const DEFAULT_MODEL = "claude-opus-5";

export interface RedisConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: boolean;
}

export interface GitHubConfig {
  /** Static PAT / pre-minted token. Fallback for local runs. */
  token: string;
  baseUrl: string;
  /** GitHub App id — the production auth path (an App install never yields a PAT). */
  appId: string;
  /** GitHub App private key (.pem contents). */
  privateKey: string;
}

export interface OrchestratorConfig {
  redis: RedisConfig;
  stream: string;
  group: string;
  consumer: string;
  github: GitHubConfig;
  gateway: GatewayConfigData;
}

// Resolve Redis connection details. Managed providers (Redis Cloud, Upstash, Render
// Key Value) give a single URL like rediss://default:password@host:port — support that
// AND discrete CAVIX_REDIS_* vars. Password + TLS are required over the public internet.
export function resolveRedis(env: NodeJS.ProcessEnv): RedisConfig {
  const url = env.CAVIX_REDIS_URL ?? env.REDIS_URL;
  if (url) {
    try {
      const u = new URL(url);
      return {
        host: u.hostname,
        port: Number(u.port || "6379"),
        username: decodeURIComponent(u.username) || undefined,
        password: decodeURIComponent(u.password) || undefined,
        tls: u.protocol === "rediss:",
      };
    } catch {
      // fall through to discrete vars if the URL is malformed
    }
  }
  return {
    host: env.CAVIX_REDIS_HOST ?? "127.0.0.1",
    port: Number(env.CAVIX_REDIS_PORT ?? "6379"),
    username: env.CAVIX_REDIS_USERNAME || undefined,
    password: env.CAVIX_REDIS_PASSWORD || undefined,
    tls: env.CAVIX_REDIS_TLS === "true",
  };
}

/**
 * The GitHub App private key, from an env var OR a file on disk.
 *
 * Multi-line values are exactly what hosting dashboards mangle, so the file path
 * matters: on Render, "Secret Files" preserves a .pem byte-for-byte where the
 * Environment Variables field may not. Set CAVIX_APP_PRIVATE_KEY_FILE to the
 * secret file's path (e.g. /etc/secrets/cavix.pem). We also accept a bare path
 * in CAVIX_APP_PRIVATE_KEY itself, since that mix-up is easy to make.
 */
export function resolvePrivateKey(env: NodeJS.ProcessEnv, readFile = defaultReadFile): string {
  const file = env.CAVIX_APP_PRIVATE_KEY_FILE ?? env.CAVIX_GITHUB_APP_PRIVATE_KEY_FILE ?? "";
  if (file) {
    const contents = readFile(file);
    if (contents) return contents;
  }
  const inline =
    env.CAVIX_APP_PRIVATE_KEY ?? env.CAVIX_GITHUB_APP_PRIVATE_KEY ?? env.GITHUB_APP_PRIVATE_KEY ?? "";
  // A path pasted where the key was expected: read it rather than failing.
  //
  // The test must be strict. Base64 uses "/" as a character, so "contains a
  // slash" alone would misread a headerless key body as a filename. Require a
  // real path shape instead: absolute, explicitly relative, or ending in .pem.
  const v = inline.trim();
  const looksLikePath =
    v.length > 0 &&
    v.length < 512 &&
    !/\s/.test(v) &&
    !v.includes("-----") &&
    (/^\.{0,2}\//.test(v) || /^[A-Za-z]:[\\/]/.test(v) || /\.pem$/i.test(v));
  if (looksLikePath) {
    const contents = readFile(v);
    if (contents) return contents;
  }
  return inline;
}

function defaultReadFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return ""; // missing/unreadable: fall through to the inline value
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  const org = env.CAVIX_ORG ?? "default";
  const provider = env.CAVIX_LLM_PROVIDER ?? "anthropic";
  const model = env.CAVIX_LLM_MODEL ?? DEFAULT_MODEL;
  const apiKey = env.CAVIX_LLM_API_KEY ?? env.ANTHROPIC_API_KEY ?? "";

  return {
    redis: resolveRedis(env),
    stream: env.CAVIX_STREAM_KEY ?? "cavix:reviewjobs",
    group: env.CAVIX_STREAM_GROUP ?? "cavix-orchestrator",
    consumer: env.CAVIX_CONSUMER_NAME ?? "orchestrator-1",
    github: {
      token: env.CAVIX_GITHUB_TOKEN ?? "",
      baseUrl: env.CAVIX_GITHUB_API ?? "https://api.github.com",
      // Accept the documented names and the common GitHub-ecosystem aliases, so a
      // value pasted under either name works instead of failing silently.
      appId: env.CAVIX_APP_ID ?? env.CAVIX_GITHUB_APP_ID ?? env.GITHUB_APP_ID ?? "",
      privateKey: resolvePrivateKey(env),
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
