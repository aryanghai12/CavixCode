import crypto from "node:crypto";
import { httpJson } from "./types.ts";

// GitHub App authentication. A GitHub App proves itself by signing a short-lived
// JWT with its private key (RS256), then exchanging that JWT for a per-INSTALLATION
// access token. Cavix uses installation tokens so it only ever has the exact
// permissions each customer granted — no personal PATs. Pure node:crypto; no SDK.

export interface AppTokenProviderOptions {
  appId: string | number;
  /** The App's PEM private key (from the App settings). Never logged. */
  privateKeyPem: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms) for deterministic tests. */
  now?: () => number;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export class AppTokenProvider {
  private readonly appId: string;
  private readonly privateKeyPem: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<number, CachedToken>();

  constructor(opts: AppTokenProviderOptions) {
    this.appId = String(opts.appId);
    this.privateKeyPem = opts.privateKeyPem;
    this.base = opts.baseUrl ?? "https://api.github.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** A signed App JWT (valid ~9 min), used to mint installation tokens. */
  mintJwt(): string {
    const iat = Math.floor(this.now() / 1000) - 30; // clock-skew cushion
    const header = { alg: "RS256", typ: "JWT" };
    const payload = { iat, exp: iat + 540, iss: this.appId };
    const signingInput = `${b64url(header)}.${b64url(payload)}`;
    const sig = crypto.sign("RSA-SHA256", Buffer.from(signingInput), crypto.createPrivateKey(this.privateKeyPem));
    return `${signingInput}.${sig.toString("base64url")}`;
  }

  /** A per-installation access token, minted on demand and cached until expiry. */
  async token(installationId: number): Promise<string> {
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAtMs - this.now() > 60_000) return cached.token;

    const { body } = await httpJson(this.fetchImpl, `${this.base}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.mintJwt()}`, accept: "application/vnd.github+json", "user-agent": "cavix" },
    });
    const data = body as { token: string; expires_at: string };
    this.cache.set(installationId, { token: data.token, expiresAtMs: Date.parse(data.expires_at) });
    return data.token;
  }
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
