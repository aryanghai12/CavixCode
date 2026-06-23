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
| 2 | Ephemeral sandbox provisioning (Firecracker/gVisor; no egress) | ⬜ later |
| 3 | Deterministic pre-analysis: linters + SAST + secrets + policy gate | ⬜ later |
| 4 | AST + intra-repo semantic graph (tree-sitter, stack-graphs) | ⬜ later |
| 5 | Cross-repo / microservice impact graph | ⬜ later |
| 6 | CI/CD telemetry & regression prediction (ClickHouse) | ⬜ later |
| 7 | Context retrieval & compression (RAG + cheap models) | ⬜ later |
| 8 | Multi-agent ensemble (model routing) | 🟡 single-model seam in place |
| 9 | Adjudication (dedupe, vote, calibrate, threshold) | ⬜ later |
| 10 | Execution-grounded verification (repro + PoC + fix-and-run) | ⬜ later |
| 11 | Synthesis & posting (summary, severity, 1-click fixes) | 🟡 inline comments + summary |
| 12 | Feedback & learning loop | ⬜ later |
| 13 | Teardown, zero-retention, observability, cost accounting | 🟡 cost accounting in gateway |

Phase 0 delivers a thin but **end-to-end** slice: a real PR webhook flows
through the edge, into a durable workflow, through a pluggable BYOK LLM gateway,
and back out as an inline review comment — and an eval harness measures the
quality of those comments from day one.

## Monorepo layout

```
services/
  edge/          Stage 0 — Go GitHub-App webhook receiver → Redis Stream
  orchestrator/  Stage 1 — TS durable workflow → diff → LLM pass → PR comments
packages/
  gateway/       Pluggable, BYOK-first LLM gateway with token + cost logging
eval/            Gold-labeled PRs + precision/recall/F1 harness
docker-compose.yml   Postgres + Redis for local dev
```

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
