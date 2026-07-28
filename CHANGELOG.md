# Changelog

All notable changes to Cavix are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). Dates are ISO-8601.

## [Unreleased]

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
