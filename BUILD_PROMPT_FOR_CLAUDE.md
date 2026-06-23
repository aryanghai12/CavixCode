# Cavix — Build Prompt-Book for Claude (Opus / Sonnet) — v3, Market-Updated

> **What this is:** a structured, copy-pasteable prompt-book that instructs Claude to build the Cavix platform defined in `PRODUCT_AND_BUSINESS_ROADMAP.md`. It aligns the build **stage-for-stage** to the 13-stage pipeline in that document.
>
> **What changed in v3:** (1) The hardcoded **OWASP/CWE "compliance core" is removed as a differentiator** — the deterministic layer keeps linters + secret-scanning (cheap signal), and OWASP/policy survives only as an **optional, off-by-default org policy-as-code gate**. (2) **Cloudflare** is added as a real option: **Workers** for the Stage-0 edge and the **Cloudflare Sandbox SDK** as a managed backend for the Stage-2/10 sandbox, kept behind the same interface as Firecracker/gVisor so self-host/air-gapped still works. (3) The sandbox security guidance is corrected to **defense-in-depth / assume-breach** — there is no "unbreakable" sandbox.
>
> **How to use it:**
> 1. Paste the **Master System Prompt** (Section A) once — it sets the rules for the whole build.
> 2. Feed **one Phase prompt at a time** (Sections C0–C4). Let Claude finish and pass its **exit gate** before moving on. Don't paste everything at once — bounded objectives produce shippable increments; mega-prompts produce mega-messes.
> 3. After each phase, run the acceptance checks yourself. If something's off, use the **Iteration prompt** (Section E).
>
> **Why structured this way:** agents perform best with (a) a fixed role + constraints, (b) one objective with explicit *done* criteria, (c) the ability to run/inspect their own work, and (d) a feedback loop. This book gives Claude all four, and maps every task to a named stage so the code stays legible.

---

## A. MASTER SYSTEM PROMPT (paste once)

```
You are the lead engineer building Cavix: an AI code-review platform whose
defining advantage is that it PROVES findings before it speaks. It reproduces a
suspected bug (or a security exploit) in an isolated sandbox, applies the fix,
and runs the tests, so its comments are verified facts, not guesses. Beyond
proof, it (a) crosses the repo boundary to flag downstream impact on OTHER
services, (b) predicts operational regressions from CI/CD telemetry, and
(c) supports an OPTIONAL, off-by-default org policy-as-code gate for the
regulated buyers who want a non-bypassable check (NOT an OWASP product).
It is model-agnostic, BYOK-first, and self-hostable including air-gapped.

THE 13-STAGE PIPELINE you are building (memorize this; every task maps to a stage):
  0 Edge ingestion & concurrency (Go webhook -> priority queue)
  1 Durable job orchestration (Temporal)
  2 Ephemeral sandbox provisioning (Firecracker/gVisor; no egress; capped)
  3 Deterministic pre-analysis: linters + SAST + secrets + OPTIONAL policy gate
  4 AST + intra-repo semantic graph (tree-sitter, LSP/stack-graphs)
  5 Cross-repo / microservice impact graph (API contracts, schemas, deps)
  6 CI/CD telemetry & regression prediction (ClickHouse)
  7 Context retrieval & compression (RAG + cheap models)
  8 Multi-agent ensemble (model routing: cheap triage, frontier reasoning)
  9 Adjudication (dedupe, vote, calibrate, threshold; enabled policy findings immune)
 10 Execution-grounded verification (repro test + exploit PoC + fix-and-run)
 11 Synthesis & posting (summary, diagrams, severity, 1-click verified fixes)
 12 Feedback & learning loop (accept/reject -> calibration + org rules)
 13 Teardown, zero-retention, observability, cost accounting

OPERATING PRINCIPLES (every task):
1. Correctness and clarity over cleverness. Boring, well-supported libraries.
2. Test as you go. Every module ships with tests. Never claim it works without
   a passing test or a runnable demonstration.
3. Small, verifiable increments. State your plan and the files you'll touch
   before coding. Show it running after.
4. Explain WHY. For each significant decision, add a short note on the reasoning
   and the mechanism — the human is learning from your work.
5. Security first. This product runs UNTRUSTED code in sandboxes and handles
   private source. Assume hostile input. Isolate execution. Never log secrets.
6. Observable by default. Structured logs, metrics, tracing from day one.
7. Cost-aware. Cheap models for triage/compression; frontier models only for
   deep reasoning, adjudication, and verification. Cache aggressively.
8. Config over hardcode. Model choice, thresholds, providers = config. BYOK must
   work on every path. Deterministic findings (linters, secrets, and any
   org-enabled policy rules) are the only things the LLM cannot silently drop;
   the policy gate ships OFF by default and is org-owned, not OWASP-branded.

TECH BASELINE (unless I say otherwise):
- MVP: Cloudflare Workers OR Go (edge), Python + LangGraph (agents),
  TypeScript/Next.js (web), NestJS or Go (control plane), tree-sitter,
  Postgres + pgvector, Redis, sandbox = Docker OR Cloudflare Sandbox SDK
  (behind an interface), LiteLLM-style gateway, Claude primary (Opus reason /
  Sonnet build / Haiku compress), pluggable to GPT/Gemini/open models.
- Production hot paths: Firecracker/gVisor sandbox (self-host/air-gapped) with
  Cloudflare Sandbox SDK as an alternate managed backend, Temporal, NATS/Kafka,
  Rust indexer, Qdrant, ClickHouse, Kubernetes + Helm + Terraform.
- SANDBOX RULE: always keep sandbox provisioning behind one interface with two
  backends — Cloudflare Sandbox SDK (managed cloud) and Firecracker/gVisor
  (self-host/air-gapped). Never couple the verification logic to one backend.

WORKING AGREEMENT:
- Before each task: restate the objective in one line; list files to create/
  change; then proceed.
- After each task: run tests, show output, state which acceptance criteria pass.
- On ambiguity: pick the simplest reasonable option, note the assumption,
  continue. Don't stall for permission.
- Maintain CHANGELOG.md and ARCHITECTURE.md as you build.

Acknowledge these principles and the 13 stages, then wait for the Phase 0 prompt.
```

**Teaching note:** Embedding the 13-stage map in the system prompt gives Claude a shared mental model, so every later instruction ("build Stage 5") lands in context. The "deterministic findings are the only things the LLM cannot silently drop" rule preserves a trustworthy floor (linters/secrets always surface) without turning the product into an OWASP/compliance tool — the optional policy gate is there only for buyers who ask for it.

---

## B. Target repository shape

```
cavix/
├─ apps/
│  ├─ web/                # Next.js dashboard
│  └─ api/                # Control plane: auth, orgs, billing, webhooks-out
├─ services/
│  ├─ edge/              # Stage 0: Go webhook receiver + enqueue
│  ├─ orchestrator/      # Stage 1/8/9: Temporal workflows, ensemble, adjudicator
│  ├─ sandbox/           # Stage 2/10: provisioning + verification runner
│  ├─ analyzer/          # Stage 3/4: deterministic + AST/graph indexer
│  ├─ orggraph/          # Stage 5: cross-repo impact graph
│  ├─ telemetry/         # Stage 6: CI/CD ingestion + regression prediction
│  ├─ context/           # Stage 7: RAG + compression
│  └─ gateway/           # model-agnostic LLM gateway + BYOK + cost metering
├─ packages/
│  ├─ shared/            # types, schemas (zod/pydantic), prompt templates
│  ├─ rules/             # Semgrep + custom AST rules
│  └─ policy/             # Stage 3c: OPTIONAL org policy-as-code (off by default)
├─ eval/                 # benchmark harness + datasets + scoring
├─ integrations/         # GitHub/GitLab/Bitbucket(incl Server)/Azure adapters
├─ deploy/               # Compose, Helm, Terraform, air-gapped manifests
├─ ARCHITECTURE.md
├─ CHANGELOG.md
└─ README.md
```

---

## C. PHASE PROMPTS (paste one at a time)

### C0 — Phase 0: Foundation (Stages 0–1 + harness)

```
PHASE 0 OBJECTIVE: Stand up the skeleton with the Stage 0 edge layer and Stage 1
orchestration, get a single-model review posting a real comment on a real GitHub
PR, and build the eval harness so we measure quality from day one.

BUILD:
1. Monorepo per the target shape. Docker Compose (Postgres, Redis). CI (lint,
   typecheck, test).
2. Stage 0 (edge, Go): GitHub App that receives pull_request webhooks, verifies
   the HMAC signature, normalizes to a canonical ReviewJob, dedupes via
   idempotency key, ACKs <100ms, and enqueues (Redis Streams for MVP).
3. Stage 1 (orchestrator): a durable workflow (BullMQ/Celery now; design the
   interface so Temporal can replace it) that drives: fetch diff -> single Claude
   pass via the gateway -> post inline comments + summary to the PR.
4. Gateway: one interface, pluggable providers (Claude default), BYOK via per-org
   key config, token + cost logging per request.
5. eval/: load sample PRs with gold-labeled issues; run Cavix over them;
   compute precision, recall, F1, false-positive rate; print a table. Seed with
   10 labeled PRs.

ACCEPTANCE (exit gate):
- Opening a PR on a test repo posts a review comment within ~60s.
- eval runs end-to-end and prints precision/recall/F1 on the seed set.
- BYOK path works: swapping the org key changes which key is billed.
- Tests pass; ARCHITECTURE.md + CHANGELOG.md exist and are accurate.

Show me the eval table and a log of the posted PR comment.
```

**Teaching note:** Measurement before intelligence. The single-model pass is the dumb baseline you'll beat; the harness is the truth source that proves every later gain.

---

### C1 — Phase 1: Context engine (Stages 2, 3, 4, 7, 8, 9)

```
PHASE 1 OBJECTIVE: Turn the dumb diff-reviewer into a context-aware one: run code
in a sandbox, ground it with deterministic analysis (linters + secrets; an
optional org policy gate stubbed off by default), build the whole-repo graph,
retrieve+compress context, and review with a multi-agent ensemble + adjudicator.

BUILD:
1. Stage 2 (sandbox): ephemeral isolated workspace behind ONE interface with two
   backends — Docker or Cloudflare Sandbox SDK now, Firecracker/gVisor later.
   Shallow clone the merge commit. NO network egress except an allowlist. Hard
   CPU/mem/time caps. Destroyed after the job.
2. Stage 3 (deterministic): run 20+ language-appropriate linters/SAST + secret
   scanning in parallel; normalize to the common finding schema.
   Stage 3c (OPTIONAL policy gate, packages/policy): an org-owned, OFF-by-default
   set of plain policy-as-code rules (e.g., "every endpoint needs an auth check").
   When an org enables it, those findings are tagged source=policy, immutable=true
   and survive adjudication. NOT OWASP-hardcoded and NOT a security product — a
   generic, configurable gate most orgs will leave off.
3. Stage 4 (analyzer): tree-sitter parse of the whole repo; symbol resolution
   (LSP/stack-graphs where feasible); a code graph (symbols, calls, imports,
   data-flow) in Postgres; embeddings in pgvector. INCREMENTAL re-index on push.
   Project the diff onto the graph to compute blast radius (changed symbols +
   their callers).
4. Stage 7 (context): RAG over graph + embeddings + past PR discussions on the
   touched modules. Use a CHEAP model to compress big files and verbose logs into
   tight briefs. Assemble a structured prompt within a token budget.
5. Stage 8 (ensemble): specialized agents in parallel — correctness, security,
   concurrency, performance, API/breaking-change, standards, test-coverage —
   each emitting STRUCTURED findings + confidence + cited evidence. A model-
   routing layer picks cheap vs frontier models per task. Agents ABSTAIN when
   unsure.
6. Stage 9 (adjudicator): dedupe overlapping findings, vote, threshold by
   confidence, assign severity, post survivors. Enabled policy-gate findings
   always survive; if the gate is off, nothing is force-passed.
7. Dashboard: org/repo onboarding, recent reviews, per-finding accept/reject
   buttons (this feeds Phase 2's learning loop).

ACCEPTANCE (exit gate):
- Indexing a real medium repo completes and updates incrementally on push.
- A review references cross-file context (show a catch that required another file).
- With the optional policy gate ENABLED on a test org, it emits a finding the LLM
   cannot suppress (demonstrate it surviving adjudication); with the gate OFF
   (the default), no findings are force-passed.
- On the eval set, F1 beats the Phase 0 baseline by a clear margin (show
   before/after).
- Dashboard records accept/reject decisions.

Explain how graph retrieval improved recall, and how the optional policy gate is
structurally non-bypassable when an org enables it.
```

**Teaching note:** Two precision/recall levers land here at once — the graph (recall) and the ensemble+adjudicator (precision via voting/threshold). The deterministic linter/secret layer is cheap grounding, not a headline; the optional policy gate is there only for orgs that explicitly want a non-bypassable check. The accept/reject buttons quietly start the data flywheel before Phase 2 needs it.

---

### C2 — Phase 2: The moat (Stages 5, 6, 10, 12 + BYOK + platforms + free tier)

```
PHASE 2 OBJECTIVE: Build the differentiators competitors structurally lack —
execution-grounded verification, cross-repo impact, CI/CD regression prediction,
and the learning loop — plus BYOK polish, more Git platforms, and a free tier.

BUILD:
1. Stage 10 (verification — the centerpiece):
   - For borderline/high-impact findings, in the sandbox: detect the project's
     build/test setup, generate a MINIMAL failing test that reproduces the bug,
     optionally apply the suggested fix, re-run the new test + existing suite.
   - For SECURITY findings, generate a proof-of-concept exploit test that
     demonstrates the vulnerability in the sandbox.
   - Mark VERIFIED / UNVERIFIED / INCONCLUSIVE. Surface VERIFIED (or high-
     confidence) only, by default. Gate behind a confidence threshold so trivial
     nits don't pay sandbox cost.
   - Sandbox security: no egress, enforced caps, ephemeral, no residual code.
2. Stage 5 (orggraph — cross-repo impact): parse API contracts (OpenAPI),
   protobuf, GraphQL SDL, and package deps; register each repo's exported
   interfaces as nodes; link consumers across repos as edges. On a PR that
   changes a public interface, walk consumer edges and flag impacted services +
   exact call sites.
3. Stage 6 (telemetry): ingest CI/CD run data (build times, test durations, perf
   benchmarks, flaky tests) into ClickHouse; correlate the PR's touched
   functions/tests with history; feed the performance agent; optionally run the
   affected benchmark in the sandbox and compare to baseline; warn on predicted
   regressions.
4. Stage 12 (learning loop): train a lightweight calibration model on the
   accept/reject data from Phase 1; update per-org thresholds and standards; feed
   back into Stage 9 AND the Stage 10 gate (learn what's worth proving).
5. BYOK polish + Git platform adapters: GitLab, Bitbucket (Cloud AND Server/Data
   Center), Azure DevOps behind a common interface.
6. Free/OSS tier: public-repo onboarding, rate limits, an opt-in "proven catches"
   feed.
7. Extend eval/ with external benchmark adapters (Defects4J / SWE-bench-style /
   CVEfixes) and side-by-side competitor scoring.

ACCEPTANCE (exit gate):
- A planted bug is REPRODUCED in the sandbox and marked VERIFIED; a non-
  reproducing false alarm is suppressed. Demonstrate both.
- A planted vulnerability gets a working PoC exploit test in the sandbox.
- A breaking change in repo A is flagged as impacting a consumer in repo B with
  the exact call sites.
- A perf-regressing PR triggers a telemetry-based warning.
- False-positive rate drops vs Phase 1; F1 rises. GitLab + Bitbucket Server +
  Azure each post a review. Sandbox passes the security check.

Walk me through one verification end to end, and one cross-repo impact trace.
```

**Teaching note:** This is the phase that makes Cavix a category, not a clone. Verification is gated behind confidence (cost-awareness in action), and the learning loop now calibrates *what's worth proving* — the system learns where to spend its expensive sandbox budget.

---

### C3 — Phase 3: Enterprise (Stages 2/13 hardening + self-host + governance + legacy)

```
PHASE 3 OBJECTIVE: Make Cavix deployable and sellable to enterprises and IT
services — self-hostable, air-gapped, compliant, governable, legacy-capable.

BUILD:
1. Self-host: production Helm charts + Terraform; signed images; offline license
   server; AIR-GAPPED mode that runs self-hosted open models via the gateway
   (zero outbound calls).
2. Governance: SSO/SAML + SCIM provisioning, RBAC, full audit logs, and a
   ZERO-RETENTION mode (Stage 13: no customer code persists after a review).
3. Policy engine (this is where the OPTIONAL Stage-3c gate graduates): org-wide
   rules in plain English ("flag any endpoint without an auth check"), compiled
   into deterministic checks the ensemble can enforce; per-repo overrides;
   STANDARDS.md ingestion. Still off by default; opt-in per org.
4. Legacy languages: extend analyzer + agents to COBOL, older Java/.NET, PL/SQL,
   C/C++, plus IaC/SQL/config. Add a modernization mode that proposes migrations
   and runs them through the SAME Stage 10 verification before suggesting.
5. Compliance scaffolding: data-flow docs, security hardening, and the technical
   evidence needed for SOC 2 / ISO 27001 readiness.

ACCEPTANCE (exit gate):
- `helm install` brings up a working isolated instance in a fresh cluster;
  air-gapped mode works with a self-hosted open model (prove no egress).
- SSO login + SCIM provisioning + an audit trail all function.
- The policy engine enforces a custom English rule on a test repo.
- A COBOL or PL/SQL PR gets a meaningful, located review.
- Zero-retention verified: no customer code remains after a review.

Explain the air-gapped data flow and prove nothing leaves the cluster.
```

**Teaching note:** This phase is what unlocks TCS/Infosys-scale logos. Air-gapped + zero-retention are the *permission slip* those security teams require. The optional policy gate is a checkbox those buyers can turn on — but it is their rules, not a baked-in OWASP product.

---

### C4 — Phase 4: Expansion (verified fix-PR agent, IDE, modernization, analytics)

```
PHASE 4 OBJECTIVE: Expand from "reviewer" to "trusted automated engineer."

BUILD:
1. Verified fix-PR agent: Cavix opens its OWN PRs with fixes — but ONLY fixes
   that pass the full Stage 10 verification (repro fails before, passes after,
   suite stays green). Human approval required to merge.
2. IDE plugins (VS Code + JetBrains): pre-PR local review using the same engine.
3. Modernization at scale: batch migration workflows with verification gating
   each change.
4. Fine-tuned per-org confidence models; a marketplace of community "review
   lenses" (rule/agent packs).
5. Analytics (ClickHouse): per-team dashboards on action rate, defects caught,
   reviewer-hours saved — the ROI numbers your sales motion needs.

ACCEPTANCE (exit gate):
- The fix-PR agent opens a PR whose fix is verified green; an unverifiable fix is
  NOT proposed. Demonstrate both.
- IDE plugin returns a useful local review before a PR is opened.
- ROI analytics produce reviewer-hours-saved and action-rate numbers.

Keep every autonomous action verification-gated and human-approvable.
```

**Teaching note:** The invariant that defines Cavix — *never act on an unverified finding* — is exactly what makes an autonomous fix-agent safe to ship, and what separates you from auto-fixers that merge plausible-but-wrong changes.

---

## D. CROSS-CUTTING SPECS (reference in any phase)

### D1 — Finding schema (the contract every stage speaks)

```json
{
  "id": "uuid",
  "file": "src/auth/session.ts",
  "line_start": 42, "line_end": 47,
  "category": "security|correctness|concurrency|performance|api|standards|policy",
  "severity": "blocker|high|medium|low|nit",
  "source": "deterministic|policy|llm",
  "title": "short human title",
  "explanation": "why this is a problem, plain language",
  "evidence": "the cross-file / cross-repo / telemetry reason it was flagged",
  "cross_repo_impact": [{"service": "billing-svc", "call_sites": ["..."]}],
  "regression_risk": {"type": "build|runtime", "basis": "telemetry evidence"},
  "suggested_fix": "optional patch",
  "confidence": 0.0,
  "verification": {
    "status": "verified|unverified|inconclusive|not_attempted",
    "repro_test": "generated test or PoC exploit",
    "result": "run output summary"
  },
  "agent": "which agent", "votes": 0,
  "immutable": false   // true ONLY for findings from an org-enabled policy gate
}
```

### D2 — Optional org-policy gate spec (Stage 3c — OFF by default)
- Ships **disabled**. An org opts in and supplies its own rules; this is **not** a built-in OWASP/CWE product.
- Implemented as **code/rules**, never as an LLM call. When enabled, emits findings with `source: policy`, `immutable: true`; the adjudicator (Stage 9) must pass those through regardless of LLM opinion or threshold.
- Fully configurable per org (add/disable specific policies). Each active rule is deterministic and auditable. Most orgs will never enable it — that's fine; the value is for the regulated minority who require a non-bypassable check.

### D3 — Cross-repo graph spec (Stage 5)
- Parsers: OpenAPI, protobuf, GraphQL SDL, package manifests (npm/pip/go.mod/maven).
- Org graph nodes: services + their exported interfaces (versioned). Edges: consumer relationships across repos.
- Query on PR: if a changed symbol is an exported interface, walk consumer edges → list impacted services + exact call sites → emit `cross_repo_impact`.

### D4 — Telemetry spec (Stage 6)
- Pull CI run data (GitHub Actions/GitLab CI/Jenkins/CircleCI) into ClickHouse, keyed by file/function/test.
- On a PR touching a function/test with a poor historical profile (long runtime, flaky, hot path), feed the performance agent and optionally run the affected benchmark in-sandbox vs baseline → emit `regression_risk`.

### D5 — Eval harness contract (Stage built in Phase 0)
- Input: PRs with gold-labeled issues. Output: precision, recall, F1/F-beta, false-positive rate, fix-correctness %, **verification accuracy** (does a VERIFIED finding truly reproduce?), latency/PR, cost/PR — per category + overall.
- Supports running competitor outputs side-by-side. Runs in CI to catch regressions.

### D6 — Sandbox security checklist (Stages 2 & 10 — non-negotiable)
- **Posture: defense-in-depth / assume-breach. There is no "unbreakable" sandbox** (V8 isolates have escape bugs; even microVMs/hypervisors have CVEs). Goal = make a breach unlikely AND low-blast-radius, never claim "impossible."
- No network egress (allowlist only what a build needs). Hard CPU/mem/time caps; kill on breach. Ephemeral FS, destroyed after job; never persist customer code in zero-retention mode. No host mounts; least privilege; dropped capabilities. One sandbox per job; per-tenant isolation so one escape can't reach another customer. Treat all executed code as hostile.
- **Secrets never enter the sandbox.** Use the Worker-proxy / short-lived-JWT pattern (the sandbox gets a token, never the real credential). Cloudflare's Outbound Workers do this natively if you use the Sandbox SDK backend.
- Before any customer code: external pen-test, a bug bounty, signed images + SBOMs, runtime monitoring, egress-attempt anomaly detection.
- **Backend choice:** Cloudflare Sandbox SDK (managed; fast to ship; VM-isolated; egress control built in) for SaaS; Firecracker/gVisor on your own K8s for self-host/air-gapped. Same interface, swappable per deployment. Do NOT use Dynamic Workers (JS/TS isolates only) for running untrusted multi-language test suites.

### D7 — Cost-control rules
- Cheap model (Haiku-class) for Stage 7 compression + Stage 8 triage; frontier model (Opus-class) only for deep reasoning, Stage 9 adjudication, Stage 10 verification. Cache repo indices + embeddings; re-embed only changed files. Gate Stage 10 behind confidence. Log token + sandbox cost per PR (Stage 13).

### D8 — Review-agent prompt rules (Stage 8)
- Demand structured output matching D1; reject free-form prose. Provide diff + compressed brief + deterministic findings + cross-repo impact + telemetry. Instruct agents to cite the cross-file/cross-repo evidence used and to **abstain when unsure** (abstention raises precision). Few-shot with high-signal examples and nits-to-suppress examples.

---

## E. ITERATION PROMPT (when a phase output falls short)

```
The current state doesn't fully meet the Phase <N> exit gate. Specifically:
<describe the gap; paste the failing test/output/log>.

Do this:
1. Diagnose the ROOT CAUSE (don't patch symptoms).
2. Propose the smallest fix; state which files change and why.
3. Implement it, run the tests, show the output.
4. Confirm which acceptance criteria now pass and which remain.
Keep the change minimal and explain the reasoning so I learn from it.
```

---

## F. How to drive the whole build (your operating manual)

1. Use **Claude Code** for building (it runs commands/tests and inspects files); use chat for design discussion.
2. **One phase per working block.** Paste the phase prompt → approve Claude's plan → let it build → *you* run the acceptance checks.
3. **Never accept "it works" without proof** — the eval table, the posted comment, the passing test, the sandbox log, the cross-repo trace.
4. **Keep the eval harness sacred.** Run it on every change. If F1 drops, stop and fix before moving on.
5. **Choose models by task:** Opus for architecture, verification reasoning, hard debugging; Sonnet for routine implementation; Haiku-class for in-product compression/triage.
6. **Commit small and often**, with CHANGELOG updated — so you can always roll back.
7. **Security-review the sandbox yourself** (or with a specialist) before any customer code touches it. This is the one place "move fast" can hurt people.

---

## G. Cold-start one-paragraph brief (if you want Claude to begin from nothing)

```
Build Cavix, an AI code-review platform whose moat is execution-grounded
verification: it reproduces suspected bugs and security exploits in an isolated
sandbox, applies and tests fixes, and only surfaces findings it can PROVE. It
runs a 13-stage pipeline: Cloudflare-Workers-or-Go edge ingestion -> durable
orchestration -> ephemeral sandbox (Cloudflare Sandbox SDK or Firecracker/gVisor,
behind one interface) -> deterministic pre-analysis (linters + secret scanning,
plus an OPTIONAL, off-by-default org policy-as-code gate — NOT an OWASP product)
-> whole-repo semantic graph -> CROSS-REPO impact graph (flagging downstream
breakage in other services) -> CI/CD telemetry regression prediction -> RAG
context with cheap-model compression -> a multi-agent ensemble with model
routing -> adjudication with calibrated confidence and voting -> sandbox
verification -> synthesis with diagrams and one-click verified fixes -> a
learning loop -> zero-retention teardown. Sandbox security is defense-in-depth /
assume-breach (no "unbreakable" claims; secrets never enter the sandbox). It is
model-agnostic and BYOK-first (Claude default; pluggable to GPT/Gemini/open
models), supports GitHub/GitLab/Bitbucket-incl-Server/Azure, and is fully
self-hostable including air-gapped for enterprises and IT services. Start with
the Master System Prompt, then Phase 0. Measure everything with the eval harness.
Explain your reasoning as you go.
```

---

*Companion file: `PRODUCT_AND_BUSINESS_ROADMAP.md` — the strategy, the full stage-by-stage mechanism, pricing, GTM, fundraising, and competitive plan this build serves.*
