import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { DecisionState, Role, Store } from "./store.ts";
import {
  clearCookie,
  constantTimeEqual,
  cookieSecureAttr,
  fingerprint,
  isPlatformAdmin,
  parseCookies,
  sessionCookie,
  sessionFromRequest,
  signSession,
  type SessionPayload,
} from "./auth.ts";
import type { OrgTier } from "./store.ts";
import * as gh from "./github.ts";
import { compileEnglishRule } from "@cavix/policy";
import { Registry } from "@cavix/metrics";
import { explainAttestation, verdictOf, type PurgeCheck, type RetentionAttestation } from "@cavix/zero-retention";
import {
  listAnthropicModels,
  listGoogleModels,
  listOpenAICompatibleModels,
  type ModelInfo,
} from "@cavix/gateway";

/**
 * Ask a provider which models the given key may actually call.
 *
 * Cached briefly: the AI & BYOK page re-renders on every provider switch, and a
 * provider listing endpoint is slower than the rest of the dashboard.
 */
const modelCache = new Map<string, { at: number; models: ModelInfo[] }>();
const MODEL_CACHE_MS = 5 * 60_000;

async function listModelsForProvider(provider: string, apiKey: string): Promise<ModelInfo[]> {
  // Key on a fingerprint, never the raw key.
  const cacheKey = `${provider}:${fingerprint(apiKey)}`;
  const hit = modelCache.get(cacheKey);
  if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.models;

  // Base URLs are overridable so a corporate proxy or an Anthropic-compatible
  // gateway can be pointed at without a code change.
  let models: ModelInfo[];
  switch (provider) {
    case "anthropic":
      models = await listAnthropicModels(apiKey, { baseUrl: process.env.CAVIX_ANTHROPIC_BASE_URL });
      break;
    case "google":
      models = await listGoogleModels(apiKey, { baseUrl: process.env.CAVIX_GOOGLE_BASE_URL });
      break;
    case "openai":
      models = await listOpenAICompatibleModels(apiKey, { baseUrl: process.env.CAVIX_OPENAI_BASE_URL });
      break;
    case "selfhosted": {
      const baseUrl = process.env.CAVIX_SELFHOSTED_URL;
      if (!baseUrl) throw new Error("self-hosted endpoint not configured (set CAVIX_SELFHOSTED_URL)");
      models = await listOpenAICompatibleModels(apiKey, { baseUrl });
      break;
    }
    default:
      throw new Error(`unknown provider "${provider}"`);
  }
  modelCache.set(cacheKey, { at: Date.now(), models });
  return models;
}

// A dependency-free HTTP API + static site server for the Cavix control plane.
// node:http (no framework) keeps it buildable in air-gapped / minimal images.
// It serves:
//   • the marketing + login + dashboard site from ./public (static SPA)
//   • the JSON API under /api/*  (onboarding, reviews, decisions, auth, settings, stats)
// The same routes are what a managed Next.js/NestJS deployment would expose.

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/**
 * This service's own metrics, which are NOT the orchestrator's.
 *
 * Both are needed and they answer different questions. The orchestrator's say
 * whether reviews are being produced; these say whether they are landing. A
 * control-plane rejecting every record looks perfectly healthy from the
 * orchestrator, which logs a warning and carries on BY DESIGN, so a review that
 * never reaches a customer's dashboard is invisible without this.
 *
 * Module-level, because a Prometheus scrape has no way to name a server instance
 * and this process only ever runs one.
 */
const metricsRegistry = new Registry();
const apiRequests = metricsRegistry.counter(
  "cavix_api_requests_total",
  "Control-plane API responses by class (ok, client_error, server_error).",
);
const reviewsRecorded = metricsRegistry.counter(
  "cavix_reviews_recorded_total",
  "Reviews accepted onto the dashboard by outcome (stored, rejected). A steady rejected line means reviews are being produced and lost.",
);
metricsRegistry.gauge("cavix_build_info", "Always 1. The version is the label.").set(1, {
  version: process.env.CAVIX_VERSION ?? "dev",
});

/**
 * Count a response. Status class only: a per-route label would be a per-path
 * time series, and several of these paths carry a workspace name.
 */
function recordApi(status: number): void {
  try {
    apiRequests.inc({ class: status >= 500 ? "server_error" : status >= 400 ? "client_error" : "ok" });
  } catch {
    /* a metric never costs a request */
  }
}

export function createControlPlane(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      await route(store, req, res);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  });
}

async function route(store: Store, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const m = req.method ?? "GET";

  if (m === "GET" && p === "/healthz") return void sendJson(res, 200, { status: "ok" });

  // Stage 13's observability half, for the other service.
  //
  // The control-plane's numbers are DIFFERENT from the orchestrator's and both
  // are needed: this is the process that answers "did the review reach the
  // dashboard", and a dashboard silently rejecting every record looks perfectly
  // healthy from the orchestrator, which logs a warning and carries on by
  // design. Same rule as the orchestrator's: no org, no repo, no path.
  if (m === "GET" && p === "/metrics") {
    if (process.env.CAVIX_METRICS === "off") return void sendJson(res, 404, { error: "metrics are disabled" });
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
    return void res.end(metricsRegistry.render());
  }

  // ---------- API ----------
  if (p.startsWith("/api/")) return void (await apiRoute(store, req, res, url, p, m));

  // ---------- static site ----------
  if (m === "GET" || m === "HEAD") return void (await serveStatic(res, p));

  sendJson(res, 404, { error: `no route for ${m} ${p}` });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function apiRoute(
  store: Store,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  p: string,
  m: string,
): Promise<void> {
  // ----- auth -----
  if (m === "POST" && p === "/api/auth/signup") {
    const body = await readJson(req);
    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "");
    const org = String(body.org ?? "").trim();
    if (!email || !password || !org) return void sendJson(res, 400, { error: "email, password and organization are required" });
    if (password.length < 8) return void sendJson(res, 400, { error: "password must be at least 8 characters" });
    try {
      const user = store.createUser({ email, password, org, name: String(body.name ?? "") });
      const token = signSession({ uid: user.id, email: user.email, org: user.org, role: user.role });
      res.setHeader("Set-Cookie", sessionCookie(token));
      return void sendJson(res, 201, { user });
    } catch (err) {
      return void sendJson(res, 409, { error: (err as Error).message });
    }
  }

  if (m === "POST" && p === "/api/auth/login") {
    const body = await readJson(req);
    const user = store.verifyLogin(String(body.email ?? ""), String(body.password ?? ""));
    if (!user) return void sendJson(res, 401, { error: "invalid email or password" });
    const token = signSession({ uid: user.id, email: user.email, org: user.org, role: user.role });
    res.setHeader("Set-Cookie", sessionCookie(token));
    return void sendJson(res, 200, { user });
  }

  if (m === "POST" && p === "/api/auth/logout") {
    res.setHeader("Set-Cookie", clearCookie());
    return void sendJson(res, 200, { ok: true });
  }

  // ----- Sign in with GitHub (OAuth) -----
  if (m === "GET" && p === "/api/auth/github/start") {
    // Not configured and not in demo mode → tell the user how to enable it, don't fake it.
    if (!gh.githubConfigured() && !gh.demoEnabled()) {
      res.writeHead(302, { location: "/login?error=github_unconfigured" });
      return void res.end();
    }
    const state = gh.newState();
    const redirectUri = `${baseUrl(req)}/api/auth/github/callback`;
    res.setHeader("Set-Cookie", `gh_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${cookieSecureAttr()}`);
    const dest = gh.githubConfigured() ? gh.authorizeUrl(state, redirectUri) : `/api/auth/github/callback?demo=1&state=${state}`;
    res.writeHead(302, { location: dest });
    return void res.end();
  }

  if (m === "GET" && p === "/api/auth/github/callback") {
    const cookies = parseCookies(req.headers.cookie);
    const state = url.searchParams.get("state");
    if (!state || state !== cookies.gh_state) {
      res.writeHead(302, { location: "/login?error=github_state" });
      return void res.end();
    }
    try {
      let profile: { email: string; name: string; login: string };
      let tokens: gh.GitHubTokens | null = null;
      if (gh.githubConfigured() && url.searchParams.get("code")) {
        const redirectUri = `${baseUrl(req)}/api/auth/github/callback`;
        tokens = await gh.exchangeCode(url.searchParams.get("code")!, redirectUri);
        const ghUser = await gh.getUser(tokens.accessToken);
        const email = (await gh.getPrimaryEmail(tokens.accessToken)) ?? `${ghUser.login}@users.noreply.github.com`;
        profile = { email, name: ghUser.name ?? ghUser.login, login: ghUser.login };
      } else if (!gh.githubConfigured() && !gh.demoEnabled()) {
        res.writeHead(302, { location: "/login?error=github_unconfigured" });
        return void res.end();
      } else {
        // demo mode
        profile = { email: gh.DEMO_USER.email!, name: gh.DEMO_USER.name!, login: gh.DEMO_USER.login };
      }
      const orgName = profile.login.toLowerCase();
      const isNew = !store.getUserByEmail(profile.email);
      const user = store.upsertOAuthUser({ email: profile.email, name: profile.name, org: orgName, provider: "github", login: profile.login });
      if (tokens) store.setOAuthToken(user.id, tokens);
      if (isNew) store.startTrial(orgName, 14); // new GitHub signups get a 14-day trial (can connect private repos)
      const session = signSession({ uid: user.id, email: user.email, org: user.org, role: user.role });
      res.writeHead(302, { location: "/app", "set-cookie": sessionCookie(session) });
      return void res.end();
    } catch (err) {
      res.writeHead(302, { location: `/login?error=${encodeURIComponent((err as Error).message)}` });
      return void res.end();
    }
  }

  // Public: what sign-in methods the login page should show.
  if (m === "GET" && p === "/api/auth/providers") {
    return void sendJson(res, 200, { github: gh.githubConfigured(), demo: gh.demoEnabled() });
  }

  if (m === "GET" && p === "/api/auth/me") {
    const s = sessionFromRequest(req);
    if (!s) return void sendJson(res, 401, { error: "not authenticated" });
    const u = store.getUser(s.uid);
    if (!u) return void sendJson(res, 401, { error: "not authenticated" });
    return void sendJson(res, 200, { user: { id: u.id, email: u.email, name: u.name, org: u.org, role: u.role, createdAt: u.createdAt, provider: u.provider, githubLogin: u.githubLogin, platformAdmin: isPlatformAdmin(u.email) } });
  }

  // ----- GitHub connect (list orgs/repos & enable from the site) -----
  if (p.startsWith("/api/github/")) {
    const s = sessionFromRequest(req);
    if (!s) return void sendJson(res, 401, { error: "authentication required" });
    const user = store.getUser(s.uid);
    if (!user) return void sendJson(res, 401, { error: "authentication required" });

    // A usable access token, renewed if it has aged out. Null means the user has
    // to reconnect. Demo fixtures are served ONLY when demo mode is on: a live
    // site showing invented repositories is worse than an honest error.
    const token = await liveGitHubToken(store, user.id);
    const live = gh.githubConfigured() && !!token;
    const demo = !live && gh.demoEnabled();
    /** Neither a real connection nor demo data: the user must reconnect. */
    const needsReconnect = !live && !demo;

    if (m === "GET" && p === "/api/github/status") {
      return void sendJson(res, 200, {
        configured: gh.githubConfigured(),
        // "Connected" means we hold a credential GitHub will accept right now,
        // not that this account was once created through GitHub. Reporting the
        // latter is what left the Repositories page trying live calls with a
        // dead token and showing a raw 401.
        connected: live || demo,
        login: user.githubLogin ?? null,
        demo,
        appSlug: gh.githubConfig().appSlug,
        installUrl: gh.installUrl(),
      });
    }

    // Which orgs have the Cavix GitHub App installed, their repos, and enabled state.
    if (m === "GET" && p === "/api/github/installations") {
      if (needsReconnect) return void sendReconnect(res, user.githubLogin);
      try {
        const ghUser = live ? await gh.getUser(token!) : gh.DEMO_USER;
        const orgs = live ? await gh.getOrgs(token!, ghUser) : gh.demoOrgs();
        const installs = live ? await gh.getInstallations(token!) : gh.demoInstallations();
        const installById = new Map(installs.map((i) => [i.account.login.toLowerCase(), i.id]));
        const enabledSet = new Set(store.listRepos(user.org).filter((r) => r.enabled !== false).map((r) => r.name));

        const out = [];
        for (const o of orgs) {
          const installed = installById.has(o.login.toLowerCase());
          let repos: Array<{ name: string; fullName: string; private: boolean; description: string; language: string; enabled: boolean }> = [];
          if (installed) {
            try {
              const list = live ? await gh.getInstallationRepos(token!, installById.get(o.login.toLowerCase())!) : gh.demoRepos(o.login);
              repos = list.map((r) => ({ name: r.name, fullName: r.full_name, private: r.private, description: r.description ?? "", language: r.language ?? "", enabled: enabledSet.has(r.full_name) }));
            } catch { repos = []; }
          }
          out.push({ login: o.login, isUser: (o.type ?? "Organization") === "User", installed, repos });
        }
        return void sendJson(res, 200, { demo, appSlug: gh.githubConfig().appSlug, installUrl: gh.installUrl(), orgs: out });
      } catch (err) {
        return void sendGitHubError(res, store, user.id, err as Error, user.githubLogin);
      }
    }

    if (m === "GET" && p === "/api/github/orgs") {
      if (needsReconnect) return void sendReconnect(res, user.githubLogin);
      try {
        const orgs = live ? await gh.getOrgs(token!, await gh.getUser(token!)) : gh.demoOrgs();
        return void sendJson(res, 200, orgs.map((o) => ({ login: o.login, description: o.description ?? "", isUser: (o.type ?? "Organization") === "User" })));
      } catch (err) {
        return void sendGitHubError(res, store, user.id, err as Error, user.githubLogin);
      }
    }

    if (m === "GET" && p === "/api/github/repos") {
      if (needsReconnect) return void sendReconnect(res, user.githubLogin);
      const owner = url.searchParams.get("org") ?? user.githubLogin ?? "";
      const isUser = owner.toLowerCase() === (user.githubLogin ?? "").toLowerCase();
      try {
        const repos = live ? await gh.getRepos(token!, owner, isUser) : gh.demoRepos(owner);
        const enabled = new Set(store.listRepos(user.org).filter((r) => r.enabled !== false).map((r) => r.name));
        return void sendJson(res, 200, repos.map((r) => ({
          name: r.name, fullName: r.full_name, private: r.private, description: r.description ?? "", language: r.language ?? "",
          enabled: enabled.has(r.full_name),
        })));
      } catch (err) {
        return void sendGitHubError(res, store, user.id, err as Error, user.githubLogin);
      }
    }

    // Enable Cavix for a repo (toggle ON). Persisted to the store → Postgres.
    if (m === "POST" && p === "/api/github/repos") {
      const body = await readJson(req);
      const fullName = String(body.fullName ?? "");
      if (!fullName.includes("/")) return void sendJson(res, 400, { error: "fullName (owner/repo) required" });
      try {
        const repo = store.setRepoEnabled(user.org, fullName, true, body.private === false ? "public" : "private");
        store.recordMute({ org: user.org, scope: "repo", target: fullName, restored: true });
        return void sendJson(res, 201, { enabled: true, repo });
      } catch (err) {
        return void sendJson(res, 403, { error: (err as Error).message });
      }
    }

    // Disable Cavix for a repo (toggle OFF). Kept in the store as enabled:false.
    if (m === "DELETE" && p === "/api/github/repos") {
      const fullName = url.searchParams.get("fullName") ?? "";
      store.setRepoEnabled(user.org, fullName, false);
      // A repo turned off is the earliest churn signal there is, and nothing was
      // recording it. Reports surfaces these so a falling workspace is visible
      // before the renewal conversation, not during it.
      store.recordMute({ org: user.org, scope: "repo", target: fullName, restored: false });
      return void sendJson(res, 200, { enabled: false });
    }

    return void sendJson(res, 404, { error: `no github route for ${m} ${p}` });
  }

  // ----- founder / platform admin (core team only) -----
  if (p.startsWith("/api/admin/")) {
    const s = sessionFromRequest(req);
    if (!s) return void sendJson(res, 401, { error: "authentication required" });
    if (!isPlatformAdmin(s.email)) return void sendJson(res, 403, { error: "forbidden: platform admin only" });

    if (m === "GET" && p === "/api/admin/orgs") return void sendJson(res, 200, store.listOrgsAdmin());
    if (m === "GET" && p === "/api/admin/stats") return void sendJson(res, 200, store.platformStats());

    const am = /^\/api\/admin\/orgs\/([^/]+)$/.exec(p);
    if (m === "POST" && am) {
      const org = decodeURIComponent(am[1]);
      const body = await readJson(req);
      try {
        if (body.tier === "free" || body.tier === "paid") store.setTier(org, body.tier as OrgTier);
        if (typeof body.trialDays === "number") store.startTrial(org, body.trialDays);
        if (body.endTrial === true) store.endTrial(org);
        if (body.reviewsPerDay === null) store.setReviewLimitOverride(org, null);
        else if (typeof body.reviewsPerDay === "number") store.setReviewLimitOverride(org, body.reviewsPerDay);
        if (typeof body.suspended === "boolean") store.setSuspended(org, body.suspended);
        const updated = store.listOrgsAdmin().find((o) => o.name === org);
        return void sendJson(res, 200, updated ?? { ok: true });
      } catch (err) {
        return void sendJson(res, 404, { error: (err as Error).message });
      }
    }
    return void sendJson(res, 404, { error: `no admin route for ${m} ${p}` });
  }

  // ----- internal service-to-service: the orchestrator fetches an org's BYOK -----
  // Returns the DECRYPTED key, so it's gated by a shared bearer token and is disabled
  // unless CAVIX_INTERNAL_TOKEN is set. Keep this on an internal network in production.
  let im = /^\/api\/internal\/orgs\/([^/]+)\/llm$/.exec(p);
  if (m === "GET" && im) {
    const token = process.env.CAVIX_INTERNAL_TOKEN;
    if (!token) return void sendJson(res, 404, { error: "internal API disabled (set CAVIX_INTERNAL_TOKEN)" });
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!constantTimeEqual(bearer, token)) return void sendJson(res, 401, { error: "unauthorized" });
    const org = decodeURIComponent(im[1]);
    const s = store.getSettings(org);
    return void sendJson(res, 200, { provider: s.llmProvider, model: s.llmModel, apiKey: store.getApiKey(org) ?? "" });
  }

  // Internal: the models an org's key can call. The orchestrator uses this to name
  // real alternatives on the pull request when a review fails because the saved
  // model was retired — far more useful than "go look at the dashboard".
  im = /^\/api\/internal\/orgs\/([^/]+)\/models$/.exec(p);
  if (m === "GET" && im) {
    const token = process.env.CAVIX_INTERNAL_TOKEN;
    if (!token) return void sendJson(res, 404, { error: "internal API disabled (set CAVIX_INTERNAL_TOKEN)" });
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!constantTimeEqual(bearer, token)) return void sendJson(res, 401, { error: "unauthorized" });
    const org = decodeURIComponent(im[1]);
    const s = store.getSettings(org);
    const apiKey = store.getApiKey(org);
    if (!apiKey) return void sendJson(res, 200, { provider: s.llmProvider, models: [] });
    try {
      const models = await listModelsForProvider(s.llmProvider, apiKey);
      return void sendJson(res, 200, { provider: s.llmProvider, models });
    } catch {
      // Best effort: the caller only uses this to enrich an error message.
      return void sendJson(res, 200, { provider: s.llmProvider, models: [] });
    }
  }

  // Internal: persist a model the orchestrator auto-selected after the saved one
  // turned out to be retired. Keeping it here means the next review and the
  // dashboard agree, and the user never has to intervene.
  im = /^\/api\/internal\/orgs\/([^/]+)\/model$/.exec(p);
  if (m === "POST" && im) {
    const token = process.env.CAVIX_INTERNAL_TOKEN;
    if (!token) return void sendJson(res, 404, { error: "internal API disabled (set CAVIX_INTERNAL_TOKEN)" });
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!constantTimeEqual(bearer, token)) return void sendJson(res, 401, { error: "unauthorized" });
    const org = decodeURIComponent(im[1]);
    const body = await readJson(req);
    const llmModel = String(body.llmModel ?? "");
    if (!llmModel) return void sendJson(res, 400, { error: "llmModel required" });
    const updated = store.updateSettings(org, { llmModel });
    return void sendJson(res, 200, { llmModel: updated.llmModel });
  }

  // Internal: everything the orchestrator must obey for this org's reviews.
  //
  // One call, one source of truth. These are the switches the repo owner flipped
  // in the dashboard — verification, where the summary goes, the pre-merge gate,
  // whether Cavix may request changes. The orchestrator has no defaults of its
  // own for them: what the owner chose on the site is what runs.
  im = /^\/api\/internal\/orgs\/([^/]+)\/review-config$/.exec(p);
  if (m === "GET" && im) {
    const token = process.env.CAVIX_INTERNAL_TOKEN;
    if (!token) return void sendJson(res, 404, { error: "internal API disabled (set CAVIX_INTERNAL_TOKEN)" });
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!constantTimeEqual(bearer, token)) return void sendJson(res, 401, { error: "unauthorized" });
    const org = decodeURIComponent(im[1]);
    const s = store.getSettings(org);
    // Stage 12 rides along here rather than on an endpoint of its own. The
    // orchestrator makes this call once per review and caches it; a separate
    // one would have added a control-plane round trip to every pull request in
    // the deployment for a number that only changes when a human clicks Accept.
    // Best-effort: a calibration that cannot be computed costs this review its
    // learned bars, never the review.
    let thresholdByCategory: Record<string, number> = {};
    try {
      thresholdByCategory = store.calibration(org).thresholdByCategory;
    } catch {
      /* the orchestrator falls back to Stage 9's own default */
    }
    return void sendJson(res, 200, {
      verifyFindings: s.verifyFindings,
      summaryInDescription: s.summaryInDescription,
      requestChangesOnFail: s.requestChangesOnFail,
      failOn: s.failOn,
      autoReview: s.autoReview,
      reviewDraftPRs: s.reviewDraftPRs,
      preMergeChecks: s.preMergeChecks,
      pathFilters: s.pathFilters,
      reviewSections: s.reviewSections,
      tone: s.tone,
      thresholdByCategory,
    });
  }

  // Internal: this workspace's GitLab access token.
  //
  // GitHub needs no equivalent, because a GitHub App mints its own short-lived
  // installation token and the orchestrator holds the private key. GitLab has
  // nothing like that, so a bot authenticates with a token an owner pasted, and
  // it is stored per workspace (encrypted) rather than per deployment: one
  // shared token would read every customer's repositories.
  im = /^\/api\/internal\/orgs\/([^/]+)\/(gitlab|bitbucket)-token$/.exec(p);
  if (m === "GET" && im) {
    const token = process.env.CAVIX_INTERNAL_TOKEN;
    if (!token) return void sendJson(res, 404, { error: "internal API disabled (set CAVIX_INTERNAL_TOKEN)" });
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!constantTimeEqual(bearer, token)) return void sendJson(res, 401, { error: "unauthorized" });
    const org = decodeURIComponent(im[1]);
    const platform = im[2];
    const saved = platform === "gitlab" ? store.getGitLabToken(org) : store.getBitbucketToken(org);
    // 404 rather than 200-with-null: the orchestrator must fail loudly on a
    // missing credential, not carry on and make an unauthenticated request that
    // surfaces later as a confusing 401 on somebody's merge request.
    if (!saved) return void sendJson(res, 404, { error: `no ${platform} token saved for "${org}"` });
    return void sendJson(res, 200, { token: saved });
  }

  // Execution gatekeeper: is this "owner/repo" enabled for review in the dashboard?
  if (m === "GET" && p === "/api/internal/repos/enabled") {
    const token = process.env.CAVIX_INTERNAL_TOKEN;
    if (!token) return void sendJson(res, 404, { error: "internal API disabled (set CAVIX_INTERNAL_TOKEN)" });
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!constantTimeEqual(bearer, token)) return void sendJson(res, 401, { error: "unauthorized" });
    const fullName = url.searchParams.get("fullName") ?? "";
    // `org` is the WORKSPACE that enabled the repo. The orchestrator needs it to
    // load that workspace's BYOK key — the GitHub owner login is a different name.
    const found = store.lookupRepo(fullName);
    if (!found) return void sendJson(res, 200, { enabled: false });

    // The daily limit and the suspension flag are decided HERE, before the
    // orchestrator fetches a diff or calls a model.
    //
    // They used to be checked only when the finished review was recorded, which
    // is after the tokens are spent and the comment is already on the pull
    // request. A suspended workspace kept getting full reviews and simply stopped
    // appearing on its own dashboard, which is the worst of the three possible
    // behaviours: the customer sees Cavix working and sees nothing to show for it,
    // and we pay for the privilege.
    const limit = store.effectiveReviewsPerDay(found.org);
    if (store.reviewCountSince(found.org, 24 * 3600_000) >= limit) {
      const tier = store.getOrg(found.org)?.tier ?? "paid";
      return void sendJson(res, 200, {
        enabled: false,
        org: found.org,
        reason:
          limit === 0
            ? "This workspace is suspended. Contact support to re-enable reviews."
            : `This workspace has used its ${limit} reviews for today (${tier} tier). Reviews resume tomorrow, or upgrade for a higher limit.`,
      });
    }
    return void sendJson(res, 200, { enabled: true, org: found.org });
  }

  // ----- Stage 5: the cross-repo contract graph -----
  //
  // The control-plane stores it; the ORCHESTRATOR builds it. That split is not
  // arbitrary: only the orchestrator holds GitHub App installation tokens, which
  // are the one credential that can read a private repository without borrowing
  // a human's OAuth token, and only the control-plane has Postgres and knows
  // which repositories a workspace has connected.
  const graphRoute = /^\/api\/internal\/orgs\/([^/]+)\/graph$/.exec(p);
  if (graphRoute) {
    const token = process.env.CAVIX_INTERNAL_TOKEN;
    if (!token) return void sendJson(res, 404, { error: "internal API disabled (set CAVIX_INTERNAL_TOKEN)" });
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!constantTimeEqual(bearer, token)) return void sendJson(res, 401, { error: "unauthorized" });
    const org = decodeURIComponent(graphRoute[1]);

    if (m === "GET") {
      const stored = store.orgGraph(org);
      // A workspace nobody has indexed yet is an ordinary state, not an error:
      // the first review on a repository is what populates it.
      return void sendJson(res, 200, stored ?? { graph: null, indexedAt: {} });
    }
    if (m === "PUT") {
      const body = await readJson(req);
      const repo = String(body.repo ?? "");
      if (!repo) return void sendJson(res, 400, { error: "repo required" });
      // Only for repositories this workspace actually connected. Without the
      // check, anything holding the internal token could write a graph naming
      // repositories the workspace has no relationship with, and those names
      // would then be quoted back on its pull requests.
      if (!store.lookupRepo(repo)) return void sendJson(res, 403, { error: `${repo} is not connected to a workspace` });
      return void sendJson(res, 200, store.saveOrgGraph(org, repo, body.graph ?? null));
    }
    return void sendJson(res, 405, { error: `no graph route for ${m}` });
  }

  // ----- Stage 6: CI telemetry -----
  //
  // Same split and the same reasoning as the contract graph above: the
  // orchestrator holds the credential that can read a private repository's
  // Actions history, the control-plane holds the storage.
  const telemetryRoute = /^\/api\/internal\/orgs\/([^/]+)\/telemetry$/.exec(p);
  if (telemetryRoute) {
    const token = process.env.CAVIX_INTERNAL_TOKEN;
    if (!token) return void sendJson(res, 404, { error: "internal API disabled (set CAVIX_INTERNAL_TOKEN)" });
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!constantTimeEqual(bearer, token)) return void sendJson(res, 401, { error: "unauthorized" });
    const org = decodeURIComponent(telemetryRoute[1]);

    if (m === "GET") return void sendJson(res, 200, store.ciHistory(org));
    if (m === "PUT") {
      const body = await readJson(req);
      const repo = String(body.repo ?? "");
      if (!repo) return void sendJson(res, 400, { error: "repo required" });
      if (!store.lookupRepo(repo)) return void sendJson(res, 403, { error: `${repo} is not connected to a workspace` });
      const runs = Array.isArray(body.runs) ? body.runs : [];
      return void sendJson(res, 200, store.saveCiHistory(org, repo, runs));
    }
    return void sendJson(res, 405, { error: `no telemetry route for ${m}` });
  }

  // ----- orgs / onboarding (unauthenticated create kept for API/tests & GitHub App onboarding) -----
  if (m === "POST" && p === "/api/orgs") {
    const body = await readJson(req);
    if (!body.name) return void sendJson(res, 400, { error: "name required" });
    const tier = body.tier === "free" ? "free" : "paid";
    return void sendJson(res, 201, store.createOrg(String(body.name), { tier, provenFeedOptIn: body.provenFeedOptIn === true }));
  }
  // Your own workspace, which is what the Billing page needs. Listing every org
  // on the platform here told any visitor who all the customers were, and what
  // tier each of them was on.
  if (m === "GET" && p === "/api/orgs") {
    const s = sessionFromRequest(req);
    if (!s) return void sendJson(res, 401, { error: "authentication required" });
    if (isPlatformAdmin(s.email)) return void sendJson(res, 200, store.listOrgs());
    const own = store.getOrg(s.org);
    return void sendJson(res, 200, own ? [own] : []);
  }

  let mm = /^\/api\/orgs\/([^/]+)\/repos$/.exec(p);
  if (mm) {
    const org = decodeURIComponent(mm[1]);
    if (m === "GET") return void sendJson(res, 200, store.listRepos(org));
    if (m === "POST") {
      const body = await readJson(req);
      if (!body.name) return void sendJson(res, 400, { error: "name required" });
      const visibility = body.visibility === "public" ? "public" : "private";
      try {
        return void sendJson(res, 201, store.createRepo(org, String(body.name), { visibility }));
      } catch (err) {
        return void sendJson(res, 403, { error: (err as Error).message });
      }
    }
  }

  mm = /^\/api\/orgs\/([^/]+)\/repos\/([^/]+)$/.exec(p);
  if (m === "DELETE" && mm) {
    const auth = requireOrg(req, res, decodeURIComponent(mm[1]));
    if (!auth) return;
    const ok = store.removeRepo(decodeURIComponent(mm[1]), decodeURIComponent(mm[2]));
    return void sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "no such repo" });
  }

  mm = /^\/api\/orgs\/([^/]+)\/proven-feed$/.exec(p);
  if (m === "POST" && mm) {
    const body = await readJson(req);
    try {
      store.setProvenFeedOptIn(decodeURIComponent(mm[1]), body.optIn === true);
      return void sendJson(res, 200, { ok: true });
    } catch {
      return void sendJson(res, 404, { error: "no such org" });
    }
  }

  // ----- settings / BYOK (auth required, must match caller's org) -----
  mm = /^\/api\/orgs\/([^/]+)\/settings$/.exec(p);
  if (mm) {
    const org = decodeURIComponent(mm[1]);
    const auth = requireOrg(req, res, org);
    if (!auth) return;
    if (m === "GET") return void sendJson(res, 200, store.getSettings(org));
    if (m === "PUT" || m === "PATCH") {
      const body = await readJson(req);
      return void sendJson(res, 200, store.updateSettings(org, body as Record<string, never>));
    }
  }

  // Does each plain-English pre-merge rule actually compile into a deterministic
  // check? Writing a rule that silently never runs is the worst outcome for a
  // gate, so the dashboard shows compile status per rule as you type.
  mm = /^\/api\/orgs\/([^/]+)\/policy\/compile$/.exec(p);
  if (m === "POST" && mm) {
    const org = decodeURIComponent(mm[1]);
    const auth = requireOrg(req, res, org);
    if (!auth) return;
    const body = await readJson(req);
    const rules: string[] = Array.isArray(body.rules) ? body.rules.map(String) : [];
    return void sendJson(
      res,
      200,
      rules.map((text) => {
        const r = compileEnglishRule(text);
        return r.ok
          ? { text, ok: true, ruleId: r.rule.id, title: r.rule.title, severity: r.rule.severity, matcher: r.matcher }
          : { text, ok: false, error: r.error };
      }),
    );
  }

  // The workspace's GitLab access token. Owners and admins only: it is a
  // credential that can read every repository the token's own account can.
  mm = /^\/api\/orgs\/([^/]+)\/(gitlab|bitbucket)-token$/.exec(p);
  if (mm) {
    const org = decodeURIComponent(mm[1]);
    const platform = mm[2];
    const auth = requireOrg(req, res, org, ["owner", "admin"]);
    if (!auth) return;
    const set = (t: string) => (platform === "gitlab" ? store.setGitLabToken(org, t) : store.setBitbucketToken(org, t));
    const get = () => (platform === "gitlab" ? store.getGitLabToken(org) : store.getBitbucketToken(org));
    const clear = () => (platform === "gitlab" ? store.clearGitLabToken(org) : store.clearBitbucketToken(org));
    if (m === "POST") {
      const body = await readJson(req);
      const raw = String(body.token ?? "");
      if (!raw.trim()) return void sendJson(res, 400, { error: "token required" });
      try {
        set(raw);
        // Never echoed back, not even to the person who just set it. A
        // fingerprint is enough to confirm which one is stored.
        return void sendJson(res, 200, { connected: true, fingerprint: fingerprint(raw.trim()) });
      } catch (err) {
        return void sendJson(res, 400, { error: (err as Error).message });
      }
    }
    if (m === "DELETE") {
      clear();
      return void sendJson(res, 200, { connected: false });
    }
    if (m === "GET") {
      const saved = get();
      return void sendJson(res, 200, {
        connected: !!saved,
        ...(saved ? { fingerprint: fingerprint(saved) } : {}),
      });
    }
  }

  mm = /^\/api\/orgs\/([^/]+)\/apikey$/.exec(p);
  if (m === "POST" && mm) {
    const org = decodeURIComponent(mm[1]);
    const auth = requireOrg(req, res, org);
    if (!auth) return;
    const body = await readJson(req);
    const key = String(body.apiKey ?? "");
    if (!key) return void sendJson(res, 400, { error: "apiKey required" });
    try {
      const s = store.setApiKey(org, key);
      return void sendJson(res, 200, { apiKeyFingerprint: s.apiKeyFingerprint, apiKeySetAt: s.apiKeySetAt });
    } catch (err) {
      return void sendJson(res, 400, { error: (err as Error).message });
    }
  }

  // Live model discovery: ask the PROVIDER which models this org's key may use.
  // A hardcoded dropdown drifts — providers retire models and gate others by
  // plan or account age, and picking one you cannot call only surfaces later as
  // a failed review ("this model is no longer available to new users").
  mm = /^\/api\/orgs\/([^/]+)\/models$/.exec(p);
  if (m === "GET" && mm) {
    const org = decodeURIComponent(mm[1]);
    const auth = requireOrg(req, res, org);
    if (!auth) return;
    const settings = store.getSettings(org);
    const provider = url.searchParams.get("provider") || settings.llmProvider;
    const apiKey = store.getApiKey(org);
    if (!apiKey) {
      return void sendJson(res, 200, {
        provider,
        models: [],
        source: "none",
        reason: "Save an API key first, then Cavix can list the models it unlocks.",
      });
    }
    try {
      const models = await listModelsForProvider(provider, apiKey);
      return void sendJson(res, 200, { provider, models, source: "live" });
    } catch (err) {
      // Never fail the settings page over this — the UI falls back to its
      // built-in list and shows why the live list is unavailable.
      return void sendJson(res, 200, {
        provider,
        models: [],
        source: "error",
        reason: (err as Error).message.slice(0, 300),
      });
    }
  }

  // ----- team -----
  mm = /^\/api\/orgs\/([^/]+)\/team$/.exec(p);
  if (m === "GET" && mm) {
    const org = decodeURIComponent(mm[1]);
    const auth = requireOrg(req, res, org);
    if (!auth) return;
    return void sendJson(res, 200, store.listTeam(org));
  }
  mm = /^\/api\/orgs\/([^/]+)\/team\/([^/]+)\/role$/.exec(p);
  if (m === "POST" && mm) {
    const org = decodeURIComponent(mm[1]);
    const auth = requireOrg(req, res, org, ["owner", "admin"]);
    if (!auth) return;
    const body = await readJson(req);
    try {
      return void sendJson(res, 200, store.setRole(org, decodeURIComponent(mm[2]), body.role as Role));
    } catch (err) {
      return void sendJson(res, 404, { error: (err as Error).message });
    }
  }

  // ----- stats -----
  mm = /^\/api\/orgs\/([^/]+)\/stats$/.exec(p);
  if (m === "GET" && mm) {
    const org = decodeURIComponent(mm[1]);
    const auth = requireOrg(req, res, org);
    if (!auth) return;
    return void sendJson(res, 200, store.stats(org));
  }

  // Trends, ROI and the per-repo rollup. Separate from /stats because it walks
  // the whole window rather than returning counters, and the Overview page does
  // not need it.
  mm = /^\/api\/orgs\/([^/]+)\/analytics$/.exec(p);
  if (m === "GET" && mm) {
    const org = decodeURIComponent(mm[1]);
    const auth = requireOrgMember(req, res, org);
    if (!auth) return;
    const raw = Number(url.searchParams.get("days") ?? "30");
    // Clamp: an unbounded `days` lets any member walk the store for as long as
    // the process has been up, one request at a time.
    const days = Number.isFinite(raw) ? Math.min(90, Math.max(7, Math.round(raw))) : 30;
    return void sendJson(res, 200, store.analytics(org, days));
  }

  // ----- reviews -----
  //
  // This is the endpoint the orchestrator calls after it posts a review, and it
  // is the only reason the dashboard has anything on it. It authenticates as the
  // service (the shared internal token) rather than as a user, because no human
  // session exists at the moment a webhook-driven review finishes.
  if (m === "POST" && p === "/api/reviews") {
    const body = await readJson(req);
    const org = String(body.org ?? "");
    if (!org) return void sendJson(res, 400, { error: "org required" });
    if (!canWriteReview(req, org)) {
      return void sendJson(res, 401, { error: "authentication required to record a review" });
    }
    const tier = store.getOrg(org)?.tier ?? "paid";
    const limit = store.effectiveReviewsPerDay(org);
    if (store.reviewCountSince(org, 24 * 3600_000) >= limit) {
      const reason = limit === 0 ? "organization is suspended" : `rate limit reached for ${tier} tier (${limit}/day)`;
      // A review that was produced and then dropped. The orchestrator logs a
      // warning and carries on by design, so without this the loss is silent.
      reviewsRecorded.inc({ outcome: "rejected" });
      return void sendJson(res, 429, { error: reason });
    }
    // Only ever an https link. An attacker-controlled URL here would otherwise
    // become a javascript: link rendered inside the dashboard.
    const link = safeReviewUrl(body.url);
    reviewsRecorded.inc({ outcome: "stored" });
    const record = store.saveReview({
      org,
      repo: String(body.repo),
      pr: Number(body.pr),
      title: String(body.title ?? ""),
      ...(link ? { url: link } : {}),
      findings: Array.isArray(body.findings) ? body.findings : [],
      // What the review cost and how it ran. The orchestrator has always known
      // these; until now it never sent them, so the dashboard could say what
      // Cavix found and never what finding it cost.
      ...(typeof body.costUsd === "number" ? { costUsd: body.costUsd } : {}),
      ...(body.model ? { model: String(body.model) } : {}),
      ...(typeof body.durationMs === "number" ? { durationMs: body.durationMs } : {}),
      ...(typeof body.verifiedCount === "number" ? { verifiedCount: body.verifiedCount } : {}),
      ...(typeof body.suppressedCount === "number" ? { suppressedCount: body.suppressedCount } : {}),
      // Stage 13. Narrowed rather than trusted: this is retained for years and
      // shown to a customer's auditor, so anything the orchestrator did not
      // promise to send is dropped here rather than stored forever.
      ...(coerceRetention(body.retention) ? { retention: coerceRetention(body.retention)! } : {}),
    });
    return void sendJson(res, 201, record);
  }
  // A workspace's reviews are its own. Without the session check any visitor
  // could read every finding Cavix has ever raised on a private repo by guessing
  // an org name.
  if (m === "GET" && p === "/api/reviews") {
    const scope = reviewScope(req, url.searchParams.get("org"));
    if ("error" in scope) return void sendJson(res, scope.status, { error: scope.error });
    return void sendJson(res, 200, store.listReviews(scope.org).map(withRetentionExplain));
  }

  // Stage 13 — one review's retention proof, on its own.
  //
  // A separate endpoint because a compliance request is not a dashboard visit:
  // an auditor asks about one review from four months ago and wants the artefact
  // rather than the findings. Same workspace scoping as the review itself.
  mm = /^\/api\/reviews\/([^/]+)\/retention$/.exec(p);
  if (m === "GET" && mm) {
    const r = store.getReview(mm[1]);
    if (!r) return void sendJson(res, 404, { error: "not found" });
    const scope = reviewScope(req, r.org);
    if ("error" in scope) return void sendJson(res, scope.status, { error: scope.error });
    if (!r.retention) {
      // An honest 404. A review from before this shipped has no proof, and
      // inventing a "clean" one for it would be the worst possible lie to tell
      // in exactly the document a regulator reads.
      return void sendJson(res, 404, {
        error: "this review predates retention attestation, so none was recorded",
      });
    }
    return void sendJson(res, 200, { ...r.retention, explain: explainAttestation(r.retention) });
  }

  mm = /^\/api\/reviews\/([^/]+)$/.exec(p);
  if (m === "GET" && mm) {
    const r = store.getReview(mm[1]);
    if (!r) return void sendJson(res, 404, { error: "not found" });
    const scope = reviewScope(req, r.org);
    if ("error" in scope) return void sendJson(res, scope.status, { error: scope.error });
    return void sendJson(res, 200, withRetentionExplain(r));
  }

  // ----- findings & decisions -----
  mm = /^\/api\/findings\/([^/]+)$/.exec(p);
  if (m === "GET" && mm) {
    const f = store.getFinding(mm[1]);
    return f ? void sendJson(res, 200, f) : void sendJson(res, 404, { error: "not found" });
  }

  // Accepting or rejecting a finding is what the learning loop trains on, so the
  // decision has to belong to a real person in the workspace that owns it. The
  // name is taken from the session, never from the request body: a client that
  // can name anyone can attribute a rejection to a colleague.
  mm = /^\/api\/findings\/([^/]+)\/decision$/.exec(p);
  if (m === "POST" && mm) {
    const body = await readJson(req);
    const state = body.state as DecisionState;
    if (state !== "accepted" && state !== "rejected") {
      return void sendJson(res, 400, { error: "state must be accepted|rejected" });
    }
    const finding = store.getFinding(mm[1]);
    if (!finding) return void sendJson(res, 404, { error: "no such finding" });
    const review = store.getReview(finding.reviewId);
    const s = sessionFromRequest(req);
    if (!s) return void sendJson(res, 401, { error: "authentication required" });
    if (review && review.org !== s.org && !isPlatformAdmin(s.email)) {
      return void sendJson(res, 403, { error: "forbidden: not a member of this organization" });
    }
    return void sendJson(res, 200, store.recordDecision(mm[1], state, s.email));
  }

  // The Learnings page: what THIS workspace has taught Cavix. Unscoped, it showed
  // other customers' decisions and their reviewers' email addresses, under a
  // heading claiming they were your team's.
  if (m === "GET" && p === "/api/decisions") {
    const s = sessionFromRequest(req);
    if (!s) {
      // The learning loop reads this as a service, across every workspace.
      if (!internalAuthorized(req)) return void sendJson(res, 401, { error: "authentication required" });
      return void sendJson(res, 200, store.listDecisions());
    }
    if (isPlatformAdmin(s.email)) return void sendJson(res, 200, store.listDecisions());
    const mine = new Set(store.listReviews(s.org, Number.MAX_SAFE_INTEGER).map((r) => r.id));
    return void sendJson(res, 200, store.listDecisions().filter((d) => mine.has(d.reviewId)));
  }

  // What those decisions actually changed, in this workspace's own numbers.
  //
  // The same object the orchestrator receives, so the Learnings page cannot
  // describe a calibration that differs from the one running on the pull
  // requests. That is the entire reason it is one function in the store rather
  // than a second derivation written for the UI.
  mm = /^\/api\/orgs\/([^/]+)\/calibration$/.exec(p);
  if (m === "GET" && mm) {
    const org = decodeURIComponent(mm[1]);
    const auth = requireOrgMember(req, res, org);
    if (!auth) return;
    return void sendJson(res, 200, store.calibration(org));
  }
  if (m === "GET" && p === "/api/feed/proven") return void sendJson(res, 200, store.provenFeed());

  sendJson(res, 404, { error: `no route for ${m} ${p}` });
}

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GitHub session credentials
// ---------------------------------------------------------------------------

/**
 * An access token GitHub will accept right now, or null if the user has to
 * reconnect.
 *
 * A GitHub App's user token lives 8 hours. Cavix uses one App for both sign-in
 * and installs, so every GitHub-backed page started failing with
 * "GitHub API /user → 401" a working day after sign-in, and the dashboard
 * reported it as a 502 as though GitHub were down. Renewing here, in the one
 * place every route reads the token from, keeps that invisible to the user:
 * they stay signed in for as long as the refresh token lives (six months).
 */
async function liveGitHubToken(store: Store, userId: string): Promise<string | null> {
  const tokens = store.getOAuthToken(userId);
  if (!tokens) return null;

  const expired = typeof tokens.expiresAt === "number" && tokens.expiresAt <= Date.now();
  if (!expired) return tokens.accessToken;
  // Expired with nothing to renew from (a classic OAuth App token, or one saved
  // before refresh support): it is spent, and only the user can fix that.
  if (!tokens.refreshToken || !gh.githubConfigured()) {
    store.clearOAuthToken(userId);
    return null;
  }
  try {
    const fresh = await gh.refreshTokens(tokens.refreshToken);
    // GitHub rotates the refresh token on use, so keep whichever it just gave us.
    store.setOAuthToken(userId, { ...fresh, refreshToken: fresh.refreshToken ?? tokens.refreshToken });
    return fresh.accessToken;
  } catch {
    // The refresh token is spent too (six months old, or the user uninstalled
    // the app). Forget it so the UI offers "Connect" instead of failing forever.
    store.clearOAuthToken(userId);
    return null;
  }
}

/**
 * Ask the user to reconnect, in the shape the dashboard knows how to render.
 *
 * Unless there is nothing to reconnect TO: a deployment with no GitHub App
 * configured cannot complete the flow, so offering the button would send the
 * user in a circle. Name the missing configuration instead, because on a
 * self-hosted Cavix the person reading this is the one who can fix it.
 */
function sendReconnect(res: http.ServerResponse, login?: string): void {
  if (!gh.githubConfigured()) {
    return void sendJson(res, 503, {
      error:
        "GitHub is not configured on this deployment. Set CAVIX_GITHUB_CLIENT_ID and " +
        "CAVIX_GITHUB_CLIENT_SECRET (or CAVIX_DEMO=true for sample data).",
    });
  }
  sendJson(res, 401, {
    error: login
      ? `Your GitHub connection for @${login} has expired. Reconnect to see your repositories.`
      : "Connect your GitHub account to see your repositories.",
    reconnect: true,
  });
}

/**
 * Report a failed GitHub call honestly.
 *
 * A rejected credential is the user's to fix and says so (and the dead token is
 * dropped, so the next page load offers Connect rather than failing the same way
 * again). Anything else really is GitHub being unavailable, and stays a 502.
 */
function sendGitHubError(
  res: http.ServerResponse,
  store: Store,
  userId: string,
  err: Error,
  login?: string,
): void {
  if (err instanceof gh.GitHubAuthError) {
    store.clearOAuthToken(userId);
    return void sendReconnect(res, login);
  }
  sendJson(res, 502, { error: `GitHub is not responding: ${err.message}` });
}

/**
 * Does this request carry the shared service token?
 *
 * False whenever no token is configured: a deployment that never set one has no
 * service identity to check against, and treating "no token" as "any token" is
 * how an internal API becomes a public one.
 */
function internalAuthorized(req: http.IncomingMessage): boolean {
  const token = process.env.CAVIX_INTERNAL_TOKEN;
  if (!token) return false;
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  return constantTimeEqual(bearer, token);
}

/**
 * May this request record a review against `org`?
 *
 * The orchestrator authenticates as a service (no human session exists when a
 * webhook-driven review finishes); a signed-in user may record against their own
 * workspace. A deployment with no CAVIX_INTERNAL_TOKEN at all is a local or
 * self-hosted one with no service identity to check, so the endpoint stays open
 * there rather than becoming impossible to call.
 */
function canWriteReview(req: http.IncomingMessage, org: string): boolean {
  if (internalAuthorized(req)) return true;
  const s = sessionFromRequest(req);
  if (s && s.org === org) return true;
  return !process.env.CAVIX_INTERNAL_TOKEN;
}

/** Which org's reviews a request may read, or why it may not read any. */
type ReviewScope = { org: string | undefined } | { error: string; status: number };

/**
 * Reviews carry findings from private repositories, so reading them is scoped to
 * the caller's own workspace. Platform admins (and the service token) may name
 * another org; nobody else can.
 */
function reviewScope(req: http.IncomingMessage, requested: string | null): ReviewScope {
  const s = sessionFromRequest(req);
  if (!s) {
    return internalAuthorized(req)
      ? { org: requested ?? undefined }
      : { error: "authentication required", status: 401 };
  }
  if (isPlatformAdmin(s.email)) return { org: requested ?? undefined };
  if (requested && requested !== s.org) {
    return { error: "forbidden: not a member of this organization", status: 403 };
  }
  return { org: s.org };
}

/**
 * Accept a review link only if it is a plain https URL. The dashboard renders it
 * as an href, so `javascript:` and friends never get stored in the first place.
 */
function safeReviewUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (url.length > 500 || !/^https:\/\/[^\s"'<>]+$/i.test(url)) return null;
  return url;
}

/** Require a valid session whose org matches `org` (and optionally a role). */
/**
 * Attach the human sentence to a review's attestation on the way out.
 *
 * Derived rather than stored: it is a pure function of the checks, and a stored
 * copy is a second version of the same claim that can drift from the evidence
 * underneath it. That drift is exactly what an auditor would catch.
 */
function withRetentionExplain<T extends { retention?: RetentionAttestation }>(review: T): T {
  if (!review.retention) return review;
  return { ...review, retention: { ...review.retention, explain: explainAttestation(review.retention) } };
}

/**
 * Narrow a retention attestation off the wire.
 *
 * An allow-list, and deliberately strict, because this record is kept for years
 * and handed to a customer's auditor. Anything the orchestrator did not promise
 * to send is dropped rather than stored forever: an artefact whose whole claim
 * is "we retained nothing" must not become the thing that retained a workspace
 * path because a future field was passed through without anyone looking.
 */
function coerceRetention(value: unknown): RetentionAttestation | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const org = typeof v.org === "string" ? v.org : "";
  if (!org) return null;

  const checks: PurgeCheck[] = [];
  for (const raw of Array.isArray(v.checks) ? v.checks : []) {
    if (typeof raw !== "object" || raw === null) continue;
    const c = raw as Record<string, unknown>;
    const status = c.status;
    if (status !== "purged" && status !== "residual" && status !== "unverifiable") continue;
    checks.push({
      backend: String(c.backend ?? "unknown").slice(0, 40),
      check: String(c.check ?? "").slice(0, 300),
      status,
      ...(typeof c.residualCount === "number" && Number.isFinite(c.residualCount)
        ? { residualCount: Math.max(0, Math.round(c.residualCount)) }
        : {}),
    });
  }

  // The verdict is RECOMPUTED, never taken from the wire. A caller that could
  // assert "proven" over a set of checks that do not support it would be able to
  // manufacture the exact claim this artefact exists to make.
  return {
    org,
    at: typeof v.at === "string" && !Number.isNaN(Date.parse(v.at)) ? v.at : new Date().toISOString(),
    sandboxes: checks.length,
    checks,
    verdict: verdictOf(checks),
  };
}

/**
 * A signed-in member of this workspace, or a platform admin, for READ-ONLY
 * workspace data. Any role will do: everyone on a team can look at the reports.
 *
 * This existed only as two call sites and no definition, so
 * `GET /api/orgs/:org/analytics` threw a ReferenceError on every request and the
 * Reports page has been answering 500 since it shipped. It went unnoticed
 * because `services/control-plane` was missing from the tsconfig `include` list,
 * so `npx tsc --noEmit` never looked at this file. Both halves are fixed.
 */
function requireOrgMember(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  org: string,
): SessionPayload | null {
  const s = sessionFromRequest(req);
  if (!s) {
    sendJson(res, 401, { error: "authentication required" });
    return null;
  }
  if (s.org !== org && !isPlatformAdmin(s.email)) {
    sendJson(res, 403, { error: "forbidden: not a member of this organization" });
    return null;
  }
  return s;
}

function requireOrg(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  org: string,
  roles?: Role[],
): SessionPayload | null {
  const s = sessionFromRequest(req);
  if (!s) {
    sendJson(res, 401, { error: "authentication required" });
    return null;
  }
  if (s.org !== org) {
    sendJson(res, 403, { error: "forbidden: not a member of this organization" });
    return null;
  }
  if (roles && !roles.includes(s.role as Role)) {
    sendJson(res, 403, { error: `forbidden: requires role ${roles.join(" or ")}` });
    return null;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

async function serveStatic(res: http.ServerResponse, urlPath: string): Promise<void> {
  // Client-side routes that should all return the dashboard shell.
  const appRoutes = new Set(["/app", "/dashboard"]);
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  if (appRoutes.has(urlPath) || urlPath.startsWith("/app/")) rel = "/app.html";
  if (urlPath === "/login" || urlPath === "/signup") rel = "/login.html";
  if (urlPath === "/docs" || urlPath.startsWith("/docs/")) rel = "/docs.html";

  // Resolve safely inside PUBLIC_DIR (block path traversal).
  const resolved = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    return void sendText(res, 403, "forbidden");
  }
  try {
    const data = await readFile(resolved);
    const ext = path.extname(resolved);
    // Always revalidate: during active development a cached stylesheet/script makes
    // it look like "nothing changed". no-store guarantees the browser fetches fresh.
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store, must-revalidate" });
    res.end(data);
  } catch {
    // SPA fallback: unknown non-file path → serve the marketing index.
    if (!path.extname(resolved)) {
      try {
        const data = await readFile(path.join(PUBLIC_DIR, "index.html"));
        res.writeHead(200, { "content-type": MIME[".html"] });
        return void res.end(data);
      } catch { /* fall through */ }
    }
    sendText(res, 404, "not found");
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 5_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, obj: unknown): void {
  // Every JSON response passes through here, so this is the one place that sees
  // them all. Counting at each route would mean the next route added is the one
  // that is not counted.
  recordApi(code);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function sendText(res: http.ServerResponse, code: number, text: string): void {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

/** Public base URL for OAuth redirects — CAVIX_PUBLIC_URL, else inferred from the request. */
function baseUrl(req: http.IncomingMessage): string {
  const configured = gh.githubConfig().publicUrl;
  if (configured) return configured;
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() || "http";
  const host = req.headers.host || "127.0.0.1:8088";
  return `${proto}://${host}`;
}
