# Changelog

All notable changes to Cavix are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). Dates are ISO-8601.

## [Unreleased]

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
