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

## Phase 0 acceptance → where it lives

| Acceptance criterion | Satisfied by |
|----------------------|--------------|
| Opening a PR posts a review comment in ~60s | `runReview` workflow (`services/orchestrator/src/workflow/reviewWorkflow.ts`); demonstrated by `npm run demo` (~2ms) and the stream→bridge→post e2e test |
| Eval prints precision/recall/F1 on the seed set | `eval/run.ts` + `eval/src/metrics.ts`; 10 PRs under `eval/datasets/seed/` |
| BYOK: swapping the org key changes which key is billed | `packages/gateway` (`resolveOrgConfig` + `keyFingerprint`); test "BYOK: swapping an org's key changes which key is billed" |
| Tests pass; docs accurate | `go test ./...` + `npm test`; this file + `CHANGELOG.md` |

## Eval as a quality gate

`eval/` scores predicted findings against gold issues by location (same file,
within a small line tolerance), reporting precision, recall, F1, and
false-positive rate, micro-averaged across PRs. It runs in **fixture** mode
(deterministic predictions bundled per PR — what CI gates on) or **live** mode
(the real `Reviewer` through the BYOK gateway, when a key is present). The CI job
fails if aggregate F1 drops below `EVAL_MIN_F1`, so review quality is a tracked
number, not a vibe — the foundation the later proof/verification stages must
improve.

## Phase 1 — context-aware review (Stages 2,3,3c,4,7,8,9)

Phase 1 turns the diff-only reviewer into a context-aware one. The data flow that
the diff now travels:

```
diff ─▶ [Stage 4 CodeIndex] blast radius (changed symbols + cross-file callers)
     ├─▶ [Stage 3 deterministic] secrets + SAST + 24 linters  ─┐
     ├─▶ [Stage 3c policy gate (opt-in)] immutable findings   ─┤
     └─▶ [Stage 7 context] caller snippets + discussions +     │
          embeddings, cheap-model compressed, budgeted  ─▶     │
            [Stage 8 ensemble] 7 agents ∥ (cited evidence) ─▶  │
                                       [Stage 9 adjudication] ◀─┘
                                          dedupe·vote·threshold
                                          (immutable always survive)
                                                 │
                                                 ▼  posted review + dashboard
```

### How graph retrieval improved recall (the required explanation)

A diff-only reviewer sees only the changed lines, so any bug that is wrong *in
light of another file* is invisible to it — e.g. tightening `validateToken`'s
contract in `auth.ts` is only a defect because `handleLogin` in `routes.ts` calls
it the old way. Stage 4 builds a whole-repo call graph and `blastRadiusFromDiff`
projects the change onto it to find the **transitive callers across files**.
Stage 7 then pulls those callers' code into the prompt. So the security /
api-breaking agents are given the exact other-file evidence they need to make the
catch; without it they would abstain. Embeddings add a second, complementary
retrieval channel for related code that has no direct call edge. Concretely on the
eval set this lifted **recall 81.8% → 100%** and **F1 81.8% → 95.7%**: the new
true positives are precisely the cases that needed reasoning + cross-file context
(path traversal, missing await, off-by-one, the cross-file break) that a single
diff-only pass missed.

### Why the optional policy gate is structurally non-bypassable (the required explanation)

When an org enables the gate, its findings are non-bypassable by *construction*,
not by policy:

1. **They never enter the LLM path.** `PolicyEngine.evaluate` runs deterministic
   rules over the code/graph and emits findings directly. No model is asked
   whether they are real, so no model can argue them away.
2. **They are tagged `immutable: true`.** The adjudicator (Stage 9) has a hard
   invariant: immutable findings are partitioned out *before* clustering and are
   never thresholded, merged, or dropped — they are concatenated to the survivors
   verbatim. There is no code path in which an LLM (or a low confidence score)
   removes one. The adjudicator tests assert exactly this.
3. **Posting includes them unconditionally.** They reach the PR regardless of the
   ensemble's opinion.

And when the gate is OFF (the default), there simply are no immutable findings, so
nothing is force-passed — adjudication proceeds normally. The gate is a generic,
org-owned governance mechanism (e.g. "every endpoint needs an auth check"), not an
OWASP/security product, and most orgs will leave it off.

### Stage 4 persistence (in-memory now, Postgres later)

`CodeIndex` is in-memory in Phase 1 but its shape mirrors the production schema:
a `symbols` table (id, name, path, line, kind, language), an `edges` table
(caller_id, callee_id), and `pgvector` embeddings keyed by symbol/file. The
`Parser` port lets tree-sitter / stack-graphs replace the heuristic parsers, and a
`PostgresGraphStore` would back the same query methods — the same isolation
strategy used for Redis/sandbox elsewhere.

## Phase 2 — the differentiators (Stages 10, 5, 6, 12)

### Stage 10 verification — the moat (how one verification flows)

The verifier slots between the ensemble (Stage 8) and adjudication (Stage 9):

```
finding ─▶ shouldVerify? (skip facts + trivial nits; verify high-impact/security/confident)
   │ yes
   ▼
provision sandbox (network=none, cpu/mem/pids caps, ephemeral)
   ▼ write repo files + generate test (failing repro, or PoC exploit for security)
run test (pre-fix) ──▶ reproduced?  (correctness: test FAILS; security: exploit PASSES)
   │ no  → UNVERIFIED  → SUPPRESS (proven false alarm)
   │ yes
   ▼ apply suggested fix → re-run test → run existing suite
VERIFIED (reproduced; fix resolves it; suite green) → SURFACE with proof
   ▼ destroy sandbox (no residual code)
```

The status drives surfacing: by default only VERIFIED findings (plus deterministic
and policy facts) reach the PR; findings proven not to reproduce are dropped. This
is why Cavix's comments are facts: each non-trivial one was reproduced in an
isolated sandbox. The two-backend sandbox rule still holds — verification only ever
touches the `Sandbox` port, so Docker/Firecracker/Cloudflare are interchangeable.

### Stage 5 cross-repo impact (how one trace flows)

Repos are ingested once: contracts (OpenAPI/proto/GraphQL/package metadata) →
**provided** interfaces; source → **consumer** call sites. A PR that edits a
contract file is diffed to find which interfaces changed, then consumer edges are
walked to other repos. Example: editing `GET /orders/{id}` in `orders-api` →
`checkout` (`src/checkout.js:4`) and `billing` (`src/invoice.js:1`) with the exact
`fetch(...)` lines. This is the downstream-impact differentiator a single-repo
reviewer structurally cannot produce.

### Stages 6 + 12 — prediction and learning

Stage 6 correlates a PR's touched functions with historical CI/CD benchmarks
(ClickHouse in prod) and warns on measured or predicted regressions, optionally
running the affected benchmark in the sandbox. Stage 12 calibrates per-org
thresholds from dashboard accept/reject decisions and feeds both the Stage 9
threshold and the Stage 10 verify gate — the system learns what's worth proving
and which categories the org trusts, lowering false positives over time.

### Why FP-rate drops and F1 rises across phases

On the eval set: linter-only (F1 77.8%, recall 63.6%) → Phase 0 diff-only LLM
(81.8%) → Phase 1 context + ensemble + deterministic (95.7%, FP-rate 8.3%) →
Phase 2 + verification (100%, FP-rate 0%). Phase 1's recall gain comes from graph
context; Phase 2's precision gain comes from verification suppressing the finding
that doesn't reproduce.

## Phase 3 — enterprise deployability (self-host, air-gap, governance)

### Air-gapped data flow (the required explanation)

In air-gapped mode Cavix runs entirely inside one Kubernetes namespace and makes
**zero outbound calls**. The orchestrator clones the PR commit into an isolated
sandbox, runs Stages 3–10 in-process, and sends context only to the in-cluster
self-hosted model (`cavix-model`, an OpenAI-compatible server). Two independent
layers prove nothing leaves:

1. **NetworkPolicy `cavix-default-deny-egress`** (`egress: []`, no `0.0.0.0/0`) —
   the CNI drops any internet-bound packet. A second policy permits only DNS and
   in-cluster services.
2. **Gateway `EgressGuard`** — every `fetch` is wrapped to allow only the model
   host; any other host throws `EgressBlockedError`. Even a mis-configured URL or
   a malicious dependency cannot exfiltrate.

`npm run airgap-demo` and `docs/compliance/AIR_GAPPED_DATA_FLOW.md` demonstrate
both layers: the in-cluster model is reached; anthropic/openai/github are blocked.

### Governance, retention, licensing

- **Identity**: SAML 2.0 SSO (signature/audience/validity/replay), SCIM 2.0
  provisioning → RBAC roles, and a hash-chained tamper-evident audit log.
- **Zero-retention (Stage 13)**: the review runs in an ephemeral sandbox whose
  destruction is *verified* (no residual on disk); only metadata persists. This
  is the teardown/zero-retention half of Stage 13.
- **Licensing**: offline Ed25519-signed licenses — entitlements (seats, features,
  air-gap) are signed and verified with no network, suitable for air-gapped sites.

### Policy graduation & legacy

The optional Stage-3c gate graduates into an org policy engine: admins write
plain-English rules (or a `STANDARDS.md`) that compile into deterministic,
immutable checks the ensemble cannot drop, with per-repo overrides — still off by
default. The analyzer/agents extend to COBOL, PL/SQL, C/C++, older Java/.NET, and
IaC with *located* findings; a modernization mode proposes migrations and runs
them through the **same Stage 10 verifier** before suggesting — so even a
migration is a proven fact, not a guess.

## Phase 4 — trusted automated engineer

Cavix goes from reviewer to engineer, but the moat is the leash: **every
autonomous action is Stage-10-gated and human-approvable.**

- **Verified fix-PR agent** (`packages/fixpr`): generates a candidate fix, runs it
  through the verifier (repro red → green, suite green), and opens a PR only if it
  passes — always a *draft* labeled `needs-human-approval`. There is deliberately
  no merge method. Unverifiable fixes are silently not proposed. This is the same
  "prove it before you speak" discipline applied to *acting*, not just commenting.
- **IDE local review** (`packages/ide`): the exact pipeline engine, run on the
  working tree before a PR exists, offline by default — so what you see in the
  editor is what Cavix would post.
- **Batch modernization** (`packages/batch`): the same per-change verification
  gate, fanned out across many files/repos with bounded concurrency; only verified
  migrations survive into human-approvable PRs.
- **Lenses** (`packages/lenses`): a marketplace of shareable rule/agent packs plus
  per-org confidence models, validated and composed into the pipeline.
- **ROI analytics** (`packages/analytics`): the action-rate / defects-caught /
  reviewer-hours-saved numbers, from an explicit model — the sales-motion metrics.

The through-line across all four phases: a finding, a fix, a migration, or an
auto-PR is only ever surfaced as a *proven fact* — verified in an isolated
sandbox — and a human always holds the merge button.

## What remains (post-Phase 4)

Stages 2–7 and 9–13 are stubbed by clean seams, not built: the sandbox
(`Stage 2`), deterministic pre-analysis and the optional policy gate (`Stage 3`),
the semantic/impact graphs (`4`/`5`), CI telemetry (`6`), RAG compression (`7`),
adjudication (`9`), execution-grounded verification (`10`), the feedback loop
(`12`), and teardown/zero-retention (`13`). The single-model reviewer is the
seam where the Stage 8 ensemble plugs in; the cost ledger is the start of
Stage 13. Crucially, the verifier (Stage 10) — Cavix's "prove it" moat — slots
between the review and post steps of the existing workflow without reshaping it.
