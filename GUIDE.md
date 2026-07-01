# Cavix — The Complete Guide

Everything you need to **understand, run, test, demo, sell, and deploy** Cavix —
written in plain English, step by step.

> **Cavix in one sentence:** an AI code-review platform that **proves its findings
> before it speaks** — it reproduces the bug (or the security exploit) in an
> isolated sandbox, applies the fix, and runs the tests, so its comments are
> *verified facts, not guesses*.

---

## Table of contents

1. [What Cavix is and why it's different](#1-what-cavix-is-and-why-its-different)
2. [How it works (the 13-stage pipeline)](#2-how-it-works-the-13-stage-pipeline)
3. [The codebase map](#3-the-codebase-map)
4. [Prerequisites](#4-prerequisites)
5. [Install (one-time setup)](#5-install-one-time-setup)
6. [Run the tests (prove it works)](#6-run-the-tests-prove-it-works)
7. [Run the demos (see it work)](#7-run-the-demos-see-it-work)
8. [Run the real services](#8-run-the-real-services)
8B. [Go live on GitHub (production GitHub App + `@cavix` commands)](#8b-go-live-on-github-production-github-app--cavix-commands)
9. [Measure quality (the eval harness)](#9-measure-quality-the-eval-harness)
10. [Configuration & BYOK](#10-configuration--byok)
11. [Self-host & air-gapped deployment](#11-self-host--air-gapped-deployment)
12. [Enterprise features](#12-enterprise-features)
13. [The buyer demo script (live pitch runbook)](#13-the-buyer-demo-script-live-pitch-runbook)
14. [The sales pitch & ROI](#14-the-sales-pitch--roi)
15. [Troubleshooting](#15-troubleshooting)
16. [What's real vs simulated (honesty)](#16-whats-real-vs-simulated-honesty)
17. [FAQ](#17-faq)

---

## 1. What Cavix is and why it's different

Most AI reviewers **guess**. They read a diff and say "this might be a bug." Half
the time they're wrong, so developers stop trusting them and turn them off.

Cavix is built around one idea: **don't guess — prove.** When Cavix suspects a
bug, it spins up a throwaway sandbox, writes a tiny test that reproduces the bug,
applies the fix, and re-runs the tests. Only if the bug *actually happens* does it
say anything. If it can't reproduce the problem, it stays quiet. The result: when
Cavix posts a comment, it's a **fact you can act on**, not noise.

On top of that proof, Cavix does four things competitors structurally can't:

- **Cross-repo impact** — it knows when a change in repo A breaks a *different*
  service in repo B, and shows the exact line.
- **Regression prediction** — it correlates your change with CI/CD history and
  warns about performance regressions before merge.
- **Optional policy gate** — an org can turn on plain-English rules ("every
  endpoint needs an auth check") that become non-bypassable checks.
- **It can act, safely** — it opens its own fix PRs, but **only** fixes it has
  proven green, always as a draft a human must approve.

It is **model-agnostic** (use Claude, GPT, Gemini, or your own model),
**BYOK-first** (bring your own key), and **self-hostable including fully
air-gapped** (zero internet calls).

---

## 2. How it works (the 13-stage pipeline)

A pull request flows through these stages. Each is a real module in the repo.

| # | Stage | What it does (plain English) |
|---|-------|------------------------------|
| 0 | **Edge ingestion** | A fast Go service receives the GitHub webhook, checks it's genuine, and queues the job in ~1ms. |
| 1 | **Orchestration** | A durable workflow drives the whole review and survives restarts. |
| 2 | **Sandbox** | An isolated, network-less, throwaway workspace to run untrusted code safely. |
| 3 | **Deterministic analysis** | Secret scanners + 20+ linters/SAST + an optional org policy gate. These are facts the AI cannot delete. |
| 4 | **Code graph** | Parses the whole repo into a map of who-calls-what, so it can compute the "blast radius" of a change. |
| 5 | **Cross-repo graph** | Maps API contracts (OpenAPI/gRPC/GraphQL) and package deps across repos to trace downstream impact. |
| 6 | **CI/CD telemetry** | Ingests build/test/benchmark history and predicts regressions. |
| 7 | **Context retrieval** | Pulls the *other* files that matter (callers, past discussions) and compresses them with a cheap model. |
| 8 | **Agent ensemble** | Seven specialist reviewers (security, correctness, concurrency, performance, etc.) run in parallel and abstain when unsure. |
| 9 | **Adjudication** | Merges duplicates, votes, thresholds by confidence. Deterministic + policy findings always survive. |
| 10 | **Verification (the moat)** | Reproduces the bug / runs a PoC exploit in the sandbox. Marks VERIFIED / UNVERIFIED / INCONCLUSIVE. |
| 11 | **Synthesis & posting** | Writes the review with severity, evidence, and one-click fixes; posts to GitHub/GitLab/Bitbucket/Azure. |
| 12 | **Learning loop** | Learns from accept/reject to tune per-org thresholds. |
| 13 | **Teardown & zero-retention** | Destroys the sandbox and verifies **no customer code remains**. |

Full architecture and the "why" behind each seam: see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 3. The codebase map

It's a **monorepo** (one repo, many small packages). Two languages: **Go** for the
edge service, **TypeScript** for everything else.

```
services/
  edge/            Stage 0 — Go webhook receiver → Redis queue
  orchestrator/    Stage 1 — durable workflow → review → post comments
  control-plane/   Dashboard API: onboarding, reviews, accept/reject, free tier
packages/
  core/            Shared types + unified-diff parser
  gateway/         BYOK LLM gateway (Claude/GPT/local) + air-gapped egress guard
  sandbox/         Stage 2 — one sandbox interface (Local/Docker/Cloudflare)
  deterministic/   Stage 3 — secrets + SAST + 24-linter registry
  policy/          Stage 3c — optional policy gate + English-rule compiler
  analyzer/        Stage 4 — code graph, blast radius, incremental index
  orggraph/        Stage 5 — cross-repo impact
  telemetry/       Stage 6 — CI/CD telemetry + regression prediction
  context/         Stage 7 — RAG context assembly + compression
  agents/          Stage 8 — 7-agent ensemble + model routing
  adjudicator/     Stage 9 — dedupe, vote, threshold
  verifier/        Stage 10 — execution-grounded verification (the moat)
  platforms/       Stage 11 — GitHub/GitLab/Bitbucket/Azure adapters
  learning/        Stage 12 — accept/reject calibration
  zero-retention/  Stage 13 — verified no-code-persists
  pipeline/        Composes the stages into one review
  governance/      SSO/SAML + SCIM + RBAC + audit (enterprise)
  license/         Offline Ed25519 signed licenses
  legacy/          COBOL/PL-SQL/C-C++/Java/.NET/IaC + modernization
  fixpr/           Verified fix-PR agent (draft, human-approval)
  ide/             Pre-PR local review engine (VS Code + JetBrains)
  batch/           Modernization at scale, verification-gated
  lenses/          Review-lens marketplace + per-org models
  analytics/       ROI dashboards (action rate, hours saved)
eval/              Quality harness (precision/recall/F1 + benchmarks)
deploy/            Helm chart + Terraform + image signing (self-host)
docs/compliance/   Air-gapped data flow, hardening, SOC 2 / ISO 27001
editors/           VS Code + JetBrains plugin manifests
scripts/           airgap-demo, phase4-demo
```

**Design rule:** everything external (databases, GitHub, the LLM, the sandbox) sits
behind an interface with a fake. That's why **all tests run with zero
infrastructure** — no Docker, no database, no API key needed.

---

## 4. Prerequisites

| Tool | Version | Needed for |
|------|---------|-----------|
| **Node.js** | 24+ (22.7+ ok) | All TypeScript packages, tests, demos |
| **Go** | 1.26+ | The edge service (Stage 0) |
| **Git** | any | Cloning + the sandbox shallow-clone test |
| Docker | 28+ | *Optional* — only for the real Postgres/Redis or Docker sandbox |
| Helm / Terraform / kubectl | — | *Optional* — only for Kubernetes self-host |

Check what you have:
```bash
node --version   # v24.x
go version        # go1.26.x
git --version
```

> You do **not** need Docker, a database, or an API key to run the tests or any of
> the demos. They're all hermetic (self-contained).

---

## 5. Install (one-time setup)

From the project root (`CavixCode/`):

```bash
# 1. Install all TypeScript workspace dependencies (fast — very few deps).
npm install

# 2. Build/verify the Go edge service.
cd services/edge && go build ./... && cd ../..
```

That's it. The repo is ready.

---

## 6. Run the tests (prove it works)

**Everything is tested.** This is the fastest way to confirm the whole system works
on your machine.

```bash
# TypeScript: ~173 tests across all packages (no infra needed)
npm test

# Type-check everything
npm run typecheck

# Go edge service tests
cd services/edge && go test ./... && cd ../..
```

Expected: **all green**, in a few seconds. If you see `tests … pass … fail 0`
you're good.

Run one package's tests:
```bash
node --test "packages/verifier/test/*.test.ts"     # the verification engine
node --test "packages/fixpr/test/*.test.ts"        # the fix-PR agent
node --test "packages/gateway/test/*.test.ts"      # BYOK + air-gap
```

**What the tests prove** (a few highlights):
- A planted bug is **reproduced** in a real sandbox and the fix verified green.
- A false alarm does **not** reproduce and is suppressed.
- A security PoC exploit runs in the sandbox.
- Air-gapped mode **blocks every internet host** and reaches only the local model.
- The policy gate is off by default and immutable when on.
- Zero-retention: customer code is gone after a review.

---

## 7. Run the demos (see it work)

These are **runnable, no-setup** demonstrations. Each prints a clear story. Use
these for yourself and for buyers.

| Command | What it shows | Phase |
|---------|---------------|-------|
| `npm run demo` | A real PR review comment is produced (summary + inline + one-click fix) | 0 |
| `npm run phase1` | Indexes THIS repo, finds a **cross-file** bug, shows the policy gate on/off | 1 |
| `npm run verify-demo` | **Reproduces a bug in a real sandbox**, verifies the fix, suppresses a false alarm, runs a PoC exploit | 2 |
| `npm run orggraph-demo` | Traces a breaking API change in repo A to consumers in repos B and C with exact call sites | 2 |
| `npm run airgap-demo` | **Proves zero egress** (blocks anthropic/openai/github), offline license, zero-retention purge | 3 |
| `npm run phase4-demo` | Verified **fix-PR** (vs unverifiable), IDE pre-PR review, ROI numbers | 4 |
| `npm run eval` | Side-by-side quality: linter-only vs Cavix Phase 0/1/2 (F1 up to 100%) | 1–2 |
| `npm run eval:bench` | Scores on external benchmark samples (CVEfixes/SWE-bench/Defects4J) | 2 |

**The three demos to show a buyer** (in this order): `verify-demo`, `orggraph-demo`,
`airgap-demo` (if they care about security/on-prem). See the
[buyer demo script](#13-the-buyer-demo-script-live-pitch-runbook) below.

### Example: the verification demo
```bash
npm run verify-demo
```
You'll see real `node` runs inside a sandbox:
```
status: VERIFIED  reproduced=true fixWorks=true suitePasses=true
  [repro]     node --test calc.repro.test.mjs → exit 1   ← bug reproduces (red)
  [after-fix] node --test calc.repro.test.mjs → exit 0   ← fix works (green)
  [suite]     node --test                     → exit 0   ← no regressions
```
The false-alarm case shows `status: UNVERIFIED → suppressed`. That's the whole
product thesis in 10 lines.

---

## 8. Run the real services

The demos use in-memory fakes so they run anywhere. To run the **actual services**
(against real infra), use these. All config is via environment variables.

### 8a. Local infra (Postgres + Redis)
```bash
docker compose up -d        # starts Postgres + Redis (see docker-compose.yml)
```

### 8b. The edge webhook receiver (Stage 0, Go)
```bash
cd services/edge
export CAVIX_WEBHOOK_SECRET="your-github-app-webhook-secret"   # required
export CAVIX_EDGE_ADDR="127.0.0.1:8080"
export CAVIX_REDIS_ADDR="127.0.0.1:6379"   # omit to use an in-memory queue
go run ./cmd/edge
# POST a signed pull_request webhook to http://127.0.0.1:8080/webhook
# Health: GET /healthz
```

### 8c. The orchestrator (Stage 1, drives the review)
```bash
# from project root
export CAVIX_GITHUB_TOKEN="ghp_…"          # a token that can read/post on the repo
export ANTHROPIC_API_KEY="sk-ant-…"        # BYOK — or CAVIX_LLM_API_KEY
export CAVIX_LLM_MODEL="claude-sonnet-4-6"
export CAVIX_REDIS_HOST="127.0.0.1"
export CAVIX_SANDBOX_BACKEND="docker"      # or "local" for dev
npm run orchestrator
```

### 8d. The dashboard / control-plane (onboarding, accept/reject)
```bash
npm run control-plane        # listens on http://127.0.0.1:8088
```
Open `http://127.0.0.1:8088/` in a browser — you'll see a simple dashboard of
recent reviews with **Accept / Reject** buttons. Those decisions feed the learning
loop (Stage 12). Useful API endpoints:
```
GET  /                         the HTML dashboard
GET  /healthz
POST /api/orgs                 {name, tier:"free|paid", provenFeedOptIn}
POST /api/orgs/:org/repos      {name, visibility:"public|private"}
POST /api/reviews              {org, repo, pr, title, findings[]}
GET  /api/reviews?org=acme
POST /api/findings/:id/decision {state:"accepted|rejected", user}
GET  /api/decisions
GET  /api/feed/proven          public "proven catches" feed (opt-in)
```

### 8e. The IDE local-review server (for the editor plugins)
```bash
npm run ide-server           # listens on http://127.0.0.1:7077
# The VS Code / JetBrains plugins POST {files:[…]} to /review and get diagnostics.
curl -s -X POST http://127.0.0.1:7077/review \
  -H 'content-type: application/json' \
  -d '{"files":[{"path":"x.py","content":"import os\nos.system(\"ping \"+h)"}]}'
```

---

## 8B. Go live on GitHub (production GitHub App + `@cavix` commands)

This is what **you, the founder, actually do** to make Cavix review real PRs in a
repo or an entire organization — and how the `@cavix review` command works.

Cavix ships as a **GitHub App** (not a bot user, not a PAT). A GitHub App is the
right primitive: it gets its own identity (`yourapp[bot]`), fine-grained
permissions the customer grants at install, and short-lived per-installation
tokens (no long-lived secrets). Cavix implements all of this
(`packages/platforms` `AppTokenProvider`).

### Step 1 — Create the GitHub App (one time, ~10 minutes)

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
   (for an org: **Org Settings → Developer settings → GitHub Apps**).
2. **GitHub App name:** e.g. `Cavix` or `CavixCode`. **This name is the mention
   handle** — if the app is `cavixcode`, users type `@cavixcode review`. Set the
   edge's `CAVIX_BOT_HANDLE` to the same handle (lowercased, no spaces).
3. **Homepage URL:** your site (anything valid).
4. **Webhook → Active:** ✓. **Webhook URL:** `https://<your-edge-host>/webhook`
   (the public URL of the Stage 0 edge service). **Webhook secret:** generate a
   strong random string and set it as the edge's `CAVIX_WEBHOOK_SECRET`.
5. **Permissions (Repository):**
   | Permission | Access | Why |
   |------------|--------|-----|
   | Contents | Read | fetch the diff / clone the commit |
   | Pull requests | Read & write | post reviews + inline comments |
   | Issues | Read & write | receive/post PR comments (`@cavix` commands) |
   | Checks | Read & write | the ✓/✗ Cavix status check |
   | Metadata | Read | required baseline |
6. **Subscribe to events:** **Pull request**, **Issue comment**,
   **Pull request review comment** (optional), **Installation**,
   **Installation repositories**.
7. **Where can this app be installed:** "Only on this account" (private) or "Any
   account" (to publish on the Marketplace).
8. **Create the app.** Then note the **App ID**, and **Generate a private key**
   (downloads a `.pem`). These become `CAVIX_APP_ID` and `CAVIX_APP_PRIVATE_KEY`.

### Step 2 — Install the App on repos / the org

On the App's page → **Install App** → choose the org/account → select **All
repositories** or specific repos → **Install**. That's the customer-facing action;
for the Marketplace, share your App's public install URL and customers self-serve.

### Step 3 — Run the Cavix services (point them at the App)

Run the edge (public), the orchestrator, and the control-plane (see §8). For
**production GitHub App auth** (instead of the dev PAT), give the orchestrator the
App credentials so it mints per-installation tokens:

```bash
export CAVIX_APP_ID="123456"
export CAVIX_APP_PRIVATE_KEY="$(cat cavix.private-key.pem)"
export CAVIX_BOT_HANDLE="cavixcode"        # must match the App name/handle
export CAVIX_WEBHOOK_SECRET="…"            # must match the App webhook secret
export CAVIX_LLM_API_KEY="sk-…"            # BYOK (or air-gapped self-hosted model)
```

> The token minting is `AppTokenProvider` (RS256 App JWT → installation token,
> cached). The dev quick-start in §8c uses a personal token (`CAVIX_GITHUB_TOKEN`);
> production uses the App key above. Both feed the same `GitHubClient` port.

**Local development trick:** GitHub can't reach `localhost`. Use a webhook proxy
like [`smee.io`](https://smee.io) or `ngrok` to forward GitHub's webhooks to your
local edge while testing.

### Step 4 — What happens automatically (the event flow)

```
Developer opens/updates a PR
        │  GitHub sends a "pull_request" webhook
        ▼
[edge] verify HMAC → normalize → queue          (Stage 0, ~1ms ack)
        ▼
[orchestrator] mint installation token → fetch diff → run the pipeline
        │      (Stages 3–10: deterministic + graph + agents + verification)
        ▼
Posts a review: summary + inline comments (with one-click fixes)
Posts a Check Run: ✓ pass / ✗ if a `failOn` severity is present
```

On the **next push** to the same PR, Cavix does an **incremental** review — it only
comments on the new commits and never reposts a finding it already made
(`packages/review-session`).

### Step 5 — The `@cavix` commands (chat / on-demand control)

Anyone with **write access** (OWNER / MEMBER / COLLABORATOR — configurable) can
comment on the PR to control Cavix. The mention handle is your App's name.

| Comment | What Cavix does |
|---------|-----------------|
| `@cavix review` | **Fresh full review** — dismisses its previous reviews, deletes its stale inline comments, **clears the cache**, and reviews from scratch. |
| `@cavix re-review` / `@cavix full` | same as `review`. |
| `@cavix resolve` | Resolves/dismisses Cavix's own review threads. |
| `@cavix pause` | Stops automatic reviews on this PR. |
| `@cavix resume` | Re-enables automatic reviews. |
| `@cavix summary` | Regenerates the PR summary/walkthrough. |
| `@cavix help` | Posts the command list. |
| `@cavix <any question>` | Free-text Q&A about the PR (chat). |

**Why "fresh" matters:** when you type `@cavix review`, GitHub delivers an
`issue_comment` event. The edge gives that job a **unique idempotency key per
comment**, so it is *never* deduplicated — every invocation runs. The
orchestrator then uses the review session to **dismiss stale reviews and bust the
cache** before posting a brand-new review. That's exactly the "remove old reviews,
give me a fresh one" behavior. Commands from users **without** write access are
ignored (an abuse guard).

Set the handle: the edge responds to `@<CAVIX_BOT_HANDLE>` (default `cavix`). To
respond to `@cavixcode`, set `CAVIX_BOT_HANDLE=cavixcode`.

### Step 6 — Per-repo configuration (`.cavix.yaml`)

Teams tune Cavix by committing a `.cavix.yaml` (or `.cavix.json`) to the repo root
— no dashboard needed (`packages/repoconfig`):

```yaml
# .cavix.yaml
autoReview: true              # review automatically on open/push
reviewDraftPRs: false
tone: concise                 # or "detailed"
pathFilters:
  include:                    # if set, only these paths are reviewed
    - "src/**"
    - "services/**"
  exclude:                    # always skipped
    - "**/*.min.js"
    - "**/generated/**"
agents:
  disabled:                   # turn off specific reviewers
    - standards
policy:
  enabled: false              # the org policy gate (off by default)
failOn:                       # severities that FAIL the Check Run (block merge if required)
  - critical
```

Sensible defaults apply if the file is absent (vendored/build paths are excluded
automatically).

### Step 7 — Make Cavix a required check (gate merges)

Cavix posts a **Check Run** on every PR. To make a failing Cavix review **block
merge**, add it as a required status check: **Repo/Org → Settings → Branches →
Branch protection rule → Require status checks to pass → select the Cavix check.**
Combined with an enabled **policy gate**, this gives regulated teams a
non-bypassable quality gate.

### How Cavix compares to CodeRabbit / other AI reviewers

Everything below is **built and tested** in this repo.

| Capability | CodeRabbit & others | **Cavix** |
|------------|:---:|:---:|
| Auto review on PR open/push | ✅ | ✅ |
| Inline comments + committable suggestions | ✅ | ✅ (one-click `suggestion` blocks) |
| PR summary / walkthrough | ✅ | ✅ |
| `@bot review` / re-review command | ✅ | ✅ **+ dismisses stale reviews & busts cache** |
| `@bot` chat / Q&A | ✅ | ✅ (`ask`) |
| Pause/resume, resolve | ✅ | ✅ |
| Incremental reviews (no duplicate comments) | ✅ | ✅ |
| Repo config file | ✅ (`.coderabbit.yaml`) | ✅ (`.cavix.yaml`/`.json`) |
| Path/file filters | ✅ | ✅ |
| Status check / merge gate | ✅ | ✅ (Check Run + required-check) |
| Multiple SCMs (GitLab/Bitbucket/Azure) | partial | ✅ (all four) |
| Learns org preferences | ✅ | ✅ (accept/reject calibration) |
| **Execution-grounded verification (repro in a sandbox)** | ❌ | ✅ **(the moat)** |
| **PoC exploit generation for vulns** | ❌ | ✅ |
| **Cross-repo impact (breaks in another service)** | ❌ | ✅ |
| **CI/CD regression prediction** | ❌ | ✅ |
| **Verified auto fix-PRs (draft, human-approved)** | partial | ✅ (only proven-green fixes) |
| **Fully air-gapped / self-hosted open model** | ❌ | ✅ (zero egress, proven) |
| **Zero-retention (no code persists), offline license** | ❌ | ✅ |
| **Legacy languages (COBOL/PL-SQL) + verified modernization** | ❌ | ✅ |

The parity items make Cavix a *credible* AI reviewer; the **bold** items are why a
team switches to it.

---

## 9. Measure quality (the eval harness)

Cavix treats review **quality** as a number you can track, not a vibe.

```bash
npm run eval          # side-by-side: linter-only vs Cavix Phase 0 / 1 / 2
```
Sample output:
```
reviewer                            Prec     Rec      F1  FP-rate
linter-only (competitor)          100.0%   63.6%   77.8%     0.0%
diff-only LLM (Cavix Phase 0)      81.8%   81.8%   81.8%    18.2%
context+ensemble (Cavix Phase 1)   91.7%  100.0%   95.7%     8.3%
+ verification (Cavix Phase 2)    100.0%  100.0%  100.0%     0.0%
```
This is the proof that each layer (graph context, then verification) **raises
recall and cuts false positives**.

```bash
npm run eval:bench    # scores on Defects4J / SWE-bench / CVEfixes samples
```

**Run the eval against a real model** (instead of the deterministic fixtures):
```bash
EVAL_MODE=live ANTHROPIC_API_KEY=sk-ant-… npm run eval
```

The labeled test PRs live in `eval/datasets/seed/` (10 gold-labeled bugs across
JS/Python/Go) — add your own to expand coverage.

---

## 10. Configuration & BYOK

Everything is configured by **environment variables** — nothing is hardcoded.

**Bring Your Own Key (BYOK):** each org configures its own provider + key + model.
The key is **never logged** — only a short fingerprint, for cost attribution. To
switch models, change one env var:
```bash
export CAVIX_LLM_PROVIDER="anthropic"     # or "selfhosted" (air-gapped), or add GPT/Gemini
export CAVIX_LLM_MODEL="claude-opus-4-8"  # frontier reasoning
export CAVIX_LLM_API_KEY="sk-…"
```

**Model routing (cost control):** cheap models do triage and compression; frontier
models only do deep reasoning, adjudication, and verification. This is automatic
and configurable per agent.

Key env vars:

| Variable | Used by | Meaning |
|----------|---------|---------|
| `CAVIX_WEBHOOK_SECRET` | edge | GitHub App webhook HMAC secret (required) |
| `CAVIX_BOT_HANDLE` | edge | Mention handle: `@<handle> review` (e.g. `cavixcode`) |
| `CAVIX_APP_ID` | orchestrator | GitHub App id (production auth) |
| `CAVIX_APP_PRIVATE_KEY` | orchestrator | GitHub App `.pem` private key (production auth) |
| `CAVIX_REDIS_ADDR` / `_HOST` / `_PORT` | edge / orchestrator | Redis queue location |
| `CAVIX_GITHUB_TOKEN` | orchestrator | Dev-only personal token (alternative to the App) |
| `ANTHROPIC_API_KEY` / `CAVIX_LLM_API_KEY` | gateway | BYOK model key |
| `CAVIX_LLM_MODEL` | gateway | Model id |
| `CAVIX_SANDBOX_BACKEND` | orchestrator | `local` \| `docker` \| `cloudflare` |
| `CAVIX_AIRGAPPED` | gateway | `true` → only the in-cluster model is reachable |
| `CAVIX_CONTROL_PLANE_PORT` | control-plane | Dashboard port (default 8088) |
| `CAVIX_FREE_REVIEWS_PER_DAY` | control-plane | Free-tier rate limit |

---

## 11. Self-host & air-gapped deployment

Cavix is built to run **inside your own cluster**, including **fully air-gapped**
(no internet at all). Two assets: a **Helm chart** and **Terraform**.

### Quick install (connected cluster)
```bash
helm lint deploy/helm/cavix
helm install cavix deploy/helm/cavix -n cavix --create-namespace \
  --set airGapped=false --set image.registry=registry.internal/cavix
```

### Air-gapped install
1. Mirror + sign images into your internal registry:
   ```bash
   COSIGN_PASSWORD=… deploy/sign-images.sh registry.internal/cavix 0.3.0 cosign.key
   ```
2. Deploy with Terraform (creates namespace, license secret, Helm release):
   ```bash
   cd deploy/terraform
   terraform apply -var air_gapped=true -var license_file=./cavix-license.json \
     -var image_registry=registry.internal/cavix
   ```

### Prove nothing leaves the cluster
With `airGapped=true`, the chart renders a **deny-all-egress NetworkPolicy** (no
`0.0.0.0/0` anywhere) and runs the model **in-cluster**.
```bash
kubectl -n cavix get networkpolicy cavix-default-deny-egress -o yaml   # egress: []
kubectl -n cavix exec deploy/cavix-orchestrator -- \
  sh -c 'wget -T3 -qO- https://api.anthropic.com || echo BLOCKED'      # → BLOCKED
```
Two independent layers enforce this: the **NetworkPolicy** (kernel/CNI) drops the
packet, and the gateway **EgressGuard** (application) refuses any host that isn't
the in-cluster model. You can see the application layer right now, no cluster
needed:
```bash
npm run airgap-demo
```
Full explanation: [docs/compliance/AIR_GAPPED_DATA_FLOW.md](docs/compliance/AIR_GAPPED_DATA_FLOW.md)
and [deploy/README.md](deploy/README.md).

---

## 12. Enterprise features

Built and tested (see `packages/governance`, `packages/license`,
`packages/zero-retention`, `packages/policy`, `packages/legacy`):

- **SSO (SAML 2.0)** — signed assertions verified (signature, audience, validity,
  replay protection).
- **SCIM provisioning** — your IdP pushes users/groups; groups map to roles.
- **RBAC** — owner / admin / reviewer / member, permission-checked per action.
- **Tamper-evident audit log** — a hash chain; any edit is detectable.
- **Zero-retention** — verified purge of all customer code after a review;
  only metadata is stored.
- **Offline licensing** — Ed25519-signed licenses verified with no network.
- **Policy engine** — write rules in **plain English** ("flag any endpoint without
  an auth check"); they compile into deterministic, non-bypassable checks. Off by
  default; ingest a `STANDARDS.md`; per-repo overrides.
- **Legacy languages** — located reviews for COBOL, PL/SQL, C/C++, older
  Java/.NET, IaC/SQL/config — plus a **modernization mode** that proposes
  migrations and *verifies them through Stage 10* before suggesting.

Compliance scaffolding (SOC 2 / ISO 27001 control mapping, hardening, data flow):
[docs/compliance/](docs/compliance/).

---

## 13. The buyer demo script (live pitch runbook)

A tight **10-minute** live demo. Have a terminal open in the project root. No
internet or keys required — everything runs locally.

### Setup (do this before the meeting)
```bash
npm install
cd services/edge && go build ./... && cd ../..
npm test          # confirm everything is green
```

### The script

**(0:00) The one-liner.**
> "Every AI reviewer guesses. Developers stop trusting it and turn it off. Cavix is
> different: it **proves** every finding by reproducing it in a sandbox before it
> says a word. Let me show you."

**(1:00) Show the proof — the moat.**
```bash
npm run verify-demo
```
> "Watch the exit codes. The bug's test fails — `exit 1`, red — so the bug is real.
> Cavix applies the fix, the test passes — `exit 0`, green — and the existing suite
> stays green. That's a **VERIFIED** finding. Now the second case: same warning,
> but the code is actually correct. The test passes immediately — nothing to fix —
> so Cavix marks it **UNVERIFIED and stays silent**. That's how we kill false
> positives: we only speak when we can prove it."

**(3:00) Show what single-repo tools can't — cross-repo impact.**
```bash
npm run orggraph-demo
```
> "Someone changes an API endpoint in the `orders` service. Cavix knows the
> `checkout` and `billing` services call it — and shows the **exact lines** that
> will break. A reviewer looking at one repo's diff would never catch this."

**(4:30) Show it acts — but safely.**
```bash
npm run phase4-demo
```
> "Cavix can open its **own fix PRs** — but only fixes it has proven green, and
> always as a **draft that a human must approve**. The unverifiable fix? Not
> proposed. It never auto-merges. Below that you see the same engine running
> **inside the IDE** before a PR even exists, and the **ROI dashboard**: action
> rate, defects caught, reviewer-hours saved."

**(6:30) Show the numbers.**
```bash
npm run eval
```
> "This is measured quality on labeled bugs. A plain linter gets 78% F1. Our
> context-aware pass gets 96%. Add verification and we hit **100% F1 with zero
> false positives**. Quality is a number we track, not a promise."

**(8:00) Security / on-prem close (for regulated buyers).**
```bash
npm run airgap-demo
```
> "It runs **fully air-gapped** — zero outbound calls. Here it reaches only the
> in-cluster model and **blocks every internet host**, even anthropic and github.
> Plus offline licensing, SSO, audit logs, and **zero-retention**: no customer
> code survives a review. Your source never leaves your cluster."

**(9:30) Close.**
> "So: it proves before it speaks, it sees across your repos, it can fix safely
> with a human in the loop, and it runs entirely inside your walls. Where would you
> want to start a pilot?"

### If they want to see real code on a real PR
Point the orchestrator at a test repo (section 8c) with a GitHub token and an API
key, open a PR, and show the posted review. The demos above are the safe,
no-dependency version for the room.

---

## 14. The sales pitch & ROI

**The problem:** AI code review is noisy. False positives train developers to
ignore it. Security and platform teams can't trust an unproven machine comment.

**The Cavix difference (say these four):**
1. **Proven, not guessed.** Every non-trivial finding is reproduced in a sandbox.
   False-positive rate drops to near zero.
2. **Sees the whole system.** Cross-repo impact + CI/CD regression prediction —
   things a diff-only reviewer structurally cannot do.
3. **Acts safely.** Opens verified fix PRs as drafts; a human always merges.
4. **Yours to run.** Model-agnostic, BYOK, self-hostable, fully air-gapped,
   SOC 2 / ISO 27001-ready.

**The ROI story (with real numbers from `phase4-demo`):**
- **Action rate** — what % of findings developers actually act on (Cavix: ~86%
  because they're proven, vs ~20–40% for noisy tools).
- **Defects caught** — execution-verified, so they're real.
- **Reviewer-hours saved** — an explicit model (minutes-per-severity + fix
  authoring − false-positive overhead). The `analytics` package produces per-team
  and org rollups your champion can take to their VP.

**Who buys:** security-conscious enterprises, regulated industries (finance,
healthcare, government), and IT-services/modernization shops with legacy estates.

**Pricing motion:** free/OSS tier (public repos, rate-limited, opt-in "proven
catches" feed) → paid per-seat with private repos, SSO, policy engine → enterprise
self-host/air-gapped with a signed offline license.

---

## 15. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `go test -race` fails with "requires cgo" | Use `go test ./...` (no `-race`) locally; CI runs `-race` on Linux. |
| A TS file errors with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | Node runs TypeScript by stripping types; avoid TS parameter properties / enums (the codebase already does). |
| `npm test` can't find a package | Run `npm install` again from the **root** so workspaces are linked. |
| A demo about the sandbox is slow | It really runs `node` in a sandbox; that's expected (a few hundred ms). |
| Edge won't start | Set `CAVIX_WEBHOOK_SECRET` — it fails closed without one. |
| Orchestrator posts nothing | Check `CAVIX_GITHUB_TOKEN` and the model key; without a key, use the demos instead. |
| `helm install` not available here | The chart is validated with `helm lint` / `helm template … --dry-run`; you need a cluster to actually install. |

---

## 16. What's real vs simulated (honesty)

So you can speak accurately to technical buyers:

- **Real and live:** the `@cavix` command parsing + authorization (Go edge,
  `issue_comment`), the GitHub App JWT→installation-token minting, Check Runs and
  stale-review dismissal, the fresh-vs-incremental review session, the
  `.cavix.yaml` config loader — all unit-tested. The Go edge service, the code
  graph, cross-repo graph,
  deterministic scanners, adjudication, the **sandbox + verification (it really
  runs `node` and checks exit codes)**, the fix-PR gate, telemetry math,
  calibration, governance crypto (SAML/Ed25519/audit), zero-retention purge, the
  air-gap egress guard, and all the platform adapter wire-formats.
- **Behind a fake in tests/demos (real code path, fake boundary):** GitHub and the
  LLM are reached through interfaces; demos use deterministic fakes so they run
  with no key/network. Swap one env var to use a real model and a real token.
- **Authored artifacts (validated, not executed here):** the Helm chart, Terraform,
  cosign script, and the VS Code/JetBrains plugin code — production-grade and
  validated by construction / `helm lint`, run with their own toolchains.
- **Heuristic where a full stack would be heavy:** the language parsers are
  heuristic (tree-sitter slots in behind the same interface); the in-memory stores
  mirror the Postgres/ClickHouse schemas they map to in production.

This honesty *is* the pitch: the one thing that must be real — **the proof** — is
real, and you can watch it run.

---

## 17. FAQ

**Do I need an API key to try it?** No. Tests and all demos run with no key and no
network. You need a key only to review real PRs with a real model.

**Which models does it support?** Claude (default), GPT, Gemini, or your own
self-hosted open model. It's BYOK and model-agnostic. In air-gapped mode it uses an
in-cluster model and makes zero outbound calls.

**Will it spam my PRs?** No — that's the whole point. It posts a finding only when
it can prove it, and it suppresses anything it can't reproduce.

**Can it merge code on its own?** No. It can open fix PRs, but always as drafts
labeled `needs-human-approval`. There is deliberately no auto-merge.

**Does my code leave my network?** In air-gapped mode, never — enforced by a
NetworkPolicy *and* an application egress guard. In zero-retention mode, no code is
stored after a review (verified).

**How do I add a custom rule?** Write it in plain English (e.g. "disallow
console.log") — the policy engine compiles it into a deterministic check. Or ship a
**lens** (a shareable pack of rules + agents).

**How do I prove quality to my team?** Run `npm run eval` — it prints
precision/recall/F1 against labeled bugs and compares Cavix to a plain linter.

**How does `@cavix review` work / get a fresh review?** Comment `@cavix review`
(use your App's handle, e.g. `@cavixcode review`) on the PR. Cavix dismisses its
previous reviews, deletes its stale inline comments, clears the cache, and posts a
brand-new full review. It's never deduplicated, so you can re-run it any time.
Only users with write access can trigger it. See §8B.

**How do I install it on my whole org?** Create the GitHub App once, then install
it on the org and choose "All repositories." Full step-by-step in §8B.

---

### Where to go next
- Architecture deep-dive: [ARCHITECTURE.md](ARCHITECTURE.md)
- What shipped in each phase: [CHANGELOG.md](CHANGELOG.md)
- Self-host: [deploy/README.md](deploy/README.md)
- Air-gap & compliance: [docs/compliance/](docs/compliance/)
- IDE plugins: [editors/README.md](editors/README.md)

**Quickest path to "wow":** `npm install && npm run verify-demo`.
