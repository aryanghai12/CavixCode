# Cavix Architecture

This document explains the **why** behind each seam, not just the what. It grows
with the system. Phase 0 covers Stages 0 and 1 of the 13-stage pipeline.

## Guiding invariants

1. **Prove, don't guess.** The product's moat is execution-grounded verification
   (Stage 10). Every design choice upstream exists to feed a *verifier* with
   enough context to reproduce and confirm a finding. Phase 0 builds the spine
   that later carries the verifier.
2. **Interfaces at every external boundary.** Redis, Postgres, GitHub, and the
   LLM provider are all reached through a port (interface) with at least two
   implementations: a real one and an in-process fake. This is what lets unit
   tests run with zero infrastructure and lets us swap BullMQ→Temporal,
   Docker→Firecracker, Anthropic→GPT without touching business logic.
3. **BYOK on every path.** No code path may hardcode a provider key. Keys are
   resolved per-org from config at request time and the *key identity* (never
   the secret) is logged for cost attribution.
4. **Never log secrets.** Webhook secrets, API keys, and tokens are redacted at
   the boundary. Structured logs carry IDs, not credentials.

## Data flow (Phase 0)

```
GitHub ──pull_request webhook──▶ [Stage 0: edge, Go]
                                   │  verify HMAC (constant-time)
                                   │  normalize → canonical ReviewJob
                                   │  dedupe via idempotency key
                                   │  ACK 202 in <100ms  ◀── ack before work
                                   ▼
                          Redis Stream  cavix:reviewjobs   (durable buffer)
                                   │
                                   │  XREADGROUP (consumer group)
                                   ▼
                        [Stage 1: orchestrator, TS]
                          bridge ─▶ WorkflowEngine.submit(job)
                                   │
                                   ▼  durable workflow steps:
                          1. fetch diff          (GitHubClient port)
                          2. single LLM pass     (Gateway → LLMProvider port)
                          3. post inline comments + summary (GitHubClient port)
                                   │
                                   ▼
                          GitHub PR review  (verified-comment shape)
```

## Why a Redis Stream *between* Stage 0 and Stage 1

The edge's only job is to absorb a webhook burst and acknowledge fast (<100ms),
so GitHub never times out or retries us into a thundering herd. It must not block
on the (slow, LLM-bound) review. A Redis **Stream** (not a plain list) gives us:

- **Durability + replay**: `XADD` persists; a consumer group (`XREADGROUP`)
  tracks per-message acks, so a crashed orchestrator resumes from the pending
  entries list instead of dropping jobs.
- **Backpressure & priority**: the stream is the natural place to later attach
  the Stage 0 *priority* queue (security PRs jump the line).
- **Clean stage boundary**: the edge knows nothing about how work is run. The
  orchestrator's `bridge` consumer is the *only* component that reads the stream
  and hands jobs to the workflow engine, so swapping BullMQ for Temporal is a
  one-file change behind `WorkflowEngine`.

## The `WorkflowEngine` port (BullMQ now, Temporal later)

Stage 1 must be *durable* — survive process restarts, retry transient failures,
and be observable. Temporal is the production target, but it is heavy for an
MVP. We define a minimal `WorkflowEngine` interface (`submit`, `worker`,
ret/ backoff semantics) and implement it twice:

- `InlineEngine` — runs the workflow synchronously in-process. Used by tests and
  the eval harness so the full review path is exercised with no broker.
- `BullMqEngine` — Redis-backed durable queue with retries/backoff for the MVP.

`TemporalEngine` will implement the same port in a later phase. Because the
review workflow is written against the port (not BullMQ), that swap does not
touch Stages fetch/LLM/post.

## The Gateway (Stage 8 seam) and BYOK

All model calls go through one `Gateway`. It:
- resolves the **per-org key** (BYOK) from config — never a global key;
- routes to an `LLMProvider` implementation (`anthropic` default, `fake` for
  tests/eval, pluggable to GPT/Gemini/open models);
- logs **tokens in/out and computed cost** per request, attributed to the org
  and the key identity (a non-secret fingerprint), satisfying Stage 13 cost
  accounting from day one.

Single-model in Phase 0, but the routing seam (cheap triage vs. frontier
reasoning) is where the Stage 8 ensemble will plug in.

## Testing strategy

- **Hermetic unit tests** (default): every external dependency faked in-process.
  `go test ./...` and `npm test` pass with no Docker, no network.
- **Gated integration tests**: real Redis/Postgres/GitHub/Anthropic exercised
  only when the corresponding env var is set (e.g. `REDIS_URL`,
  `CAVIX_GITHUB_TOKEN`, `ANTHROPIC_API_KEY`). CI runs the hermetic set.
- **Eval as a first-class gate**: `eval/` measures precision/recall/F1 over
  gold-labeled PRs so review *quality* is a number we can regress against, not a
  vibe.

## Security posture (Phase 0 scope)

- Webhook authenticity: HMAC-SHA256 verified in **constant time** before the
  body is parsed or trusted.
- Secret hygiene: keys/secrets/tokens never enter logs; only IDs and key
  fingerprints do.
- Least trust: the edge treats every field of the payload as hostile and
  normalizes to a strict canonical schema before anything downstream sees it.
- (Stage 2 untrusted-code sandboxing arrives with the verifier; Phase 0 does not
  execute repo code.)
