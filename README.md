# Cavix

**AI code review that proves its findings before it speaks.**

Cavix does not guess. For a suspected bug or security exploit it reproduces the
problem in an isolated sandbox, applies the fix, and runs the tests — so every
comment it posts is a *verified fact*, not a probabilistic hunch. On top of
proof it crosses the repo boundary to flag downstream impact on other services,
predicts operational regressions from CI/CD telemetry, and (optionally) enforces
an org-owned policy-as-code gate for regulated buyers.

Model-agnostic. BYOK-first. Self-hostable, including air-gapped.

---

## The 13-stage pipeline

| # | Stage | Phase 0 status |
|---|-------|----------------|
| 0 | Edge ingestion & concurrency (Go webhook → priority queue) | ✅ built |
| 1 | Durable job orchestration (Temporal-swappable) | ✅ built (BullMQ) |
| 2 | Ephemeral sandbox provisioning (Firecracker/gVisor; no egress) | ✅ built (Local/Docker/CF) |
| 3 | Deterministic pre-analysis: linters + SAST + secrets + policy gate | ✅ built |
| 4 | AST + intra-repo semantic graph (tree-sitter, stack-graphs) | ✅ built (heuristic parsers) |
| 5 | Cross-repo / microservice impact graph | ✅ built |
| 6 | CI/CD telemetry & regression prediction (ClickHouse) | ✅ built |
| 7 | Context retrieval & compression (RAG + cheap models) | ✅ built |
| 8 | Multi-agent ensemble (model routing) | ✅ built (7 agents) |
| 9 | Adjudication (dedupe, vote, calibrate, threshold) | ✅ built |
| 10 | Execution-grounded verification (repro + PoC + fix-and-run) | ✅ built |
| 11 | Synthesis & posting (summary, severity, 1-click fixes) | ✅ built (5 platforms) |
| 12 | Feedback & learning loop | ✅ built (calibration) |
| 13 | Teardown, zero-retention, observability, cost accounting | ✅ built (verified purge) |

Phase 0 delivers a thin but **end-to-end** slice: a real PR webhook flows
through the edge, into a durable workflow, through a pluggable BYOK LLM gateway,
and back out as an inline review comment — and an eval harness measures the
quality of those comments from day one.

## Monorepo layout

```
services/
  edge/          Stage 0 — Go GitHub-App webhook receiver → Redis Stream
  orchestrator/  Stage 1 — TS durable workflow → diff → LLM pass → PR comments
  control-plane/ Dashboard API: onboarding, reviews, accept/reject decisions
packages/
  core/          Shared domain types + unified-diff parser
  gateway/       Pluggable, BYOK-first LLM gateway with token + cost logging
  sandbox/       Stage 2 — one sandbox port (Local/Docker/Cloudflare backends)
  deterministic/ Stage 3 — secrets + SAST + 24-linter registry
  policy/        Stage 3c — optional, off-by-default org policy gate
  analyzer/      Stage 4 — code graph, blast radius, incremental index
  context/       Stage 7 — RAG context assembly + cheap-model compression
  agents/        Stage 8 — 7-agent ensemble + model routing
  adjudicator/   Stage 9 — dedupe, vote, threshold, policy immunity
  verifier/      Stage 10 — execution-grounded verification (reproduce/PoC)
  orggraph/      Stage 5 — cross-repo impact (contracts → consumer call sites)
  telemetry/     Stage 6 — CI/CD telemetry + regression prediction
  learning/      Stage 12 — accept/reject calibration loop
  platforms/     Stage 11 — GitHub/GitLab/Bitbucket/Azure review adapters
  verifier/ orggraph/ telemetry/ learning/  (Phase 2 differentiators)
  governance/    SSO/SAML + SCIM + RBAC + tamper-evident audit
  zero-retention/ Stage 13 — verified no-customer-code-persists
  license/       Offline Ed25519 signed licenses
  legacy/        COBOL/PL-SQL/C-C++/Java/.NET/IaC + modernization
  pipeline/      Composes Stages 3/3c/4/7/8/9 → runPhase1Review (+ demo)
eval/            Gold-labeled PRs + competitor + external-benchmark harness
deploy/          Helm chart (deny-all-egress) + Terraform + cosign signing
docs/compliance/ Air-gapped data flow, hardening, SOC 2 / ISO 27001 mapping
docker-compose.yml   Postgres + Redis for local dev
```

Demos: `npm run demo` (Phase 0 PR comment) · `npm run phase1` (cross-file catch,
policy gate) · `npm run verify-demo` (reproduce a bug + PoC in a real sandbox) ·
`npm run orggraph-demo` (cross-repo impact trace) · `npm run airgap-demo` (prove
no egress + offline license + zero-retention) · `npm run eval` (Phase 0→1→2
side-by-side) · `npm run eval:bench` (external benchmarks).

Self-host / air-gapped deployment: see [deploy/README.md](deploy/README.md) and
[docs/compliance/AIR_GAPPED_DATA_FLOW.md](docs/compliance/AIR_GAPPED_DATA_FLOW.md).

## Quick start

```bash
# 1. Infra (Postgres + Redis)
docker compose up -d

# 2. Edge (Stage 0)
cd services/edge && go test ./... && go run ./cmd/edge

# 3. Orchestrator + gateway + eval (Stage 1)
npm install            # workspaces: orchestrator, gateway, eval
npm test               # hermetic: no infra required
npm run eval           # prints precision/recall/F1 table on the seed set
```

Every unit test runs with **zero infrastructure** — external systems (Redis,
Postgres, GitHub, Anthropic) sit behind interfaces with in-process fakes.
Integration paths against real infra are gated behind environment variables.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the why behind each seam and
[CHANGELOG.md](CHANGELOG.md) for what shipped when.
