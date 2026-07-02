import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { DecisionState, Role, Store } from "./store.ts";
import {
  clearCookie,
  isPlatformAdmin,
  parseCookies,
  sessionCookie,
  sessionFromRequest,
  signSession,
  type SessionPayload,
} from "./auth.ts";
import type { OrgTier } from "./store.ts";
import * as gh from "./github.ts";

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
    const state = gh.newState();
    const redirectUri = `${baseUrl(req)}/api/auth/github/callback`;
    res.setHeader("Set-Cookie", `gh_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
    // Real OAuth when configured; otherwise a demo callback so the flow works with no setup.
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
      let token: string | null = null;
      if (gh.githubConfigured() && url.searchParams.get("code")) {
        const redirectUri = `${baseUrl(req)}/api/auth/github/callback`;
        token = await gh.exchangeCode(url.searchParams.get("code")!, redirectUri);
        const ghUser = await gh.getUser(token);
        const email = (await gh.getPrimaryEmail(token)) ?? `${ghUser.login}@users.noreply.github.com`;
        profile = { email, name: ghUser.name ?? ghUser.login, login: ghUser.login };
      } else {
        // demo mode
        profile = { email: gh.DEMO_USER.email!, name: gh.DEMO_USER.name!, login: gh.DEMO_USER.login };
      }
      const orgName = profile.login.toLowerCase();
      const isNew = !store.getUserByEmail(profile.email);
      const user = store.upsertOAuthUser({ email: profile.email, name: profile.name, org: orgName, provider: "github", login: profile.login });
      if (token) store.setOAuthToken(user.id, token);
      if (isNew) store.startTrial(orgName, 14); // new GitHub signups get a 14-day trial (can connect private repos)
      const session = signSession({ uid: user.id, email: user.email, org: user.org, role: user.role });
      res.writeHead(302, { location: "/app", "set-cookie": sessionCookie(session) });
      return void res.end();
    } catch (err) {
      res.writeHead(302, { location: `/login?error=${encodeURIComponent((err as Error).message)}` });
      return void res.end();
    }
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
    const token = store.getOAuthToken(user.id);
    const live = gh.githubConfigured() && !!token;

    if (m === "GET" && p === "/api/github/status") {
      return void sendJson(res, 200, {
        configured: gh.githubConfigured(),
        connected: user.provider === "github" || !!token,
        login: user.githubLogin ?? null,
        demo: !live,
        installUrl: gh.installUrl(),
      });
    }

    if (m === "GET" && p === "/api/github/orgs") {
      try {
        const orgs = live ? await gh.getOrgs(token!, await gh.getUser(token!)) : gh.demoOrgs();
        return void sendJson(res, 200, orgs.map((o) => ({ login: o.login, description: o.description ?? "", isUser: (o.type ?? "Organization") === "User" })));
      } catch (err) {
        return void sendJson(res, 502, { error: `GitHub: ${(err as Error).message}` });
      }
    }

    if (m === "GET" && p === "/api/github/repos") {
      const owner = url.searchParams.get("org") ?? user.githubLogin ?? "";
      const isUser = owner.toLowerCase() === (user.githubLogin ?? "").toLowerCase();
      try {
        const repos = live ? await gh.getRepos(token!, owner, isUser) : gh.demoRepos(owner);
        const enabled = new Set(store.listRepos(user.org).map((r) => r.name));
        return void sendJson(res, 200, repos.map((r) => ({
          name: r.name, fullName: r.full_name, private: r.private, description: r.description ?? "", language: r.language ?? "",
          enabled: enabled.has(r.full_name),
        })));
      } catch (err) {
        return void sendJson(res, 502, { error: `GitHub: ${(err as Error).message}` });
      }
    }

    if (m === "POST" && p === "/api/github/repos") {
      const body = await readJson(req);
      const fullName = String(body.fullName ?? "");
      if (!fullName.includes("/")) return void sendJson(res, 400, { error: "fullName (owner/repo) required" });
      try {
        const repo = store.createRepo(user.org, fullName, { visibility: body.private === false ? "public" : "private" });
        return void sendJson(res, 201, { enabled: true, repo });
      } catch (err) {
        return void sendJson(res, 403, { error: (err as Error).message });
      }
    }

    if (m === "DELETE" && p === "/api/github/repos") {
      const fullName = url.searchParams.get("fullName") ?? "";
      const ok = store.removeRepo(user.org, fullName);
      return void sendJson(res, ok ? 200 : 404, ok ? { enabled: false } : { error: "not connected" });
    }

    return void sendJson(res, 404, { error: `no github route for ${m} ${p}` });
  }

  // ----- founder / platform admin (core team only) -----
  if (p.startsWith("/api/admin/")) {
    const s = sessionFromRequest(req);
    if (!s) return void sendJson(res, 401, { error: "authentication required" });
    if (!isPlatformAdmin(s.email)) return void sendJson(res, 403, { error: "forbidden: platform admin only" });

    if (m === "GET" && p === "/api/admin/orgs") return void sendJson(res, 200, store.listOrgsAdmin());

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

  // ----- orgs / onboarding (unauthenticated create kept for API/tests & GitHub App onboarding) -----
  if (m === "POST" && p === "/api/orgs") {
    const body = await readJson(req);
    if (!body.name) return void sendJson(res, 400, { error: "name required" });
    const tier = body.tier === "free" ? "free" : "paid";
    return void sendJson(res, 201, store.createOrg(String(body.name), { tier, provenFeedOptIn: body.provenFeedOptIn === true }));
  }
  if (m === "GET" && p === "/api/orgs") return void sendJson(res, 200, store.listOrgs());

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
    const auth = requireOrg(req, res, store, decodeURIComponent(mm[1]));
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
    const auth = requireOrg(req, res, store, org);
    if (!auth) return;
    if (m === "GET") return void sendJson(res, 200, store.getSettings(org));
    if (m === "PUT" || m === "PATCH") {
      const body = await readJson(req);
      return void sendJson(res, 200, store.updateSettings(org, body as Record<string, never>));
    }
  }

  mm = /^\/api\/orgs\/([^/]+)\/apikey$/.exec(p);
  if (m === "POST" && mm) {
    const org = decodeURIComponent(mm[1]);
    const auth = requireOrg(req, res, store, org);
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

  // ----- team -----
  mm = /^\/api\/orgs\/([^/]+)\/team$/.exec(p);
  if (m === "GET" && mm) {
    const org = decodeURIComponent(mm[1]);
    const auth = requireOrg(req, res, store, org);
    if (!auth) return;
    return void sendJson(res, 200, store.listTeam(org));
  }
  mm = /^\/api\/orgs\/([^/]+)\/team\/([^/]+)\/role$/.exec(p);
  if (m === "POST" && mm) {
    const org = decodeURIComponent(mm[1]);
    const auth = requireOrg(req, res, store, org, ["owner", "admin"]);
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
    const auth = requireOrg(req, res, store, org);
    if (!auth) return;
    return void sendJson(res, 200, store.stats(org));
  }

  // ----- reviews -----
  if (m === "POST" && p === "/api/reviews") {
    const body = await readJson(req);
    const org = String(body.org);
    const tier = store.getOrg(org)?.tier ?? "paid";
    const limit = store.effectiveReviewsPerDay(org);
    if (store.reviewCountSince(org, 24 * 3600_000) >= limit) {
      const reason = limit === 0 ? "organization is suspended" : `rate limit reached for ${tier} tier (${limit}/day)`;
      return void sendJson(res, 429, { error: reason });
    }
    const record = store.saveReview({
      org,
      repo: String(body.repo),
      pr: Number(body.pr),
      title: String(body.title ?? ""),
      findings: Array.isArray(body.findings) ? body.findings : [],
    });
    return void sendJson(res, 201, record);
  }
  if (m === "GET" && p === "/api/reviews") {
    return void sendJson(res, 200, store.listReviews(url.searchParams.get("org") ?? undefined));
  }

  mm = /^\/api\/reviews\/([^/]+)$/.exec(p);
  if (m === "GET" && mm) {
    const r = store.getReview(mm[1]);
    return r ? void sendJson(res, 200, r) : void sendJson(res, 404, { error: "not found" });
  }

  // ----- findings & decisions -----
  mm = /^\/api\/findings\/([^/]+)$/.exec(p);
  if (m === "GET" && mm) {
    const f = store.getFinding(mm[1]);
    return f ? void sendJson(res, 200, f) : void sendJson(res, 404, { error: "not found" });
  }

  mm = /^\/api\/findings\/([^/]+)\/decision$/.exec(p);
  if (m === "POST" && mm) {
    const body = await readJson(req);
    const state = body.state as DecisionState;
    if (state !== "accepted" && state !== "rejected") {
      return void sendJson(res, 400, { error: "state must be accepted|rejected" });
    }
    try {
      const updated = store.recordDecision(mm[1], state, String(body.user ?? "unknown"));
      return void sendJson(res, 200, updated);
    } catch {
      return void sendJson(res, 404, { error: "no such finding" });
    }
  }

  if (m === "GET" && p === "/api/decisions") return void sendJson(res, 200, store.listDecisions());
  if (m === "GET" && p === "/api/feed/proven") return void sendJson(res, 200, store.provenFeed());

  sendJson(res, 404, { error: `no route for ${m} ${p}` });
}

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

/** Require a valid session whose org matches `org` (and optionally a role). */
function requireOrg(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: Store,
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

  // Resolve safely inside PUBLIC_DIR (block path traversal).
  const resolved = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    return void sendText(res, 403, "forbidden");
  }
  try {
    const data = await readFile(resolved);
    const ext = path.extname(resolved);
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600" });
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
