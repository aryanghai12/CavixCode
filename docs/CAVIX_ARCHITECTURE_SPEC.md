# Cavix Architecture Specification

**GitHub Consent Remediation · MultiCA AI Teardown · Harness Engineering · Review Output & Incremental Verification**

| | |
| :--- | :--- |
| Status | **Implemented** (2026-08-13). See §6 for what shipped and what did not |
| Date | 2026-08-13 |
| Scope | `services/control-plane`, `services/orchestrator`, `services/edge`, `packages/*` |
| Audience | Cavix engineering |

---

## 0. Method and Provenance

This spec is written against code that was read, not recalled. Everything asserted about Cavix carries a file and line reference. Everything asserted about GitHub is checked against GitHub's own documentation. Everything asserted about MultiCA AI is checked against its repository contents (migrations, Go sources, directory listings) rather than its marketing README, and where the two disagree the schema wins.

**What was inspected in Cavix**

| Area | Files read |
| :--- | :--- |
| GitHub connect | [github.ts](services/control-plane/src/github.ts), [server.ts:226-424](services/control-plane/src/server.ts#L226-L424), [server.ts:1145-1230](services/control-plane/src/server.ts#L1145-L1230) |
| Webhook ingest | [github.go](services/edge/internal/webhook/github.go) |
| Review output | [poster.ts](services/orchestrator/src/poster/poster.ts) |
| Incremental state | [ledger.ts](packages/review-session/src/ledger.ts) |
| Context assembly | [assembler.ts](packages/context/src/assembler.ts) |
| Adjudication | [adjudicator.ts](packages/adjudicator/src/adjudicator.ts) |
| Model routing | [router.ts](packages/agents/src/router.ts) |

**Three premises in the brief that the evidence contradicts.** Stated up front because the rest of the document depends on them.

1. **MultiCA's Skills memory is not vector-based.** Migration `008_structured_skills.up.sql` defines `skill`, `skill_file`, and `agent_skill` with `TEXT` and `JSONB` columns and four B-tree indexes. There is no embedding column and no vector index. `001_init.up.sql` enables `pgcrypto` only; no migration in the series enables `pgvector`. Skills are Markdown-with-frontmatter documents (`server/internal/skill/frontmatter.go`) attached to agents explicitly through a join table. Retrieval is selection, not similarity search.
2. **MultiCA's search is bigram full-text, not semantic.** `032_issue_search_index.up.sql` enables `pg_bigm` and builds GIN indexes with `gin_bigm_ops`, chosen for CJK friendliness.
3. **Cavix's GitHub problem is not a bug in Cavix's OAuth code.** The OAuth code is correct. It is solving the wrong problem: it performs the account-authorization grant, and repository consent lives in a different grant entirely. Details in Part 1.

Where a claim could not be confirmed from primary sources it is marked **[unverified]** and given a verification procedure rather than being asserted.

---

# Part 1 — The GitHub "Silent Authentication" Failure

## 1.1 The symptom, stated precisely

A user clicks "Continue with GitHub". GitHub redirects back to Cavix immediately. No consent screen, no account picker, no repository selection. The user lands on the dashboard believing they connected something, and the Repositories page shows either nothing or a partial list.

CodeRabbit, on the same GitHub account, shows a full-page consent every time: choose an account or organization, choose "All repositories" or "Only select repositories", review permissions, click Install.

The instinct is that CodeRabbit passes some flag Cavix is missing. It does not. The two products are entering GitHub through **different doors**.

## 1.2 Root cause: GitHub has two independent grants, and Cavix only requests one

This is the whole diagnosis. GitHub's own documentation states it without ambiguity:

> "You can install a GitHub App without authorizing the app. Similarly, you can authorize the app without installing the app."
>
> "When you **install** a GitHub App on your account or organization, you grant the app permission to access the organization and repository resources that it requested."
>
> "When you **authorize** a GitHub App, you grant the app access to your GitHub account, based on the account permissions the app requested."
>
> — [Authorizing GitHub Apps](https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps)

Two grants, two consent surfaces, two lifecycles:

| | **Authorization** (user-to-server) | **Installation** (app-to-account) |
| :--- | :--- | :--- |
| Entry point | `github.com/login/oauth/authorize` | `github.com/apps/SLUG/installations/new` |
| Grants access to | The signed-in **user's account**: email, gists, profile | **Repositories** of a user or org |
| Repository picker | **None. Does not exist on this screen.** | Yes: "All repositories" / "Only select repositories" |
| Target | Always the signed-in user | Any account the user administers |
| Re-entry | Skipped once granted | Always renders (install or configure) |
| Revocation | User revokes the authorization | User uninstalls or edits repo access |
| Produces | `access_token` (+ refresh) | `installation_id` and installation tokens |

Cavix calls exactly one of these. [github.ts:66-76](services/control-plane/src/github.ts#L66-L76):

```ts
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
```

That is the authorization leg. **It has no repository picker to show.** Asking why the repository consent screen does not appear here is like asking why a passport check does not issue a boarding pass. The screen is not being suppressed by a missing parameter; it belongs to a flow Cavix never enters.

And the second half of the symptom, the *silence*: once a user has granted the authorization, GitHub honours it. A repeat visit to `/login/oauth/authorize` for an already-authorized app with nothing new to request redirects straight back to `redirect_uri` with a fresh `code`. That is standard OAuth 2.0 behaviour and the entire point of an authorization grant. It is not a defect; it is the feature working. It only reads as a defect because Cavix has attached a *repository connection* promise to a *sign-in* button.

## 1.3 Four defects in Cavix that compound the root cause

The architectural miss above is the cause. These four make it worse and each needs its own fix.

### Defect 1 — The `scope` parameter is inert (or dangerously blunt)

[github.ts:31](services/control-plane/src/github.ts#L31) defaults scopes to `read:org,user:email,repo`. GitHub's documentation for GitHub App user tokens lists the accepted authorize parameters as `client_id`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method`, `login`, `allow_signup`, and `prompt`. **`scope` is not among them**, and the page states:

> "Unlike a traditional OAuth token, the user access token does not use scopes. Instead, it uses fine-grained permissions."
>
> — [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)

So there are two possible worlds, and Cavix's code cannot tell you which one it is in:

- **If the registration is a GitHub App:** the `scope` parameter is silently discarded. Cavix is sending a string that does nothing, and every permission actually in force comes from the App's registered permissions, which no code in this repository states.
- **If the registration is a classic OAuth App:** `repo` is granted, and `repo` is **full read/write on every repository the user can reach**, present and future, with no per-repository selection possible at any point in the flow. There is no granular consent to force because OAuth Apps do not have one. The consent screen also appears exactly once; GitHub skips it on subsequent authorizations when the requested scope set has not grown.

Both worlds produce the reported symptom, by different mechanisms. §1.5 gives a five-minute procedure to determine which one you are in.

### Defect 2 — The install link is a dead-end deep link

[github.ts:79-81](services/control-plane/src/github.ts#L79-L81):

```ts
export function installUrl(): string {
  return `https://github.com/apps/${githubConfig().appSlug}/installations/new`;
}
```

The URL is correct. Everything around it is missing:

- **No `state`.** Nothing ties the install that comes back to the Cavix session that started it.
- **No target.** The user must re-pick the account they already picked inside Cavix.
- **No return path.** After installing, GitHub sends the user to the App's registered Setup URL. Cavix has no route to receive that (see Defect 3), so the user's browser lands wherever the registration happens to point, most likely nowhere useful, and they are left on GitHub wondering whether it worked.
- **It is a secondary button.** The primary CTA is "Continue with GitHub", which is the leg with no picker. The one flow that *does* show granular repository consent is the one Cavix presents as an optional extra.

The default slug is `"cavix"` ([github.ts:35](services/control-plane/src/github.ts#L35)). If the real App is registered under any other slug, this link 404s and the only granular path in the product is broken.

### Defect 3 — There is no setup/installation callback route

The router at [server.ts:314-424](services/control-plane/src/server.ts#L314-L424) handles `/api/github/status`, `/installations`, `/orgs`, `/repos` (GET/POST/DELETE), and 404s everything else. There is no `/api/github/setup`. GitHub redirects to the Setup URL with an `installation_id`:

> "GitHub redirects users to the setup URL, it includes an `installation_id` query parameter." … "Bad actors can hit this URL with a spoofed `installation_id`" — validate via a user access token instead.
>
> — [About the setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)

Cavix has nowhere for that redirect to land, so the moment of successful connection, the single highest-signal event in the entire onboarding, is dropped on the floor.

### Defect 4 — Installations are discovered by polling, never by webhook

[github.go:33-58](services/edge/internal/webhook/github.go#L33-L58) defines the webhook contract as `pullRequestEvent`, and [github.go:17-25](services/edge/internal/webhook/github.go#L17-L25) filters to `opened`, `synchronize`, `reopened`, `ready_for_review`. `installation` and `installation_repositories` events are not parsed anywhere in the repository.

The consequence: when a user adds a repository from GitHub's own UI, or an org admin approves a pending install, or someone uninstalls, **Cavix does not know**. It finds out the next time somebody happens to open the Repositories page, which calls `GET /user/installations` live ([server.ts:345-369](services/control-plane/src/server.ts#L345-L369)). Between those two moments Cavix's `repos` table and GitHub's reality drift apart silently, and every review decision made from the stale side is wrong.

## 1.4 Why CodeRabbit's screen always appears

Not a trick, and not a parameter. A different entry point with different re-entry semantics:

1. **The install flow is the front door.** "Add repositories" sends the user to `github.com/apps/SLUG/installations/new`. GitHub renders the account chooser, the "All repositories / Only select repositories" control, and the permission list. Per GitHub's install documentation, that screen shows a location selector, the repository-access choice when the app requests repository permissions, a permissions review, and an **Install** button.
2. **Installation is idempotent but never silent.** The installation grant is not a one-time token exchange, it is a *configuration*. Re-entering it takes the user to the configure screen for an existing installation, still with the repository picker. There is no cached decision to short-circuit, which is precisely why it "reliably triggers every time".
3. **Identity is fused into the install.** With the App setting "Request user authorization (OAuth) during installation" enabled, the install completes and GitHub immediately runs the authorization leg, returning `code` **and** the installation context to one callback. The user experiences one screen and one click; the backend receives both grants.
4. **A Setup URL with "Redirect on update" enabled** brings the user back after they *change* repository access later, so the picker is a recurring, first-class surface rather than a one-time onboarding step.

Cavix has the pieces of (1) and none of (2), (3), or (4).

## 1.5 Diagnostic: which registration do you actually have?

Run before implementing anything. The remediation differs by branch.

```powershell
# 1. What is configured?
$env:CAVIX_GITHUB_CLIENT_ID
$env:CAVIX_GITHUB_APP_SLUG
```

```powershell
# 2. A GitHub App client_id begins "Iv1." or "Iv23"; an OAuth App client_id is a
#    20-character hex string. This is the fastest tell.
```

```powershell
# 3. Authoritative: does an App exist at the slug?
Invoke-RestMethod "https://api.github.com/apps/$env:CAVIX_GITHUB_APP_SLUG"
# 200 with { id, slug, permissions, events } -> a GitHub App exists.
# 404 -> the slug is wrong, or there is no App at all and you are on an OAuth App.
```

```powershell
# 4. With a live user token, does the App have installations at all?
#    An OAuth App always returns 403/404 here; a GitHub App returns a list.
Invoke-RestMethod -Headers @{ Authorization = "Bearer $TOKEN" } `
  "https://api.github.com/user/installations"
```

| Branch | Meaning | Path |
| :--- | :--- | :--- |
| **A** — GitHub App registered | Correct model; the flow is wired wrong | Implement §1.6 in full |
| **B** — OAuth App only | Wrong model; granular consent is not obtainable | Register a GitHub App first, then §1.6. Keep the OAuth App only as a legacy sign-in path, and plan its removal |
| **C** — Both exist | Two identities, split-brain | Consolidate onto the App; §1.6.7 covers migration |

Branch B deserves emphasis: **no configuration change makes a classic OAuth App show a repository picker.** The picker is a GitHub App feature. If Cavix is on an OAuth App, the fix is a registration change, not a code change.

## 1.6 Remediation specification

### 1.6.1 Target architecture: install-first, authorization-fused

One GitHub App. The installation grant is the primary flow; the authorization grant rides along with it. Sign-in without installation remains possible but is a *degraded* state that the UI names honestly.

```
  ┌─ Landing / Dashboard ──────────────────────────────────────────┐
  │  [ Connect GitHub ]  ← ONE primary button, always the install  │
  └───────────────────────────┬────────────────────────────────────┘
                              │ GET /api/github/connect?target=<login>?
                              │  · mint state, store in signed cookie + server side
                              ▼
     github.com/apps/<slug>/installations/new?state=<state>
     (or .../permissions?target_id=<id>&target_type=Organization when targeted)
                              │
                              │  ACCOUNT PICKER + REPO PICKER + PERMISSIONS
                              │  (this is the screen the brief is asking for)
                              ▼
     "Request user authorization (OAuth) during installation" = ON
                              │
                              ▼
     GET /api/github/setup?code=..&installation_id=..&setup_action=..&state=..
       1. verify state (constant-time)
       2. exchange code -> user token (+ refresh)          [authorization grant]
       3. GET /user/installations -> validate installation_id belongs to user
       4. GET /user/installations/{id}/repositories -> authoritative repo set
       5. reconcile store; upsert user; open session
       6. 302 -> /app/repositories?connected=<account>
```

**The invariant:** Cavix never claims a repository is connected on the strength of a user token alone. A repository is connected when it appears in an installation Cavix can enumerate. The user token establishes *who*; the installation establishes *what*.

### 1.6.2 GitHub App registration checklist

Settings that must be set in the App registration itself. None of these are code, and the flow cannot work without them.

| Setting | Required value | Why |
| :--- | :--- | :--- |
| App name / slug | Matches `CAVIX_GITHUB_APP_SLUG` exactly | [github.ts:80](services/control-plane/src/github.ts#L80) builds the install URL from it; a mismatch 404s |
| Callback URL | `https://<public-url>/api/github/setup` | Receives `code` when authorization-during-install is on |
| Setup URL | `https://<public-url>/api/github/setup` | Receives `installation_id` when it is off. Same route handles both |
| **Request user authorization (OAuth) during installation** | **ON** | Fuses the two grants into one user-visible screen. This is the single most important switch |
| **Redirect on update** | **ON** | User changes repo selection later → Cavix is told immediately |
| Expire user authorization tokens | ON | 8-hour tokens + refresh; already handled at [server.ts:1159](services/control-plane/src/server.ts#L1159) |
| Webhook URL | Edge service webhook endpoint | See §1.6.5 |
| Webhook secret | Set, stored as `CAVIX_GITHUB_WEBHOOK_SECRET` | HMAC verification is non-negotiable |
| Where can this be installed | Any account | Org owners are the target market |

**Repository permissions** (read-only unless stated):

| Permission | Level | Used for |
| :--- | :--- | :--- |
| Contents | Read | Fetch file bodies for AST/context assembly |
| Metadata | Read | Mandatory baseline |
| Pull requests | **Read & write** | Post reviews, inline comments, edit the description block |
| Issues | Read & write | `@cavixcode` command handling in issue comments |
| Checks | **Read & write** | The `CHECK_NAME` row in the Checks box ([poster.ts](services/orchestrator/src/poster/poster.ts)) |
| Commit statuses | Read & write | Fallback gate where blocking reviews are unavailable |
| Actions | Read | CI telemetry (the `ciRuns` scope signal) |

**Account permissions:** Email addresses → Read. This replaces the `user:email` scope and removes the noreply-address fallback path at [server.ts:267](services/control-plane/src/server.ts#L267).

**Subscribed events:** `pull_request`, `pull_request_review_comment`, `issue_comment`, `installation`, `installation_repositories`, `installation_target`, `check_suite`, `push`.

> The last three of the first six are the fix for Defect 4 and are currently unsubscribed.

### 1.6.3 API route table

Routes to add or change in [server.ts](services/control-plane/src/server.ts). All state values are 32 bytes from `randomBytes(16).toString("hex")` per [github.ts:62-64](services/control-plane/src/github.ts#L62-L64), stored in an HttpOnly `SameSite=Lax` cookie **and** in a server-side table keyed by the state so a callback can be validated even when the cookie is lost to a cross-site hop.

| Method | Route | Purpose |
| :--- | :--- | :--- |
| `GET` | `/api/github/connect` | **NEW. The primary CTA.** Mints state, 302s to the install URL. Query: `target` (optional org login), `next` (optional post-connect path) |
| `GET` | `/api/github/setup` | **NEW.** Single callback for install and install+auth. Handles `code`, `installation_id`, `setup_action`, `state` |
| `GET` | `/api/auth/github/start` | **CHANGED.** Sign-in only. Adds `prompt`, PKCE; drops `scope` under a GitHub App |
| `GET` | `/api/auth/github/callback` | **CHANGED.** Verifies PKCE; on zero installations, 302s to `/api/github/connect` instead of `/app` |
| `GET` | `/api/github/status` | **CHANGED.** Adds `installations[]`, `hasInstallation`, `pendingApproval`, `configureUrl` |
| `GET` | `/api/github/installations` | **CHANGED.** Serves reconciled store state; `?refresh=1` forces a live poll. Adds `configureUrl` per org |
| `POST` | `/api/github/repos` | **CHANGED.** Rejects with `409 not_in_installation` when the repo is not in an installation |
| `POST` | `/api/github/disconnect` | **NEW.** Revokes the grant and clears tokens (§1.6.6) |
| `POST` | `/webhooks/github` | **CHANGED (edge).** Accepts installation events (§1.6.5) |

#### `GET /api/github/connect`

```ts
// The one entry point for connecting repositories. Never the authorize URL:
// that grant has no repository picker to show (see §1.2).
if (m === "GET" && p === "/api/github/connect") {
  const s = sessionFromRequest(req);              // sign-in optional: an anonymous
  const state = gh.newState();                    // visitor may install first
  const target = url.searchParams.get("target") ?? "";
  const next = safeNext(url.searchParams.get("next"));

  store.putOAuthState({ state, uid: s?.uid ?? null, next, target, kind: "install",
                        createdAt: Date.now() });
  res.setHeader("Set-Cookie",
    `gh_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${cookieSecureAttr()}`);
  res.writeHead(302, { location: gh.installUrl({ state, target }) });
  return void res.end();
}
```

```ts
// github.ts — replaces the parameterless installUrl().
export interface InstallUrlOptions {
  state: string;
  /** Account login to pre-target. Requires targetId to skip the chooser. */
  target?: string;
  /** Numeric account id; enables the direct permissions screen. */
  targetId?: number;
  targetType?: "User" | "Organization";
}

export function installUrl(o: InstallUrlOptions): string {
  const slug = githubConfig().appSlug;
  const q = new URLSearchParams({ state: o.state });
  // Pre-targeted: straight to the permissions + repository picker for that account.
  if (o.targetId) {
    q.set("target_id", String(o.targetId));
    q.set("target_type", o.targetType ?? "Organization");
    return `https://github.com/apps/${slug}/installations/new/permissions?${q}`;
  }
  // Untargeted: GitHub renders the account chooser first, then the picker.
  return `https://github.com/apps/${slug}/installations/new?${q}`;
}
```

> **[unverified]** GitHub's public documentation does not spell out `state` pass-through on `installations/new`, nor the `target_id` / `target_type` parameters on `installations/new/permissions`, though both are in widespread use by GitHub App vendors. **Verification procedure:** hit each URL shape in a browser against the real App, complete an install, and log the exact query string GitHub sends to the Setup URL. If `state` does not survive the round trip, fall back to the session cookie as the correlation key and treat `installation_id` as untrusted input, which §1.6.4 already does.

#### `GET /api/github/setup`

The single most important new route. It must be correct about trust: `installation_id` arrives from an untrusted redirect.

```ts
if (m === "GET" && p === "/api/github/setup") {
  const cookies = parseCookies(req.headers.cookie);
  const state = url.searchParams.get("state") ?? "";
  const rec = store.takeOAuthState(state);            // single-use, 10-min TTL

  // Constant-time compare. A state that matches neither store nor cookie is a
  // forged callback and must not be allowed to attach an installation to a session.
  if (!rec || !timingSafeEqualStr(state, cookies.gh_state ?? "")) {
    res.writeHead(302, { location: "/app/repositories?error=github_state" });
    return void res.end();
  }

  const code = url.searchParams.get("code");
  const setupAction = url.searchParams.get("setup_action");   // install | update | request
  const claimedInstall = Number(url.searchParams.get("installation_id") ?? 0);

  let uid = rec.uid;
  let tokens: gh.GitHubTokens | null = null;

  // (a) Authorization-during-install: one screen produced both grants.
  if (code) {
    tokens = await gh.exchangeCode(code, `${baseUrl(req)}/api/github/setup`, rec.verifier);
    const ghUser = await gh.getUser(tokens.accessToken);
    const email = (await gh.getPrimaryEmail(tokens.accessToken))
               ?? `${ghUser.login}@users.noreply.github.com`;
    const user = store.upsertOAuthUser({ email, name: ghUser.name ?? ghUser.login,
      org: ghUser.login.toLowerCase(), provider: "github", login: ghUser.login });
    store.setOAuthToken(user.id, tokens);
    uid = user.id;
  }

  if (!uid) {                                   // installed while signed out
    res.writeHead(302, { location: `/login?next=${encodeURIComponent("/app/repositories")}` });
    return void res.end();
  }

  // (b) NEVER trust installation_id from the query string. GitHub says so
  //     explicitly. Enumerate with the user token and intersect.
  const token = tokens?.accessToken ?? (await liveGitHubToken(store, uid));
  const installs = token ? await gh.getInstallations(token) : [];
  const verified = installs.find((i) => i.id === claimedInstall) ?? null;

  // (c) An org install may be pending an owner's approval. That is a real state
  //     with a real UI, not an error: say so instead of showing an empty list.
  if (!verified && setupAction === "request") {
    store.recordPendingInstall(uid, rec.target ?? "");
    res.writeHead(302, { location: "/app/repositories?pending=1" });
    return void res.end();
  }

  // (d) Reconcile every installation, not just the new one: an uninstall
  //     elsewhere is discovered here too.
  if (token) await reconcileInstallations(store, uid, token, installs);

  const session = signSession(store.sessionClaims(uid));
  res.writeHead(302, {
    location: rec.next ?? `/app/repositories?connected=${encodeURIComponent(verified?.account.login ?? "")}`,
    "set-cookie": [sessionCookie(session), clearStateCookie()],
  });
  return void res.end();
}
```

#### Changes to `/api/auth/github/start`

```ts
export function authorizeUrl(state: string, redirectUri: string, challenge: string): string {
  const c = githubConfig();
  const q = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri,
    state,
    allow_signup: "true",
    // Documented for GitHub App authorization. Forces the account picker even
    // when the user has exactly one account, so a multi-account user is never
    // silently signed in as the wrong identity.
    prompt: "select_account",
    // "Strongly recommended" by GitHub for the user-token flow.
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  // NOTE: no `scope`. A GitHub App's user token does not use scopes; it uses the
  // App's registered fine-grained permissions. Sending it is a no-op that reads
  // like a security control and is not one.
  return `${GH_OAUTH}/authorize?${q.toString()}`;
}
```

`prompt=select_account` is documented — GitHub shipped it in the [June 2024 account-picker changelog](https://github.blog/changelog/2024-06-07-account-picker-updates-for-oauth-and-github-app-sign-in/) — and it forces the account chooser, interrupting the otherwise instant flow. **It does not restore the permission consent screen and it shows no repositories.** It fixes "signed in as the wrong account", not "no repository picker". Do not sell it internally as the fix.

The callback must stop treating sign-in as completion:

```ts
// server.ts, in /api/auth/github/callback, replacing the unconditional 302 to /app
const installs = tokens ? await gh.getInstallations(tokens.accessToken) : [];
const dest = installs.length === 0 ? "/api/github/connect" : "/app";
res.writeHead(302, { location: dest, "set-cookie": sessionCookie(session) });
```

A user who signs in with zero installations has connected nothing. Sending them to a dashboard that shows an empty Repositories page is the silent failure restated in the UI. Send them to the install flow.

### 1.6.4 Forced-consent levers, ranked by what they actually do

| # | Lever | Forces what | Use |
| :--- | :--- | :--- | :--- |
| 1 | Enter via `installations/new` | Account picker + **repository picker** + permissions, every time | **The fix.** Primary CTA |
| 2 | Setup URL + "Redirect on update" | Cavix is returned to whenever repo access changes | Always on |
| 3 | `prompt=select_account` on authorize | Account picker only | Sign-in path; multi-account safety |
| 4 | Link to `installation.html_url` | The configure screen for an existing install, with its repo picker | "Manage repositories" per org |
| 5 | `DELETE /applications/{client_id}/grant` | Full re-consent: deletes the grant **and every token** | Explicit "Disconnect" only |

Lever 5 is the only true force-re-consent primitive GitHub offers. Per [the REST documentation](https://docs.github.com/en/rest/apps/oauth-applications), it uses Basic auth with `client_id` as username and `client_secret` as password, takes the user's `access_token` in the body, and deleting the grant "will also delete all OAuth tokens associated with the application for the user". After that the next authorize renders the full screen.

**It must never be used to paper over a missing installation.** Revoking a working user's grant to make a screen appear destroys their session, their refresh token, and their trust. Bind it to an explicit user action:

```ts
if (m === "POST" && p === "/api/github/disconnect") {
  const s = requireSession(req, res); if (!s) return;
  const token = await liveGitHubToken(store, s.uid);
  if (token) await gh.revokeGrant(token);   // DELETE /applications/{id}/grant
  store.clearOAuthToken(s.uid);
  store.markAllReposDisconnected(s.org);
  return void sendJson(res, 200, { ok: true, note: "Cavix's GitHub authorization was revoked. Reconnecting will show the full consent screen." });
}
```

```ts
// github.ts
export async function revokeGrant(accessToken: string): Promise<void> {
  const c = githubConfig();
  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64");
  const res = await fetch(`${GH_API}/applications/${c.clientId}/grant`, {
    method: "DELETE",
    headers: { authorization: `Basic ${basic}`, accept: "application/vnd.github+json",
               "content-type": "application/json", "user-agent": "cavix" },
    body: JSON.stringify({ access_token: accessToken }),
  });
  // 204 = revoked. 404 = already gone, which is the same end state.
  if (res.status !== 204 && res.status !== 404) {
    throw new Error(`GitHub grant revocation failed: ${res.status}`);
  }
}
```

Note the asymmetry worth stating in the UI copy: revoking the *authorization* does not uninstall the App. Only the account owner can uninstall, from GitHub. "Disconnect" in Cavix should say which of the two it did.

### 1.6.5 Webhook contract for installation lifecycle

Fixes Defect 4. Add to [services/edge/internal/webhook/github.go](services/edge/internal/webhook/github.go), routed by the `X-GitHub-Event` header, which the current code does not read at all.

| Event | Action | Cavix must |
| :--- | :--- | :--- |
| `installation` | `created` | Record installation, enumerate repos, mark connected |
| `installation` | `deleted` | Mark every repo of that installation disconnected; stop reviewing immediately |
| `installation` | `suspend` / `unsuspend` | Pause / resume without losing configuration |
| `installation` | `new_permissions_accepted` | Re-read granted permissions; clear any degraded-mode banner |
| `installation_repositories` | `added` / `removed` | **The repository picker's output.** Apply `repositories_added` / `repositories_removed` verbatim |
| `installation_target` | `renamed` | Rewrite `owner/name` across the store; stale full names break every permalink in [poster.ts](services/orchestrator/src/poster/poster.ts) |

```go
// Envelope for installation-lifecycle deliveries. Same allow-list discipline as
// pullRequestEvent: unlisted fields are dropped so hostile input cannot reach
// downstream code.
type installationEvent struct {
	Action       string `json:"action"`
	Installation struct {
		ID      int64 `json:"id"`
		Account struct {
			ID    int64  `json:"id"`
			Login string `json:"login"`
			Type  string `json:"type"`
		} `json:"account"`
		RepositorySelection string `json:"repository_selection"` // "all" | "selected"
		SuspendedAt         string `json:"suspended_at"`
	} `json:"installation"`
	Repositories        []repoRef `json:"repositories"`
	RepositoriesAdded   []repoRef `json:"repositories_added"`
	RepositoriesRemoved []repoRef `json:"repositories_removed"`
	Sender struct{ Login string `json:"login"` } `json:"sender"`
}

type repoRef struct {
	ID       int64  `json:"id"`
	FullName string `json:"full_name"`
	Private  bool   `json:"private"`
}
```

Two rules for the handler:

1. **`repository_selection` is load-bearing.** `"all"` means future repositories are automatically in scope; `"selected"` means the set is exactly what was listed. Cavix must store this per installation and stop inferring reach from a repository list snapshot.
2. **Order is not guaranteed.** Deliveries can arrive out of order and can be redelivered. Every installation row carries a monotonic `updated_at` from the payload, and an older delivery is discarded rather than applied. This is the same idempotency discipline already used for review jobs at [github.go:116-120](services/edge/internal/webhook/github.go#L116-L120).

### 1.6.6 Reconciliation: webhook is truth, polling is repair

```
webhook (installation, installation_repositories)   → apply immediately, authoritative
setup callback                                      → full reconcile for that user
GET /api/github/installations?refresh=1             → user-triggered repair
hourly sweep per active org                         → drift detection, alert on mismatch
```

The sweep exists because webhooks are dropped, not because they are unreliable in principle. If the sweep finds a difference, that is a **bug report**, not a routine correction: log it with the installation id and the delta, because a silent auto-heal hides a broken webhook endpoint for months.

`getInstallations` must also carry the field that makes lever 4 possible:

```ts
export interface GitHubInstallation {
  id: number;
  account: { login: string; type?: string; id?: number };
  /** The configure page for this installation: the repository picker for an
   *  account that already has Cavix installed. Currently dropped on the floor. */
  html_url?: string;
  repository_selection?: "all" | "selected";
  suspended_at?: string | null;
  permissions?: Record<string, string>;
}
```

`html_url` already arrives in GitHub's response and [github.ts:217-220](services/control-plane/src/github.ts#L217-L220) discards it by not declaring it. That one field is the difference between "Manage repositories" working and Cavix having to guess the settings URL from the account type.

### 1.6.7 Frontend checklist

| # | Change | File |
| :--- | :--- | :--- |
| 1 | Primary CTA on Repositories becomes **Connect GitHub** → `/api/github/connect`. "Continue with GitHub" stays on the login page only | `public/app.js` |
| 2 | Per-org row: not installed → **Install**; installed → **Manage repositories** → `installation.html_url` | `public/app.js` |
| 3 | Render `repository_selection`: "All repositories" vs "3 of 47 selected" | `public/app.js` |
| 4 | Pending-approval state for org installs awaiting an owner, with the request date and who to chase | `public/app.js` |
| 5 | Post-connect toast keyed off `?connected=<login>`, naming the account and repo count | `public/app.js` |
| 6 | Suspended installation banner, distinct from disconnected | `public/app.js` |
| 7 | Disconnect confirmation stating exactly what it revokes and what it does not | `public/app.js` |
| 8 | Remove any copy implying sign-in connects repositories | landing + docs |

Copy note, per the house style in [poster.ts:47-70](services/orchestrator/src/poster/poster.ts#L47-L70) and the project's no-em-dash rule: say "Cavix can read 3 of 47 repositories in acme-inc", never "Connected". "Connected" is the word that made the original failure invisible.

### 1.6.8 Data model additions

```
installation
  id                    bigint primary key       -- GitHub's installation id
  org                   text not null            -- Cavix workspace
  account_login         text not null
  account_id            bigint not null
  account_type          text not null            -- User | Organization
  repository_selection  text not null            -- all | selected
  permissions           jsonb not null default '{}'
  suspended_at          timestamptz
  html_url              text
  installed_by          uuid
  created_at            timestamptz not null
  updated_at            timestamptz not null     -- from the payload, for ordering

installation_repo
  installation_id       bigint references installation(id) on delete cascade
  repo_id               bigint not null          -- GitHub's numeric repo id
  full_name             text not null
  private               boolean not null
  added_at              timestamptz not null
  primary key (installation_id, repo_id)

oauth_state
  state                 text primary key
  uid                   uuid
  kind                  text not null            -- install | signin
  target                text
  next                  text
  code_verifier         text
  created_at            timestamptz not null     -- 10-minute TTL, single use
```

`installation_repo` keys on the **numeric repo id**, not `full_name`. Renames happen, and the existing store keys repositories by `owner/name` ([server.ts:399-421](services/control-plane/src/server.ts#L399-L421)); after a rename that row is orphaned and a fresh row appears with no history. The numeric id is stable for the repository's lifetime.

### 1.6.9 Acceptance tests

Each is a statement about behaviour, and each currently fails.

| # | Given | When | Then |
| :--- | :--- | :--- | :--- |
| 1 | User has never installed | Clicks Connect GitHub | GitHub renders the account picker and the repository picker |
| 2 | User installed on personal, not on `acme-inc` | Clicks Connect on `acme-inc` | Picker renders for `acme-inc` |
| 3 | User installed on `acme-inc` | Clicks Manage repositories | GitHub's configure page opens with the current selection |
| 4 | Install completes | GitHub redirects to Setup URL | Cavix opens a session and shows the exact repositories granted |
| 5 | Forged `installation_id` in the setup URL | Callback runs | Rejected; nothing attached |
| 6 | Mismatched or replayed `state` | Callback runs | Rejected; state is single-use |
| 7 | User adds a repo from GitHub's UI | `installation_repositories.added` delivers | Repo appears in Cavix with no page refresh |
| 8 | Org owner uninstalls | `installation.deleted` delivers | Every repo marked disconnected; queued reviews cancelled |
| 9 | Member requests install on a restricted org | Setup returns `setup_action=request` | Pending-approval UI, not an empty list |
| 10 | User clicks Disconnect | Grant revoked | Next connect shows the full consent screen |
| 11 | Repository renamed | `installation_target.renamed` delivers | Store and permalinks follow the rename |
| 12 | Webhook delivery replayed out of order | Older payload arrives second | Discarded on `updated_at` |

### 1.6.10 Sequencing

| Phase | Work | Unblocks |
| :--- | :--- | :--- |
| 0 | Run §1.5. Register or correct the GitHub App. Set every switch in §1.6.2 | Everything |
| 1 | `/api/github/connect` + `/api/github/setup` + state table + PKCE | Tests 1-6 |
| 2 | Installation webhooks in edge + reconciler | Tests 7, 8, 11, 12 |
| 3 | Frontend §1.6.7 | Tests 2, 3, 9 |
| 4 | Disconnect + grant revocation | Test 10 |
| 5 | Drop `scope` from the App path; retire the OAuth App if branch B or C | Removes the inert-control class of bug |

Phase 0 is not optional and is not code. If the App registration is wrong, every phase after it is theatre.

---

# Part 2 — MultiCA AI Teardown and the Cavix Harness Framework

## 2.1 What MultiCA actually is

MultiCA is **not a code review product**. It is an agent workforce manager: a Linear-style issue tracker where the assignee can be an AI coding agent, which then executes on the user's own machine through a local daemon. Code review appears only as a *gate* on the resulting work, not as a capability the system provides.

This matters for positioning. Cavix and MultiCA are adjacent, not competing. MultiCA's reviewer is a human clicking approve on an agent's PR; Cavix's reviewer is the machine. What MultiCA is worth studying for is not its review quality, which is out of scope for it, but its **execution substrate**: how it moves work through states without losing it, how it dispatches to untrusted remote workers, how it dedupes work by commit, and how it stores reusable procedural knowledge. Cavix needs all four and currently has partial answers to two.

| | MultiCA | Cavix |
| :--- | :--- | :--- |
| Unit of work | Issue assigned to an agent | Pull request event |
| Where execution happens | User's machine, via local daemon | Cavix's sandbox / orchestrator |
| Human role | Approves the agent's output | Consumes the agent's review |
| Model relationship | Broker across ~20 agent CLIs | Direct provider calls + BYOK |
| Persistence of knowledge | Skills (Markdown + frontmatter) | Learnings, org graph, PR ledger |
| Trust posture | Code never leaves the user's machine | Sandbox proof, zero-retention mode |

## 2.2 Verified architecture map

| Layer | Technology | Evidence |
| :--- | :--- | :--- |
| API server | Go, Chi router, sqlc, gorilla/websocket | `server/go.mod`, `server/sqlc.yaml` |
| Database | PostgreSQL, `pgcrypto`, `pg_bigm` | `001_init.up.sql`, `032_issue_search_index.up.sql` |
| Web | Next.js 16 App Router | `apps/`, `packages/{ui,views,core}` |
| Desktop | Electron sharing the web packages | README |
| Mobile | Expo / React Native | README |
| Execution | Local daemon spawning agent CLIs | `server/internal/daemon`, `daemonws` |
| Transport | WebSocket hub with RPC | `server/internal/daemonws/hub.go` |

Server-side module inventory (`server/internal`, 32 packages):

```
agentconfig  analytics  attribution  attributionbackfill  auth  channelmedia
cli  cloudruntime  daemon  daemonws  dispatch  events  featureflags  handler
integrations  issueguard  issueposition  logger  metrics  middleware  migrations
pluginbundled  realtime  runtimeapps  scheduler  selfexec  service  skill
storage  taskusagebackfill  testutil  util
```

Three names in that list are the interesting ones. `issueguard` and `dispatch` are where correctness lives; `selfexec` is how the platform runs its own agents against itself.

## 2.3 State management: the Kanban lifecycle is a database constraint

The most transferable idea in the codebase. MultiCA does not model its lifecycle in application code; it models it in `CHECK` constraints, so an invalid state cannot be written by any code path.

```sql
-- issue.status
CHECK (status IN ('backlog','todo','in_progress','in_review','done','blocked','cancelled'))

-- agent.status
CHECK (status IN ('idle','working','blocked','error','offline'))

-- agent_task_queue.status
CHECK (status IN ('queued','dispatched','running','completed','failed','cancelled'))

-- daemon_connection.status
CHECK (status IN ('connected','disconnected'))
```

Four separate state machines, deliberately not collapsed into one:

- **Issue status** is what humans see on the board.
- **Task status** is what the execution engine sees.
- **Agent status** is capacity.
- **Daemon status** is connectivity.

The separation is the design. An issue sitting in `in_progress` while its task is `failed` and its daemon is `disconnected` is a *legible* state that the UI can explain. A single fused status column would have to pick one story and lose the other two, which is exactly the failure mode Cavix has today: a review either "ran" or "did not", with nothing in the schema distinguishing "the model refused", "the sandbox timed out", "the platform token expired", and "we never received the webhook".

### The concurrency primitive

One partial unique index carries the entire duplicate-work guarantee:

```sql
CREATE UNIQUE INDEX idx_one_pending_task_per_issue
    ON agent_task_queue (issue_id)
    WHERE status IN ('queued', 'dispatched');
```

At most one queued-or-dispatched task per issue, enforced by Postgres. No advisory locks, no Redis mutex, no application-level check-then-insert race. A duplicate enqueue fails with a constraint violation, which the caller treats as "already queued" and moves on. The test file names in `server/internal/service` show this was fought for: `duplicate_pending_task_test.go`, `task_claim_race_test.go`, `task_batch_claim_test.go`, `task_complete_race_test.go`, `task_cancel_reconcile_dedup_test.go`, `empty_claim_cache.go`.

**Note what the predicate excludes**: `running` is not in the index. A task that is executing does not block a new one being queued behind it. That is a deliberate choice for a system where a human might push a correction mid-run.

## 2.4 Task routing: pull, not push

The dispatch model is inverted from what the README's "assign it and it runs" framing suggests. The server never pushes work to a daemon. It rings a bell.

From `hub.go`:

```go
// The server notifies; it does not deliver.
NotifyTaskAvailable(runtimeID, taskID string)
  → protocol.Message{ Type: protocol.EventDaemonTaskAvailable,
                      Payload: protocol.TaskAvailablePayload{...} }
```

The daemon, on receiving that hint, calls back over RPC to *claim* the task. Claiming is a transactional state transition `queued → dispatched` guarded by the unique index above, so if two daemons race, exactly one wins and the other gets a clean miss.

Why this is the right shape, and why Cavix should copy it:

1. **The notification is an optimisation, not a mechanism.** Drop it, and work still flows: the daemon polls on its own schedule. `hub.go` makes this explicit by using a 16-slot buffered send channel with a non-blocking `trySend`, dropping notifications when the buffer is full and recording a metric. A dropped notification is a latency event, never a lost task. This is a *far* stronger property than a push queue with retries.
2. **Backpressure is free.** A daemon claims when it has capacity. There is no need to model remote worker capacity server-side.
3. **The worker can be behind a firewall.** It holds an outbound WebSocket; nothing needs to reach it.
4. **Dedupe on the notification path is cheap and lossy on purpose.** `eventDedupCapacity = 128` caps the seen-event map. Overflow means a duplicate notification, which costs one wasted claim attempt that the index rejects.

Cavix's edge service already computes an idempotency key at [github.go:116-120](services/edge/internal/webhook/github.go#L116-L120) over `(repo_id, pr_number, action, head_sha)`. That is the same instinct, implemented one layer earlier. What Cavix lacks is the database-enforced single-in-flight guarantee at the *review* level, which §2.9 addresses.

## 2.5 The WebSocket layer

`daemonws/hub.go` is 27 KB with a 21 KB test file next to it. The protocol:

| Constant | Direction | Purpose |
| :--- | :--- | :--- |
| `protocol.EventDaemonHeartbeat` | daemon → server | Liveness, carries `RuntimeID`, `SupportsBatchImport` |
| `protocol.EventDaemonHeartbeatAck` | server → daemon | Acknowledgement |
| `protocol.EventDaemonRPCRequest` | daemon → server | Request/response over the socket |
| `protocol.EventDaemonRPCResponse` | server → daemon | Echoes `RequestID`, carries status |
| `protocol.EventDaemonTaskAvailable` | server → daemon | Work is waiting |
| `protocol.EventDaemonPendingWork` | server → daemon | Queued work summary |
| `protocol.EventDaemonRuntimeProfilesChanged` | server → daemon | Config invalidation |
| `protocol.EventDaemonWorkspacesChanged` | server → daemon | Membership invalidation |

Envelope is `protocol.Message{ Type string, Payload json.RawMessage }`. RPC payload is `{ RequestID, Method, Body, TimeoutMs }`, dispatched to a handler with signature `(ctx, identity ClientIdentity, method string, body json.RawMessage)`. Concurrency is bounded per connection at `maxInFlightRPCPerClient = 8`. Liveness is `pongWait = 60s` with pings at `pingPeriod = (pongWait * 9) / 10`.

Four things worth stealing verbatim:

1. **RPC multiplexed over one socket with an explicit `TimeoutMs` per call.** The caller states its own deadline; the server does not guess.
2. **Per-connection in-flight cap.** A misbehaving client cannot exhaust server goroutines.
3. **Typed message constants in a shared `protocol` package** imported by both ends. Cavix's cross-service contracts are typed on the TypeScript side and hand-rolled in Go at the edge.
4. **Buffered, droppable notifications with a metric on the drop.** Not "reliable delivery"; "reliable *work*, best-effort *notification*".

The last one is the design principle Cavix's live review log should be built on. Streaming progress to a dashboard is a nice-to-have; it must never be able to stall or fail a review.

## 2.6 Skills: procedural memory as versioned documents

The brief describes "vector-based Skills memory". The schema says otherwise:

```sql
CREATE TABLE skill (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    config JSONB NOT NULL DEFAULT '{}',
    created_by UUID REFERENCES "user"(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(workspace_id, name)
);

CREATE TABLE skill_file (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id UUID NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
    path TEXT NOT NULL, content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(skill_id, path)
);

CREATE TABLE agent_skill (
    agent_id UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
    skill_id UUID NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, skill_id)
);
```

No embedding column. No vector index. `pgvector` is not enabled by any migration in the series (`001` enables `pgcrypto`; `032` enables `pg_bigm`). A skill is a **name, a description, a Markdown body, a config blob, and a bag of attached files**, parsed by `server/internal/skill/frontmatter.go` with a reserved-names guard in `reserved.go`. Skills reach an agent because someone attached them through `agent_skill`, and the model picks among them by reading their `description`.

That is the Claude-Code / Agent-Skills pattern, and it is a **better** design than embedding search for this job. Three reasons:

1. **Determinism.** The same task loads the same skills. A vector search over procedural knowledge means an agent that followed the deployment runbook yesterday might not today, and nothing in the trace explains why.
2. **Auditability.** "Which instructions were in force for this run" is a join, not a similarity threshold.
3. **Authoring.** A skill is a file a human wrote and reviewed. It can live in git, be diffed, and be rolled back.

The cost is recall: with 200 skills the `description` field is doing retrieval work it was not designed for, and there is no mechanism to notice a skill that should have fired and did not.

**Direct implication for Cavix.** Cavix's repo-rules and learnings layer should be document-first with deterministic selection by path glob, language, and category, with semantic retrieval added only as a *supplementary recall* channel that is clearly labelled in the context block. [assembler.ts:110-128](packages/context/src/assembler.ts#L110-L128) already gets this right for code context, where embedding neighbours are explicitly labelled "Semantically related" and ranked below graph-derived callers. Extend the same discipline to rules.

## 2.7 Commit review: the head-SHA dedupe

The single most directly relevant piece of MultiCA to Cavix's Task 3, found in `service/task_dedup_head_sha_test.go`. It documents a real production bug (referenced as TEN-356) and its fix:

> "The fix stamps the reviewed head SHA into the task's context JSONB and keys `HasPendingTaskForIssueAndAgent` on it."

The dedupe key moved from `(issue_id, agent_id)` to `(issue_id, agent_id, head_sha)`. Four behaviours are asserted:

| # | Scenario | Required behaviour |
| :--- | :--- | :--- |
| 1 | Pending task on commit A, request arrives for commit B | Dedupe **misses**; a fresh review runs |
| 2 | Force-push advances HEAD mid-review | Resolver sees the new SHA, dedupe misses, fresh review |
| 3 | Re-request for the same commit A | Dedupe **hits**; coalesced, no duplicate run |
| 4 | Issue with no linked PR, so no review SHA | Falls back to `(issue_id, agent_id)` |

The bug it prevents is precise and expensive: **reusing a verdict computed against different code.** A pending review for an old commit satisfying a request for a new one means the team sees a green result that was never computed against what they are about to merge.

Cavix is partly protected here. [github.go:116-120](services/edge/internal/webhook/github.go#L116-L120) includes `HeadSHA` in the idempotency key, so redelivery collapses and a new commit produces a fresh job. But that guard lives at the *ingest* boundary. Once a job is running, nothing cancels it when HEAD advances. Scenario 2 is unhandled: a force-push during a long review produces a review posted against a commit that no longer exists, anchored to lines that have moved. §2.9 and §3.3 close this.

## 2.8 Structural findings

**Strengths worth naming.**

| Finding | Why it matters |
| :--- | :--- |
| Lifecycle in `CHECK` constraints | Illegal states unrepresentable at the storage layer |
| Partial unique index for in-flight work | Concurrency correctness without distributed locks |
| Pull-based claim with best-effort notify | Survives dropped messages, firewalls, and slow workers |
| Bounded RPC concurrency per connection | One client cannot degrade the fleet |
| Test names that state the bug | `duplicate_pending_task_test.go`, `task_claim_race_test.go`, `resume_unsafe_test.go` |
| Reversible migrations throughout | Every `.up.sql` has a `.down.sql`; 41 numbered pairs |
| Skills as reviewable documents | Procedural knowledge is diffable and auditable |
| Execution on the user's machine | Strongest possible data-residency story |

**Weaknesses worth avoiding.**

| Finding | Evidence | Risk |
| :--- | :--- | :--- |
| **`service/task.go` is 262 KB** | Directory listing | A quarter-megabyte in one file is where a state machine goes to become unmaintainable. It is telling that ~30 of the ~56 files in that package are tests *of that file's* race conditions |
| `service/autopilot.go` at 74 KB | Directory listing | Same shape, one layer up |
| Duplicate migration numbers | `020` ×2, `026` ×2, `029` ×3, `032` ×4, `033` ×2, `035` ×2, `040` ×2, `041` ×2 | Ordering across a duplicated number is filename-lexical, not intentional. A merge-order-dependent schema is a bad night waiting to happen |
| No semantic layer at all | No `pgvector` in any migration | `pg_bigm` bigrams find issues by substring; they cannot find "the issue about the refund race" |
| Skill retrieval is by `description` | `008_structured_skills.up.sql` | No signal when a skill that should have applied did not |
| Review is a human gate | No review service in `internal/` | The reviewing itself is entirely unautomated |

**The competitive read.** MultiCA has an excellent *execution substrate* and no *verification engine*. Cavix has a verification engine ([verifier](packages/verifier/), [adjudicator](packages/adjudicator/), [sandbox](packages/sandbox/)) and a weaker execution substrate. The gap Cavix should attack is not "review better than MultiCA", which is not a contest, but "be the thing that makes an agent-written PR safe to merge" — which is precisely the gate MultiCA leaves to a human.

## 2.9 What Cavix should adopt, concretely

| # | From MultiCA | Cavix change | Where |
| :--- | :--- | :--- | :--- |
| 1 | Lifecycle in schema | `review_run.status CHECK IN ('queued','claimed','running','posting','completed','failed','cancelled','superseded')`, plus separate `outcome` and `failure_reason` columns | control-plane store |
| 2 | Partial unique index | `CREATE UNIQUE INDEX one_active_review_per_pr ON review_run (repo_id, pr_number) WHERE status IN ('queued','claimed','running')` | control-plane store |
| 3 | Head-SHA in the dedupe key | Already at ingest; extend to the run table and add `superseded` | [github.go](services/edge/internal/webhook/github.go), store |
| 4 | Supersede on HEAD advance | New `synchronize` for the same PR with a different SHA cancels the in-flight run before enqueuing | [reviewWorkflow.ts](services/orchestrator/src/workflow/reviewWorkflow.ts) |
| 5 | Pull-based claim | Orchestrator workers claim from the queue transactionally rather than being handed work | orchestrator + edge |
| 6 | Best-effort notify | Live review progress as droppable notifications, never on the critical path | control-plane |
| 7 | Skills as documents | Repo rules as versioned Markdown with frontmatter, deterministically selected | [repoconfig](packages/repoconfig/) |
| 8 | Bounded per-tenant concurrency | Cap in-flight reviews per org; a monorepo cannot starve the fleet | orchestrator |
| 9 | Tests named for the bug | `force_push_supersedes_test.ts`, `duplicate_review_per_pr_test.ts` | orchestrator tests |
| 10 | Avoid the 262 KB file | Keep the review state machine in its own module with a table-driven transition map | new |

---

## 2.10 The Cavix Harness Framework

> **Agent = Model + Harness.** The model is a commodity that improves without you. The harness is the product. Everything below is specification for the harness.

The design goal is a **falsifiable review**: every posted claim traces to either an execution artifact, a deterministic tool, or a graph fact, and any claim that traces to none of those must clear an explicit bar to survive. Cavix already implements pieces of this. This section specifies the whole and names what is missing.

### 2.10.0 The harness contract

Four stages wrap every model call. Each has an input contract, an output contract, a budget, and a defined behaviour on failure. **No stage may fail the review.** A degraded harness produces a smaller review that says so, never a crash and never a silent full-confidence answer.

```
        ┌──────────────────────────────────────────────────────────┐
        │  H1  FEEDFORWARD          rules + graph + memory → prompt │
        └───────────────────────────┬──────────────────────────────┘
                                    ▼
        ┌──────────────────────────────────────────────────────────┐
        │  H2  COMPUTATIONAL FEEDBACK   linters, SAST, types, tests │
        │      runs BEFORE the model; its findings are facts        │
        └───────────────────────────┬──────────────────────────────┘
                                    ▼
        ┌──────────────────────────────────────────────────────────┐
        │  H4  ROUTING          which model sees which slice        │
        └───────────────────────────┬──────────────────────────────┘
                                    ▼
                              ╔═══════════╗
                              ║ GENERATOR ║  ensemble of specialists
                              ╚═════╤═════╝
                                    ▼
        ┌──────────────────────────────────────────────────────────┐
        │  H3  CRITIC LOOP     verify → challenge → repair → adjudicate │
        └───────────────────────────┬──────────────────────────────┘
                                    ▼
                              POST (Part 3)
```

```ts
// packages/harness/src/types.ts
export interface HarnessStage<I, O> {
  readonly id: string;
  /** Hard wall-clock ceiling. Exceeding it degrades; it never throws upward. */
  readonly budgetMs: number;
  run(input: I, ctx: HarnessContext): Promise<StageResult<O>>;
}

export interface StageResult<O> {
  status: "ok" | "degraded" | "skipped";
  value: O;
  /** Plain-English, user-facing. Surfaces in the Review Scope module. */
  degradedReason?: string;
  /** Real measurements only. Feeds ScopeSignals in the poster. */
  metrics: Record<string, number>;
}
```

The `degradedReason` field is load-bearing and matches the discipline already stated at [poster.ts:210-215](services/orchestrator/src/poster/poster.ts#L210-L215): a scope row with no measurement behind it is not rendered. A stage that degraded must be able to say so in a sentence a customer can read.

---

### 2.10.1 H1 — Feedforward context

**Job:** everything the model needs to know before it reads a line of the diff, assembled deterministically, ranked by evidential strength, and packed to budget.

Cavix's [ContextAssembler](packages/context/src/assembler.ts) is a strong foundation: it takes graph blast radius, caller snippets, changed-symbol definitions, past discussions, and embedding neighbours, compresses oversized items with a cheap model, and packs to a token budget. Three things are missing.

#### Missing 1 — Repository rules are not in the context at all

The assembler's five item kinds are `diff`, `caller`, `definition`, `discussion`, `related`. There is no `rule`. Org settings (`preMergeChecks`, `pathFilters`, tone) exist in the control plane but are not part of the assembled context object.

```ts
// packages/context/src/types.ts — extend ContextItem["kind"]
export type ContextKind =
  | "rule"          // NEW. Repository law. Priority 95: above everything but the diff.
  | "convention"    // NEW. Observed house style, mined not declared. Priority 45.
  | "diff"          // 100
  | "caller"        // 80
  | "definition"    // 70
  | "discussion"    // 50
  | "related";      // 40
```

**Rule sourcing, in precedence order.** Later sources override earlier ones on conflict, and the winning source is recorded on the item.

| # | Source | Nature |
| :--- | :--- | :--- |
| 1 | Cavix built-in defaults | Shipped |
| 2 | `.cavix/rules/*.md` in the repo | Markdown + frontmatter, MultiCA's skill shape |
| 3 | `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` | Read if present; teams already wrote these |
| 4 | Dashboard rules (`OrgSettings.preMergeChecks.rules`) | Owner-authored |
| 5 | Learned conventions from [learning](packages/learning/) | Mined from accepted/rejected findings |

**Rule file format** — deliberately the same frontmatter-plus-body shape MultiCA validated, so a rule is a reviewable document:

```markdown
---
name: no-raw-sql-in-handlers
description: HTTP handlers must not build SQL strings; use the query layer.
applies_to: ["services/**/handler/**/*.ts", "services/**/routes/*.ts"]
severity: high
category: architecture
enforcement: advisory          # advisory | blocking
rationale_url: https://wiki.internal/adr/0042
---

Handlers own transport concerns only. Any SQL belongs in `packages/db/queries`.
A handler that builds SQL cannot be unit-tested without a database and bypasses
the parameterisation helpers, which is how the 2025-11 injection got in.
```

**Selection is deterministic.** A rule enters the context if and only if its `applies_to` globs intersect the changed paths. No embedding search, no relevance model, no silent omission. This is MultiCA's lesson (§2.6) applied where it belongs: for *law*, deterministic selection beats recall.

```ts
export interface RuleItem extends ContextItem {
  kind: "rule";
  ruleId: string;
  source: "builtin" | "repo" | "convention-file" | "dashboard" | "learned";
  severity: Severity;
  enforcement: "advisory" | "blocking";
  matchedPaths: string[];       // why this rule is here, for the audit trail
}
```

#### Missing 2 — The context object has no provenance for the reviewer's own claims

Every context item should carry a `trust` level, and the prompt should state what each level licenses the model to say.

| Trust | Sources | The model may |
| :--- | :--- | :--- |
| `fact` | Diff, AST graph edges, tool output, CI results | Assert directly |
| `stated` | Repo rules, org settings | Assert as policy, citing the rule id |
| `observed` | Past discussions, learned conventions | Suggest, marked as convention |
| `retrieved` | Embedding neighbours | Use for orientation; **may not** be the sole basis of a finding |

That last row is the anti-hallucination lever with the highest yield per line of code. A semantically similar file is a hint, not evidence, and the current renderer at [assembler.ts:176-190](packages/context/src/assembler.ts#L176-L190) presents it in the same visual register as a resolved caller.

#### Missing 3 — Budget is a single flat number

`budgetTokens ?? 6000` with a strict priority sort means a change touching 40 files can evict every caller snippet in favour of the diff, and nothing records that the review then had no cross-file context. Replace with **reserved bands**:

```ts
export interface ContextBudget {
  total: number;
  reserve: {
    rules: number;        // e.g. 0.10 — law is never evicted by a large diff
    diff: number;         // 0.40
    graph: number;        // 0.30 — callers + definitions
    memory: number;       // 0.10 — discussions + learned conventions
    retrieved: number;    // 0.10 — embedding neighbours, first to go
  };
}
```

Unused reserve flows to the next band down. A band that overflows compresses within itself before borrowing. The `droppedForBudget` counter already returned at [assembler.ts:170](packages/context/src/assembler.ts#L170) becomes per-band, and any band that dropped items sets `degradedReason` so the Review Scope module can say "cross-file context was truncated on this change" rather than quietly reviewing less.

**H1 acceptance:** given a diff touching a path covered by a rule, that rule appears in the rendered prompt with its id, and removing the rule file changes the prompt. Given a 40-file diff, caller context is still present. Given an embedding-only item, no posted finding cites it as sole evidence.

---

### 2.10.2 H2 — Computational feedback

**Job:** compute everything computable before the model runs. Two payoffs, and the second is the one people miss.

1. Deterministic findings are free and correct. Cavix already treats them as unchallengeable facts at [adjudicator.ts:8-14](packages/adjudicator/src/adjudicator.ts#L8-L14).
2. **Tool output is the model's ground truth.** A type error, a failing test, or a SAST hit fed *into* the prompt stops the model inventing a different explanation for the same symptom, and stops it re-reporting what a linter already caught.

Cavix has [packages/deterministic](packages/deterministic/) with `builtins.ts`, `runner.ts`, `secrets.ts`, `tools.ts`. The specification here is about what it must guarantee.

#### The tool ladder

Run in order; each tier's output is available to the next and to the model.

| Tier | Tools | Budget | On failure |
| :--- | :--- | :--- | :--- |
| 0 | Secret scan, dependency advisories, license | 10 s | Fail the review loudly. A leaked credential is not a degradable finding |
| 1 | Syntax parse / AST build per changed file | 15 s | Mark file `unparsed`; exclude from AST claims and say so |
| 2 | Type check, incremental where the toolchain allows | 90 s | Degrade to Tier 1; set `typesUnavailable` |
| 3 | Repo's own linters, respecting its config | 60 s | Degrade; never substitute Cavix defaults for a repo's config |
| 4 | SAST on changed files plus their imports | 60 s | Degrade |
| 5 | Impacted tests only, selected from the graph | 180 s | Degrade; `testsSkipped` with the reason |

**Hard rules.**

- **The repository's own configuration wins.** If the repo has an ESLint config, run it. Never post a finding from a Cavix default that the repo's own config disables: that is the single fastest way to be muted.
- **Findings are scoped to changed lines plus their blast radius.** A pre-existing lint error two thousand lines away is not this PR's problem.
- **Every tool result is stamped with the tool version.** Findings that change because a linter minor-bumped must be explainable.
- **Tool output enters the prompt in a structured block, not as prose.**

```
### Deterministic results (facts, already reported; do not restate)
tool=tsc@5.7.2  status=fail  scope=changed
  services/api/src/refund.ts:88  TS2532  Object is possibly 'undefined'
tool=eslint@9.14.0 config=repo status=pass scope=changed
tool=semgrep@1.95 status=fail  scope=changed+imports
  services/api/src/refund.ts:41  sql-injection  string-built query reaches execute()
tool=vitest@2.1 status=fail  scope=impacted  selected=12 failed=1
  refund.spec.ts > partial refund > rounds down  AssertionError: expected 999 to be 1000
```

The instruction "already reported; do not restate" is doing real work. Without it, the ensemble spends its budget rediscovering the type error and the adjudicator spends its budget deduping it. **What the model should do with tool output is explain the *consequence***: `TS2532` at line 88 is a fact; "this is the null path that produces the 999 rounding failure in `refund.spec.ts`" is the review.

#### The reverse channel: tools as verification

H2 runs a second time, after generation, inside the critic loop, but pointed at the *model's* claims:

- Model claims a null dereference → run the type checker at that symbol.
- Model claims a broken test → run that test.
- Model suggests a fix → apply it in the sandbox and re-run the impacted suite.

This is what [packages/verifier](packages/verifier/) already does for reproduction. H2's contribution is making the *cheap* half of that loop run on every finding, not only on the ones expensive enough to sandbox.

**H2 acceptance:** tool output appears in the prompt; the ensemble does not re-report a finding already in the deterministic block (measured as duplicate-cluster rate in the adjudicator); a repo whose ESLint config disables a rule never receives a finding for that rule.

---

### 2.10.3 H3 — The critic / generator loop

**Job:** no claim reaches a pull request without something other than its author agreeing with it.

Cavix has two of the four pieces: the [adjudicator](packages/adjudicator/) clusters and thresholds, and the [verifier](packages/verifier/) reproduces. Missing are the **critic** and the **repair** pass. Today an ensemble finding that clears a confidence threshold gets posted; nothing ever argues against it.

#### Loop topology

```
   GENERATOR                CRITIC                  ARBITER
   ensemble of        adversarial reviewer      deterministic merge
   specialists    ──►  of the review itself  ──►  + threshold + verify
        ▲                       │                        │
        └──── repair (≤1) ◄─────┘ (only for VERDICT=REPAIRABLE)
```

#### The critic's contract

The critic is **not a second reviewer**. It never reads the code looking for bugs. It reads a *draft finding* plus its cited evidence and answers one question: does the evidence support the claim?

```ts
// packages/critic/src/types.ts
export interface CriticVerdict {
  findingId: string;
  verdict: "SUPPORTED" | "UNSUPPORTED" | "REPAIRABLE" | "DUPLICATE" | "OUT_OF_SCOPE";
  /** Which context items actually carry the claim. Empty ⇒ UNSUPPORTED. */
  citedEvidence: string[];
  /** The specific defect in the reasoning. Required unless SUPPORTED. */
  objection?: string;
  /** Multiplier applied to the finding's confidence. */
  confidenceDelta: number;
  checks: {
    /** Do the path and line exist in the diff? Computed, not judged. */
    locationExists: boolean;
    /** Does every identifier the finding names appear in the context? */
    symbolsResolve: boolean;
    /** Is the claim falsifiable, or is it taste? */
    testable: boolean;
    /** Does a repo rule or a deterministic tool already cover it? */
    alreadyCovered: boolean;
  };
}
```

**Half of these checks are computed, not prompted.** `locationExists` is a set lookup against `commentableLines`, which [poster.ts:518-526](services/orchestrator/src/poster/poster.ts#L518-L526) already computes. `symbolsResolve` is a lookup against the AST index. Anything a program can decide, a program decides. The model is only asked the two questions that need judgement.

#### The five hallucination classes and who catches each

| Class | Example | Caught by |
| :--- | :--- | :--- |
| **Phantom location** | Finding at `refund.ts:412`, file has 300 lines | Computed: `locationExists` |
| **Phantom symbol** | "the `validateRefund` helper" that does not exist | Computed: AST index lookup |
| **Invented semantics** | "`parseAmount` throws on negative" when it returns null | Verifier, or critic demanding the definition be in context |
| **Confident taste** | "This should use dependency injection" | Critic: `testable = false` → downgrade to `info` or drop |
| **Stale context** | Correct against the base, wrong against the head | Computed: re-anchor against the head SHA (§3.3) |

The first, second, and fifth are **fully deterministic**. They are also, empirically, the ones that most damage credibility, because a reviewer that cites a line that does not exist is not merely wrong, it is visibly not reading. Implement those three before writing a single critic prompt.

#### Repair, bounded at one round

```ts
export interface RepairRequest {
  finding: Finding;
  objection: string;            // the critic's exact words
  additionalContext: ContextItem[];  // what the critic said was missing
  instruction: "Revise or withdraw. Do not restate.";
}
```

One round only, and withdrawal must be a first-class outcome the generator is told is acceptable. Unbounded repair loops converge on a model arguing itself into confidence.

#### Arbiter: extending the existing adjudicator

[adjudicator.ts](packages/adjudicator/src/adjudicator.ts) already has the right invariant structure: immutable policy findings pass untouched, deterministic findings survive regardless of confidence, and only pure-LLM clusters face the threshold. Extend with a fourth invariant:

```
4. A pure-LLM cluster whose critic verdict is UNSUPPORTED is dropped regardless
   of confidence or agreement. Ensemble agreement raises confidence
   (adjudicator.ts:135-138) and correlated models agree on the same
   hallucination; agreement is therefore not evidence, and the critic's
   verdict outranks it.
```

That is the sharpest single change in this document. The current probabilistic-OR combination at [adjudicator.ts:136-138](packages/adjudicator/src/adjudicator.ts#L136-L138) treats independent agreement as confirmation. For models from the same family reading the same context, agreement is substantially correlated. The critic is the only mechanism in the pipeline that can disagree on *grounds*.

#### Budget

| Path | Cost |
| :--- | :--- |
| Critic on every draft finding | 1 cheap call per finding, batched to 10 per call |
| Repair | ≤1 call per `REPAIRABLE`, capped at 5 per review |
| Verification | Existing sandbox path, `high`+ severity only |

The critic runs on the cheap tier. It is a narrow, well-specified classification task with the evidence supplied, which is exactly the shape small models do well.

**H3 acceptance:** a finding citing a nonexistent line is never posted; a finding whose only evidence is a `retrieved` item is never posted; measured precision on the [eval](eval/) corpus rises without recall falling more than 5%; every dropped finding carries a machine-readable reason, as [adjudicator.ts:83-90](packages/adjudicator/src/adjudicator.ts#L83-L90) already does.

---

### 2.10.4 H4 — Model routing

**Job:** spend frontier tokens only where frontier reasoning changes the answer.

The current router at [router.ts](packages/agents/src/router.ts) is a two-tier map with per-agent overrides: `cheap` and `frontier`, defaulting to `claude-sonnet-5` and `claude-opus-5`. It is a clean abstraction and too coarse. It routes on **who is asking**, never on **what is being asked** or **what happened last time**.

#### Four tiers

| Tier | Class | Work | Failure tolerance |
| :--- | :--- | :--- | :--- |
| `T0` | Deterministic | Location checks, symbol resolution, dedupe, anchoring | None. Must not fail |
| `T1` | Free / self-hosted (OpenCode-style endpoints, local models) | Single-file syntax, style, docs, commit-message quality, batched critic pre-screen | High. Cheap to retry, cheap to discard |
| `T2` | Fast hosted (`claude-haiku-4-5`, `claude-sonnet-5`) | Per-file findings, context compression, critic verdicts, summary prose | Moderate |
| `T3` | Frontier (`claude-opus-5`) | Cross-file logic, concurrency, security, breaking-change analysis, final arbitration | Low |

Model ids are configuration, never literals, as [router.ts:5-6](packages/agents/src/router.ts#L5-L6) already insists. Verify current ids with the `claude-api` skill before changing defaults.

#### Routing on the work, not the worker

```ts
export interface RouteRequest {
  agent: AgentSpec;
  slice: DiffSlice;
  signals: {
    /** Does this slice reach beyond one file? T3 territory. */
    crossFile: boolean;
    /** Blast radius from the graph. */
    callerCount: number;
    /** Security-sensitive path per repo rules or heuristics. */
    sensitivePath: boolean;
    /** Async, locking, or shared mutable state present. */
    concurrency: boolean;
    /** Public API or exported signature changed. */
    apiSurfaceChange: boolean;
    /** Deterministic tools already flagged this slice. */
    toolHits: number;
    /** How many T1/T2 attempts already produced nothing usable. */
    escalations: number;
  };
  budget: { remainingUsd: number; remainingMs: number };
}

export interface RouteDecision {
  tier: "T1" | "T2" | "T3";
  model: string;
  /** Human-readable, recorded on every finding for cost attribution. */
  reason: string;
  /** T1/T2 result quality below this escalates one tier, once. */
  escalateBelow?: number;
}
```

**The escalation ladder is the cost lever, not the tier table.** Most diffs are boring. Route them all to T1/T2 first and escalate only on signal:

```
T1 pass over every changed file
  ├─ nothing found, no cross-file signal, no tool hits  → done, ~90% of hunks
  ├─ finding produced                                    → escalate slice to T2 for judgement
  └─ cross-file OR sensitive OR concurrency OR API change → T3 directly, skip T1
```

**Rules that constrain routing.**

1. **A finding's severity caps its tier floor.** No `critical` or `high` is *posted* on T1 output alone; it must be confirmed at T2 or above. Cheap models may find, they may not sentence.
2. **The critic must not share a model with the generator on the same finding.** Same model, same context, same blind spot. A different family is better; a different tier is the minimum.
3. **BYOK changes economics, not architecture.** A customer's own key makes T3 cheap *for them*; the tier table is per-workspace configuration, and the routing logic is identical.
4. **Zero-retention and air-gapped deployments pin the tier map** to whatever is locally available, and the harness must degrade rather than refuse. [packages/zero-retention](packages/zero-retention/) already implies this constraint.
5. **Every finding records its route.** `finding.route = { tier, model, reason, escalatedFrom? }`. Without it, the cost-per-accepted-finding question, which is the only question that matters for the tier map, cannot be answered.

#### Feeding routing from outcomes

[packages/learning](packages/learning/) already measures which categories a workspace accepts, feeding the per-category thresholds at [adjudicator.ts:76-79](packages/adjudicator/src/adjudicator.ts#L76-L79). The same signal should feed routing:

- A category whose T1 findings are accepted at a high rate stays on T1.
- A category whose T1 findings are consistently dismissed stops being routed to T1 at all.
- A category whose T3 findings are also dismissed should be **switched off**, not upgraded. Spending frontier tokens on a category a team does not care about is the most expensive way to be ignored.

**H4 acceptance:** cost per review falls without accepted-finding count falling; every finding carries its route; no `critical` is posted from T1 alone; a workspace pinned to self-hosted models produces a review that says which capabilities were unavailable.

---

### 2.10.5 Why this outclasses MultiCA

MultiCA's harness is an **execution** harness: claim, run, stream, gate. It is very good at not losing work and it makes no claim about whether the work is correct; a human decides that.

Cavix's harness is a **verification** harness. The comparison that matters:

| Property | MultiCA | Cavix with this framework |
| :--- | :--- | :--- |
| Work is never lost | Partial unique index + pull-claim | §2.9 adopts it |
| Work is never stale | Head-SHA dedupe key | §2.9 + §3.3, plus supersede-in-flight |
| Output is verified | Human review gate | H2 tools + H3 critic + sandbox proof |
| Claims are falsifiable | Not a goal | Trust levels; deterministic hallucination checks |
| Knowledge compounds | Skills, human-authored | Rules (authored) + learnings (mined) + PR ledger |
| Cost is controlled | Token accounting per run | Routing on work signals + escalation ladder |

The defensible position is the third and fourth rows. Anyone can call a frontier model on a diff. **The harness is what makes the output safe to put in front of a staff engineer**, and it is the part that does not become obsolete when the next model ships.

---

# Part 3 — Review Output and the Incremental Verification Engine

## 3.1 Review output format specification

### 3.1.0 What MultiCA contributes here, honestly

MultiCA produces no review markdown; its review step is a human clicking approve. So there is no comment format to borrow. What its design *does* contribute is structural, and it is worth naming precisely because it is the part Cavix's current output under-serves:

| MultiCA structure | What it forces into the open | Cavix equivalent to add |
| :--- | :--- | :--- |
| Explicit lifecycle columns | Where this work is, not just what it says | "Since your last push" section |
| Token/cost accounting per run | What the run cost | Run footer with tier attribution |
| Task history on the issue | Continuity across runs | Ledger already has it; surface it better |
| Reason codes (`dispatch/reason.go`) | Why the system did what it did | Machine-readable reason on every drop |

### 3.1.1 Three surfaces, unchanged

The split established at [poster.ts:28-45](services/orchestrator/src/poster/poster.ts#L28-L45) is correct and this spec keeps it:

| Surface | Carries | Lifetime |
| :--- | :--- | :--- |
| **PR description block** | Executive summary, walkthrough, sequence diagram | Durable. Rewritten in place, never appended |
| **Review comment** | Scope, verdict, delta, findings, gates | Point in time. Superseded by the next review |
| **Inline comments** | One finding, on the line at fault, with proof and fix | Anchored. GitHub ages them out on its own |

The reasoning is worth restating because it is the most commonly broken rule in this product category: **no verdict, no counts, and no severities in the PR description.** A description that still says "1 critical" an hour after the critical was fixed is worse than no description, because every later reader believes it and the author cannot see it to correct it.

### 3.1.2 Canonical section order for the review comment

Order is a claim about what matters. Reading top to bottom must answer, in order: can I merge, what changed since I last looked, what must I fix, and what should I think about.

| # | Section | Condition | Owner |
| :--- | :--- | :--- | :--- |
| 1 | Badge strip | `badges !== false` | `badgeStrip` |
| 2 | **Review Scope & Effort** | `sections.reviewEffort` | `renderScope` |
| 3 | **Verdict callout** | Always | `verdict` |
| 4 | **Since your last push** | **NEW.** Re-review only | `renderDelta` |
| 5 | Diff limitations | Any file undiffable | `renderDiffLimitations` |
| 6 | Pre-merge gate | Gate enabled | `renderPreMerge` |
| 7 | Still open from earlier reviews | `carried.length > 0` | `renderCarried` |
| 8 | Cleared by this push | `resolved` has fixes | `renderResolved` |
| 9 | **Impact Scope** | **NEW.** Cross-file reach exists | `renderImpact` |
| 10 | **Security Risks** | **NEW.** Any security finding | `renderSecurity` |
| 11 | Fix these first | Any high or above | `renderPriority` |
| 12 | Findings by file | Any finding | `renderFileSection` |
| 13 | **Architectural Feedback** | **NEW.** Any structural observation | `renderArchitecture` |
| 14 | Legend | Any finding | `legendLine` |
| 15 | Run footer | Always | `footer` |

Sections 4, 9, 10, and 13 are new. Sections 1, 2, 3, 5, 6, 7, 8, 11, 12, 14, 15 exist today in [poster.ts](services/orchestrator/src/poster/poster.ts) and keep their current implementation.

**Why these four, and no others.**

- **Since your last push (4)** sits directly under the verdict because on any PR past its first review, "what changed" is the reader's actual question. Today they have to infer it by diffing two comments.
- **Impact Scope (9)** is the AST payoff made visible. Reporting "3 files changed" is what GitHub already does; reporting "reaches 11 call sites across 4 modules, 2 of them in other repositories" is what nothing else does.
- **Security Risks (10)** is separated from general findings because security has a different reader with different urgency. It restates rather than relocates: a security finding still appears in its file section.
- **Architectural Feedback (13)** sits *below* the findings deliberately. It is the least urgent and most opinionated content in the review, and putting design opinions above defects is how a reviewer trains people to skim past the defects.

### 3.1.3 The four new sections

#### Section 4 — Since your last push

```markdown
### ◈ Since your last push

`a3f8c21` → `7b2e904` · 2 commits · 4 files re-read

| | Change |
| :--: | :--- |
| ✓ | **2 findings cleared.** SQL injection in `refund.ts`, unchecked index in `batch.ts` |
| ◆ | **1 finding raised.** New null path in `refund.ts:94`, introduced by this push |
| ▲ | **3 findings still open.** The files they point at have not changed |
| ◇ | **6 files unchanged since the last review.** Not re-read |
```

Every row is measured, not narrated. The last row is the one that builds trust in the incremental engine: it states plainly that Cavix knows what it did not look at again, and why that was safe.

Rendered only when `prior.entries.length > 0` or `reviewsUsed > 0` from the [PrLedger](packages/review-session/src/ledger.ts#L85-L94).

#### Section 9 — Impact Scope

```markdown
### ◈ Impact Scope

**`refund()`** in `services/api/src/refund.ts` changed signature.

| | Reached | Where |
| :--: | :--- | :--- |
| ◆ | 7 call sites | `api/handlers/refund.ts`, `api/jobs/nightly.ts`, `+3 files` |
| ▲ | 2 consumers | `acme/billing-worker`, `acme/admin-console` |
| ◇ | 1 public export | `@acme/api-client` re-exports `refund` |
| ⬢ | 12 tests | 12 selected from the graph, 11 passed, 1 failed |

<sub>Traced from the AST call graph at depth 3. Call sites resolved statically;
dynamic dispatch is not represented.</sub>
```

That closing caveat is mandatory. Cavix's parsers are static and heuristic ([parser.ts:1-5](packages/analyzer/src/parser.ts#L1-L5)), and a reach claim that does not disclose its method is exactly the fabricated-statistic failure the poster already refuses to commit ([poster.ts:64-67](services/orchestrator/src/poster/poster.ts#L64-L67)).

#### Section 10 — Security Risks

```markdown
### ▲ Security Risks

> [!CAUTION]
> **1 exposure, highest critical.** One was reproduced by execution.

| | Risk | Where | Evidence |
| :--: | :--- | :--- | :--- |
| ◆ | SQL injection via `orderId` | [`refund.ts:41`](…) | ⬢ verified · semgrep@1.95 |

**Reachability.** The tainted parameter enters at the HTTP boundary in
`handlers/refund.ts:22` and reaches `execute()` with no intervening
sanitisation. No authentication check sits between them.
```

The **Reachability** paragraph is what separates a security finding from a scanner hit. A SAST tool says "string-built query"; a reviewer with a call graph says "and here is the unauthenticated path from the internet to it". If the graph cannot establish reachability, the paragraph is omitted rather than softened. "Potentially reachable" is not a measurement.

#### Section 13 — Architectural Feedback

```markdown
### ◇ Architectural Feedback

> [!NOTE]
> Observations about structure. Nothing here blocks the merge.

**Transaction boundary crosses the service layer.** `refund()` opens a
transaction and calls `notifyCustomer()`, which performs network I/O inside
it. Under retry the customer is notified once per attempt, and the
transaction is held open for the duration of an external call.

<sub>`services/api/src/refund.ts:88` · category: architecture · confidence 72%
· not verified by execution</sub>
```

Three constraints on this section:

1. **Capped at three items.** A review with nine architectural opinions is a review nobody finishes.
2. **Never blocking.** Architecture findings may not escalate to `REQUEST_CHANGES` even when the gate is on.
3. **Must name a consequence.** "This violates SRP" is not admissible. "Under retry the customer is notified once per attempt" is. The consequence is what makes an opinion falsifiable, and unfalsifiable opinions are what get review bots muted.

### 3.1.4 Automated fix snippets

Cavix already emits GitHub `suggestion` blocks at [poster.ts:570-575](services/orchestrator/src/poster/poster.ts#L570-L575). The specification tightens when one may be emitted:

| Rule | Requirement |
| :--- | :--- |
| **Syntactic validity** | The patched file must parse. Check before emitting; a suggestion that breaks the build is worse than no suggestion |
| **Anchoring** | Must replace exactly the lines it is attached to. GitHub applies it literally |
| **Scope** | Single hunk, one concern. A refactor is not a suggestion |
| **Indentation** | Must match surrounding lines exactly, including tabs versus spaces |
| **Verification tiering** | See below |
| **No suggestion for taste** | Suggestions are for defects. An architecture opinion gets prose |

Three tiers, and the label must match the tier:

~~~~markdown
```suggestion
  const amount = parseAmount(raw) ?? 0;
```
<sub>⬢ **Verified fix.** Applied in a sandbox: the reproduction stops failing and
the existing suite still passes.</sub>
~~~~

~~~~markdown
```suggestion
  const amount = parseAmount(raw) ?? 0;
```
<sub>◇ **Unverified fix.** Parses and type-checks; not executed.</sub>
~~~~

For anything larger, no `suggestion` block at all. Emit a `diff` fence, which renders coloured but has no Apply button, and say why:

~~~~markdown
```diff
- await tx.begin();
- await notifyCustomer(id);
- await tx.commit();
+ await tx.begin();
+ await tx.commit();
+ await notifyCustomer(id);
```
<sub>▪ **Sketch.** Moves the notification outside the transaction. Spans a
control-flow change, so it is shown rather than offered as a one-click apply.</sub>
~~~~

The distinction matters because a one-click Apply button is a promise. Once a team has applied a broken suggestion, they stop using the button, and the feature is dead for that account.

### 3.1.5 Worked example

The full review comment for a second push on an open PR:

```markdown
<!-- cavix:review -->
## ◈ Cavix Review

![Security: 1 critical](…) ![Execution Proof: 2 verified](…) ![Confidence: 88%](…) ![Review Effort: 4 of 5](…)

### ◈ Review Scope & Effort

| | Signal | Reading |
| :--: | :--- | :--- |
| ◇ | **Deep Scan** | 2 subsystems traversed · 7 changed regions · TypeScript |
| ◇ | **Symbol Scope** | `refund`, `issueCredit`, `parseAmount` |
| ⬢ | **AST Verification** | 34 symbols resolved, cross-file impact mapped |
| ⬢ | **Deterministic Pass** | 5 linter, SAST and secret tools run over the change |
| ◇ | **Ensemble** | 4 specialist agents read this diff independently |
| ◇ | **Blast Radius** | 2 downstream call sites checked in other repositories |
| ▲ | **Still Open** | 3 findings from earlier reviews, in 2 files unchanged since they were raised |
| ▲ | **Security Gate** | ◆ 1 exposure, highest **critical** |
| ⬢ | **Execution Proof** | 2 of 3 findings reproduced in a sealed sandbox, 1 other discarded as unreproducible |
| ◇ | **Confidence Score** | ●●●●○ 88% mean across the findings raised |
| ▲ | **Review Effort** | ◆◆◆◆◇ **4 of 5**, a careful read |

---

> [!CAUTION]
> **3 findings** across **2 files**
>
> ◆ 1 critical · ◇ 2 medium
>
> plus 3 findings still open from earlier reviews

<sub>2 of 3 findings were reproduced in a sealed sandbox. 4 agents read this diff.</sub>

---

### ◈ Since your last push

`a3f8c21` → `7b2e904` · 2 commits · 4 files re-read

| | Change |
| :--: | :--- |
| ✓ | **2 findings cleared.** Unchecked index in `batch.ts`, missing await in `jobs.ts` |
| ◆ | **1 finding raised.** SQL injection in `refund.ts:41`, introduced by this push |
| ▲ | **3 findings still open.** The files they point at have not changed |
| ◇ | **6 files unchanged since the last review.** Not re-read |

---

### ▲ Still open from earlier reviews

These were raised on this pull request and have not been dealt with. Cavix did not
raise them again in this review, and it checked why: **the files they point at have
not changed since.** They count towards the result above.

| | Finding | Where | Raised |
| :--: | :--- | :--- | :--- |
| ◈ | Refund amount is not idempotent under retry | `ledger.ts` line 210 | 3 reviews ago |
| ◇ | Missing index on `refund.order_id` | `schema.sql` line 44 | an earlier review |
| ▫ | Error swallowed without logging | `ledger.ts` line 88 | an earlier review |

<sub>Fix one and push, and it clears itself on the next review. Disagree with one?
`@cavixcode resolve` closes them all, and the dashboard can dismiss them one at a time.</sub>

---

### ✓ Cleared by this push

- Unchecked array index <sub>services/api/src/batch.ts</sub>
- Missing await on `flush()` <sub>services/api/src/jobs.ts</sub>

---

### ◈ Impact Scope

**`refund()`** in `services/api/src/refund.ts` changed signature.

| | Reached | Where |
| :--: | :--- | :--- |
| ◆ | 7 call sites | `api/handlers/refund.ts`, `api/jobs/nightly.ts`, `+3 files` |
| ▲ | 2 consumers | `acme/billing-worker`, `acme/admin-console` |
| ⬢ | 12 tests | 12 selected from the graph, 11 passed, 1 failed |

<sub>Traced from the AST call graph at depth 3. Call sites resolved statically;
dynamic dispatch is not represented.</sub>

---

### ▲ Security Risks

> [!CAUTION]
> **1 exposure, highest critical.** Reproduced by execution.

| | Risk | Where | Evidence |
| :--: | :--- | :--- | :--- |
| ◆ | SQL injection via `orderId` | `refund.ts:41` | ⬢ verified · semgrep@1.95 |

**Reachability.** The tainted parameter enters at the HTTP boundary in
`handlers/refund.ts:22` and reaches `execute()` with no intervening sanitisation.
No authentication check sits between them.

---

### Findings

> [!CAUTION]
> **Fix these first**
>
> ◆ **SQL injection via `orderId`** · `refund.ts:41`

#### `services/api/src/refund.ts`

| | Finding | Line | Detail |
| :--: | :--- | :--- | :--- |
| ◆ | SQL injection via `orderId` | 41 | ▸ inline |
| ◇ | Rounding drops the final cent on partial refunds | 94 | ▸ inline |

#### `services/api/src/ledger.ts`

| | Finding | Line | Detail |
| :--: | :--- | :--- | :--- |
| ◇ | Ledger write is not idempotent | 132 | ▸ inline |

---

### ◇ Architectural Feedback

> [!NOTE]
> Observations about structure. Nothing here blocks the merge.

**Transaction boundary crosses the service layer.** `refund()` opens a transaction
and calls `notifyCustomer()`, which performs network I/O inside it. Under retry the
customer is notified once per attempt, and the transaction is held open for the
duration of an external call.

<sub>`services/api/src/refund.ts:88` · category: architecture · confidence 72%
· not verified by execution</sub>

---

<sub>◆ critical · ◈ high · ◇ medium · ▪ low · ▫ info · ⬢ proved by execution.
3 findings, 3 with inline detail.</sub>

<sub>Cavix · review 4 of this pull request · 4 agents · 2 verified by execution ·
routed T3 (2), T2 (6), T1 (31) · 1m 48s</sub>
```

The run footer is new and comes from MultiCA's token-accounting habit. It states the tier mix, which makes cost legible without exposing token counts a customer cannot act on.

### 3.1.6 Format invariants

Machine-checkable rules for a `poster` test suite:

| # | Invariant |
| :--- | :--- |
| 1 | No emoji anywhere. Geometric marks only: `◆ ◈ ◇ ▪ ▫ ⬢ ▲ ✓ ✕ ● ○` |
| 2 | No em or en dashes, including in model-authored text. `plain()` rewrites on the way out |
| 3 | Every number is measured. A stage that did not run contributes no row |
| 4 | Never restate `files changed`, `+lines`, `-lines`. GitHub renders them directly above |
| 5 | One H2 per surface, H3 per section, H4 per file. Nothing larger |
| 6 | Body under `MAX_BODY` (60000). Whole sections drop from the end, never mid-table |
| 7 | Sections 4, 7, 8 survive truncation: they precede this review's own findings |
| 8 | Every permalink built from `ReviewLinkRef.host` and `platform`, never a hardcoded github.com |
| 9 | A finding appears at most once as an inline comment |
| 10 | The check-run title and the verdict callout never disagree |
| 11 | A `suggestion` block always parses when applied |
| 12 | The description block contains no verdict, count, or severity |

---

## 3.2 AST and graph context requirements

### 3.2.1 The requirement, stated as a test

> Given a diff that changes the signature of a function, Cavix must be able to name every caller that now passes the wrong arguments, **including callers in files the diff does not touch**, and must be able to say so with the file, the line, and the reason.

A raw-diff reviewer cannot do this at any model size, because the information is not in the diff. This is the single capability that separates a review engine from a prompt wrapper.

### 3.2.2 Current state

[packages/analyzer](packages/analyzer/) has the right architecture: a `Parser` port ([parser.ts](packages/analyzer/src/parser.ts)) with heuristic regex implementations behind it, a symbol/edge graph ([graph.ts](packages/analyzer/src/graph.ts)), an incremental `CodeIndex` with `blastRadiusFromDiff` at depth 3 ([indexer.ts:195-211](packages/analyzer/src/indexer.ts#L195-L211)), and a consumer at [assembler.ts:54-58](packages/context/src/assembler.ts#L54-L58). The port comment already anticipates the replacement: "a tree-sitter / stack-graphs parser can replace them per language without touching the graph, indexer, or retrieval code above."

Five gaps stand between that and the requirement above.

### 3.2.3 Gap 1 — Symbol identity is not unique and not stable

`symbolId(path, name)` returns `` `${path}#${name}` `` ([graph.ts:37-39](packages/analyzer/src/graph.ts#L37-L39)). Two problems:

- **Not unique.** Two classes in one file each with a `run` method collide into one node. Their callers merge. Blast radius for one silently includes the other's.
- **Not stable.** A file rename changes every id in it. Every edge breaks, every ledger fingerprint keyed on the path changes, and the review reports a rename as "everything new and everything fixed".

```ts
export interface SymbolId {
  path: string;
  /** Enclosing scope chain: ["RefundService", "process"] for a method. */
  scope: string[];
  name: string;
  kind: "function" | "method" | "class" | "interface" | "type" | "const" | "enum";
  /** Signature hash. Distinguishes overloads and detects signature change. */
  signature: string;
}

/** Unique within a repository at a point in time. */
export function symbolKey(id: SymbolId): string {
  return `${id.path}#${[...id.scope, id.name].join(".")}:${id.kind}`;
}

/** Survives renames and moves. Content-derived, path-free. */
export function symbolIdentity(id: SymbolId, bodyHash: string): string {
  return sha1(`${id.name}|${id.kind}|${id.signature}|${bodyHash}`).slice(0, 16);
}
```

Two ids, two jobs. `symbolKey` addresses a symbol now. `symbolIdentity` recognises it after it moves, which is what makes rename-safe finding tracking possible (§3.3.6).

### 3.2.4 Gap 2 — Only call edges exist

`FileRecord` carries `calls` and `importedModules` ([graph.ts:26-35](packages/analyzer/src/graph.ts#L26-L35)). A review needs more edge kinds, each answering a question a reviewer actually asks:

| Edge | Question it answers | Priority |
| :--- | :--- | :--- |
| `calls` | Who breaks if I change this signature? | Have it |
| `imports` | What modules depend on this file? | Have it (module-level) |
| `implements` / `extends` | What else must change with this interface? | **P0** |
| `reads` / `writes` | Who touches this shared state? | **P0** |
| `throws` / `catches` | Where does this error surface? | P1 |
| `awaits` | Where can this suspend, and what is held meanwhile? | P1 |
| `routes` | Which HTTP endpoint reaches this code? | **P0**, security |
| `queries` | Which tables does this touch? | P1 |
| `tests` | Which tests cover this symbol? | **P0**, test selection |

`routes` and `tests` earn P0 by paying for themselves immediately: `routes` produces the Reachability paragraph in §3.1.3, and `tests` produces graph-selected test execution in H2 Tier 5.

### 3.2.5 Gap 3 — Heuristic parsers cap the ceiling

Regex parsers are the right Phase 1 choice: fast, hermetic, dependency-free, and consistent with the project's dependency-free constraint. They cannot resolve overloads, generics, re-exports, dynamic dispatch, or decorators, and they will silently mis-resolve rather than report uncertainty.

**The requirement is not "use tree-sitter". It is: every graph fact must carry its confidence, and the review must not state a low-confidence fact as certain.**

```ts
export interface GraphEdge {
  from: string; to: string; kind: EdgeKind;
  resolution: "exact" | "heuristic" | "ambiguous";
  /** Populated when ambiguous: every candidate considered. */
  candidates?: string[];
  line: number;
}
```

Rendering rules follow directly: `exact` may be stated as fact; `heuristic` must be hedged with its method ("resolved by name match"); `ambiguous` may inform routing and context selection but **may never appear in a posted claim**. This is the trust-level discipline from H1 applied to the graph, and it lets a heuristic parser ship safely today while a tree-sitter backend lands language by language behind the same port.

### 3.2.6 Gap 4 — Blast radius is uniform depth 3

`blastRadius(changedIds, depth = 3)` ([indexer.ts:211](packages/analyzer/src/indexer.ts#L211)) treats every symbol identically. A utility called from 400 places floods the context with callers, evicting everything else under the flat budget; a leaf handler called from one place gets the same depth it does not need.

```ts
export interface BlastRadiusOptions {
  /** Stop expanding a symbol with more callers than this; report the count. */
  fanoutCap: number;          // default 25
  /** Deeper for signature changes, shallower for body-only edits. */
  depthFor(change: ChangeKind): number;
  /** Always expand fully, whatever the fanout. */
  alwaysExpand: EdgeKind[];   // ["implements", "routes"]
}

export type ChangeKind =
  | "signature"   // depth 4: the whole point is who calls it
  | "body"        // depth 2
  | "added"       // depth 1: nothing calls it yet
  | "deleted"     // depth 4: everything that called it is now broken
  | "renamed"     // depth 4
  | "moved";      // depth 1: identity preserved, callers unaffected
```

When the cap truncates, the context must say so: "`log()` has 412 callers; 25 shown". A reviewer told the fanout is huge reasons differently than one shown 25 callers as though that were all of them.

### 3.2.7 Gap 5 — The graph is rebuilt, not maintained

`CodeIndex` is incremental per file (`FileRecord.hash` at [graph.ts:28](packages/analyzer/src/graph.ts#L28)), but nothing persists it across reviews. Every review of every PR re-parses the repository. On a large monorepo that is the dominant cost and it scales with repository size rather than change size.

**Requirements:**

| # | Requirement |
| :--- | :--- |
| 1 | Graph persisted per `(repo, commit)` with content-addressed file records |
| 2 | Reindex only files whose blob hash changed between the cached commit and the head |
| 3 | Cold-start budget bounded; on timeout, degrade to diff-only and say so in the Scope module |
| 4 | Base-branch graph warmed on push to the default branch, so PR reviews are always incremental |
| 5 | Cross-repo consumer edges resolved through [packages/orggraph](packages/orggraph/) at published-symbol granularity |
| 6 | Graph is a cache, never a source of truth. A stale entry produces a slower review, never a wrong one |

Requirement 6 is the safety property. Every graph fact used in a posted claim must be revalidated against the head blob before rendering.

### 3.2.8 What replaces the raw diff in the prompt

The diff itself is never removed; it is the change under review and [assembler.ts:62](packages/context/src/assembler.ts#L62) is right to pin it at priority 100. What changes is that it stops being the *only* structural information:

~~~~text
### Change under review
```diff
@@ -38,7 +38,7 @@ async function refund(orderId: string, amount: number) {
-  const row = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
+  const row = await db.query(`SELECT * FROM orders WHERE id = ${orderId}`);
```

### Symbol graph for this change
symbol   refund(orderId: string, amount: number): Promise<Refund>
         services/api/src/refund.ts:38  kind=function  change=body
callers  handlers/refund.ts:22   refund(req.params.id, req.body.amount)   [exact]
         jobs/nightly.ts:88      refund(o.id, o.total)                    [exact]
         +5 more, 2 in other repositories
routes   POST /api/refunds/:id -> handlers/refund.ts:22 -> refund   [exact]
         auth middleware on this route: NONE
reads    db (module import)
tests    refund.spec.ts:12 "partial refund rounds down"  [exact]
         refund.spec.ts:41 "rejects unknown order"       [exact]
~~~~

The `auth middleware on this route: NONE` line is a graph fact, not a model inference. A reviewer that can state it turns a generic "consider validating input" into "an unauthenticated POST reaches a string-built query", which is the difference between a comment that gets resolved and one that gets fixed.

---

## 3.3 The incremental verification engine

### 3.3.1 What already works

[packages/review-session/src/ledger.ts](packages/review-session/src/ledger.ts) is the strongest piece of incremental logic in the codebase and this spec extends rather than replaces it. Its three rules are correct and hard-won:

1. **A finding is never cleared by silence.** It clears when the code moved *and* the reviewer did not raise it again ([ledger.ts:21-33](packages/review-session/src/ledger.ts#L21-L33)).
2. **"The code moved" is measured**, as a digest of that file's hunks ([fileDigests](packages/review-session/src/ledger.ts#L156-L169)).
3. **Anything unmeasurable stays open.** A finding carried by mistake costs a conversation; a finding cleared by mistake costs the defect.

Identity excludes the line number and the body ([fingerprintOf](packages/review-session/src/ledger.ts#L121-L127)), which is exactly right: models rephrase, and a fix earlier in a file shifts every line below it.

Five gaps remain.

### 3.3.2 Gap 1 — File-level digests over-clear and over-carry

`fileDigests` hashes **all** hunks of a file ([ledger.ts:156-169](packages/review-session/src/ledger.ts#L156-L169)), so the resolution rule operates at file granularity. Two failure modes:

- **False clear.** A finding at line 40. Someone edits line 900 of the same file. The digest changes. The reviewer does not re-raise the finding at line 40. It is marked `fixed`. **It was not fixed.** Nobody touched it.
- **False carry.** A finding in a file whose other hunks changed but whose relevant region did not, correctly carried, but with no way to say "and the code it points at is untouched" with more precision than "the file changed".

The false clear is the serious one, because it silently re-opens the exact class of bug the ledger was built to close.

**Fix: region digests.**

```ts
export interface RegionDigest {
  /** Digest of the whole file's hunks. Backwards compatible. */
  file: string;
  /** Digest per changed region, keyed by enclosing symbol where known. */
  bySymbol: Record<string, string>;
  /** Fallback when no symbol resolves: hunk index -> digest. */
  byHunk: Record<string, string>;
}
```

Resolution rule becomes, in order of preference:

```
1. Symbol known for the finding and present in bySymbol
     unchanged  -> CARRY  (regardless of what else moved in the file)
     changed    -> eligible for clear
2. No symbol, but the finding's line falls inside a known hunk range
     that hunk's digest unchanged -> CARRY
3. Neither -> fall back to the file digest (today's behaviour)
```

Every step degrades to the current, safe behaviour. The enclosing symbol is already available: git writes it into the hunk header and [poster.ts:884-895](services/orchestrator/src/poster/poster.ts#L884-L895) already extracts it with `symbolFrom`.

### 3.3.3 Gap 2 — Every review re-reads the whole PR

The diff is `base...head` by design, and for the **verdict** that is correct: the merge introduces the whole diff, not the last commit. But it means the *reviewer* re-reads everything on every push. Costs: tokens proportional to PR size rather than push size, latency that grows through a PR's life, and non-determinism, because the model re-reads code it already judged and may reach a different conclusion for no reason.

**Fix: separate the verdict domain from the attention domain.**

```ts
export interface ReviewScope {
  /** base...head. What the verdict is computed over. Never narrowed. */
  verdictDiff: string;
  /** prevHead...head. What is new since the last review. */
  deltaDiff: string;
  /** Files with hunks in deltaDiff. Full attention. */
  hotFiles: string[];
  /** In verdictDiff, not in deltaDiff, and carrying open findings. Ledger-only. */
  warmFiles: string[];
  /** In verdictDiff, not in deltaDiff, no open findings. Not re-read. */
  coldFiles: string[];
}
```

| Domain | Treatment |
| :--- | :--- |
| **Hot** | Full pipeline: H1 context, H2 tools, ensemble, critic, verify |
| **Warm** | No model call. Ledger resolution only. Carried findings hold their state |
| **Cold** | No model call. No tools. Counted in scope, reported as not re-read |

The verdict is still computed over the whole PR, because the ledger holds every open finding from every earlier review whether or not this review looked at its file. **This is precisely what the ledger was built for**, and it is what makes narrowing attention safe. Without the ledger, narrowing the diff would silently drop findings; with it, narrowing is sound.

Three cases force a full re-read regardless:

1. Base branch moved (merge or rebase from base). The whole diff is genuinely different.
2. Force-push (§3.3.4).
3. A repo rule, a `.cavix/` config, or a lockfile changed. The law changed, so prior judgements are void.

Expected effect on a typical PR with 6 pushes: first review reads 100%, pushes 2 through 6 read the delta plus warm files, roughly 15 to 30% of the diff each.

### 3.3.4 Gap 3 — Force-push and rebase are undetected

`ReconcileInput` takes only `headSha` ([ledger.ts:171-182](packages/review-session/src/ledger.ts#L171-L182)). After a rebase, every file's hunks differ because the base changed, so **every** open finding sees a changed digest and clears if not re-raised. A rebase can wipe the ledger clean without a single line of the author's code being fixed.

```ts
export interface ReconcileInput {
  prior: PrLedger;
  findings: Finding[];
  diff: string;
  headSha: string;
  /** NEW. The merge base this diff was computed against. */
  baseSha: string;
  /** NEW. head/base of the review this ledger was last written by. */
  priorHeadSha?: string;
  priorBaseSha?: string;
  /** NEW. False when head is not a descendant of priorHead. */
  linearHistory: boolean;
  now?: () => Date;
}
```

```ts
// Detection, before reconciliation.
const rebased  = input.baseSha !== input.priorBaseSha;
const forced   = !input.linearHistory;

if (rebased || forced) {
  // Digests are not comparable across a rewritten history. Comparing them
  // would clear every open finding on evidence that measures the rebase,
  // not the code. Rule 3 applies: what cannot be measured stays open.
  return reconcileConservatively(input);   // carry all open entries,
                                           // re-digest, clear nothing
}
```

`reconcileConservatively` carries every open entry, refreshes digests against the new diff, and clears nothing. The next ordinary push then resolves normally. A finding carried one review too long costs a conversation; the alternative silently clears the whole ledger, which is the failure this module exists to prevent.

The review must also say so:

```markdown
| ▲ | **History rewritten** | The branch was rebased. Findings from earlier reviews are carried forward without clearing, because their evidence was measured against a history that no longer exists |
```

### 3.3.5 Gap 4 — No supersede for an in-flight review

MultiCA's TEN-356 fix (§2.7), applied to Cavix. Cavix's edge idempotency key includes `HeadSHA` ([github.go:116-120](services/edge/internal/webhook/github.go#L116-L120)), so a *new* job is correctly created for a new commit. Nothing cancels the *running* one. A push during a two-minute review yields two reviews posted seconds apart, the older one anchored to lines that have moved, and a race over which writes the ledger last.

```sql
CREATE TABLE review_run (
  id              uuid PRIMARY KEY,
  repo_id         bigint  NOT NULL,
  pr_number       int     NOT NULL,
  head_sha        text    NOT NULL,
  base_sha        text    NOT NULL,
  status          text    NOT NULL
    CHECK (status IN ('queued','claimed','running','posting',
                      'completed','failed','cancelled','superseded')),
  outcome         text,
  failure_reason  text,
  claimed_by      text,
  claimed_at      timestamptz,
  updated_at      timestamptz NOT NULL
);

-- MultiCA's idx_one_pending_task_per_issue, for reviews. Note that 'running'
-- IS included here, unlike MultiCA's: a second concurrent review of one PR is
-- never useful, whereas a second agent run on one issue sometimes is.
CREATE UNIQUE INDEX one_active_review_per_pr
  ON review_run (repo_id, pr_number)
  WHERE status IN ('queued','claimed','running','posting');
```

```
on pull_request.synchronize:
  active = SELECT ... WHERE repo_id, pr_number AND status IN (queued,claimed,running,posting)

  if active is null                   -> enqueue
  if active.head_sha == new head      -> drop (redelivery; coalesce)
  if active.status == 'posting'       -> wait for it, then enqueue
                                         (never interrupt a partial post)
  otherwise                           -> mark active 'superseded',
                                         signal cancel, enqueue
```

`posting` is a distinct state because a review that is half-written to GitHub must never be abandoned: a PR with three inline comments and no review body is worse than a late review. The worker checks a cancel flag between pipeline stages and exits cleanly; it never checks inside a post.

### 3.3.6 Gap 5 — Renames break identity

`fingerprintOf` includes `f.path` ([ledger.ts:121-127](packages/review-session/src/ledger.ts#L121-L127)). Rename `refund.ts` to `refunds.ts` and every finding in it is simultaneously cleared (old path absent from the digest map, treated as `reverted`) and re-raised as new. The reader sees a review claiming it fixed four things and found four new ones, when nothing changed but a filename.

**Fix, in two parts.**

1. **Consume git's rename detection.** Unified diffs carry `rename from` / `rename to`; the parser at [packages/differ](packages/differ/) must surface it as `DiffFile.renamedFrom`.
2. **Migrate ledger entries before reconciling.**

```ts
function applyRenames(prior: PrLedger, renames: Map<string, string>): PrLedger {
  if (renames.size === 0) return prior;
  return {
    ...prior,
    entries: prior.entries.map((e) => {
      const to = renames.get(e.path);
      if (!to) return e;
      // The fingerprint is path-derived, so it must be recomputed, and the
      // original recorded: a finding whose id changed under the reader's feet
      // is unexplainable without it.
      return { ...e, path: to, fingerprint: refingerprint(e, to), renamedFrom: e.path };
    }),
  };
}
```

When the parser reports a rename with `similarity < 60%`, treat it as delete-plus-add and let normal resolution run. That is git's own threshold and it is the right one: below it, the file genuinely was rewritten.

### 3.3.7 Inline comment lifecycle

The ledger tracks findings. Nothing tracks the *comments* that represent them, so across six pushes a PR accumulates six sets of inline comments for the same three findings.

| Ledger transition | Inline comment action |
| :--- | :--- |
| `fresh` | Post new inline comment, stamped with `INLINE_MARKER` and the fingerprint |
| `repeated`, line unchanged | **Leave the existing comment.** Do not repost |
| `repeated`, line moved | Update the existing comment body; re-anchor to the new line |
| `carried` (not re-raised) | Leave in place. It is already outdated on GitHub, which is honest |
| `resolved: fixed` | Reply once with "Fixed in `<sha>`", then resolve the thread where the platform allows |
| `resolved: reverted` | Resolve the thread silently. No reply; nothing was fixed |
| `dismissed` | Resolve the thread, reply naming who dismissed it |

This requires the fingerprint in the comment. `INLINE_MARKER` ([poster.ts:555](services/orchestrator/src/poster/poster.ts#L555)) already exists as a hidden HTML comment; extend it:

```html
<!-- cavix:inline:fp=a3f81c92b40e5d77 -->
```

A later run lists its own comments, parses the fingerprints, and reconciles against the ledger. Without this the incremental engine is invisible: the ledger can be perfectly correct while the PR page shows six copies of the same comment, and the reader believes the page.

### 3.3.8 Full reconciliation algorithm

```
INPUT  event(repo, pr, head, base), prior ledger L, prior review R
──────────────────────────────────────────────────────────────────────

 1  SUPERSEDE      cancel any active run for (repo, pr) with a different head
                   coalesce if same head; wait if status = posting

 2  FETCH          verdictDiff = base...head
                   deltaDiff   = R.head...head        (empty on first review)
                   renames     = from the unified diff
                   linear      = is head a descendant of R.head

 3  MIGRATE        L = applyRenames(L, renames)

 4  CLASSIFY       hot  = files with hunks in deltaDiff
                   warm = files in verdictDiff with open entries in L, not hot
                   cold = everything else in verdictDiff
                   if rebased or forced or rules changed: hot = all files

 5  INDEX          graph = incremental index over hot files (§3.2.7)
                   revalidate every cached fact against head blobs

 6  H2 TOOLS       deterministic tiers 0-5, scoped to hot + blast radius

 7  H1 CONTEXT     assemble rules, graph, memory over hot files

 8  ROUTE + GEN    H4 tiers, ensemble over hot slices

 9  H3 CRITIC      verdicts, bounded repair, adjudication

10  VERIFY         sandbox reproduction for high+ (existing verifier)

11  RECONCILE      reconcile({ prior: L, findings, diff: verdictDiff,
                               headSha, baseSha, priorHeadSha, priorBaseSha,
                               linearHistory })
                   -> { ledger, carried, resolved, fresh, repeated }
                   region digests (§3.3.2); conservative mode if !linear

12  COMMENTS       reconcile inline comments by fingerprint (§3.3.7)

13  POST           review comment, description block, check run
                   verdict computed over (fresh + repeated + carried),
                   NEVER over this review's findings alone

14  PERSIST        ledger; review_run -> completed; emit run metrics
```

Step 13's parenthetical is the invariant the entire ledger exists to protect, already stated at [ledger.ts:6-19](packages/review-session/src/ledger.ts#L6-L19). Every change in this document must preserve it.

### 3.3.9 Acceptance tests

| # | Given | When | Then |
| :--- | :--- | :--- | :--- |
| 1 | 3 open findings, 1 fixed and pushed | Re-review | 1 cleared, 2 carried, verdict counts 2 |
| 2 | Finding at line 40; line 900 of the same file edited | Re-review does not re-raise it | **Carried, not cleared** (region digest) |
| 3 | Open findings; branch rebased onto a new base | Re-review | All carried; review states history was rewritten |
| 4 | Review running on commit A | Commit B pushed | A is `superseded`; only B's review posts |
| 5 | Review in `posting` | Commit B pushed | Posting completes; B queues behind it |
| 6 | Finding in `refund.ts` | Renamed to `refunds.ts` | Finding follows; not cleared, not duplicated |
| 7 | Same finding raised on 4 pushes | Fourth review | One inline comment, updated in place |
| 8 | 20-file PR, 1 file touched by the push | Re-review | Only that file is re-read; others reported not re-read |
| 9 | `.cavix/rules/*.md` changed | Re-review | Full re-read, whatever the delta |
| 10 | Webhook redelivered for the same SHA | Second delivery | Coalesced; no second review |
| 11 | Finding off-diff (file has no hunks) | Any number of reviews | Stays open until the file enters the PR or a human dismisses it |
| 12 | Ledger unreachable | Review runs | Posts, and does not claim a clean pass ([poster.ts:1101-1109](services/orchestrator/src/poster/poster.ts#L1101-L1109)) |
| 13 | Force-push with no base change | Re-review | Conservative mode; nothing cleared |
| 14 | Symbol renamed within a file | Re-review | Tracked by `symbolIdentity`, not reported as new |

---

## 4. Implementation sequence

Ordered by risk retired per unit of work, not by section number.

| Phase | Work | Why first |
| :--- | :--- | :--- |
| **P0** | §1.5 diagnostic, then §1.6.2 App registration | Every GitHub fix is blocked on it, and it is configuration, not code |
| **P1** | §1.6.3 connect + setup routes, §1.6.5 installation webhooks | Fixes the reported bug. Highest visible value |
| **P2** | §3.3.5 supersede + `review_run` table | Prevents wrong reviews being posted. Correctness, not features |
| **P3** | §3.3.2 region digests, §3.3.4 rebase detection, §3.3.6 renames | Closes false-clear paths in a shipped guarantee |
| **P4** | §2.10.3 H3 deterministic hallucination checks (location, symbol, anchor) | Cheapest credibility win available; no model calls |
| **P5** | §3.3.3 hot/warm/cold scoping | Cost and latency fall with no capability loss |
| **P6** | §2.10.1 H1 rules + trust levels + banded budget | Makes reviews repo-aware |
| **P7** | §3.1.3 new report sections, §3.3.7 comment lifecycle | Output catches up with the engine |
| **P8** | §2.10.4 H4 routing signals + escalation ladder | Cost curve, once quality is stable |
| **P9** | §3.2 graph persistence, edge kinds, tree-sitter backend | Largest effort, highest ceiling |
| **P10** | §2.10.3 full critic-generator loop with repair | Last, because it needs the rest to measure against |

Two ordering notes. **P4 before P10:** the deterministic hallucination checks catch the three classes that damage credibility most and cost nothing to run, while the full critic loop needs an eval baseline to be tuned against. **P2 before P3:** a superseded review that never posts cannot corrupt a ledger, so the cancellation path retires more risk than the resolution refinements do.

---

## 5. Verification log

| Claim | Source |
| :--- | :--- |
| Install and authorization are independent grants | [docs.github.com — Authorizing GitHub Apps](https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps) |
| GitHub App user tokens do not use scopes | [docs.github.com — Generating a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) |
| `prompt` is an accepted authorize parameter; `scope` is not | same |
| `prompt=select_account` forces the account picker | [GitHub Changelog, 2024-06-07](https://github.blog/changelog/2024-06-07-account-picker-updates-for-oauth-and-github-app-sign-in/) |
| Install screen offers "All repositories" / "Only select repositories" | [docs.github.com — Installing a GitHub App from a third party](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party) |
| Setup URL receives `installation_id`; it must not be trusted | [docs.github.com — About the setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url) |
| Grant revocation deletes the grant and all tokens | [docs.github.com — REST endpoints for OAuth authorizations](https://docs.github.com/en/rest/apps/oauth-applications) |
| MultiCA architecture, agents, self-hosting | [github.com/multica-ai/multica](https://github.com/multica-ai/multica) |
| MultiCA lifecycle enums, `pgcrypto` only | `server/migrations/001_init.up.sql` |
| One pending task per issue | `server/migrations/022_task_lifecycle_guards.up.sql` |
| Skills schema has no vector column | `server/migrations/008_structured_skills.up.sql` |
| Search is `pg_bigm` bigram GIN | `server/migrations/032_issue_search_index.up.sql` |
| WebSocket protocol, RPC caps, ping periods | `server/internal/daemonws/hub.go` |
| Head-SHA dedupe (TEN-356) | `server/internal/service/task_dedup_head_sha_test.go` |
| Server module inventory, file sizes | GitHub contents API, `server/internal/*` |

**Marked unverified and requiring confirmation before implementation:**

1. `state` pass-through on `github.com/apps/SLUG/installations/new` (§1.6.3). Confirm by completing one install and logging the exact callback query string.
2. `target_id` / `target_type` on `installations/new/permissions` (§1.6.3). Same procedure.
3. Whether the running Cavix registration is a GitHub App or an OAuth App (§1.5). This is the highest-priority open question in the document; the Part 1 remediation branches on it.

---

## 6. Implementation status

Built on 2026-08-13. The whole tree typechecks, 894 TypeScript tests and every Go package pass.

### Shipped

| Spec | What landed | Where |
| :--- | :--- | :--- |
| §1.6.3 | `GET /api/github/connect`, `GET /api/github/setup`, `POST /api/github/disconnect` | [server.ts](services/control-plane/src/server.ts) |
| §1.6.3 | `installUrl({state,targetId})`, `configureUrl`, `pkce`, `revokeGrant`; `scope` dropped, `prompt=select_account` added | [github.ts](services/control-plane/src/github.ts) |
| §1.6.4 | Grant revocation bound to Disconnect only, with copy that says it does not uninstall | [server.ts](services/control-plane/src/server.ts) |
| §1.6.5 | `installation`, `installation_repositories`, `installation_target` parsed, normalised and forwarded | [installation.go](services/edge/internal/webhook/installation.go), [controlplane.go](services/edge/internal/webhook/controlplane.go) |
| §1.6.5 | `POST /api/internal/github/installation` applies them | [server.ts](services/control-plane/src/server.ts) |
| §1.6.6 | Live installation reads write through to the store; a page load repairs a missed webhook | [server.ts](services/control-plane/src/server.ts) |
| §1.6.7 | Install-first CTA, per-org "Change repositories", repository-selection scope, pending-approval and error toasts | [app.js](services/control-plane/public/app.js) |
| §1.6.8 | `Installation` + `OAuthStateRecord`, single-use state with TTL, repos keyed by numeric id, out-of-order deliveries discarded | [store.ts](services/control-plane/src/store.ts) |
| §2.10.3 | Deterministic critic: phantom file, phantom line, phantom symbol; UNSUPPORTED drops, REPAIRABLE downgrades | [packages/critic](packages/critic/) |
| §2.10.3 | Adjudicator invariant 4: an unsupported LLM finding is dropped **before** clustering, so agreement cannot vote a phantom in | [adjudicator.ts](packages/adjudicator/src/adjudicator.ts) |
| §2.10.4 | `SignalModelRouter` + `signalsFor`: routes on blast radius, sensitive paths, concurrency, API surface. Escalation is one-directional | [router.ts](packages/agents/src/router.ts), [signals.ts](packages/agents/src/signals.ts) |
| §3.1.3 | Since your last push, Impact Scope, Security Risks, Architectural Feedback | [poster.ts](services/orchestrator/src/poster/poster.ts) |
| §3.1.5 | Run footer with tier mix and review range | [poster.ts](services/orchestrator/src/poster/poster.ts) |
| §3.3.2 | Region digests: an edit elsewhere in a file no longer clears a finding nobody touched | [ledger.ts](packages/review-session/src/ledger.ts) |
| §3.3.4 | Rebase and force-push detection; conservative reconciliation clears nothing | [ledger.ts](packages/review-session/src/ledger.ts) |
| §3.3.6 | Rename migration, with exact fingerprint recomputation or none at all | [ledger.ts](packages/review-session/src/ledger.ts), [diff.ts](packages/core/src/diff.ts) |
| §3.3.7 | `<!-- cavix:inline:fp=… -->` on every inline comment, and a reader for it | [poster.ts](services/orchestrator/src/poster/poster.ts) |

### Shipped in the second pass

| Spec | What landed | Where |
| :--- | :--- | :--- |
| §3.3.5 | Single in-flight review slot per pull request: claim, supersede, uninterruptible posting, stale takeover, head-scoped failure release | [run.ts](packages/review-session/src/run.ts), [store.ts](services/control-plane/src/store.ts), [runs.ts](services/orchestrator/src/report/runs.ts) |
| §3.3.7 | Inline comments reconciled by fingerprint: post only what is new, leave what is current, remove what the ledger cleared | [comments.ts](services/orchestrator/src/poster/comments.ts), [rest.ts](services/orchestrator/src/github/rest.ts) |
| §2.10.1 | Repository rules from `.cavix/rules/*.md` and the convention files teams already write; glob selection, priority 95, never compressed | [rules.ts](packages/context/src/rules.ts) |

### Shipped in the third pass

| Spec | What landed | Where |
| :--- | :--- | :--- |
| §3.3.3 | `scopeFor`: hot / warm / cold classification, with every unsafe case falling back to reading the whole pull request | [scope.ts](packages/review-session/src/scope.ts) |
| §3.3.3 | `fetchCompareDiff`, so "what did this push change" is a measured fact rather than the whole diff restated | [rest.ts](services/orchestrator/src/github/rest.ts) |

### Deliberately not built yet

| Spec | Why not |
| :--- | :--- |
| §3.2 gap 2 (new edge kinds) and gap 5 (graph persistence) | Both are additive and neither changes an existing answer. Edge kinds (`implements`, `routes`, `reads`/`writes`, `tests`) need parser work per language; persistence needs a store and a cache-invalidation story. The three gaps that were producing *wrong* answers are closed, which is the part that could not wait |

### Shipped in the fourth pass

| Spec | What landed | Where |
| :--- | :--- | :--- |
| §3.3.3, second half | The findings pass reads only the hot files, behind `CAVIX_NARROW_REREVIEWS`. Default OFF | [reviewWorkflow.ts](services/orchestrator/src/workflow/reviewWorkflow.ts) |
| §3.2 gap 1 | Symbol identity no longer collides when one file declares a name twice | [indexer.ts](packages/analyzer/src/indexer.ts) |
| §3.2 gap 3 | Every call edge carries `exact` / `heuristic` / `ambiguous`, and the Impact Scope repeats the weakest one | [graph.ts](packages/analyzer/src/graph.ts), [indexer.ts](packages/analyzer/src/indexer.ts) |
| §3.2 gap 4 | Fanout cap, with truncated symbols reported and their real caller counts | [indexer.ts](packages/analyzer/src/indexer.ts) |
| §3.1.3 | The Impact Scope section is populated. It was written in an earlier pass and nothing ever filled it in, so it rendered on no review at all | [reviewWorkflow.ts](services/orchestrator/src/workflow/reviewWorkflow.ts) |

The spec's proposed fix for gap 1 was a structured `SymbolId` carrying a scope chain and a signature hash. That needs the parser to track enclosing scope, which the heuristic parsers do not, so it would have meant a parser rewrite to fix a collision. Disambiguating a repeated name by its line achieves the same thing: the first occurrence keeps the id it has today, so nothing downstream moves.

Gap 3 turned out to be the one that mattered. The spec framed it as "carry confidence so a tree-sitter backend can land later". Reading the code, the fallback `return [...candidates][0]` was already producing wrong answers in production: an arbitrary pick among same-named symbols, stored as a call edge indistinguishable from a resolved one, feeding a review that would then report the lot as "resolved statically".

The restructure the previous pass balked at turned out to be unnecessary. Rather than reordering the workflow so the ledger is fetched before the review, the narrowing step makes its own cheap ledger read, which touches nothing else: with the flag off, not a single line of the existing path executes differently. That is a smaller blast radius than the reorder would have had, and it is why this shipped.

Two things are deliberately not narrowed, and both would be bugs if they were:

- **The prose pass** keeps the whole diff. The description describes the whole change, and a summary written from one file of a forty-file pull request is worse than none.
- **The verdict** is unchanged: `hot + warm + cold` is always the complete pull request, because the merge introduces all of it.

The flag is off by default because the trade is real. Narrowing is sound for findings already on the record, since the ledger carries them whether or not their file was re-read. What it gives up is the re-roll: a model asked a second time about untouched code might find something it missed the first time. That belongs to whoever runs the deployment, not to whoever wrote the service.

### Bugs found by auditing the work above

Four, all introduced by the earlier passes, all found by re-reading rather than by a test failing.

**The heartbeat could keep a dead claim alive.** A review that throws never reaches the clear on the success path. The failure path releases the claim, but if *that* was the call that could not reach the control-plane, the timer kept beating and kept refreshing a dead run's claim, for up to two hours. That is a worse version of the exact wedge the heartbeat was added to prevent. It now stops the moment the control-plane says the claim is no longer ours, and `stillMine` answers true when it cannot reach the control-plane, so a network blip never kills a live review.

**The critic downgraded legitimate off-diff findings.** It reasoned "the diff only reaches line 40, so line 400 is suspicious" whenever the file's real length was unknown. That punishes exactly the findings worth keeping: a change that breaks a caller further down the file anchors outside the diff, and in a 500-line file whose diff touches lines 1 to 8, every one of those correct findings looked suspicious. The range check now runs only where the length is a fact.

**The deferral message promised a retry nothing performed.** It said a queued review "runs on its own in a moment". Returning normally takes the job off the queue, so nothing brought it back. It now asks the person to comment again, which is true.

**The delta section reported a meaningless number.** `filesReread` was derived from the whole `base...head` diff, so on the tenth push of a forty-file pull request the review claimed it re-read forty files. Technically true and useless: it says the same thing on every push whatever anybody did. It now reports what the push actually touched.

### Corrections to the spec, made while building it

**§3.3.2, region digests.** The spec proposed a hunk-index fallback beneath the symbol region. Dropped: hunk indices shift between reviews as lines move, so a hunk-keyed digest would carry findings on evidence about *position* rather than content. Regions are keyed by the enclosing symbol git names in the hunk header, and anything git could not name falls back to the whole-file digest, which is exactly the behaviour that shipped. Strictly safer, never worse.

A consequence worth stating plainly: a finding in a hunk git labels with an import line still clears on a file-level change. The fix is real but bounded by what a hunk header can resolve, and §3.2's tree-sitter work is what widens it.

**§3.3.5, the claim state machine.** The spec's ordering checked "same commit" before "stale worker". That is wrong, and the bug it produces is nasty: a dead run holding the slot for its own commit makes every retry of that commit a duplicate *forever*, so the pull request silently stops being reviewed with nothing in any log to explain it. Stale takeover is checked first.

The spec also did not say what happens when a review *fails*. Without an answer, a failed review holds the slot for the whole stale window and the retry that would have fixed it is turned away as a duplicate. There is now a release keyed on the commit, so a newer review that superseded the failed one keeps its claim.

**§3.3.7, comment reconciliation.** The spec said "update the existing comment body" when a repeated finding's line moves. Not done, deliberately: rewriting a comment bumps its timestamp, re-notifies everyone subscribed, and moves it in the conversation as though something happened. Nothing happened. An unchanged finding is left exactly where it is.

**§2.10.1, the banded context budget.** Not built. Rules carry priority 95 and are exempt from compression, which solves the case the bands existed for: a large diff evicting the team's own law, or a cheap model paraphrasing it. Reserved bands with borrowing are a real design with no demonstrated failure behind them yet.

**Two bugs found while building, not in the spec at all.** `**` in a glob matched one-or-more directories rather than zero-or-more, so `src/**/auth/*.ts` did not match `src/auth/token.ts`; a glob that matches nothing is indistinguishable from one nobody configured. And the diff parser did not understand `rename from` / `rename to`, so a pure rename with no content change produced no `---`/`+++` lines and was dropped entirely, which is precisely the input §3.3.6 was written to handle.

