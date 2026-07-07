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

import { randomBytes } from "node:crypto";

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

export function authorizeUrl(state: string, redirectUri: string): string {
  const c = githubConfig();
  const q = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri,
    scope: c.scopes.split(",").join(" "),
    state,
    allow_signup: "true",
  });
  return `${GH_OAUTH}/authorize?${q.toString()}`;
}

/** The one-time GitHub App install page (GitHub requires this consent screen). */
export function installUrl(): string {
  return `https://github.com/apps/${githubConfig().appSlug}/installations/new`;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<string> {
  const c = githubConfig();
  const res = await fetch(`${GH_OAUTH}/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: redirectUri }),
  });
  const data = (await res.json()) as { access_token?: string; error_description?: string };
  if (!data.access_token) throw new Error(data.error_description ?? "GitHub token exchange failed");
  return data.access_token;
}

async function ghGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${GH_API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "cavix" },
  });
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
  account: { login: string; type?: string };
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
    { id: 101, account: { login: "aryanghai12", type: "User" } },
    { id: 102, account: { login: "cavix-labs", type: "Organization" } },
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
