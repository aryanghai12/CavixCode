# Cavix — The Complete Guide

Everything you need to **understand, run, test, demo, sell, and deploy** Cavix —
written in plain English, step by step, for someone who is **not** a programmer.

> **Cavix in one sentence:** an AI code‑review tool that **proves its findings
> before it speaks** — it recreates the bug (or the security hole) in a safe,
> throwaway space, applies the fix, and runs the tests. So its comments are
> *checked facts, not guesses.*

> **New here and not very technical? Read this box first.**
>
> - You do **not** need to write any code. You will mostly **copy a line, paste it,
>   press Enter, and read what comes back.**
> - A **"terminal"** (also called a "command line", "PowerShell", or "shell") is a
>   text window where you type commands. On Windows the one you'll use is called
>   **PowerShell**. Section 4 shows you how to open it.
> - When this guide shows a grey box with commands, you **copy the whole box, paste
>   it into PowerShell, and press Enter.** That's it.
> - If a command looks scary, don't worry — after each one, this guide tells you
>   **what you should see** so you know it worked.
> - **Keys and passwords** (for GitHub and the AI) have their own dead‑simple,
>   click‑by‑click companion guide: **[SETUP_KEYS.md](SETUP_KEYS.md)**. You do
>   **not** need any of those to try the tests and demos below.

---

## Table of contents

1. [What Cavix is and why it's different](#1-what-cavix-is-and-why-its-different)
2. [How it works (the 13‑stage pipeline)](#2-how-it-works-the-13-stage-pipeline)
3. [The codebase map](#3-the-codebase-map)
4. [Prerequisites (what to install first)](#4-prerequisites-what-to-install-first)
5. [Install Cavix (one‑time setup)](#5-install-cavix-one-time-setup)
6. [Run the tests (prove it works)](#6-run-the-tests-prove-it-works)
7. [Run the demos (see it work)](#7-run-the-demos-see-it-work)
8. [Run the real services](#8-run-the-real-services)
8B. [Go live on GitHub (production GitHub App + `@cavix` commands)](#8b-go-live-on-github-production-github-app--cavix-commands)
8C. [The Cavix web app — dashboard, login & BYOK](#8c-the-cavix-web-app--dashboard-login--byok)
8D. [Deploy to production (hand it to org owners for a trial)](#8d-deploy-to-production-hand-it-to-org-owners-for-a-trial)
8E. [Run the business — founder & core‑team controls](#8e-run-the-business--founder--core-team-controls)
9. [Measure quality (the eval harness)](#9-measure-quality-the-eval-harness)
10. [Configuration & keys (BYOK)](#10-configuration--keys-byok)
11. [Self‑host & air‑gapped deployment](#11-self-host--air-gapped-deployment)
12. [Enterprise features](#12-enterprise-features)
13. [The buyer demo script (live pitch runbook)](#13-the-buyer-demo-script-live-pitch-runbook)
14. [The sales pitch & ROI](#14-the-sales-pitch--roi)
15. [Troubleshooting](#15-troubleshooting)
16. [What's real vs simulated (honesty)](#16-whats-real-vs-simulated-honesty)
17. [FAQ](#17-faq)
18. [Glossary (every tech word, explained)](#18-glossary-every-tech-word-explained)

---

## 1. What Cavix is and why it's different

Most AI reviewers **guess**. They read a code change and say "this might be a bug."
Half the time they're wrong, so developers stop trusting them and switch them off.

Cavix is built around one idea: **don't guess — prove.** When Cavix suspects a bug,
it spins up a throwaway workspace, writes a tiny test that recreates the bug, applies
the fix, and runs the tests again. Only if the bug *actually happens* does it say
anything. If it can't recreate the problem, it stays quiet. The result: when Cavix
posts a comment, it's a **fact you can act on**, not noise.

On top of that proof, Cavix does four things competitors structurally can't:

- **Cross‑repo impact** — it knows when a change in project A breaks a *different*
  service in project B, and shows the exact line.
- **Regression prediction** — it studies your project's build/test history and warns
  about slowdowns before they merge.
- **Optional policy gate** — a company can turn on plain‑English rules ("every web
  endpoint needs a login check") that become rules nobody can bypass.
- **It can act, safely** — it can open its own fix requests, but **only** fixes it
  has proven work, always as a draft a human must approve.

It is **model‑agnostic** (works with Claude, GPT, Gemini, or your own AI),
**BYOK‑first** ("Bring Your Own Key" — you plug in your own AI account), and
**self‑hostable including fully offline** (zero internet calls).

> **Jargon check:** *repo* = "repository" = one project's folder of code, usually
> stored on GitHub. *Diff* = the specific lines a change adds or removes. *PR* =
> "Pull Request" = GitHub's way of proposing a change for review before it's merged
> in. All tech words are listed in the [Glossary](#18-glossary-every-tech-word-explained).

---

## 2. How it works (the 13‑stage pipeline)

A code change (a "Pull Request") flows through these stages. Each is a real part of
the software in this project. You don't have to memorize this — it's here so you can
speak to it. Plain‑English version:

| # | Stage | What it does (plain English) |
|---|-------|------------------------------|
| 0 | **Edge ingestion** | A fast "front door" service catches the GitHub message, checks it's genuine, and puts the job in line in about 1 millisecond. |
| 1 | **Orchestration** | A "conductor" drives the whole review and can survive a restart without losing its place. |
| 2 | **Sandbox** | A sealed, internet‑less, throwaway workspace to run unknown code safely. |
| 3 | **Deterministic analysis** | Password/secret scanners + 20+ automated code checkers. These are hard facts the AI is not allowed to erase. |
| 4 | **Code graph** | Reads the whole project into a map of "what calls what," so it can work out how far a change ripples ("blast radius"). |
| 5 | **Cross‑repo graph** | Maps how separate projects depend on each other, to trace knock‑on effects across them. |
| 6 | **CI/CD telemetry** | Reads build/test history and predicts slowdowns. |
| 7 | **Context retrieval** | Pulls in the *other* files that matter (who calls this, past discussions) and shrinks them with a cheap AI. |
| 8 | **Agent ensemble** | Seven specialist AI reviewers (security, correctness, speed, etc.) work at the same time and stay silent when unsure. |
| 9 | **Adjudication** | Merges duplicates, has them "vote," and keeps only confident findings. Hard facts always survive. |
| 10 | **Verification (the moat)** | Actually recreates the bug / runs the exploit in the sandbox. Labels it VERIFIED / UNVERIFIED / INCONCLUSIVE. |
| 11 | **Synthesis & posting** | Writes the review with severity, evidence, and one‑click fixes; posts it to GitHub (or GitLab/Bitbucket/Azure). |
| 12 | **Learning loop** | Learns from what you accept/reject to tune itself for your team. |
| 13 | **Teardown & zero‑retention** | Destroys the sandbox and confirms **no customer code is left behind.** |

Full architecture and the "why" behind each part: see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 3. The codebase map

This is a **monorepo** — one big folder that holds many small parts. Two programming
languages are used: **Go** for the fast front‑door service, and **TypeScript** for
everything else. (You don't need to know either to run this guide.)

```
services/
  edge/            Stage 0 — the "front door" that catches GitHub messages
  orchestrator/    Stage 1 — the "conductor" that runs a review and posts comments
  control-plane/   The dashboard: sign‑up, reviews, accept/reject, free tier
packages/
  core/            Shared building blocks
  gateway/         The AI connector (Claude/GPT/local) + offline safety guard
  sandbox/         Stage 2 — the safe throwaway workspace
  deterministic/   Stage 3 — secret + security scanners (24 checkers)
  policy/          Stage 3c — the optional plain‑English rules gate
  analyzer/        Stage 4 — the "what calls what" map
  orggraph/        Stage 5 — cross‑project impact
  telemetry/       Stage 6 — build/test history + slowdown prediction
  context/         Stage 7 — gathering the relevant surrounding files
  agents/          Stage 8 — the 7 specialist AI reviewers
  adjudicator/     Stage 9 — merge, vote, filter
  verifier/        Stage 10 — the proof engine (the moat)
  platforms/       Stage 11 — GitHub/GitLab/Bitbucket/Azure connectors
  learning/        Stage 12 — learning from accept/reject
  zero-retention/  Stage 13 — proving no code is kept
  pipeline/        Wires all the stages into one review
  governance/      Company login (SSO/SAML) + user sync + roles + audit
  license/         Offline license checks
  legacy/          Old languages (COBOL/PL‑SQL/C/C++/Java/.NET) + modernization
  fixpr/           The verified fix‑request agent (draft, human approves)
  ide/             Review inside the code editor, before a PR exists
  batch/           Modernizing lots of code at once, proof‑gated
  lenses/          A marketplace of review "rule packs"
  analytics/       ROI dashboards (how much time saved)
eval/              The quality scorecard (precision/recall/F1 + benchmarks)
deploy/            Install files for running on your own servers
docs/compliance/   Security & compliance documents
editors/           VS Code + JetBrains editor plugins
scripts/           Extra demo scripts
```

**The design rule that makes life easy:** everything on the outside (databases,
GitHub, the AI, the sandbox) is plugged in through a "socket" that has a **fake**
stand‑in. That's why **every test and demo runs with nothing else installed** — no
database, no internet, no keys.

---

## 4. Prerequisites (what to install first)

You need to install **two** free programs on your computer: **Node.js** and **Go**.
Everything else in the "Needed for" column below is optional.

| Program | Version | What it's for | Do I need it? |
|---------|---------|---------------|---------------|
| **Node.js** | 24 or newer (22.7+ works) | Runs most of Cavix, the tests, and the demos | **Yes** |
| **Go** | 1.26 or newer | Runs the fast front‑door service | **Yes** (only if you build the edge) |
| **Git** | any | Downloading the project | **Yes** (probably already installed) |
| Docker | 28+ | Only for real databases or the Docker sandbox | Optional |
| Helm / Terraform / kubectl | — | Only for running on your own big servers | Optional |

### Step 4.1 — Open PowerShell (your terminal)

1. Press the **Windows key** on your keyboard.
2. Type **`PowerShell`**.
3. Click **Windows PowerShell** in the results.
4. A dark‑blue or black text window opens. **This is where every command in this
   guide goes.** Keep it open.

### Step 4.2 — Install Node.js

1. In a web browser, go to **https://nodejs.org**.
2. Click the big button that says **"LTS"** (that means the stable version).
3. Open the downloaded file and click **Next → Next → Install** (accept the defaults).
4. When it finishes, **close and reopen PowerShell** (so it notices the new program).

### Step 4.3 — Install Go

1. Go to **https://go.dev/dl/**.
2. Download the Windows installer (the file ending in `.msi`).
3. Open it and click through **Next → Install**.
4. **Close and reopen PowerShell** again.

### Step 4.4 — Check everything is installed

Copy this whole box, paste it into PowerShell, and press Enter:

```powershell
node --version
go version
git --version
```

**What you should see:** three lines, something like `v24.3.0`, `go version go1.26.1`,
and `git version 2.x`. If any line says *"is not recognized"*, that program didn't
install — redo its step and remember to reopen PowerShell.

> You do **not** need Docker, a database, or any key/password to run the tests or
> the demos. They're fully self‑contained.

---

## 5. Install Cavix (one‑time setup)

### Step 5.1 — Go to the project folder

Every command from here on must run **inside the project folder.** Point PowerShell
at it by pasting this (adjust the path if your copy lives elsewhere):

```powershell
cd "C:\Users\aryan\Videos\CavixCode"
```

**What you should see:** the text at the start of your PowerShell line now ends with
`\CavixCode>`. That means you're "inside" the project.

### Step 5.2 — Download the building blocks

```powershell
npm install
```

**What this does:** downloads the small helper libraries Cavix needs. **What you
should see:** a few lines ending with something like `added N packages`. It takes a
few seconds. (A `warn` message or two is normal and safe to ignore.)

### Step 5.3 — Build the fast front‑door service

```powershell
cd services/edge
go build ./...
cd ../..
```

**What this does:** compiles the Go "edge" service to check it's healthy. **What you
should see:** *nothing* — no output at all means success. (In the computer world,
silence is good news here.) You're now back in the main folder.

**That's the entire setup.** The project is ready.

---

## 6. Run the tests (prove it works)

**Everything in Cavix is tested.** Running the tests is the fastest way to confirm
the whole system works on your machine. A "test" is just an automatic check the
software runs on itself.

```powershell
npm test
```

**What this does:** runs ~173 automatic checks across the whole project (no internet,
no database, no keys). **What you should see:** lots of lines scrolling by, then a
summary near the bottom with **`fail 0`**. If you see `pass` numbers and `fail 0`,
**everything works.** It takes a few seconds.

Two more optional checks:

```powershell
npm run typecheck
```
Confirms all the code is internally consistent. Success = no errors listed.

```powershell
cd services/edge
go test ./...
cd ../..
```
Runs the front‑door service's own tests. Success = lines that say **`ok`**.

### Run just one part's tests (optional)
If you only want to check one area:
```powershell
node --test "packages/verifier/test/*.test.ts"     # the proof engine
node --test "packages/fixpr/test/*.test.ts"        # the fix-request agent
node --test "packages/gateway/test/*.test.ts"      # the AI connector + offline mode
```

**What the tests actually prove** (highlights you can quote to people):
- A planted bug is **recreated** in a real sandbox and the fix is confirmed to work.
- A false alarm does **not** recreate, so it's automatically hidden.
- A real security exploit runs safely inside the sandbox.
- Offline mode **blocks every internet address** and only reaches the local AI.
- The rules gate is **off by default** and can't be tampered with when on.
- Zero‑retention: customer code is **gone** after a review.

---

## 7. Run the demos (see it work)

Demos are **runnable, no‑setup stories.** Each one prints a clear narrative on the
screen. Use them for yourself and when showing Cavix to a buyer. **None of them need
keys or internet.**

| Type this command | What it shows on screen | Phase |
|-------------------|-------------------------|-------|
| `npm run demo` | A full PR review comment is produced (summary + inline notes + one‑click fix) | 0 |
| `npm run phase1` | Scans THIS project, finds a **cross‑file** bug, shows the rules gate on/off | 1 |
| `npm run verify-demo` | **Recreates a bug in a real sandbox**, confirms the fix, hides a false alarm, runs a security exploit | 2 |
| `npm run orggraph-demo` | Traces a breaking change in project A to the projects B and C that depend on it, with exact lines | 2 |
| `npm run airgap-demo` | **Proves zero internet leakage** (blocks Anthropic/OpenAI/GitHub), offline license, data purge | 3 |
| `npm run phase4-demo` | A verified **fix‑request** (vs one it can't prove), in‑editor review, and ROI numbers | 4 |
| `npm run eval` | Side‑by‑side quality scores: a plain checker vs Cavix (F1 up to 100%) | 1–2 |
| `npm run eval:bench` | Scores against well‑known public bug datasets | 2 |

**The three demos to show a buyer** (in this order): `verify-demo`, `orggraph-demo`,
`airgap-demo` (the last one if they care about security / running on their own
servers). The full word‑for‑word script is in [section 13](#13-the-buyer-demo-script-live-pitch-runbook).

### Example: the verification demo (the most important one)
```powershell
npm run verify-demo
```
You'll watch real code actually run inside the safe sandbox:
```
status: VERIFIED  reproduced=true fixWorks=true suitePasses=true
  [repro]     node --test calc.repro.test.mjs → exit 1   ← bug is real (fails, "red")
  [after-fix] node --test calc.repro.test.mjs → exit 0   ← fix works ("green")
  [suite]     node --test                     → exit 0   ← nothing else broke
```
Then a second case shows `status: UNVERIFIED → suppressed` — a warning Cavix could
**not** prove, so it stays silent. **That's the entire product idea in ten lines:**
it only speaks when it can prove it.

> **How to read "exit 0" and "exit 1":** when a program finishes, it reports a number.
> **`exit 0` means success ("green").** Any other number, like **`exit 1`, means it
> failed ("red").** So a bug's test showing `exit 1` = the bug is real; after the fix,
> `exit 0` = the fix worked.

---

## 8. Run the real services

The demos use built‑in fakes so they run anywhere. To run the **actual services**
against real infrastructure, use the steps below. All settings are provided through
**environment variables** — named slots you fill in before starting a service.

> **On Windows, how do I set an environment variable?** The examples in this section
> use the Mac/Linux style `export NAME="value"`. On **your** machine (PowerShell) the
> exact same thing is written **`$env:NAME = "value"`**. For example, wherever you
> see `export CAVIX_WEBHOOK_SECRET="abc"`, you type `$env:CAVIX_WEBHOOK_SECRET = "abc"`.
> Full click‑by‑click details for every key are in **[SETUP_KEYS.md](SETUP_KEYS.md)**.

### 8a. Local infrastructure (Postgres + Redis) — optional
Only if you want real databases instead of the built‑in in‑memory ones. This needs
**Docker** installed.
```powershell
docker compose up -d        # starts Postgres + Redis in the background
```

### 8b. The edge webhook receiver (Stage 0 — the front door)
This is the service that listens for GitHub's messages. PowerShell version:
```powershell
cd services/edge
$env:CAVIX_WEBHOOK_SECRET = "your-github-app-webhook-secret"   # required — see SETUP_KEYS.md
$env:CAVIX_EDGE_ADDR = "127.0.0.1:8080"
$env:CAVIX_REDIS_ADDR = "127.0.0.1:6379"   # leave this out to use a built-in queue
go run ./cmd/edge
```
**What you should see:** a line saying it's listening on `127.0.0.1:8080`. Leave the
window open. To confirm it's alive, open a browser to `http://127.0.0.1:8080/healthz`
— it should respond OK.

### 8c. The orchestrator (Stage 1 — the conductor that runs the review)

> **You do NOT need this for a trial.** The orchestrator is the *background engine*
> that reviews real GitHub pull requests. It needs **Redis** (a job queue) running, or
> it exits with `ECONNREFUSED …:6379`. If you just want the website org owners log into,
> run **`npm run control-plane`** (§8d) — it needs no Redis, no orchestrator, and no
> keys (owners add their AI key on the site). Only set this up when you want Cavix to
> post reviews on real PRs.

> **About the keys here:** the site is the source of truth for AI keys — each org adds
> its own provider/model/key on the **AI & BYOK** page, encrypted at rest. The env vars
> below are just an **optional single‑org dev shortcut** for running one review locally;
> you don't feed keys for the trial site.

If you do want the real PR pipeline locally, first start Redis, then run the orchestrator:
```powershell
# 1) Redis is required (the queue between the edge and the orchestrator):
docker run -p 6379:6379 redis           # needs Docker; leave it running

# 2) In a second PowerShell window, from the project root:
$env:CAVIX_GITHUB_TOKEN = "github_pat_..."     # a GitHub token that can read/post on the repo
$env:CAVIX_REDIS_HOST = "127.0.0.1"
$env:CAVIX_SANDBOX_BACKEND = "local"           # or "docker"
# LLM key is OPTIONAL here — production reads each org's key from the site's BYOK store.
# For a quick one-org local test only, you may set: $env:CAVIX_LLM_API_KEY = "sk-ant-..."
npm run orchestrator
```
**What you should see:** it starts up and waits for review jobs. When a PR arrives via
the edge, it runs the review and posts the comments. If you see the Redis error, Redis
isn't running — start it with the `docker run` line above.

> **Deploying against a managed Redis** (Redis Cloud, Upstash, Render Key Value)?
> Those require a **password and usually TLS** over the public internet. Don't use the
> bare `CAVIX_REDIS_HOST`/`_PORT` (they drop the password). Instead paste the one
> connection URL your provider gives you:
> ```powershell
> $env:CAVIX_REDIS_URL = "rediss://default:YOUR_PASSWORD@your-host.redis.cloud:6380"
> ```
> That single var sets host, port, username, password, and TLS. (Or set
> `CAVIX_REDIS_PASSWORD` / `CAVIX_REDIS_USERNAME` / `CAVIX_REDIS_TLS=true` separately.)

### 8d. The web app / control‑plane (the full site: login, dashboard, BYOK)
```powershell
npm run control-plane        # runs the whole website at http://127.0.0.1:8088
```
Open **`http://127.0.0.1:8088/`** in a browser — you'll see the **full Cavix website**:
a modern marketing landing page, a **Log in / Sign up** flow, and the **dashboard**
(Overview, Reviews, Repositories, AI & BYOK, Review settings, Team, Billing, Proven
catches). **This is the app you hand to org owners for a trial.** Full walkthrough of
every page is in **[section 8C](#8c-the-cavix-web-app--dashboard-login--byok)** and
production deployment is in **[section 8D](#8d-deploy-to-production-hand-it-to-org-owners-for-a-trial)**.

> **Try it in 20 seconds:** run the command above, open the URL, click **Log in**, and
> sign in with the seeded demo account — email `demo@cavix.dev`, password `cavixdemo`.
> You'll land in a populated dashboard.

### 8e. The in‑editor review server (for the VS Code / JetBrains plugins)
```powershell
npm run ide-server           # runs at http://127.0.0.1:7077
```
The editor plugins send your open files to this and get instant review notes back,
**before** a PR even exists.

---

## 8B. Go live on GitHub (production GitHub App + `@cavix` commands)

This is what **you, the founder, actually do** to make Cavix review real Pull
Requests in a repo or a whole company — and how the `@cavix review` command works.

> **Do this section slowly and it's very doable even if you're not technical.** For
> the exact click‑by‑click of every key and password mentioned here, keep
> **[SETUP_KEYS.md](SETUP_KEYS.md)** open alongside it.

Cavix ships as a **GitHub App.** Think of a GitHub App as an official "employee badge"
for your software: it gets its own identity (shown as `yourapp[bot]`), the customer
grants it only the permissions it needs at install time, and it uses short‑lived
passes instead of one permanent password. Much safer than a personal login.

### Step 1 — Create the GitHub App (one time, ~10 minutes)

1. In a browser, go to **GitHub → click your photo (top‑right) → Settings →**
   scroll down to **Developer settings → GitHub Apps → New GitHub App.**
   (For a company account instead: **Organization → Settings → Developer settings →
   GitHub Apps.**)
2. **GitHub App name:** e.g. `Cavix` or `CavixCode`. ⚠️ **This name becomes the
   `@mention` handle.** If the app ends up called `cavixcode`, people type
   `@cavixcode review` on their PRs. Remember this name.
3. **Homepage URL:** any valid web address (your website, or even your GitHub profile
   page).
4. **Webhook** area:
   - Tick **Active.**
   - **Webhook URL:** the public internet address of your running edge service,
     ending in `/webhook` — e.g. `https://your-server.com/webhook`. (Testing from
     your laptop? See the "Local development trick" below to get a temporary public
     address for free.)
   - **Webhook secret:** invent a long random password and paste it here. **Save a
     copy** — this exact text also becomes `CAVIX_WEBHOOK_SECRET`.
5. **Permissions (Repository):** set each of these:
   | Permission | Access | Why |
   |------------|--------|-----|
   | Contents | Read | to fetch the code / the change |
   | Pull requests | Read & write | to post reviews + inline comments |
   | Issues | Read & write | to receive/post PR comments (`@cavix` commands) |
   | Checks | Read & write | the ✓/✗ Cavix status mark on the PR |
   | Metadata | Read | required basic access |
6. **Subscribe to events:** tick **Pull request**, **Issue comment**,
   **Pull request review comment** (optional), **Installation**, and
   **Installation repositories.**
7. **Where can this app be installed:** "Only on this account" (private/your own use)
   or "Any account" (if you'll list it publicly on the Marketplace).
8. Click **Create GitHub App.** Then, on the app's page, note the **App ID** (a
   number) and click **Generate a private key** (a `.pem` file downloads). These two
   become `CAVIX_APP_ID` and `CAVIX_APP_PRIVATE_KEY`.

### Step 2 — Install the App on repos / the org

On the app's page → **Install App** → choose the account/company → pick **All
repositories** or specific ones → **Install.** That's the action a *customer* takes
too; for the Marketplace, you just share your app's public install link and customers
install it themselves.

### Step 3 — Run the Cavix services (pointed at the App)

Run the edge (must be reachable from the internet), the orchestrator, and the
control‑plane (see [section 8](#8-run-the-real-services)). For **real GitHub App
login** (instead of the developer token), give the orchestrator the app's credentials
so it can mint its own short‑lived passes. PowerShell:

```powershell
$env:CAVIX_APP_ID = "123456"
$env:CAVIX_APP_PRIVATE_KEY = Get-Content "C:\Users\aryan\Downloads\cavix.private-key.pem" -Raw
$env:CAVIX_BOT_HANDLE = "cavixcode"        # must match the App name you chose
$env:CAVIX_WEBHOOK_SECRET = "..."          # must match the App's webhook secret
$env:CAVIX_LLM_API_KEY = "sk-..."          # your AI key (or an offline self-hosted model)
```

> **In one sentence:** the developer quick‑start (8c) uses a personal token
> (`CAVIX_GITHUB_TOKEN`); production uses the App key above. Both plug into the same
> place — the App way is just safer and works for many customers at once.

**Local development trick:** GitHub lives on the internet and can't reach your
laptop's private address. To test on your own machine, use a free forwarder like
**[smee.io](https://smee.io)** or **ngrok** to pass GitHub's messages through to your
local edge service. Step‑by‑step for smee.io is in **[SETUP_KEYS.md](SETUP_KEYS.md)**.

### Step 4 — What happens automatically (the flow)

```
A developer opens or updates a Pull Request
        │  GitHub sends a "pull_request" message
        ▼
[edge] checks it's genuine → tidies it up → puts it in line   (Stage 0, ~1ms)
        ▼
[orchestrator] gets a short-lived pass → fetches the change → runs the pipeline
        │      (Stages 3–10: scanners + maps + AI reviewers + proof)
        ▼
Posts a review: a summary + inline comments (with one-click fixes)
Posts a status mark: ✓ pass, or ✗ if a serious problem is present
```

On the **next push** to the same PR, Cavix does an **incremental** review — it only
comments on the new changes and never repeats a comment it already made.

### Step 5 — The `@cavix` commands (chat / on‑demand control)

Anyone with **write access** to the repo can type a comment on the PR to control
Cavix. The `@name` you use is your app's name.

| Comment you type on the PR | What Cavix does |
|---------------------------|-----------------|
| `@cavix review` | **Fresh full review** — throws away its old reviews, deletes its stale comments, **clears its memory of the PR**, and reviews from scratch. |
| `@cavix re-review` / `@cavix full` | Same as `review`. |
| `@cavix resolve` | Marks its own review threads as resolved. |
| `@cavix pause` | Stops automatic reviews on this PR. |
| `@cavix resume` | Turns automatic reviews back on. |
| `@cavix summary` | Rewrites the PR summary/overview. |
| `@cavix help` | Posts the list of commands. |
| `@cavix <any question>` | Free‑text Q&A about the PR (chat). |

**Why "fresh" matters:** when you type `@cavix review`, that comment is treated as a
brand‑new, one‑off request every single time (it's never skipped as a duplicate).
Cavix then clears out its old reviews and comments before posting a completely new
one. That's exactly the "remove the old stuff, give me a clean new review" behavior.
Commands from people **without** write access are ignored (a safety guard against
abuse).

**Setting the name:** Cavix answers to `@` + whatever you put in `CAVIX_BOT_HANDLE`
(default `cavix`). To make it answer to `@cavixcode`, set
`CAVIX_BOT_HANDLE = "cavixcode"`.

### Step 6 — Per‑repo configuration (`.cavix.yaml`)

Teams fine‑tune Cavix by adding a small text file named `.cavix.yaml` (or
`.cavix.json`) to the top of their repo — no dashboard needed. Example, with every
line explained:

```yaml
# .cavix.yaml — a settings file you put in the repo
autoReview: true              # review automatically when a PR opens or updates
reviewDraftPRs: false         # skip PRs still marked as "draft"
tone: concise                 # how wordy the comments are ("concise" or "detailed")
pathFilters:
  include:                    # if set, ONLY these folders are reviewed
    - "src/**"
    - "services/**"
  exclude:                    # these are always skipped
    - "**/*.min.js"
    - "**/generated/**"
agents:
  disabled:                   # turn off specific reviewers by name
    - standards
policy:
  enabled: false              # the plain-English rules gate (off by default)
failOn:                       # which severities make the ✓/✗ mark FAIL (can block merge)
  - critical
```
(`**` means "any folder underneath." So `src/**` means "everything inside the `src`
folder.") If the file is absent, sensible defaults apply and generated/build folders
are skipped automatically.

### Step 7 — Make Cavix a required check (block risky merges)

Cavix puts a ✓/✗ **status mark** on every PR. To make a *failing* Cavix review
actually **block the merge button**, add it as a required check:
**Repo (or Org) → Settings → Branches → Branch protection rule → tick "Require status
checks to pass" → choose the Cavix check.** Combine that with the rules gate turned
on, and regulated teams get a quality gate nobody can bypass.

### How Cavix compares to CodeRabbit / other AI reviewers

Everything below is **built and tested** in this project.

| Capability | CodeRabbit & others | **Cavix** |
|------------|:---:|:---:|
| Auto review on PR open/update | ✅ | ✅ |
| Inline comments + one‑click fixes | ✅ | ✅ |
| PR summary / overview | ✅ | ✅ |
| `@bot review` / re‑review command | ✅ | ✅ **+ clears old reviews & memory** |
| `@bot` chat / Q&A | ✅ | ✅ |
| Pause/resume, resolve | ✅ | ✅ |
| Incremental reviews (no repeat comments) | ✅ | ✅ |
| Repo settings file | ✅ (`.coderabbit.yaml`) | ✅ (`.cavix.yaml`/`.json`) |
| Folder/file filters | ✅ | ✅ |
| Status check / merge gate | ✅ | ✅ |
| Works with GitLab/Bitbucket/Azure too | partial | ✅ (all four) |
| Learns your team's preferences | ✅ | ✅ |
| **Proves findings by recreating them in a sandbox** | ❌ | ✅ **(the moat)** |
| **Generates a real proof‑of‑concept for security holes** | ❌ | ✅ |
| **Cross‑project impact (breaks in another service)** | ❌ | ✅ |
| **Build/test slowdown prediction** | ❌ | ✅ |
| **Verified auto fix‑requests (draft, human‑approved)** | partial | ✅ (only proven fixes) |
| **Fully offline / self‑hosted with your own AI** | ❌ | ✅ (zero leakage, proven) |
| **Zero‑retention (no code kept), offline license** | ❌ | ✅ |
| **Old languages (COBOL/PL‑SQL) + verified modernization** | ❌ | ✅ |

The plain (✅/✅) rows make Cavix a *credible* AI reviewer; the **bold** rows are why a
team *switches* to it.

---

## 8C. The Cavix web app — dashboard, login & BYOK

This is the **website** an org owner logs into. It's what makes Cavix feel like a real
product (like CodeRabbit's dashboard), and it's what you hand out for trials. It lives
in the **control‑plane** service and, like the rest of Cavix, is **dependency‑free** —
no React build step, no bundler — so it runs anywhere and deploys in one process.

### Start it
```powershell
cd "C:\Users\aryan\Videos\CavixCode"
npm run control-plane
```
**What you should see:** a line like
`{"service":"control-plane","msg":"listening","port":8088,...}`.
Now open **`http://127.0.0.1:8088/`** in your browser.

### Log in with the demo account
The app seeds a demo workspace so it's not empty. Click **Log in** (top‑right) and use:

| Field | Value |
|-------|-------|
| Email | `demo@cavix.dev` |
| Password | `cavixdemo` |

You land in a fully populated dashboard. (You can also click **Sign up** to create a
brand‑new workspace — the first person to sign up for an organization becomes its
**owner**.)

### The pages (what an org owner sees)

| Page | What it does |
|------|--------------|
| **Landing page** (`/`) | The public marketing site: the pitch, feature grid, a live "verify" terminal, the CodeRabbit comparison table, pricing, and calls to action. This is what a prospect sees first. |
| **Log in / Sign up** (`/login`, `/signup`) | Real accounts — email/password **or "Continue with GitHub"** (OAuth). Sign‑up creates the workspace + owner; login starts a secure session. |
| **Overview** | Headline numbers (reviews run, verified findings, action rate, reviewer‑hours saved), a 7‑day activity sparkline, findings‑by‑severity, and a "getting started" checklist. |
| **Reviews** | Every review with its findings. Each finding shows severity, file:line, whether it's **✅ verified** or a **🔒 policy** fact, and **Accept / Reject** buttons that feed the learning loop. |
| **Repositories** | The **CodeRabbit‑style connect flow** — sign in with GitHub, browse **all your organizations**, see **every repo** in each, and flip a toggle to enable Cavix on the ones you want. Nothing done from the GitHub website except the one‑time App install. |
| **Reports** | ROI + quality at a glance: reviews, verified findings, action rate, reviewer‑hours saved, findings‑by‑severity, and decision counts. |
| **Learnings** | What Cavix has learned from your accept/reject history — the personalization that makes it fit *your* team (and hard to switch away from). |
| **AI & BYOK** | The heart of "bring your own key": pick the provider (Anthropic / OpenAI / Google / self‑hosted) and model, and paste your API key. The key is **encrypted at rest** and only a **fingerprint** is ever shown again. |
| **Review settings** | Mirrors `.cavix.yaml`: auto‑review, review drafts, air‑gapped mode; **comment tone** (concise / detailed / educational / assertive / chill); **path filters** (include/exclude globs); severities that fail the check; and **Pre‑merge checks** — an optional gate, off by default, where an owner writes plain‑English rules that become non‑bypassable checks. |
| **Integrations** | Source control (GitHub connected; GitLab/Bitbucket/Azure adapters) plus chat/issue trackers (Slack/Jira/Linear). |
| **Team** | Members and their roles (owner / admin / reviewer / member). Owners/admins can change roles. |
| **Plan & billing** | The current plan and upgrade options, driven by the **single pricing source** shared with the marketing site (wire Stripe for real charging — see §8D). |
| **Proven catches** | The public feed of execution‑verified findings that opted‑in public repos chose to share. |
| **Docs** (`/docs`) | Public documentation: getting started, `@cavix` commands, PR summaries, tone, `.cavix.yaml`, pre‑merge checks, BYOK, self‑host, security. |

### Connect GitHub from the site (like CodeRabbit)

Org owners never have to fiddle on the GitHub website. From the **Repositories** page:

1. Click **Continue with GitHub** → GitHub asks them to authorize Cavix (the same
   `read:org` + `user:email` consent screen CodeRabbit uses) → they're back on your site.
2. Cavix lists **every organization they belong to** (plus their personal account) as
   selectable chips.
3. Pick an org → Cavix lists **all its repositories** with language, description, and
   public/private. A search box filters them.
4. Flip the **toggle** on any repo to enable Cavix reviews on it (or off to disable).
   That's the whole setup — done from your site.

> **The one unavoidable GitHub step:** installing the **GitHub App** itself shows a
> one‑time GitHub consent screen (GitHub *requires* this — no tool, including
> CodeRabbit, can bypass it). The dashboard gives owners an **"Install GitHub App ↗"**
> button that deep‑links straight to it, so it's still one click from your site.

**Two modes, automatic:**
- **Demo mode (zero setup):** if you haven't configured OAuth, "Continue with GitHub"
  logs in a demo GitHub user and shows realistic sample orgs/repos — so you can *see*
  the entire flow working immediately (great for trials and screenshots).
- **Live mode:** set the four env vars below and it uses **real GitHub** — real login,
  real orgs, real repos.

**To turn on real GitHub sign‑in** (one‑time), create a GitHub **OAuth App** at
**github.com → Settings → Developer settings → OAuth Apps → New OAuth App** with the
callback URL `https://<your-site>/api/auth/github/callback`, then set:
```powershell
$env:CAVIX_GITHUB_OAUTH_CLIENT_ID = "Iv1...."       # from the OAuth App
$env:CAVIX_GITHUB_OAUTH_CLIENT_SECRET = "...."       # from the OAuth App
$env:CAVIX_PUBLIC_URL = "https://app.yourdomain.com" # your site's public URL
$env:CAVIX_GITHUB_APP_SLUG = "cavix"                 # your GitHub App's name (for the Install button)
```
GitLab / Bitbucket / Azure appear in the connect UI as "soon" — the same repo‑browser
pattern extends to each once you add that provider's OAuth (the code is structured for it).

> **GitLab, Bitbucket, Azure:** the review engine and platform adapters already support
> all four ([section 8B](#8b-go-live-on-github-production-github-app--cavix-commands)
> comparison). Only the *self‑serve web connect UI* currently ships for GitHub; the
> others connect via the same adapters at the service level today.

### How the site works (plain English)

- **One process serves everything.** The control‑plane is a small Node HTTP server
  ([services/control-plane/src/server.ts](services/control-plane/src/server.ts)). It
  serves two things: the **website files** (from
  [services/control-plane/public/](services/control-plane/public/)) and the **JSON API**
  under `/api/*`. No separate frontend server is required.
- **The dashboard is a single‑page app.** [public/app.js](services/control-plane/public/app.js)
  fetches data from the API and renders each page in the browser. It's plain
  JavaScript — open it and read it; there's no magic build.
- **Login is a secure signed cookie.** When you log in, the server hands your browser a
  tamper‑proof session cookie (HMAC‑signed). Every dashboard request carries it, so the
  server knows who you are and which org you belong to
  ([src/auth.ts](services/control-plane/src/auth.ts)).
- **Passwords are hashed** (scrypt, salted) — never stored in plain text.
- **BYOK keys are encrypted** (AES‑256‑GCM) before storage, and the raw key is *never*
  sent back to the browser — only a short fingerprint like `sk-…demo (f909ad28)`.
- **The API is the same one the orchestrator uses.** When a real review finishes, the
  orchestrator `POST`s it to `/api/reviews`, and it shows up on the dashboard instantly.

> **Security note for going live:** two secrets protect the app. Set them in production
> (they have insecure dev defaults):
> ```powershell
> $env:CAVIX_SESSION_SECRET = "a-long-random-string"   # signs login cookies
> $env:CAVIX_SECRET_KEY     = "another-long-random"    # encrypts stored BYOK keys
> ```
> Generate each with:
> `-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | % {[char]$_})`

---

## 8D. Deploy to production (hand it to org owners for a trial)

This section takes you from "runs on my laptop" to "a real URL an org owner can sign
up on." You do **not** need to be a DevOps expert — pick **Path A** (managed hosting,
easiest) and follow the steps. Path B (Docker/VPS) and Path C (Kubernetes) are for
when you want more control.

### The production picture (what runs where)

```
                            ┌──────────────────────────────┐
   Org owner's browser ───► │  control-plane (the website)  │  ← the site + API + dashboard
                            │  Node, port 8088              │
                            └───────────────┬───────────────┘
                                            │ shares the same DB/queue
   GitHub  ──webhook──►  ┌─────────────┐    │    ┌──────────────────┐
   (a PR opens)          │ edge (Go)   │───►Redis│  orchestrator     │──► posts the review
                         │ port 8080   │  queue  │  (runs the review) │    back to GitHub
                         └─────────────┘         └──────────────────┘
                                            │
                                   ┌────────┴────────┐
                                   │ Postgres (data) │   ← orgs, users, reviews, decisions
                                   └─────────────────┘
```

Four things run in production:
1. **control‑plane** — the website + dashboard + API (what this section is mostly about).
2. **edge** — the fast Go "front door" that receives GitHub webhooks.
3. **orchestrator** — runs the actual review pipeline and posts results.
4. **Data stores** — **Postgres** (durable data) and **Redis** (the job queue).

> **Important honesty note:** in this repo the control‑plane and orchestrator use
> **in‑memory** stores (great for trials and demos — they "just run"). For a real
> multi‑day production deployment you swap those for **Postgres/Redis** so data
> survives a restart. The code is written behind interfaces exactly so this swap is a
> config change, not a rewrite. For a **short pilot/trial**, the in‑memory version is
> genuinely fine — just know that a restart clears data.

---

### Path A0 — FREE one‑click deploy (the fastest way to go live, $0)

The repo ships a **`render.yaml` blueprint** that provisions the **whole product** on
Render's **free** plan: the **website**, the **edge** (webhook receiver), the
**orchestrator** (review engine), a **Redis** queue, and a **Postgres** database — all
wired together automatically.

1. **Push the repo to GitHub** (see Step A1 below if it isn't there yet).
2. Go to **https://render.com** → sign up (use your GitHub account) → **New + →
   Blueprint** → pick your repo → **Apply**.
3. Render reads `render.yaml`, creates all five components, **auto‑generates** the
   secrets, and **auto‑wires** `DATABASE_URL`, the Redis URL, and the shared
   `CAVIX_INTERNAL_TOKEN` between services.
4. Fill in the few values it can't generate (each service's **Environment** tab):
   - **cavix:** `CAVIX_ADMIN_EMAILS` = your email (founder Admin console).
   - **cavix‑orchestrator:** `CAVIX_CONTROL_PLANE_URL` = the **cavix** service URL;
     `CAVIX_APP_ID` + `CAVIX_APP_PRIVATE_KEY` from your GitHub App ([§8B](#8b-go-live-on-github-production-github-app--cavix-commands)).
5. In your **GitHub App** settings, set the **Webhook URL** to the **cavix‑edge** URL
   ending in `/webhook`, and the **Webhook secret** to cavix‑edge's generated
   `CAVIX_WEBHOOK_SECRET` (view it in Render → cavix‑edge → Environment).
6. Open the **cavix** URL, sign up, and share it. Install the GitHub App on a repo and
   open a PR — Cavix reviews it end‑to‑end, using that org's own key from the site. 🎉

> **Just want the free trial site (no real‑PR pipeline)?** In `render.yaml`, delete the
> **cavix‑edge**, **cavix‑orchestrator**, and **cavix‑redis** blocks. The **cavix** web
> service + Postgres are fully self‑contained — org owners bring their own AI key on the
> site (BYOK). This is the simplest, guaranteed‑green free deploy; do the full pipeline
> once you've created the GitHub App.

> **Free‑tier facts (so nothing surprises you):**
> - Free web services **spin down after ~15 minutes idle** and **cold‑start**
>   (~30–60s) on the next request. Fine for a trial; a plan bump keeps them always‑on.
> - **Data persists** via the auto‑wired Postgres (`DATABASE_URL`), so accounts and
>   reviews **survive restarts/redeploys**.
> - Render's free **Postgres and Redis are time‑limited**; for unlimited free, swap in
>   **Neon/Supabase** (Postgres → `DATABASE_URL`) or **Upstash** (Redis → set each
>   service's `CAVIX_REDIS_URL` to the `rediss://…` string). Both are supported now
>   (password + TLS).
> - Don't rotate `CAVIX_SECRET_KEY` or previously‑saved BYOK keys can't be decrypted.

The manual steps below (Path A) are the website done by hand, or for Railway/Fly.

---

### Path A — Managed hosting by hand (Render/Railway/Fly)

The goal: get the **website** live on a public URL in ~15 minutes. Good hosts for a
Node app with no build step: **Render**, **Railway**, or **Fly.io** (all have free/cheap
tiers). Steps below use **Render** as the example; the others are nearly identical.

**Step A1 — Put the code on GitHub.** If it isn't already, create a repo and push:
```powershell
cd "C:\Users\aryan\Videos\CavixCode"
git init; git add -A; git commit -m "Cavix"
# then create a repo on github.com and follow its "push existing repo" lines
```

**Step A2 — Create the web service on Render.**
1. Go to **https://render.com**, sign up (you can use your GitHub account).
2. Click **New → Web Service** and connect your GitHub repo.
3. Fill in:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm run control-plane`  ← **this is the website.** Do **not**
     use `npm run orchestrator` here — that's the background review engine (it needs
     Redis and will exit on a web host).
   - **Instance type:** the free or cheapest paid tier is fine to start.

**Step A3 — Set the environment variables** (Render: the **Environment** tab → Add).
These are the "named slots" from [section 10](#10-configuration--keys-byok):
```
CAVIX_SESSION_SECRET     = <long random string>     # required: signs login cookies
CAVIX_SECRET_KEY         = <another long random>     # required: encrypts stored BYOK keys
CAVIX_ADMIN_EMAILS       = you@yourdomain.com         # so you get the Admin console
CAVIX_LLM_PROVIDER       = anthropic                  # OPTIONAL: default shown to new orgs
CAVIX_LLM_MODEL          = claude-sonnet-4-6          # OPTIONAL: default model for new orgs
```
> **No AI key here.** You do **not** put any `..._API_KEY` on the website. Each org adds
> its own key on the **AI & BYOK** page after signing up (that's the whole BYOK point) —
> it's encrypted at rest. `CAVIX_LLM_PROVIDER` / `CAVIX_LLM_MODEL` are just the *default*
> a brand‑new org sees; they can change both on the site. So the only **required** vars
> are the two secrets.
>
> **Port:** you do **not** need to set a port. The control‑plane automatically listens
> on Render's `$PORT` (and binds `0.0.0.0`), so it works out of the box. Locally it
> still defaults to `8088`.

**Step A4 — Deploy.** Click **Create Web Service**. Render installs and starts it. In a
minute you'll get a public URL like `https://cavix.onrender.com`. Open it — the
marketing site loads, and **org owners can now sign up at `/signup`.** 🎉

**Step A5 (recommended) — A custom domain.** In Render → **Settings → Custom Domain**,
add `app.yourdomain.com` and follow the DNS instructions. Now owners visit *your* brand.

That's a shippable trial. To also review **real PRs**, deploy the edge + orchestrator
the same way (two more Node/Go services) and add the GitHub App keys from
[section 8B](#8b-go-live-on-github-production-github-app--cavix-commands) — see
**"Wiring in real reviews"** below.

---

### Path B — Docker (one container, any server/VPS)

If you have a server (DigitalOcean, AWS EC2, Hetzner, etc.) or just prefer containers,
this bundles the control‑plane into one image. Create this file at the repo root:

```dockerfile
# Dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY services ./services
COPY eval ./eval
RUN npm install --omit=dev
ENV CAVIX_CONTROL_PLANE_PORT=8088
EXPOSE 8088
CMD ["npm", "run", "control-plane"]
```
Build and run it:
```bash
docker build -t cavix-web .
docker run -d -p 80:8088 \
  -e CAVIX_SESSION_SECRET="a-long-random-string" \
  -e CAVIX_SECRET_KEY="another-long-random-string" \
  -e CAVIX_LLM_PROVIDER="anthropic" \
  -e CAVIX_LLM_MODEL="claude-sonnet-4-6" \
  --name cavix-web cavix-web
```
The site is now on your server's IP on port 80. Point a domain at that IP and put it
behind HTTPS with a reverse proxy (Caddy is the simplest — it gets you a free TLS
certificate automatically):
```
# Caddyfile
app.yourdomain.com {
    reverse_proxy localhost:80
}
```

> **All four services on one box (full product, not just the site):** add a
> `docker-compose.yml` with `postgres`, `redis`, `control-plane`, `edge`, and
> `orchestrator`. A `docker-compose.yml` already exists for the Postgres+Redis part
> (see [section 8a](#8-run-the-real-services)); add service blocks that run
> `npm run control-plane`, `npm run orchestrator`, and the Go edge, all sharing the
> `CAVIX_REDIS_HOST` and (in production) a `DATABASE_URL`.

---

### Path C — Kubernetes / air‑gapped (enterprise self‑host)

For customers who must run it **inside their own cluster** (including fully offline),
Cavix already ships a **Helm chart** and **Terraform**. This is the enterprise path and
is covered in **[section 11](#11-self-host--air-gapped-deployment)**. In short:
```bash
helm install cavix deploy/helm/cavix -n cavix --create-namespace \
  --set image.registry=registry.internal/cavix
```
The chart runs all four services + Postgres/Redis and, with `airGapped=true`, enforces
zero outbound internet. Hand this to a customer's platform team.

---

### Wiring in real reviews (connect the website to live GitHub PRs)

The website alone lets owners sign up and manage BYOK. To make Cavix actually **review
PRs**, connect the other two services (all deployed the same way as Path A/B):

1. **Create the GitHub App** and get its keys — full click‑by‑click in
   [section 8B](#8b-go-live-on-github-production-github-app--cavix-commands) and
   [SETUP_KEYS.md](SETUP_KEYS.md).
2. **Deploy the edge** (Go) with a public URL, set as the App's **Webhook URL**. Give it
   `CAVIX_WEBHOOK_SECRET` and `CAVIX_BOT_HANDLE`.
3. **Deploy the orchestrator** with the App keys (`CAVIX_APP_ID`,
   `CAVIX_APP_PRIVATE_KEY`) and point it at the same Redis + control‑plane.
4. **Org owners install the App** on their repos (or self‑serve from your Marketplace
   listing). From then on, every PR is reviewed and appears on their dashboard.

> **Use the keys owners set on the site (no env keys).** So real reviews use each
> org's own provider/model/key from the **AI & BYOK** page, connect the orchestrator to
> the control‑plane with a shared secret:
> - On **both** services set the same **`CAVIX_INTERNAL_TOKEN`** (any long random
>   string). This turns on a token‑gated internal endpoint on the site.
> - On the **orchestrator** also set **`CAVIX_CONTROL_PLANE_URL`** to your site URL
>   (e.g. `https://cavix.onrender.com`).
>
> Now, for each review, the orchestrator fetches that org's key from the site
> (cached ~60s) and uses it — no `CAVIX_LLM_API_KEY` env needed. If the site is
> unreachable or the org hasn't set a key, it falls back to the env config, so a
> review never hard‑fails. Keep the two services on the same private network in
> production (the endpoint returns the decrypted key over the shared‑secret channel).

Now the loop is complete: **owner signs up on your site → adds their AI key → installs
the GitHub App → opens a PR → Cavix reviews it → the result appears in their dashboard.**

> **Running the orchestrator for FREE (Render/Railway/Fly).** Free plans only keep
> **web services** alive (a background worker is paid). The orchestrator now opens a
> small **health port** (on `$PORT`) precisely so it qualifies as a free web service —
> deploy it with **Start Command `npm run orchestrator`**, and set the health check to
> `/healthz`. It also **won't crash while Redis is missing**: it stays live and retries,
> so the deploy reports healthy. For the Redis it needs, use a **free managed Redis**
> (Render **Key Value** free plan, or **Upstash** free) and give the orchestrator the
> one connection URL:
> ```
> CAVIX_REDIS_URL = rediss://default:PASSWORD@your-host:6380
> ```
> Same trick works for the Go **edge** (it's already an HTTP server, so it's a natural
> free web service). That means the *entire* pipeline can run on free tiers.

---

### Going‑to‑production checklist

Before you invite real org owners, tick these:

- [ ] **Secrets set** — `CAVIX_SESSION_SECRET` and `CAVIX_SECRET_KEY` are long random
      strings (not the dev defaults). Never commit them; use the host's secret manager.
- [ ] **HTTPS on** — the site is served over `https://` (managed hosts do this for you;
      on a VPS use Caddy/Nginx). Login cookies should only travel over HTTPS.
- [ ] **A real database (so data survives restarts)** — set **`DATABASE_URL`** to a
      Postgres and the control‑plane persists all accounts/reviews/settings to it
      automatically (it snapshots state to a `cavix_state` table). The one‑click
      blueprint (Path A0) wires a free Render Postgres for you. For an **unlimited free**
      database, create one at **Neon** (neon.tech) or **Supabase** (supabase.com) and
      paste its connection string as `DATABASE_URL` (use the `?sslmode=require` URL).
      Without `DATABASE_URL` the store is in‑memory and clears on restart — fine for
      demos only. (The orchestrator, if you run it, still uses Redis for its queue.)
- [ ] **Change/disable the demo login** — remove the `demo@cavix.dev` seed in
      [services/control-plane/src/main.ts](services/control-plane/src/main.ts) for a real
      deployment (it's there for trials).
- [ ] **BYOK works** — log in, go to **AI & BYOK**, paste a real key, and confirm reviews
      run. The key should show only as a fingerprint afterward.
- [ ] **GitHub App live** (if reviewing real PRs) — webhook delivering, check runs
      posting. Test on a throwaway repo first.
- [ ] **Backups** — if using Postgres, enable automated backups on your host.
- [ ] **A status page / health check** — point your host's health check at `/healthz`.

> **The fastest trial path, summarized:** Path A on Render → set the two secrets → send
> an org owner your URL → they sign up, add their AI key, and (optionally) install the
> GitHub App. That's a real, brandable, multi‑tenant trial they can use today.

---

## 8E. Run the business — founder & core‑team controls

This is the **operator's manual**: how you (the founder) and your core team control the
whole product — who has power, how trials work, how many reviews each tier gets, and how
you manage the code. There are **two completely separate layers of control**, and it's
important not to confuse them:

| Layer | Who it's for | What it controls | How you grant it |
|-------|-------------|------------------|------------------|
| **Platform admin** (you / core team) | The founder & trusted core team | **Every** organization on your platform — tiers, trials, review limits, suspend | Add their email to `CAVIX_ADMIN_EMAILS` |
| **Org role** (your customers) | People inside a customer's workspace | Only **their own** org — repos, BYOK, settings, their teammates | Set on the Team page (owner/admin/reviewer/member) |

**In one sentence:** *platform admins run the whole company; org roles run one customer's
workspace.* A customer's "owner" has zero power over other customers or over your pricing.

---

### Part 1 — Who has control (and how to grant / revoke it)

#### The founder & core team = "platform admins"
A platform admin can open the **Admin console** in the dashboard and change any org's
plan. You decide who's a platform admin with **one environment variable** — a
comma‑separated list of emails:

```powershell
$env:CAVIX_ADMIN_EMAILS = "you@cavix.dev,cofounder@cavix.dev,ops@cavix.dev"
```

- **To give a core‑team member control:** add their email to that list and restart the
  control‑plane. Next time they log in, an **🛡️ Admin console** appears in their sidebar.
- **To remove someone's control:** delete their email from the list and restart. The
  Admin console disappears for them instantly — no code change, no database edit.
- **Security:** the check happens on the **server** for every admin request (not just
  hidden in the UI), so someone who isn't listed **cannot** call the admin API even if
  they try. Non‑admins get a `403 forbidden` (verified by tests).

> **Default for the demo:** if you never set `CAVIX_ADMIN_EMAILS`, only the seeded
> `demo@cavix.dev` is treated as admin (so the console is visible out of the box). **In
> production, always set `CAVIX_ADMIN_EMAILS` to your real team** — otherwise no live
> user is an admin, which is the safe default.

#### Your customers = "org roles"
Inside each customer workspace, people have one of four roles (managed on the **Team**
page by that org's own owner/admin):

| Role | Can do |
|------|--------|
| **owner** | Everything in their org: billing, BYOK, settings, connect repos, manage members, change roles |
| **admin** | Same as owner except (by convention) not billing ownership |
| **reviewer** | Use the dashboard, accept/reject findings |
| **member** | View the dashboard |

The **first person to sign up** for an organization automatically becomes its **owner**.
Owners/admins can promote or demote teammates; a `403` is returned if a mere member tries.

---

### Part 2 — The Admin console (control every org)

Log in as a platform admin and click **🛡️ Admin console** in the sidebar. You see a table
of **every organization** on your platform with its member/repo/review counts, and for
each one you can:

| Control | What it does | Effect |
|---------|--------------|--------|
| **Tier** dropdown (free ⇄ paid) | Move an org between plans | Changes their default review limit |
| **Start 14‑day trial** | Give a free org paid‑level limits for 14 days | Auto‑expires; no cleanup needed |
| **Set limit** | Override reviews/day for *that one org* (any number, or blank to clear) | Beats the tier default |
| **Suspend / Unsuspend** | Instantly stop (or resume) an org's reviews | Suspended = 0 reviews allowed |

Every change takes effect **immediately** for that org's next review. Behind the scenes
these call the admin API (`POST /api/admin/orgs/:org`), which only platform admins can
reach.

---

### Part 3 — Controlling how many reviews each tier gets

Review limits are a **rolling 24‑hour quota**. There are two ways to set them, and they
combine in a clear priority order.

**A) The default per‑tier limits (apply to everyone on that tier)** — two env vars on the
control‑plane:
```powershell
$env:CAVIX_FREE_REVIEWS_PER_DAY = "25"        # every free org: 25 reviews/day
$env:CAVIX_PAID_REVIEWS_PER_DAY = "1000000"   # paid = effectively unlimited
```
Change these and restart to reprice every org on that tier at once.

**B) A per‑org override (for one specific customer)** — use **Set limit** in the Admin
console, or the API. This beats the tier default. Great for "give this one pilot 200/day."

**How the effective limit is decided (top wins):**
1. **Suspended?** → **0** (reviews blocked).
2. **Per‑org override set?** → use that number.
3. **Active trial?** → paid‑tier limit.
4. Otherwise → the org's **tier** default (free or paid).

When an org hits its quota, the review API returns `429` with a clear message, and no
review runs until the 24‑hour window rolls forward (or you raise the limit).

---

### Part 4 — Providing a trial (step by step)

You have three easy ways to give a prospect a trial — pick whichever fits:

**Option 1 — Self‑serve free tier (zero effort).** Just send them your site URL. They
click **Sign up**, and their new org starts on the **free tier** (25 reviews/day, public
repos). This is your default top‑of‑funnel.

**Option 2 — A time‑boxed paid trial (the classic "14‑day trial").**
1. Ask the prospect to sign up (creates their org, e.g. `acme`).
2. You log into the **Admin console**, find `acme`, click **Start 14‑day trial**.
3. For 14 days they get **paid‑tier limits and features**; it auto‑expires back to free.

**Option 3 — A custom pilot (specific limit).** In the Admin console, set their **tier**
to paid and use **Set limit** to grant exactly what you agreed (e.g. 500/day) for a named
pilot. Clear the override or flip them back to free when the pilot ends.

To **end** any trial early, open the org in the Admin console and suspend it, drop it to
free, or clear its limit.

---

### Part 5 — How you (the founder) manage the code

This keeps your source clean and releasable.

**Day‑to‑day workflow (never commit straight to `main`):**
```powershell
git checkout -b feature/short-name     # start a branch
# ...make changes...
npm run typecheck; npm test            # everything must be green
git add -A
git commit -m "feat: describe the change"
git push -u origin feature/short-name  # open a Pull Request on GitHub to merge
```

**The golden rules that keep git clean:**
- **`main` is always shippable.** Merge into it only via reviewed Pull Requests.
- **Run `npm test` and `npm run typecheck` before every commit** — the whole suite is
  hermetic (no keys/infra) so there's no excuse to skip it. Green means safe.
- **Never commit secrets.** Keys live in environment variables (and your host's secret
  manager), never in the code. Keep a `.gitignore` for `.env`, `*.pem`, and build output.
- **Small commits with clear messages** (`feat:`, `fix:`, `docs:` prefixes) so the
  history reads like a changelog.
- **Cut releases from `main`** with a version tag (`git tag v0.4.0 && git push --tags`)
  and note what changed in [CHANGELOG.md](CHANGELOG.md).

**Who can push to your repo** is controlled on **GitHub → your repo → Settings →
Collaborators and teams** (and **Branch protection** to require PR review before merge).
That's separate from Cavix's own admin controls above — it's how you decide which *core
team members* can change the **product's source code**.

---

### Part 6 — Controlling the whole app (the levers, in one place)

Everything about how the running product behaves is an **environment variable** you set
on the services (no code changes). The founder‑relevant ones:

| Lever | Variable | Effect |
|-------|----------|--------|
| Who is a platform admin | `CAVIX_ADMIN_EMAILS` | Comma‑separated core‑team emails |
| Free‑tier review quota | `CAVIX_FREE_REVIEWS_PER_DAY` | Default reviews/day for free orgs |
| Paid‑tier review quota | `CAVIX_PAID_REVIEWS_PER_DAY` | Default reviews/day for paid orgs |
| Login cookie security | `CAVIX_SESSION_SECRET` | Must be a long random string in prod |
| BYOK key encryption | `CAVIX_SECRET_KEY` | Must be a long random string in prod |
| Which AI + model (default) | `CAVIX_LLM_PROVIDER` / `CAVIX_LLM_MODEL` | Platform default; each org overrides via BYOK |
| Air‑gapped mode | `CAVIX_AIRGAPPED` | `true` = zero outbound calls |
| Dashboard port | `CAVIX_CONTROL_PLANE_PORT` | Default 8088 |

Per‑org things (tier, trial, limit, suspend, plus each org's own BYOK/settings) are set
**at runtime** from the Admin console and the dashboard — not from env vars — so you
change them without redeploying.

> **Mental model:** *env vars = platform‑wide defaults & secrets (set at deploy);*
> *Admin console = per‑customer controls (set anytime, live).*

---

## 9. Measure quality (the eval harness)

Cavix treats review **quality** as a number you can track, not a gut feeling.

```powershell
npm run eval          # side-by-side: a plain checker vs Cavix Phase 0 / 1 / 2
```
Sample output:
```
reviewer                            Prec     Rec      F1  FP-rate
linter-only (competitor)          100.0%   63.6%   77.8%     0.0%
diff-only LLM (Cavix Phase 0)      81.8%   81.8%   81.8%    18.2%
context+ensemble (Cavix Phase 1)   91.7%  100.0%   95.7%     8.3%
+ verification (Cavix Phase 2)    100.0%  100.0%  100.0%     0.0%
```
> **How to read this table:** **Prec (precision)** = of the things it flagged, what %
> were real. **Rec (recall)** = of the real bugs, what % it caught. **F1** = a single
> combined score (higher is better; 100% is perfect). **FP‑rate (false‑positive
> rate)** = how often it cried wolf (lower is better). The bottom row — Cavix with its
> proof step — hits **100% F1 with 0% false alarms.**

```powershell
npm run eval:bench    # scores against well-known public bug datasets
```

**Run the scorecard against a real AI** (instead of the built‑in fixed examples):
```powershell
$env:EVAL_MODE = "live"; $env:ANTHROPIC_API_KEY = "sk-ant-..."; npm run eval
```

The labeled example bugs live in `eval/datasets/seed/` (10 hand‑checked bugs across
JavaScript/Python/Go) — you can add your own to widen the test.

---

## 10. Configuration & keys (BYOK)

Everything is configured by **environment variables** (named slots) — nothing is
hard‑coded. **BYOK** means "Bring Your Own Key": each company plugs in its own AI
account. Your key is **never written to logs** — only a short harmless fingerprint,
so costs can be tracked.

> 📎 **The full, click‑by‑click, non‑technical walkthrough of how to get every key and
> exactly where to paste it is in [SETUP_KEYS.md](SETUP_KEYS.md).** The table below is
> the quick reference.

To switch which AI you use, you change one slot:
```powershell
$env:CAVIX_LLM_PROVIDER = "anthropic"        # the AI vendor ("anthropic", "selfhosted", etc.)
$env:CAVIX_LLM_MODEL = "claude-opus-4-8"      # which model (smartest Claude)
$env:CAVIX_LLM_API_KEY = "sk-..."             # your key from that vendor
```

**Model routing (to save money):** cheap AIs do the quick sorting; the expensive,
smartest AI is used only for deep reasoning and the final proof. This happens
automatically and can be tuned per reviewer.

Key slots at a glance:

| Slot (variable) | Used by | What it means |
|-----------------|---------|---------------|
| `CAVIX_WEBHOOK_SECRET` | edge | Shared password proving GitHub messages are genuine (required) |
| `CAVIX_BOT_HANDLE` | edge | The `@mention` name (e.g. `cavixcode`) |
| `CAVIX_APP_ID` | orchestrator | Your GitHub App's ID number (production login) |
| `CAVIX_APP_PRIVATE_KEY` | orchestrator | Your GitHub App's private key file contents (production login) |
| `CAVIX_REDIS_ADDR` / `_HOST` / `_PORT` | edge / orchestrator | Where the job queue lives (optional — omit for built‑in) |
| `CAVIX_REDIS_URL` | orchestrator | **Managed Redis in one line**, e.g. `rediss://default:PASSWORD@host:6380`. Sets host, port, username, password, and TLS all at once (use this for Redis Cloud / Upstash / Render Key Value). |
| `CAVIX_REDIS_PASSWORD` / `_USERNAME` / `_TLS` | orchestrator | Redis auth + TLS as separate vars (alternative to the URL). `_TLS=true` for `rediss`. |
| `CAVIX_GITHUB_TOKEN` | orchestrator | A personal GitHub token — developer/testing only |
| `ANTHROPIC_API_KEY` / `CAVIX_LLM_API_KEY` | gateway | Your AI key |
| `CAVIX_LLM_MODEL` | gateway | Which AI model |
| `CAVIX_SANDBOX_BACKEND` | orchestrator | Where code runs safely: `local`, `docker`, or `cloudflare` |
| `CAVIX_AIRGAPPED` | gateway | `true` = fully offline; only the in‑house AI is reachable |
| `CAVIX_CONTROL_PLANE_PORT` | control‑plane | Dashboard web port (default 8088) |
| `CAVIX_FREE_REVIEWS_PER_DAY` | control‑plane | Daily review limit for the free tier |
| `CAVIX_PAID_REVIEWS_PER_DAY` | control‑plane | Daily review limit for the paid tier |
| `CAVIX_ADMIN_EMAILS` | control‑plane | Comma‑separated founder/core‑team emails who get the Admin console (see §8E) |
| `CAVIX_SESSION_SECRET` | control‑plane | Signs dashboard login cookies — **set in production** |
| `CAVIX_SECRET_KEY` | control‑plane | Encrypts stored BYOK keys + OAuth tokens at rest — **set in production** |
| `DATABASE_URL` (or `CAVIX_DATABASE_URL`) | control‑plane | Postgres connection string — set it and data **survives restarts** (Render/Neon/Supabase). Omit = in‑memory. |
| `CAVIX_DATABASE_SSL` | control‑plane | `off` / `true` to override TLS auto‑detection for Postgres |
| `CAVIX_INTERNAL_TOKEN` | control‑plane + orchestrator | Shared secret that lets the orchestrator read each org's BYOK key from the site. Set the **same** value on both. |
| `CAVIX_CONTROL_PLANE_URL` | orchestrator | The site's URL, so the orchestrator fetches org keys from it (BYOK end‑to‑end) |
| `CAVIX_GITHUB_OAUTH_CLIENT_ID` | control‑plane | "Sign in with GitHub" OAuth App client id (unset = demo mode) |
| `CAVIX_GITHUB_OAUTH_CLIENT_SECRET` | control‑plane | GitHub OAuth App client secret |
| `CAVIX_PUBLIC_URL` | control‑plane | Public site URL, for the OAuth callback (e.g. `https://app.yourdomain.com`) |
| `CAVIX_GITHUB_APP_SLUG` | control‑plane | Your GitHub App's name, for the dashboard "Install App" link |

---

## 11. Self‑host & air‑gapped deployment

Cavix is built to run **inside your own company's servers**, including **fully
offline** ("air‑gapped" = no internet at all). This section is for an IT person —
if you're not technical, hand it to your IT team; the concepts are explained so you
can follow along. Two installer assets are provided: a **Helm chart** and
**Terraform** (industry‑standard tools for setting up servers).

### Quick install (a normal, internet‑connected cluster)
```bash
helm lint deploy/helm/cavix
helm install cavix deploy/helm/cavix -n cavix --create-namespace \
  --set airGapped=false --set image.registry=registry.internal/cavix
```

### Fully offline (air‑gapped) install
1. Copy + digitally sign the software images into your own private image store:
   ```bash
   COSIGN_PASSWORD=… deploy/sign-images.sh registry.internal/cavix 0.3.0 cosign.key
   ```
2. Install with Terraform (creates the space, the license, and the release):
   ```bash
   cd deploy/terraform
   terraform apply -var air_gapped=true -var license_file=./cavix-license.json \
     -var image_registry=registry.internal/cavix
   ```

### Prove nothing leaves the building
With offline mode on, the installer sets up a strict "no outbound internet" rule and
runs the AI **inside your own cluster.**
```bash
kubectl -n cavix get networkpolicy cavix-default-deny-egress -o yaml   # shows: no exits allowed
kubectl -n cavix exec deploy/cavix-orchestrator -- \
  sh -c 'wget -T3 -qO- https://api.anthropic.com || echo BLOCKED'      # → prints BLOCKED
```
Two independent layers enforce this: the **network rule** blocks the traffic at the
infrastructure level, and the AI connector itself **refuses** any address that isn't
the in‑house AI. You can watch the second layer right now, no cluster needed:
```powershell
npm run airgap-demo
```
Full explanation: [docs/compliance/AIR_GAPPED_DATA_FLOW.md](docs/compliance/AIR_GAPPED_DATA_FLOW.md)
and [deploy/README.md](deploy/README.md).

> **Note on the two blocks above:** those `helm`, `terraform`, and `kubectl`
> commands are shown in Mac/Linux style because they're meant for an IT admin on a
> server. The `npm run airgap-demo` line works on your Windows machine as‑is.

---

## 12. Enterprise features

Built and tested (see `packages/governance`, `packages/license`,
`packages/zero-retention`, `packages/policy`, `packages/legacy`):

- **Company sign‑in (SSO / SAML 2.0)** — employees log in with your company's
  existing login, with proper security checks.
- **Automatic user provisioning (SCIM)** — your company directory pushes users and
  groups in; groups map to roles.
- **Roles (RBAC)** — owner / admin / reviewer / member, each with the right
  permissions.
- **Tamper‑evident audit log** — a linked chain of records; any edit is detectable.
- **Zero‑retention** — proven deletion of all customer code after a review; only
  harmless summary data is kept.
- **Offline licensing** — licenses that verify with no internet at all.
- **Rules engine** — write rules in **plain English** ("flag any endpoint without a
  login check"); they turn into strict, non‑bypassable checks. Off by default.
- **Old languages** — reviews for COBOL, PL/SQL, C/C++, older Java/.NET, and infra
  config — plus a **modernization mode** that proposes upgrades and *proves them
  through the sandbox* before suggesting.

Compliance paperwork (SOC 2 / ISO 27001 mapping, hardening, data‑flow):
[docs/compliance/](docs/compliance/).

---

## 13. The buyer demo script (live pitch runbook)

A tight **10‑minute** live demo. Have a PowerShell window open in the project folder.
**No internet or keys required** — everything runs locally.

### Before the meeting
```powershell
npm install
cd services/edge; go build ./...; cd ../..
npm test          # confirm everything is green (fail 0)
```

### The script (what to run + what to say)

**(0:00) The one‑liner.**
> "Every AI reviewer guesses. Developers stop trusting it and turn it off. Cavix is
> different: it **proves** every finding by recreating it in a sandbox before it says
> a word. Let me show you."

**(1:00) Show the proof — the moat.**
```powershell
npm run verify-demo
```
> "Watch the exit codes. The bug's test fails — `exit 1`, red — so the bug is real.
> Cavix applies the fix, the test passes — `exit 0`, green — and everything else stays
> green. That's a **VERIFIED** finding. Now the second case: same warning, but the
> code is actually fine. The test passes right away — nothing to fix — so Cavix marks
> it **UNVERIFIED and stays silent.** That's how we kill false alarms: we only speak
> when we can prove it."

**(3:00) Show what single‑repo tools can't — cross‑project impact.**
```powershell
npm run orggraph-demo
```
> "Someone changes an interface in the `orders` service. Cavix knows the `checkout`
> and `billing` services depend on it — and shows the **exact lines** that will break.
> A reviewer looking at one project's change would never catch this."

**(4:30) Show it acts — but safely.**
```powershell
npm run phase4-demo
```
> "Cavix can open its **own fix requests** — but only fixes it has proven work, always
> as a **draft a human must approve.** The one it couldn't prove? Not proposed. It
> never merges on its own. Below that you see the same engine running **inside the
> code editor** before a PR even exists, and the **ROI dashboard**: how much reviewer
> time it saves."

**(6:30) Show the numbers.**
```powershell
npm run eval
```
> "This is measured quality on labeled bugs. A plain checker gets 78% F1. Our
> context‑aware pass gets 96%. Add proof and we hit **100% F1 with zero false
> alarms.** Quality is a number we track, not a promise."

**(8:00) Security / on‑prem close (for regulated buyers).**
```powershell
npm run airgap-demo
```
> "It runs **fully offline** — zero outbound calls. Here it reaches only the in‑house
> AI and **blocks every internet address**, even Anthropic and GitHub. Plus offline
> licensing, company sign‑in, audit logs, and **zero‑retention**: no customer code
> survives a review. Your source never leaves your walls."

**(9:30) Close.**
> "So: it proves before it speaks, it sees across your projects, it can fix safely
> with a human in the loop, and it runs entirely inside your walls. Where would you
> want to start a pilot?"

### If they want to see it on a real PR
Point the orchestrator at a test repo ([section 8c](#8-run-the-real-services)) with a
GitHub token and an AI key, open a PR, and show the posted review. The demos above are
the safe, no‑dependency version for the room.

---

## 14. The sales pitch & ROI

**The problem:** AI code review is noisy. False alarms train developers to ignore it.
Security and platform teams can't trust an unproven machine comment.

**The Cavix difference (say these four):**
1. **Proven, not guessed.** Every non‑trivial finding is recreated in a sandbox.
   False alarms drop to near zero.
2. **Sees the whole system.** Cross‑project impact + slowdown prediction — things a
   single‑change reviewer structurally cannot do.
3. **Acts safely.** Opens verified fix requests as drafts; a human always merges.
4. **Yours to run.** Works with any AI, bring your own key, self‑hostable, fully
   offline, SOC 2 / ISO 27001‑ready.

**The ROI story (with real numbers from `phase4-demo`):**
- **Action rate** — what % of findings developers actually act on (Cavix: ~86%
  because they're proven, vs ~20–40% for noisy tools).
- **Defects caught** — proven by running, so they're real.
- **Reviewer‑hours saved** — a clear model (minutes per severity + fix authoring −
  false‑alarm overhead). The `analytics` part produces per‑team and company rollups
  your champion can take to their VP.

**Who buys:** security‑conscious enterprises, regulated industries (finance,
healthcare, government), and IT‑services/modernization firms with lots of old code.

**Pricing motion:** free tier (public repos, rate‑limited, opt‑in "proven catches"
feed) → paid per‑seat with private repos, company sign‑in, rules engine → enterprise
self‑host/offline with a signed license.

---

## 15. Troubleshooting

| What you see | What it means / the fix |
|--------------|-------------------------|
| A command says *"is not recognized"* | That program isn't installed, or you didn't reopen PowerShell after installing it. Redo the install step in [section 4](#4-prerequisites-what-to-install-first) and reopen PowerShell. |
| Commands do nothing / wrong folder | You're not inside the project. Run `cd "C:\Users\aryan\Videos\CavixCode"` first (your line should end in `\CavixCode>`). |
| `npm test` can't find a package | Run `npm install` again from the **project root** so everything links up. |
| A TS file errors with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | Harmless for you as a user; it's a code‑style note. The project already avoids the patterns that trigger it. |
| A sandbox demo feels slow | It really runs code inside a sandbox; a few hundred milliseconds is expected and normal. |
| Edge won't start | You didn't set `CAVIX_WEBHOOK_SECRET`. It refuses to start without one, on purpose (safety). Set it (see [SETUP_KEYS.md](SETUP_KEYS.md)). |
| Orchestrator posts nothing | Check your `CAVIX_GITHUB_TOKEN` and AI key. With no key, use the demos instead — they need no key. |
| `go test -race` fails with "requires cgo" | Use `go test ./...` (without `-race`) on your machine; the strict version runs in the cloud. |
| `helm install` "not found" | That's a server tool; you only need it if self‑hosting. It's not required for tests or demos. |

---

## 16. What's real vs simulated (honesty)

So you can speak accurately to technical buyers:

- **Real and live:** the `@cavix` command handling + permission checks, the GitHub App
  secure‑login mechanism, the ✓/✗ status marks and stale‑review cleanup, the
  fresh‑vs‑incremental review logic, the `.cavix.yaml` settings loader — all tested.
  The Go front‑door service, the code maps, the security scanners, the merging/voting,
  the **sandbox + proof engine (it really runs code and checks the results)**, the
  fix‑request safety gate, the history math, the learning, the enterprise security
  (sign‑in, licenses, audit log), the zero‑retention purge, the offline guard, and all
  the platform connectors.
- **Behind a fake in tests/demos (real code path, fake edge):** GitHub and the AI are
  reached through "sockets" so the demos run with no key or internet. Change one
  setting to use a real AI and a real token.
- **Authored, validated, not run here:** the server installer files (Helm, Terraform),
  the signing script, and the editor plugins — production‑grade, validated by their own
  tools.
- **Simplified where a full build would be heavy:** the language readers are
  approximate (a full‑strength version slots into the same socket); the in‑memory data
  stores mirror the real database layouts they map to in production.

This honesty *is* the pitch: the one thing that must be real — **the proof** — is real,
and you can watch it run.

---

## 17. FAQ

**Do I need a key or password to try it?** No. The tests and all demos run with no key
and no internet. You only need keys to review real PRs with a real AI. See
[SETUP_KEYS.md](SETUP_KEYS.md) when you get there.

**Which AIs does it support?** Claude (default), GPT, Gemini, or your own in‑house AI.
Bring your own key; it's not tied to any one vendor. In offline mode it uses an
in‑house AI and makes zero outbound calls.

**Will it spam my PRs?** No — that's the whole point. It posts a finding only when it
can prove it, and hides anything it can't recreate.

**Can it merge code on its own?** No. It can open fix requests, but always as drafts
labeled "needs human approval." There is deliberately no auto‑merge.

**Does my code leave my network?** In offline mode, never — enforced by a network rule
*and* the AI connector's own guard. In zero‑retention mode, no code is kept after a
review (proven).

**How do I add a custom rule?** Write it in plain English (e.g. "disallow
`console.log`") — the rules engine turns it into a strict check. Or share a "lens" (a
reusable pack of rules).

**How do I prove quality to my team?** Run `npm run eval` — it prints the quality
scores against labeled bugs and compares Cavix to a plain checker.

**How does `@cavix review` work / how do I get a fresh review?** Comment `@cavix review`
(use your app's name, e.g. `@cavixcode review`) on the PR. Cavix throws away its
previous reviews, deletes its stale comments, clears its memory of the PR, and posts a
brand‑new full review. It's never skipped as a duplicate, so you can re‑run it anytime.
Only people with write access can trigger it. See [section 8B](#8b-go-live-on-github-production-github-app--cavix-commands).

**How do I install it on my whole company?** Create the GitHub App once, then install
it on the organization and choose "All repositories." Full step‑by‑step in
[section 8B](#8b-go-live-on-github-production-github-app--cavix-commands).

---

## 18. Glossary (every tech word, explained)

| Word | Plain‑English meaning |
|------|-----------------------|
| **Terminal / command line / shell / PowerShell** | The text window where you type commands. On Windows you use PowerShell. |
| **Command** | A line you paste in and press Enter to run. |
| **Repo / repository** | One project's folder of code, usually on GitHub. |
| **PR / Pull Request** | GitHub's way of proposing a code change so it can be reviewed before merging. |
| **Diff** | The exact lines a change adds or removes. |
| **Merge** | Accepting a proposed change into the main code. |
| **Commit / push** | Saving a change / sending it up to GitHub. |
| **Branch** | A parallel copy of the code where a change is worked on. |
| **Environment variable** | A named slot (like `CAVIX_LLM_API_KEY`) you fill with a value before starting a service. |
| **Key / token / secret** | A password‑like piece of text that grants access (to GitHub or the AI). |
| **Webhook** | An automatic message GitHub sends your software when something happens (e.g. a PR opens). |
| **Sandbox** | A sealed, internet‑less, throwaway workspace where unknown code can run safely. |
| **exit 0 / exit 1** | How a program reports its result: `exit 0` = success ("green"), anything else = failure ("red"). |
| **Model / LLM** | The AI brain (e.g. Claude). "LLM" = "Large Language Model." |
| **BYOK** | "Bring Your Own Key" — you plug in your own AI account. |
| **GitHub App** | An official "badge" identity for your software on GitHub, safer than a personal login. |
| **CI/CD** | The automated build‑and‑test system a team runs on every change. |
| **False positive / false alarm** | When a tool flags something that isn't actually a problem. |
| **Air‑gapped / offline** | Running with no internet connection at all. |
| **Self‑host** | Running the software on your own company's servers instead of someone else's cloud. |
| **Node.js / npm** | The system that runs most of Cavix / its package installer. |
| **Go** | The programming language of the fast front‑door service. |
| **Docker / Kubernetes / Helm / Terraform** | Tools IT teams use to run software on servers. You don't need them for tests or demos. |

---

### Where to go next
- **Keys & passwords, step by step:** [SETUP_KEYS.md](SETUP_KEYS.md)
- Architecture deep‑dive: [ARCHITECTURE.md](ARCHITECTURE.md)
- What shipped in each phase: [CHANGELOG.md](CHANGELOG.md)
- Self‑host: [deploy/README.md](deploy/README.md)
- Air‑gap & compliance: [docs/compliance/](docs/compliance/)
- Editor plugins: [editors/README.md](editors/README.md)

**Quickest path to "wow":** open PowerShell, then run
`cd "C:\Users\aryan\Videos\CavixCode"`, then `npm install`, then `npm run verify-demo`.
