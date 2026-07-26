import { createSign } from "node:crypto";
import type { TokenProvider } from "./rest.ts";

// GitHub App authentication. A GitHub App cannot call the API with a static
// secret: it signs a short-lived RS256 JWT with its private key, then exchanges
// that JWT for a per-installation access token (valid ~60 min).
//
// This is the provider the product actually runs on — installing the Cavix App on
// a repo is the whole onboarding flow, and an App install never yields a PAT. It
// uses node:crypto only, consistent with the repo's dependency-free stance.

/** Normalize a PEM pasted into an env var (Render/Railway often escape newlines). */
export function normalizePrivateKey(raw: string): string {
  let key = raw.trim();
  // Some dashboards wrap the whole value in quotes.
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  // A PEM pasted as a single line keeps its newlines as the two characters \ and n.
  if (key.includes("\\n")) key = key.replace(/\\n/g, "\n");
  // Base64 of a whole PEM file is also a common way to smuggle it through env vars.
  if (!key.includes("-----BEGIN") && /^[A-Za-z0-9+/=\s]+$/.test(key)) {
    const decoded = Buffer.from(key.replace(/\s/g, ""), "base64").toString("utf8");
    if (decoded.includes("-----BEGIN")) key = decoded;
  }
  return key.replace(/\r\n/g, "\n").trim();
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint an App JWT (RS256). GitHub allows at most 10 minutes; we use 9 and
 * backdate `iat` by 60s so a slightly fast clock doesn't get rejected.
 */
export function createAppJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${base64url(signer.sign(privateKeyPem))}`;
}

export interface GitHubAppOptions {
  appId: string;
  privateKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  logger?: { info: (msg: string, meta?: Record<string, unknown>) => void };
}

interface CachedToken {
  token: string;
  /** Epoch ms at which we stop trusting it (real expiry minus a safety margin). */
  expiresAt: number;
}

/**
 * Exchanges the App JWT for installation tokens and caches them per installation
 * until shortly before they expire.
 */
export class GitHubAppTokenProvider implements TokenProvider {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly logger?: GitHubAppOptions["logger"];
  private readonly cache = new Map<number, CachedToken>();
  /** In-flight mints, so a burst of parallel calls makes one token request. */
  private readonly inflight = new Map<number, Promise<string>>();

  constructor(opts: GitHubAppOptions) {
    this.appId = String(opts.appId).trim();
    this.privateKey = normalizePrivateKey(opts.privateKey);
    this.baseUrl = opts.baseUrl ?? "https://api.github.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userAgent = opts.userAgent ?? "cavix-orchestrator";
    this.logger = opts.logger;

    if (!this.appId) throw new Error("github app: CAVIX_APP_ID is empty");
    if (!this.privateKey.includes("-----BEGIN")) {
      throw new Error(
        "github app: CAVIX_APP_PRIVATE_KEY is not a PEM private key — paste the whole .pem file contents, including the BEGIN/END lines",
      );
    }
  }

  async token(installationId: number): Promise<string> {
    if (!installationId) {
      throw new Error(
        "github app: webhook carried no installation id — is the Cavix App installed on this repository?",
      );
    }
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const pending = this.inflight.get(installationId);
    if (pending) return pending;

    const mint = this.mint(installationId).finally(() => this.inflight.delete(installationId));
    this.inflight.set(installationId, mint);
    return mint;
  }

  private async mint(installationId: number): Promise<string> {
    const jwt = createAppJwt(this.appId, this.privateKey);
    const res = await this.fetchImpl(`${this.baseUrl}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": this.userAgent,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // 401 here almost always means the App id and the private key don't belong
      // to the same App, so say that rather than echoing a bare status code.
      const hint =
        res.status === 401
          ? " (check that CAVIX_APP_ID and CAVIX_APP_PRIVATE_KEY come from the SAME GitHub App)"
          : res.status === 404
            ? " (the App is not installed on that account, or the installation id is stale)"
            : "";
      throw new Error(
        `github app: installation token HTTP ${res.status} ${res.statusText}${hint}: ${detail.slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as { token: string; expires_at: string };
    const realExpiry = Date.parse(data.expires_at);
    // Renew a minute early so a token never expires mid-review.
    const expiresAt = Number.isFinite(realExpiry) ? realExpiry - 60_000 : Date.now() + 50 * 60_000;
    this.cache.set(installationId, { token: data.token, expiresAt });
    this.logger?.info("github app: minted installation token", {
      installation_id: installationId,
      expires_at: data.expires_at,
    });
    return data.token;
  }
}
