import { createSign } from "node:crypto";
import type { TokenProvider } from "./rest.ts";

// GitHub App authentication. A GitHub App cannot call the API with a static
// secret: it signs a short-lived RS256 JWT with its private key, then exchanges
// that JWT for a per-installation access token (valid ~60 min).
//
// This is the provider the product actually runs on — installing the Cavix App on
// a repo is the whole onboarding flow, and an App install never yields a PAT. It
// uses node:crypto only, consistent with the repo's dependency-free stance.

/** PEM wrappers we can rebuild a key into. GitHub hands out PKCS#1 ("RSA PRIVATE
 *  KEY"); some tooling converts to PKCS#8 ("PRIVATE KEY"). Node reads both. */
const PEM_LABELS = ["RSA PRIVATE KEY", "PRIVATE KEY"] as const;

/** Re-wrap a bare base64 body into a PEM block with 64-char lines. */
function wrapPem(body: string, label: string): string {
  const lines = body.replace(/[^A-Za-z0-9+/=]/g, "").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** Can node actually sign with this? The only test that means anything. */
export function canSign(pem: string): boolean {
  try {
    const s = createSign("RSA-SHA256");
    s.update("cavix-probe");
    s.end();
    s.sign(pem);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a private key pasted into an env var, then verify it can sign.
 *
 * Hosting dashboards mangle PEMs in a handful of predictable ways and each one
 * produces a service that boots fine and then fails on every review, so we
 * repair them here instead of demanding a perfect paste:
 *   - wrapped in quotes;
 *   - newlines escaped as the two characters \ and n;
 *   - newlines flattened to SPACES by a single-line input (the common one);
 *   - the whole .pem base64-encoded;
 *   - header/footer lines lost entirely, leaving just the base64 body.
 * Returns "" if nothing we can do produces a usable key.
 */
export function normalizePrivateKey(raw: string): string {
  let key = (raw ?? "").trim();
  if (!key) return "";

  // Some dashboards keep the surrounding quotes as part of the value.
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }
  key = key.replace(/\\r/g, "").replace(/\\n/g, "\n").replace(/\r\n?/g, "\n").trim();

  // Straightforward case: it already is a PEM and node accepts it.
  if (canSign(key)) return key;

  // The whole file, base64-encoded.
  if (!key.includes("-----BEGIN") && /^[A-Za-z0-9+/=_\-\s]+$/.test(key)) {
    const decoded = Buffer.from(key.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, ""), "base64").toString("utf8");
    if (decoded.includes("-----BEGIN") && canSign(decoded)) return decoded;
  }

  // A PEM whose newlines became spaces: pull the label and the body back out and
  // re-wrap it properly. This is what a single-line env-var input does to a paste.
  const marked = /-----BEGIN ([A-Z ]+?)-----([\s\S]*?)-----END \1-----/.exec(key);
  if (marked) {
    const rebuilt = wrapPem(marked[2], marked[1].trim());
    if (canSign(rebuilt)) return rebuilt;
  }

  // Header and footer lost: we have only the base64 body. Try each label.
  const body = key.replace(/-----[^-]*-----/g, "").replace(/\s/g, "");
  if (body.length > 100 && /^[A-Za-z0-9+/=]+$/.test(body)) {
    for (const label of PEM_LABELS) {
      const rebuilt = wrapPem(body, label);
      if (canSign(rebuilt)) return rebuilt;
    }
  }

  return "";
}

/**
 * A safe description of what we actually received, for logs. Never reveals key
 * material: only shape. Without this, "not a PEM" is unactionable.
 */
export function describeKeyMaterial(raw: string): string {
  const v = raw ?? "";
  if (!v.trim()) return "empty";
  const parts = [
    `${v.length} chars`,
    `${v.split("\n").length} line(s)`,
    v.includes("-----BEGIN") ? "has BEGIN marker" : "NO BEGIN marker",
    v.includes("-----END") ? "has END marker" : "NO END marker",
  ];
  if (v.includes("\\n")) parts.push("contains literal \\n");
  return parts.join(", ");
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

  /**
   * A credential problem is recorded, NOT thrown. Throwing here killed the whole
   * process at boot: the health server never bound a port, the deploy failed,
   * and the Redis consumer never started, so a one-line env-var typo took the
   * entire service down. Now the service stays up and each affected review
   * reports the problem on its own PR (the confused reaction + a comment).
   */
  readonly configError: string | null = null;

  constructor(opts: GitHubAppOptions) {
    this.appId = String(opts.appId ?? "").trim();
    this.privateKey = normalizePrivateKey(opts.privateKey ?? "");
    this.baseUrl = opts.baseUrl ?? "https://api.github.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userAgent = opts.userAgent ?? "cavix-orchestrator";
    this.logger = opts.logger;

    if (!this.appId) {
      this.configError = "github app: CAVIX_APP_ID is empty";
    } else if (!/^\d+$/.test(this.appId)) {
      // A frequent mix-up: pasting the Client ID (Iv1.abc…) instead of the App ID.
      this.configError =
        `github app: CAVIX_APP_ID should be the numeric "App ID" from the GitHub App's General page, got "${this.appId}". ` +
        "The Client ID (starts with Iv1. or Iv23) is a different value.";
    } else if (!this.privateKey) {
      this.configError =
        "github app: CAVIX_APP_PRIVATE_KEY could not be read as an RSA private key. Paste the ENTIRE .pem file " +
        "you downloaded from the GitHub App page, including the -----BEGIN and -----END lines. " +
        `Received: ${describeKeyMaterial(opts.privateKey ?? "")}.`;
    }
  }

  async token(installationId: number): Promise<string> {
    if (this.configError) throw new Error(this.configError);
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
