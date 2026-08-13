// GitHub connection: "Sign in with GitHub", list the user's orgs + repos, and
// enable repos for review — all from the Cavix site (the CodeRabbit-style flow).
//
// Two modes, chosen automatically:
//   • REAL   — when CAVIX_GITHUB_OAUTH_CLIENT_ID/SECRET are set, we run the real
//              OAuth code exchange and call the GitHub REST API with the user token.
//   • DEMO   — when they're not set, we return realistic fixture orgs/repos so the
//              whole experience works with zero setup (great for trials/screens).
//
// Dependency-free: uses the global fetch + node:crypto only.

import { createHash, randomBytes } from "node:crypto";

const GH_API = "https://api.github.com";
const GH_OAUTH = "https://github.com/login/oauth";

export interface GitHubConfig {
  clientId: string;
  clientSecret: string;
  scopes: string;
  publicUrl: string;
  appSlug: string;
}

export function githubConfig(): GitHubConfig {
  return {
    // ONE GitHub App powers both sign-in (OAuth) and bot installs. Prefer the unified
    // CAVIX_GITHUB_CLIENT_ID/SECRET; fall back to the older OAuth-specific names.
    clientId: process.env.CAVIX_GITHUB_CLIENT_ID ?? process.env.CAVIX_GITHUB_OAUTH_CLIENT_ID ?? "",
    clientSecret: process.env.CAVIX_GITHUB_CLIENT_SECRET ?? process.env.CAVIX_GITHUB_OAUTH_CLIENT_SECRET ?? "",
    scopes: process.env.CAVIX_GITHUB_OAUTH_SCOPES ?? "read:org,user:email,repo",
    // Auto-detect the public URL on managed hosts (Render sets RENDER_EXTERNAL_URL),
    // so the OAuth redirect_uri is correct with no manual config.
    publicUrl: (process.env.CAVIX_PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, ""),
    appSlug: process.env.CAVIX_GITHUB_APP_SLUG ?? "cavix",
  };
}

export function githubConfigured(): boolean {
  const c = githubConfig();
  return !!(c.clientId && c.clientSecret);
}

/**
 * Whether demo mode (seeded workspace + fake "Sign in with GitHub") is on. OFF in
 * production so a live site is empty and uses real auth. Defaults ON only for local
 * dev (no DATABASE_URL, not on a managed host). Force with CAVIX_DEMO=true|false.
 */
export function demoEnabled(): boolean {
  if (process.env.CAVIX_DEMO === "true") return true;
  if (process.env.CAVIX_DEMO === "false") return false;
  return !process.env.DATABASE_URL && !process.env.RENDER && !process.env.CAVIX_DATABASE_URL;
}

/** True when session cookies should carry the Secure flag (HTTPS site). */
export function secureCookies(): boolean {
  if (process.env.CAVIX_SECURE_COOKIES === "true") return true;
  if (process.env.CAVIX_SECURE_COOKIES === "false") return false;
  return (process.env.CAVIX_PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").startsWith("https");
}

export function newState(): string {
  return randomBytes(16).toString("hex");
}

/**
 * The SIGN-IN leg, and only the sign-in leg.
 *
 * This grant is about the person, not their repositories. GitHub is explicit
 * that the two are independent: "You can install a GitHub App without
 * authorizing the app. Similarly, you can authorize the app without installing
 * the app." Authorization grants access to the signed-in user's account, which
 * is why this screen has no repository picker on it and never has had. The
 * picker lives in the INSTALL flow, `installUrl` below.
 *
 * This is the whole reason "Continue with GitHub" appeared to do nothing: it
 * completes an account grant the user already made, so GitHub honours it and
 * redirects straight back. That is OAuth working, not a bug, and no parameter
 * added here will produce a repository consent screen.
 *
 * `scope` is deliberately absent. A GitHub App user token does not use scopes,
 * it uses the App's registered fine-grained permissions, so the parameter is
 * discarded on arrival. Sending it looked like an access control and was not
 * one, which is worse than sending nothing.
 */
export function authorizeUrl(state: string, redirectUri: string, codeChallenge?: string): string {
  const c = githubConfig();
  const q = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri,
    state,
    allow_signup: "true",
    // Documented, and it fixes a real failure that is not the one above: a user
    // with a personal and a work account gets silently signed in as whichever
    // GitHub saw last. It forces the account chooser. It does NOT restore the
    // permission screen and it shows no repositories.
    prompt: "select_account",
  });
  if (codeChallenge) {
    q.set("code_challenge", codeChallenge);
    q.set("code_challenge_method", "S256");
  }
  return `${GH_OAUTH}/authorize?${q.toString()}`;
}

export interface InstallUrlOptions {
  /** CSRF token, echoed back to the setup callback. */
  state?: string;
  /** Numeric account id to install onto, skipping the account chooser. */
  targetId?: number;
  targetType?: "User" | "Organization";
}

/**
 * The INSTALL leg: the screen this product needs and was not using.
 *
 * GitHub renders the account chooser, the "All repositories" / "Only select
 * repositories" control, and the permission list here. Unlike the authorize
 * screen it is re-enterable: an installation is a configuration rather than a
 * one-time token exchange, so there is no cached decision to short-circuit and
 * the picker appears every single time. That is why competitors appear to
 * "force" consent. They are not forcing anything, they are using this door.
 */
export function installUrl(options: InstallUrlOptions = {}): string {
  const slug = githubConfig().appSlug;
  const q = new URLSearchParams();
  if (options.state) q.set("state", options.state);
  if (options.targetId) {
    // Pre-targeted: straight to the permission and repository picker for one
    // account, so somebody who already chose "acme-inc" in Cavix does not have
    // to choose it again on GitHub.
    q.set("target_id", String(options.targetId));
    q.set("target_type", options.targetType ?? "Organization");
    const qs = q.toString();
    return `https://github.com/apps/${slug}/installations/new/permissions${qs ? `?${qs}` : ""}`;
  }
  const qs = q.toString();
  return `https://github.com/apps/${slug}/installations/new${qs ? `?${qs}` : ""}`;
}

/**
 * The settings page for an existing installation, where the repository picker
 * lives once the app is already installed.
 *
 * GitHub hands this back on the installation object as `html_url`, and using it
 * is better than constructing one: the path differs between a user account and
 * an organisation, and getting it wrong sends somebody to a 404 in the middle of
 * the one flow that matters.
 */
export function configureUrl(install: GitHubInstallation): string {
  if (install.html_url) return install.html_url;
  const login = install.account.login;
  return install.account.type === "User"
    ? `https://github.com/settings/installations/${install.id}`
    : `https://github.com/organizations/${login}/settings/installations/${install.id}`;
}

/**
 * What GitHub hands back for a signed-in user.
 *
 * A GitHub App's user token EXPIRES (8 hours by default) and arrives with a
 * refresh token that is good for six months. Keeping only the access token is
 * why the dashboard started answering "GitHub API /user → 401" a working day
 * after sign-in: the token had simply aged out and nothing renewed it.
 *
 * A classic OAuth App issues a non-expiring token and no refresh token, so both
 * extra fields are optional and the code path is the same either way.
 */
export interface GitHubTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Absent means "does not expire" (classic OAuth App). */
  expiresAt?: number;
}

/**
 * GitHub rejected the credential itself: it expired, was revoked, or the user
 * removed the app. Distinct from "GitHub is down", because the only cure is for
 * the user to reconnect, and telling them to do that is the whole job.
 */
export class GitHubAuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "GitHubAuthError";
    this.status = status;
  }
}

interface TokenPayload {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error_description?: string;
  error?: string;
}

function toTokens(data: TokenPayload): GitHubTokens {
  return {
    accessToken: data.access_token!,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    // Renew a minute early: a token that expires mid-request is a 401 the user sees.
    ...(data.expires_in ? { expiresAt: Date.now() + (data.expires_in - 60) * 1000 } : {}),
  };
}

async function tokenRequest(body: Record<string, string>): Promise<TokenPayload> {
  const res = await fetch(`${GH_OAUTH}/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as TokenPayload;
}

export async function exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<GitHubTokens> {
  const c = githubConfig();
  const data = await tokenRequest({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    code,
    redirect_uri: redirectUri,
    ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
  });
  if (!data.access_token) throw new Error(data.error_description ?? "GitHub token exchange failed");
  return toTokens(data);
}

/** PKCE: a verifier to keep, and the challenge to send. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Revoke this user's authorization outright.
 *
 * The ONLY mechanism GitHub offers that genuinely forces a full consent screen
 * next time: it deletes the grant and, with it, every token issued under it. So
 * it is bound to an explicit "Disconnect" and to nothing else. Using it to make
 * a screen reappear for a working user would destroy their session and their
 * refresh token to fix a cosmetic complaint.
 *
 * Note what it does NOT do: it does not uninstall the App. Only an account owner
 * can do that, from GitHub. The UI has to say which of the two happened, or the
 * user believes Cavix has lost access it still has.
 */
export async function revokeGrant(accessToken: string): Promise<void> {
  const c = githubConfig();
  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64");
  const res = await fetch(`${GH_API}/applications/${c.clientId}/grant`, {
    method: "DELETE",
    headers: {
      authorization: `Basic ${basic}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "cavix",
    },
    body: JSON.stringify({ access_token: accessToken }),
  });
  // 204 is revoked. 404 means there was nothing to revoke, which is the same end
  // state and must not be reported to the user as a failure.
  if (res.status !== 204 && res.status !== 404) {
    throw new Error(`GitHub refused to revoke this authorization (${res.status})`);
  }
}

/**
 * Trade a refresh token for a fresh access token.
 *
 * Throws GitHubAuthError when the refresh token itself is spent (expired after
 * six months, or revoked when the user uninstalled the app): there is no way
 * back from that except signing in again.
 */
export async function refreshTokens(refreshToken: string): Promise<GitHubTokens> {
  const c = githubConfig();
  const data = await tokenRequest({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (!data.access_token) {
    throw new GitHubAuthError(data.error_description ?? "GitHub refused to refresh this session");
  }
  return toTokens(data);
}

async function ghGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${GH_API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "cavix" },
  });
  if (res.status === 401) {
    throw new GitHubAuthError(`GitHub rejected this account's credentials (${path})`);
  }
  if (!res.ok) throw new Error(`GitHub API ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export interface GitHubUser { login: string; name: string | null; email: string | null; avatar_url: string; }
export interface GitHubOrg { login: string; avatar_url: string; description?: string | null; type?: string; }
export interface GitHubRepo { name: string; full_name: string; private: boolean; description: string | null; language: string | null; owner: { login: string }; }

export async function getUser(token: string): Promise<GitHubUser> {
  return ghGet<GitHubUser>(token, "/user");
}
export async function getPrimaryEmail(token: string): Promise<string | null> {
  try {
    const emails = await ghGet<Array<{ email: string; primary: boolean; verified: boolean }>>(token, "/user/emails");
    return (emails.find((e) => e.primary && e.verified) ?? emails[0])?.email ?? null;
  } catch {
    return null;
  }
}
/** The user's personal account plus every org they belong to. */
export async function getOrgs(token: string, user: GitHubUser): Promise<GitHubOrg[]> {
  const orgs = await ghGet<GitHubOrg[]>(token, "/user/orgs");
  return [{ login: user.login, avatar_url: user.avatar_url, type: "User", description: "Your personal repositories" }, ...orgs];
}
/** Repos for an owner (the user's own, or an org's). */
export async function getRepos(token: string, owner: string, isUser: boolean): Promise<GitHubRepo[]> {
  const path = isUser ? "/user/repos?per_page=100&sort=updated&affiliation=owner" : `/orgs/${owner}/repos?per_page=100&sort=updated`;
  const repos = await ghGet<GitHubRepo[]>(token, path);
  return isUser ? repos.filter((r) => r.owner.login === owner) : repos;
}

// ---------------------------------------------------------------------------
// GitHub App installations (which orgs have Cavix installed, and their repos)
// ---------------------------------------------------------------------------

export interface GitHubInstallation {
  id: number;
  account: { login: string; type?: string; id?: number };
  /**
   * The configure page for this installation: GitHub's repository picker for an
   * account that already has Cavix installed.
   *
   * It has always been in GitHub's response and was thrown away by not being
   * declared here, which left the dashboard with no way to send anybody back to
   * the picker once the first install was done.
   */
  html_url?: string;
  /**
   * "all" or "selected", and it is load-bearing.
   *
   * "all" means repositories created in future are automatically in scope.
   * "selected" means the set is exactly what was picked. Inferring reach from a
   * repository snapshot instead gets the first case permanently wrong.
   */
  repository_selection?: "all" | "selected";
  suspended_at?: string | null;
}

/** Installations of THIS GitHub App that the signed-in user can access. */
export async function getInstallations(token: string): Promise<GitHubInstallation[]> {
  const data = await ghGet<{ installations: GitHubInstallation[] }>(token, "/user/installations?per_page=100");
  return data.installations ?? [];
}

/** Repositories the user can access within a given installation. */
export async function getInstallationRepos(token: string, installationId: number): Promise<GitHubRepo[]> {
  const data = await ghGet<{ repositories: GitHubRepo[] }>(token, `/user/installations/${installationId}/repositories?per_page=100`);
  return data.repositories ?? [];
}

// In demo mode, pretend the app is installed on the personal account + cavix-labs,
// but NOT on acme-inc (so the "Install Cavix" button is demonstrated).
export function demoInstallations(): GitHubInstallation[] {
  return [
    {
      id: 101,
      account: { login: "aryanghai12", type: "User", id: 9001 },
      repository_selection: "selected",
      html_url: "https://github.com/settings/installations/101",
    },
    {
      id: 102,
      account: { login: "cavix-labs", type: "Organization", id: 9002 },
      repository_selection: "all",
      html_url: "https://github.com/organizations/cavix-labs/settings/installations/102",
    },
  ];
}

// ---------------------------------------------------------------------------
// DEMO fixtures (used when OAuth isn't configured)
// ---------------------------------------------------------------------------

export const DEMO_USER: GitHubUser = { login: "aryanghai12", name: "Aryan Ghai", email: "demo@cavix.dev", avatar_url: "" };

export function demoOrgs(): GitHubOrg[] {
  return [
    { login: "aryanghai12", avatar_url: "", type: "User", description: "Your personal repositories" },
    { login: "cavix-labs", avatar_url: "", type: "Organization", description: "Cavix Labs" },
    { login: "acme-inc", avatar_url: "", type: "Organization", description: "Acme, Inc." },
  ];
}

export function demoRepos(org: string): GitHubRepo[] {
  const mk = (name: string, priv: boolean, lang: string, desc: string): GitHubRepo => ({ name, full_name: `${org}/${name}`, private: priv, description: desc, language: lang, owner: { login: org } });
  if (org === "cavix-labs") return [
    mk("payments-api", true, "TypeScript", "Billing & refunds service"),
    mk("web-dashboard", true, "TypeScript", "Customer dashboard"),
    mk("infra", true, "HCL", "Terraform + Helm"),
  ];
  if (org === "acme-inc") return [
    mk("checkout", true, "Go", "Checkout microservice"),
    mk("orders", true, "Go", "Orders service"),
    mk("mobile-app", true, "Kotlin", "Android app"),
  ];
  return [
    mk("portfolio", false, "JavaScript", "Personal site"),
    mk("dotfiles", false, "Shell", "Config files"),
    mk("cavix-experiments", true, "Python", "Weekend hacks"),
  ];
}
