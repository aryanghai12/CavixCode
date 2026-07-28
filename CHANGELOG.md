# Changelog

All notable changes to Cavix are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). Dates are ISO-8601.

## [Unreleased]

### Stage 5 live: cross-repo impact on a real pull request

`packages/orggraph` was written, tested and imported by nothing. It now runs, in
two halves with different timing.

#### Added
- **The query.** Before a review is posted, a changed public interface is traced
  to its consumers in OTHER repositories, and each becomes one finding naming the
  repositories and the exact call sites. This is the finding no single-repo
  reviewer can produce: a change to `DELETE /orders/{id}` reads as a clean,
  well-tested diff inside the orders service, and the only thing wrong with it
  lives in a repository nobody in the pull request has open.
- **The indexer**, which runs AFTER the review is posted and only when this
  repository's slice of the graph has gone stale (12 hours). A tree listing and a
  few dozen file reads do not belong in front of somebody waiting for a review,
  and none of it changes the review that was just posted.
- **`listTree` on the GitHub client**: the repository's whole file list in one
  call, via the git trees API. Stage 5 has to FIND the contract files before it
  can read them, and there was no way to do that without cloning.
- **Graph storage in the control-plane** (`/api/internal/orgs/:org/graph`), with
  per-repository index timestamps so refreshes are incremental. The split is
  forced: only the orchestrator holds GitHub App installation tokens, which are
  the one credential that reads a private repository without borrowing a human's
  OAuth token, and only the control-plane has Postgres and knows which
  repositories a workspace connected. A graph naming a repository the workspace
  never connected is rejected.
- `CAVIX_CROSS_REPO=off` turns the whole stage off. It fails soft either way: a
  broken trace costs the cross-repo section, never the review.
- The Scope module's `Blast Radius` row now renders, from real call-site counts.

#### Fixed
Four bugs in `packages/orggraph`, all of which would have shipped:

- **A concrete call never matched a templated route.** A provider declares
  `/orders/{id}`, normalized to `/orders/*`; a caller writes `/orders/abc123`.
  Those were compared as strings, so they never matched, and that is the single
  most common shape in any real organisation. Paths are now compared segment by
  segment, aligned on their tails, with a variable on either side matching
  anything. A route made entirely of variables matches nothing rather than
  everything.
- **Removing an operation did not count as changing the path that owns it.**
  Deleting an endpoint from an OpenAPI document removes the `"delete": {}` line
  while `"/orders/{id}":` sits above it as unchanged context, so reading only
  changed lines saw a method with no path and concluded nothing had changed. The
  enclosing path is now tracked across context lines.
- **Generic method names manufactured consumers.** `redisClient.get(key)` and
  `dbClient.get(id)` were reported as callers of `orders.OrderService/Get`, so
  changing one RPC would have told three unrelated teams their code was about to
  break. That is precisely the noise this product exists to be incapable of. A
  gRPC match now requires the receiver to name the service, unless the method
  name is distinctive enough to stand alone.
- **One row per call site.** A monorepo importing one package from four hundred
  files produced four hundred identical edges, all held, persisted and shipped to
  every review. References now dedupe by what they are, keeping the first eight
  locations.

Also added: `toJSON`/`fromJSON` so a graph outlives the process that built it,
and `fromJSON` returns an empty graph for anything it does not recognise rather
than throwing.

#### Fixed elsewhere
- **`mutes` was missing from the store snapshot**, so every mute event was lost
  on restart. Added, along with the graph, and `restore` now resets both rather
  than leaving the previous process's data beside freshly loaded orgs.
- **A temporal dead zone crash in the control-plane router.** A new route used
  the shared `mm` match variable above its `let`, which threw on every request
  that reached it and 500'd every route below. Caught by the existing suite.

### Dashboard analytics, and the churn signals nobody was recording

#### Added
- **`@cavix/analytics` is wired into the control-plane.** The Reports page's ROI
  numbers now come from the package's explicit minutes-per-severity model rather
  than a second one hand-written in the store, so the dashboard and anything
  built on the package quote the same hours for the same month.
- **Mute tracking (`MuteEvent`).** A repository toggled off, or a pull request
  paused, is recorded and surfaced at the top of Reports. The roadmap calls this
  "your single most important leading indicator of churn" and nothing was
  capturing it.
- **Action-rate trend**, first half of the window against the second, in
  percentage points. A single action rate says how a team feels about Cavix; the
  direction says whether they are leaving. Returns 0 when either half decided
  nothing, so a quiet fortnight does not fire the alarm.
- **Cost, model, duration, verified and suppressed counts** on every recorded
  review. The workflow has had all of them since Phase 0 and threw them away at
  the recorder boundary, so the dashboard could report what Cavix found and never
  what finding it cost. Cost per review is computed over the reviews that
  actually reported one: "not measured" is not "free".
- **`GET /api/orgs/:org/analytics`** with daily series, per-repository rollup,
  ROI and mute log. `days` is clamped to 7..90.
- **`public/charts.js`**: dependency-free inline SVG (the site ships static with
  a strict CSP, so a CDN chart library is not an option). Series colours were
  validated against the dark card surface rather than chosen by eye.

#### Changed
- Severity is rendered as a labelled meter list, not a five-colour chart.
  critical/high/medium/low/info forces red, orange and yellow adjacent, and that
  trio cannot clear the normal-vision separation floor at any stepping (worst
  adjacent pair ΔE ~13 against a floor of 15). Name, geometric mark and count
  carry identity; length carries magnitude. That is the correct form for an
  ordered scale regardless.
- **The Learnings page showed a column of hashes.** `listDecisions` now carries
  the finding's title, path, severity, category, repo and verified flag, and the
  page leads with the categories a team keeps rejecting, which is the one thing
  on it that changes what Cavix does next.

#### Fixed
- **Tier limits and suspension were enforced after the money was spent.** The
  daily allowance and the suspended flag were checked only when a finished review
  was recorded, which is after the diff was fetched, the models were called and
  the comment was already on the pull request. A suspended workspace kept getting
  full reviews and simply stopped appearing on its own dashboard: the customer
  sees Cavix working and sees nothing to show for it, and the tokens are spent
  either way. Both are now decided at `/api/internal/repos/enabled`, before
  anything is spent, and the gate returns a `reason` so a command job says
  "this workspace is suspended" instead of "turn the repo on" for a repo whose
  toggle is already green.
- **The deep review path silently degraded on any pull request touching more
  than 12 files**, which is most real pull requests: it threw, and the workflow
  fell all the way back to a single model over the raw diff. It now indexes the
  files it can read and runs anyway (the agents read the DIFF, so they lose
  nothing), and reports `fullyScanned` so the Scope module withholds the
  Deterministic Pass row rather than claiming coverage it did not have.

### Stages 3 to 9 now run on real pull requests

#### Added
- **`makeDeepReviewStep`** wires `packages/pipeline` into `runReview`: the
  deterministic scanners (Stage 3), a call graph over the changed files (Stage
  4), context assembly and compression (Stage 7), seven specialist agents in
  parallel (Stage 8) and adjudication over all of it (Stage 9). Until now the
  live service reviewed every pull request with one model and one prompt over
  the raw diff, while the pipeline that does all of the above ran nowhere but its
  own tests. The eval harness has scored the two side by side the whole time:
  81.8% F1 and an 18.2% false-positive rate for the single pass, 95.7% and 8.3%
  for the pipeline.
- **`Reviewer.summarise`**, a cheap pass that produces only the summary,
  walkthrough and effort. The ensemble finds defects; nobody was left writing the
  prose the description needs, and running a second full review for it would have
  paid twice to find the same things.
- Fails soft, deliberately. The deep path reads files through the API and fans
  out to seven models; any error there falls back to the single-model pass rather
  than costing somebody their review. `CAVIX_DEEP_REVIEW=off` makes that fallback
  permanent and roughly halves the model spend per review.
- The Scope module's `AST Verification`, `Deterministic Pass` and `Ensemble` rows
  now render, fed by real counts from the stages that ran. They were built for
  this and had been dark since the module shipped.

#### Fixed
- **`runDeterministic` under-reported `toolsRun`.** The two always-on in-process
  scanners were excluded, so a deployment without semgrep installed reported that
  zero tools had scanned the change. `Phase1Result` now carries `toolsRun` and
  `toolsSkipped` through, so a caller stating "N tools ran" is stating what
  executed rather than counting findings.

### Command handling and four dead settings

#### Fixed
- **Every `@cavix` command ran a full, billable review.** The Go edge recognises
  eight commands and enqueues all of them; the orchestrator never read
  `job.command`. Typing `@cavixcode help` made a frontier-model call, ran the
  sandbox and posted a review comment, and `@cavixcode pause` started a review
  instead of stopping one. New `workflow/commands.ts` dispatches: `review` and
  `summary` reach a model, `ask` gets its own cheap prose path, and `resolve`,
  `pause`, `resume`, `configure` and `help` are repository operations that cost
  nothing.
- **`force_fresh` was never read**, so `@cavix review` stacked a new review on
  top of every earlier one. A fresh review now deletes Cavix's own inline
  comments and dismisses a stale blocking review first. Reviews are found by a
  hidden `REVIEW_MARKER` in the body rather than by bot login, which differs per
  deployment. GitHub does not permit deleting or dismissing a plain COMMENTED
  review, by anyone, so that limitation is documented rather than papered over.
- **`pathFilters` did nothing.** Stored, served to the orchestrator, ignored. Now
  applied to the diff *before* the model sees it, so an excluded directory is
  neither billed for nor disclosed to the provider. A pull request with nothing
  left after filtering closes the check as "Nothing to review" instead of posting
  an empty one.
- **`tone` did nothing.** It reached the settings page and the preview and never
  the model. Five voices now append a rule to the system prompt. None of them can
  change what is reported or how severe it is: tone is a voice control, not a
  leniency dial.
- **`autoReview` and `reviewDraftPRs` did nothing.** Both now suppress automatic
  triggers only. An explicit `@cavixcode review` overrides both, and a pause,
  because a human asking by name is the clearest signal there is.
- Pause state lives in a hidden marker on Cavix's own PR comment, not in worker
  memory: the orchestrator restarts and scales horizontally, so memory is the one
  place the setting could not survive.

#### Changed
- `OrgReviewConfig` carries `autoReview`, `reviewDraftPRs`, `tone` and
  `pathFilters`. Missing fields take the safe default, never `undefined`-as-false,
  so an older control-plane cannot silently stop reviews for everyone.
- README's stage table is now two columns, **Built** and **Live on a real PR**.
  They were not the same thing, and one table saying "Built" for both was the
  first dishonest claim in a product whose pitch is that it does not make those.
  Stage 11 said "5 platforms"; only GitHub is reachable from the running service.

### Cavix in the Checks box

#### Added
- **A `Cavix Review` check run on every pull request**, the way CodeRabbit and
  the other AI reviewers appear. It opens `in_progress` the moment the job is
  picked up, before the model is called, so a reviewer sees Cavix working rather
  than nothing at all. It closes `completed` when the review is posted, with the
  Review Scope table as its expanded output and a `details_url` pointing at the
  review. `createCheckRun` / `updateCheckRun` added to the orchestrator's
  `GitHubClient` port, with a REST implementation and a recording fake.
- **`ReviewCheck`**, a small lifecycle object in the workflow. The handler owns
  one per job and hands it to every attempt, so a self-heal that re-runs the
  review against a different model moves the existing row instead of opening a
  second one. Previously there was no row at all; naively adding one per attempt
  would have left three Cavix checks on a healed PR, two spinning until GitHub
  timed them out.
- Conclusions: `success` when the review posts and nothing the owner asked to
  block on failed, `failure` only when they turned blocking on and a nominated
  rule or severity failed, and **`neutral` when Cavix could not finish**. GitHub
  counts neutral as passing for a required check, which is the point: an expired
  API key must not silently block every merge in the org.
- Whole path is best-effort. A 403 (personal access token, or an install without
  `checks: write`), a 404, a 422 on a fork head SHA, or an exception all leave
  `checkRunId` at 0 and cost the status row only, never the review. New
  `checkRun.test.ts` covers the lifecycle, the conclusions, and every one of
  those degradations.
- GUIDE §Step 7 now names the check, documents the conclusion table, and explains
  why a missing row means the App lacks `Checks: Read & write`.

### Review output redesign

The posted review is the product demo, so it was rebuilt to read like a document
a staff engineer would forward rather than a bot comment.

#### Changed
- **The PR description carries no findings at all.** No verdict callout, no
  finding counts, no severities, not even a severity mark beside a file in the
  walkthrough. What a change does stays true until merge; what is wrong with it
  stops being true the moment the author pushes a fix, and nobody but Cavix can
  edit that block to correct it. The description block is now the executive
  summary plus the per-file walkthrough and nothing else, under its own heading
  (`## ◈ Cavix Summary`). The verdict, the Scope module and every finding live on
  the review comment, which is dated, supersedable, and marked outdated by GitHub
  once the lines move. `renderSummarySection` split into `renderNarrative` (the
  durable half) and the comment's own head.
- **No emoji anywhere in posted output.** The severity scale is geometric now
  (`◆` critical, `◈` high, `◇` medium, `▪` low, `▫` info), `⬢` marks anything
  proven by execution, `▲` marks attention, and `✓`/`✕` are the policy check
  states. A test scans every posted surface and fails the build if one emoji
  gets through.
- **New `Review Scope & Effort` module opens the review comment.** Deep Scan,
  Symbol Scope, Security Gate, Execution Proof, Policy Gate, Confidence Score
  and Review Effort, each a measurement. Rows with no data behind them are
  omitted rather than filled in, so nothing in the module is invented. Optional
  `ScopeSignals` on `PosterOptions` lets earlier pipeline stages contribute an
  AST Verification, Deterministic Pass, Ensemble or Blast Radius row.
- **No git stats in the review.** Files changed, lines added and lines removed
  are rendered by GitHub directly above the comment, so the size table and the
  per-file line columns are gone. Line counts are still computed internally, but
  only to estimate review effort when the model does not supply one.
- **Colour comes from GitHub-native rendering.** Findings are introduced by alert
  callouts coloured by severity (`CAUTION`, `WARNING`, `IMPORTANT`, `NOTE`),
  provenance is a row of `<kbd>` chips, and suggested fixes off the diff get a
  real language fence for syntax highlighting.
- **New "Fix these first" callout** above the findings tables, naming only the
  findings at high severity or above, capped at five.
- **The walkthrough is bullets, not a table**, and leads with what each file now
  does rather than how many lines moved.
- Dashboard sample-review preview and the landing page sample were updated to
  match, so neither has drifted from what actually gets posted.

#### Added
- **Bounded shields.io badge strip** above the Scope table, in muted hex
  (crimson, burnt amber, amber gold, slate, emerald). At most five per review,
  never one per finding. `CAVIX_REVIEW_BADGES=off` turns it off for air-gapped
  GitHub Enterprise, where the image proxy cannot reach shields.io; the same
  facts stay in the table underneath.
- Review prompt now specifies the summary as a 2 to 4 sentence executive summary
  written in architectural intent, and bans emoji in every model-written field.

### Phase 5 — production GitHub App + `@cavix` commands + competitor parity

#### Added
- **`@cavix` command handling (edge, Go)**: `issue_comment` webhooks are parsed
  for `@<handle> <command>` (review/re-review/resolve/pause/resume/help/summary/
  ask). Commands carry a unique per-comment idempotency key so they are **never
  deduplicated** (fresh every time); only OWNER/MEMBER/COLLABORATOR may trigger.
  Handle configurable via `CAVIX_BOT_HANDLE`.
- **GitHub App auth (`packages/platforms`)**: `AppTokenProvider` mints an RS256
  App JWT → per-installation access token (cached), plus **Check Runs**
  (create/update) and **review management** (list/dismiss own reviews, delete
  stale comments).
- **Review session (`packages/review-session`)**: fresh vs incremental planning;
  `@cavix review` dismisses stale reviews + deletes stale comments + **busts the
  cache** for a full re-review; incremental never reposts a finding.
- **Repo config (`packages/repoconfig`)**: `.cavix.yaml`/`.cavix.json` with auto-
  review toggle, path filters (globs), disabled agents, policy toggle, tone, and
  `failOn` severities — dependency-free YAML-subset parser.

#### Verified (acceptance gate)
- `@cavix review` on a PR triggers a fresh review that removes stale reviews/cache
  (edge command tests + review-session tests).
- Production install flow documented end-to-end (GitHub App create → install → run
  → event flow → commands → config → required check) in GUIDE §8B, with a
  CodeRabbit competitor-parity table.
- Full suite green: 190 TypeScript tests + the Go edge suite.

### Phase 4 — trusted automated engineer (fix-PRs, IDE, batch, lenses, ROI)

#### Added
- **Verified fix-PR agent (`packages/fixpr`)**: opens its own fix PRs, but ONLY
  when Stage 10 proves the fix (repro fails before, passes after, suite stays
  green). Always a DRAFT labeled `needs-human-approval`; Cavix never auto-merges.
- **IDE local review (`packages/ide`)** + VS Code/JetBrains plugin manifests:
  pre-PR review with the SAME engine (deterministic + legacy + optional ensemble),
  offline by default, served to editors over a localhost server.
- **Batch modernization (`packages/batch`)**: migration at scale where EACH change
  is independently gated through Stage 10; unverified migrations are excluded.
- **Review lenses (`packages/lenses`)**: a marketplace substrate — installable
  packs of English/policy rules + extra agents + a bundled per-org confidence
  model; validated and composed into the pipeline.
- **ROI analytics (`packages/analytics`)**: per-team action rate, defects caught
  (verified), and reviewer-hours saved via an explicit, tunable model.

#### Verified (acceptance gate)
- The fix-PR agent opens a draft PR whose fix is verified green; an unverifiable
  fix is NOT proposed (`npm run phase4-demo`; fixpr tests with a real sandbox).
- The IDE plugin returns a useful local review before a PR is opened (ide tests).
- ROI analytics produce reviewer-hours-saved and action-rate numbers (analytics
  tests + demo: 86% action rate, 6 defects caught, ~6 hours saved).
- Every autonomous action stays verification-gated and human-approvable.

### Phase 3 — enterprise deployability (self-host, air-gap, governance, legacy, compliance)

#### Added
- **Air-gapped mode (`packages/gateway`)**: `SelfHostedProvider` (OpenAI-compatible
  in-cluster model) + `EgressGuard` (allowlist; all other hosts throw) +
  `createAirgappedGateway`. Zero outbound calls; proven by tests + the air-gap demo.
- **Governance (`packages/governance`)**: SAML 2.0 assertion verification, SCIM 2.0
  provisioning → RBAC roles, and a tamper-evident hash-chained audit log.
- **Policy graduation (`packages/policy`)**: English-rule compiler → deterministic
  immutable checks, STANDARDS.md ingestion, per-repo overrides (still off by default).
- **Legacy languages (`packages/legacy`)**: located COBOL/PL-SQL/C-C++/Java/.NET/IaC
  analysis + a modernization mode that verifies migrations through Stage 10.
- **Zero-retention (`packages/zero-retention`)**: ephemeral review lifecycle with a
  verified purge + metadata-only persistence.
- **Offline licensing (`packages/license`)**: Ed25519-signed licenses verified
  offline (air-gap safe); seat + feature entitlements.
- **Self-host infra (`deploy/`)**: Helm chart with a deny-all-egress NetworkPolicy
  and hardened pods, Terraform, and cosign image signing.
- **Compliance (`docs/compliance/`)**: air-gapped data-flow proof, security
  hardening, SOC 2 / ISO 27001 control mapping.

#### Verified (acceptance gate)
- Air-gapped mode makes zero outbound calls: `npm run airgap-demo` reaches only the
  in-cluster model; anthropic/openai/github are blocked (NetworkPolicy + EgressGuard).
- SSO (SAML), SCIM provisioning, RBAC, and a tamper-evident audit trail all function.
- A custom English policy rule is enforced on a test repo (off by default).
- COBOL and PL/SQL PRs get meaningful, located reviews (named paragraphs/procedures).
- Zero-retention: customer code present during a review is gone after, verified.
- `helm lint`/`helm template … | kubectl apply --dry-run` validate the chart; a
  deny-all-egress NetworkPolicy with no `0.0.0.0/0` is the kernel-layer air-gap proof.

### Phase 2 — differentiators (Stages 10, 5, 6, 12 + platforms + free tier + benchmarks)

#### Added
- **Stage 10 — verifier (`packages/verifier`)**: execution-grounded verification.
  Detects build/test setup, generates a minimal failing test (or a PoC exploit
  for security findings), reproduces in a hardened sandbox (no egress, caps,
  ephemeral), optionally applies the fix and re-runs the suite. Marks
  VERIFIED/UNVERIFIED/INCONCLUSIVE; gate skips facts + trivial nits;
  `verifyAndFilter` surfaces VERIFIED + facts and suppresses proven false alarms.
  Real `node`-in-sandbox e2e tests + demo.
- **Stage 5 — orggraph (`packages/orggraph`)**: cross-repo impact. Extracts
  provided interfaces (OpenAPI, protobuf, GraphQL, package names) and consumer
  call sites; a contract-changing PR is traced to consumers in other repos with
  exact call sites.
- **Stage 6 — telemetry (`packages/telemetry`)**: CI/CD ingest (ClickHouse port),
  baselines + flaky detection, regression prediction (measured + predicted-risk),
  optional sandbox benchmark-vs-baseline; deterministic `telemetry` findings.
- **Stage 12 — learning (`packages/learning`)**: calibrate per-org thresholds from
  accept/reject decisions; feeds Stage 9 thresholds and the Stage 10 verify gate;
  lowers false positives.
- **Platforms (`packages/platforms`)**: one `ReviewPlatform` port + GitHub,
  GitLab, Bitbucket Cloud, Bitbucket Server/DC, and Azure DevOps adapters.
- **Free/OSS tier (`services/control-plane`)**: tiers, public-repo-only
  onboarding, per-tier rate limits, opt-in proven-catches feed (verified findings
  from public repos only).
- **Eval**: Phase 2 verification scoring, side-by-side competitor table, and
  Defects4J / SWE-bench / CVEfixes benchmark adapters.

#### Verified (acceptance gate)
- A planted bug is reproduced in the sandbox → VERIFIED; a non-reproducing false
  alarm → UNVERIFIED and suppressed (verifier tests + `npm run verify-demo`).
- A planted vulnerability gets a working PoC exploit test (real `node` run).
- A breaking change in repo A is flagged as impacting repo B with exact call
  sites (`npm run orggraph-demo`).
- A perf-regressing PR triggers a telemetry warning (telemetry tests).
- FP-rate drops and F1 rises vs Phase 1: **F1 95.7% → 100%, FP-rate 8.3% → 0%**
  (`npm run eval`). GitLab + Bitbucket Server + Azure each post a review
  (platform tests). The verification sandbox uses no egress + hard caps.

### Phase 1 — context-aware review (Stages 2, 3, 3c, 4, 7, 8, 9 + dashboard)

#### Added
- **Stage 4 — analyzer (`packages/analyzer`)**: heuristic JS/TS/Python/Go parsers
  behind a `Parser` port; whole-repo `CodeIndex` with cross-file call resolution;
  `blastRadiusFromDiff` (changed symbols + transitive callers + touched files);
  incremental re-index; `Embedder` port + deterministic `FakeEmbedder` + cosine.
- **Stage 3 — deterministic (`packages/deterministic`)**: `SecretScanner`,
  `BuiltinRuleScanner` (15 in-process SAST rules + an SSRF data-flow rule), and a
  registry of 24 external linters/SAST selected by language and normalized from
  SARIF / semgrep-JSON. All normalized to the common `Finding` schema.
- **Stage 3c — policy gate (`packages/policy`)**: OFF by default; when enabled,
  emits `source=policy`, `immutable=true` findings (generic governance rules:
  endpoint-needs-auth (cross-file aware), banned-import). Not security-specific.
- **Stage 2 — sandbox (`packages/sandbox`)**: one `Sandbox` port, backends
  Local (dev) / Docker (isolation: no-egress, CPU/mem/pids caps, ro-rootfs) /
  Cloudflare (managed) + fake; `shallowClone` of the merge commit.
- **Stage 7 — context (`packages/context`)**: `ContextAssembler` (blast-radius
  caller snippets + past discussions + embedding neighbors), cheap-model
  compression, token-budgeted packing.
- **Stage 8 — ensemble (`packages/agents`)**: 7 specialized agents in parallel
  with abstention, cited cross-file evidence, and a cheap/frontier model router.
- **Stage 9 — adjudicator (`packages/adjudicator`)**: dedupe + vote + threshold;
  immutable policy findings pass through untouched; deterministic facts survive.
- **`packages/pipeline`**: composes the stages into `runPhase1Review`; a demo
  indexes this repo and shows a cross-file catch + policy off/on.
- **`services/control-plane`**: org/repo onboarding, recent reviews, and
  per-finding accept/reject decisions (the Phase 2 learning-loop signal) + a
  minimal HTML dashboard.
- **Eval**: Phase 1 predictor (real deterministic + real adjudication + fixtured
  ensemble) with a before/after table.

#### Verified (acceptance gate)
- Indexing a real medium repo completes (this monorepo: 85 files / 193 symbols /
  265 edges in ~9ms) and re-indexes incrementally on push (~2ms / file).
- A review references cross-file context: the api-breaking finding cites
  `routes.ts` for a change in `auth.ts` (shown by `npm run phase1`).
- Policy gate ENABLED emits an immutable finding that survives adjudication;
  OFF (default) forces nothing (pipeline + adjudicator tests, `npm run phase1`).
- Eval F1 beats the Phase 0 baseline by a clear margin: **81.8% → 95.7%**
  (recall 81.8% → 100%, FP-rate 18.2% → 8.3%).
- Dashboard records accept/reject decisions (control-plane tests).

### Phase 0 — end-to-end skeleton (Stages 0 + 1)

#### Added
- Monorepo foundation: `.gitignore`, `README.md`, `docker-compose.yml`
  (Postgres + Redis), GitHub Actions CI (lint + typecheck + test for both the
  Go and Node toolchains, plus an eval F1 gate).
- **Stage 0 — edge (Go, `services/edge`)**: GitHub App webhook receiver.
  Constant-time HMAC-SHA256 verification (fail-closed); strict normalization of
  `pull_request` payloads to a canonical `ReviewJob`; idempotency dedupe keyed on
  (repo, PR, action, head SHA); enqueue-then-ACK with a ~1ms 202 response
  (<100ms budget); `queue.Producer` port with an in-memory fake and a Redis
  Streams (`XADD`) implementation over a **zero-dependency, stdlib-only RESP
  client** (air-gapped buildable); structured JSON logs with secret redaction;
  graceful shutdown.
- **Gateway (`packages/gateway`)**: single LLM chokepoint. `LLMProvider` port
  with a fetch-based `AnthropicProvider` (no SDK) and a deterministic
  `FakeProvider`; **per-org BYOK** key resolution (key never logged, only a
  sha256 fingerprint); per-request **token + USD cost ledger** with a
  configurable pricing table (Stage 13 cost accounting).
- **Shared core (`packages/core`)**: canonical `ReviewJob` (+ validation),
  `Finding`/`ReviewResult` types, and a dependency-free unified-diff parser with
  commentable-line extraction.
- **Stage 1 — orchestrator (`services/orchestrator`)**: durable review workflow.
  `WorkflowEngine` port (InlineEngine with retry/backoff + lazy BullMqEngine,
  Temporal-swappable); `GitHubClient` port (REST + capturing fake); single-model
  `Reviewer` through the BYOK gateway with a robust JSON finding parser; poster
  that anchors findings to diff lines, renders GitHub `suggestion` blocks, and
  buckets a summary by severity; Stage 0→1 bridge consuming the Redis Stream via
  a consumer group (poison-ack / unacked-on-failure semantics) over a stdlib TS
  RESP client; `main.ts` production wiring and a `demo` that posts a full review
  in ~2ms.
- **Eval (`eval/`)**: precision/recall/F1/false-positive-rate harness with
  location-based matching, 10 gold-labeled seed PRs (real diffs), fixture +
  live modes, a results table, and a CI F1 regression gate.

#### Verified (acceptance gate)
- PR → posted review: `npm run demo` posts a 2-comment review (with a one-click
  fix) in ~2ms (budget 60s), exercised end-to-end through the stream bridge in
  the e2e test.
- Eval prints precision/recall/F1 on the seed set: **F1 81.8%, FPR 18.2%**.
- BYOK: swapping an org's key changes the billed key fingerprint (gateway test
  `BYOK: swapping an org's key changes which key is billed`).
- Tests: `go test ./...` (edge) and `npm test` (38 TS tests) green;
  `ARCHITECTURE.md` + `CHANGELOG.md` accurate.
