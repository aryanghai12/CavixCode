# Handoff: what is left to build in Cavix

Paste the prompt at the bottom into a fresh Claude Code session in this repo.
Everything above it is the context that prompt assumes.

---

## Where the product stands

The live review path (`services/orchestrator/src/main.ts` → `runReview`) now runs
stages 0, 1, 2, 3, 3c, 4, 7, 8, 9, 10, 11 and part of 13 on a real pull request.

| Stage | Status |
|---|---|
| 0 Edge ingestion (Go) | live |
| 1 Durable orchestration (BullMQ) | live |
| 2 Sandbox | live |
| 3 Deterministic scanners | live |
| 3c Org policy gate | live |
| 4 AST + call graph | live, over the changed files only |
| 5 Cross-repo impact graph | live |
| 6 CI/CD telemetry | **built, not wired** |
| 7 Context + compression | live |
| 8 Seven-agent ensemble | live |
| 9 Adjudication | live |
| 10 Execution verification | live |
| 11 Synthesis and posting | live, GitHub only |
| 12 Learning loop | decisions recorded and surfaced; nothing feeds them back |
| 13 Teardown, cost accounting | sandbox teardown and cost live; zero-retention package unwired |

Run `npm test` (515 tests), `npx tsc --noEmit`, `npm run demo`, `npm run eval`,
and `cd services/edge && go test ./...`. All green as of this handoff.

## How Stage 5 was wired, since the next stages should copy it

The pattern is worth knowing before you add Stage 6, because it is the same
shape:

- **An injected step that fails soft.** `blastRadius` and `indexGraph` are
  optional dependencies of the workflow, like `verify` and `deepReview` before
  them. Absent, or throwing, costs that section of one review and nothing else.
- **Work that is not on the critical path runs after the review is posted.** The
  indexer is a tree listing plus a few dozen file reads; none of it changes the
  review that just went out, so it runs afterwards and only when this
  repository's slice has gone stale.
- **The orchestrator computes, the control-plane stores.** Only the orchestrator
  holds GitHub App installation tokens (the one credential that reads a private
  repo without borrowing a human's OAuth token). Only the control-plane has
  Postgres and knows which repositories a workspace connected. Stage 6 will have
  exactly the same split.
- **Bounded reads.** Twelve contract files and forty source files per repository,
  shallowest first. This runs on somebody else's rate limit.

## What is left, in the order I would do it

### 1. Stage 6 live: CI/CD telemetry and regression prediction

`packages/telemetry/` has the store, a `RegressionPredictor` and a sandbox
benchmark runner. Nothing imports it. The roadmap calls this the one genuinely
empty lane in the whole competitive set.

Needs: ingestion from GitHub Actions (start there), somewhere to keep the time
series, and a review-time prediction that becomes a finding or a Scope row. The
warning is the product: "this change touches a hot path whose p95 has been
climbing for two weeks".

### 2. Stage 12 closed: make the learning loop actually learn

Decisions are captured, stored, and now shown on the Learnings page with the
categories a team keeps rejecting. Nothing reads them back. `packages/learning/`
has the calibration code.

The loop closes when a per-org confidence threshold, derived from that history,
is passed into `adjudicate()` at review time.
`DeepReviewOptions.confidenceThreshold` is already plumbed for exactly this and
is currently never set.

### 3. Mermaid sequence diagrams in the review

The dashboard has had a "Sequence diagram" toggle marked "soon" since the
settings page was written, and `reviewSections.sequenceDiagram` is stored and
served. Nothing generates one. GitHub renders Mermaid natively in comments.

### 4. The other four platforms

`packages/platforms/` has GitLab, Bitbucket and Azure DevOps adapters, written
and tested. The orchestrator has its own GitHub client and imports none of them,
so the live product is GitHub only. This is an adapter seam, not new logic.

### 5. Zero-retention, live

`packages/zero-retention/` proves no customer code persists after teardown, and
runs only in `scripts/airgap-demo.ts`. It should run in the real teardown path
and its result should be visible to the customer, because that claim is what
sells to regulated buyers.

## Things to know before you start

- **The house style is enforced.** No emoji anywhere Cavix posts (there is a test
  that fails the build). No em dashes or en dashes. Geometric marks: `◆` critical,
  `◈` high, `◇` medium, `▪` low, `▫` info, `⬢` proven, `▲` attention.
- **The Scope module never states a number it did not measure.** Rows render only
  when their stage actually ran and covered what it claims. Follow that rule; it
  is the product's whole credibility.
- **Every new stage must fail soft.** `deepReview` and `verify` are both injected
  steps whose failure falls back rather than costing a customer their review.
  Copy that shape.
- **The PR description carries no findings.** Only what the change does. Findings
  go on the review comment, which is dated and supersedable.
- Tests run with zero infrastructure. Keep it that way.

---

## The prompt

> I am continuing work on Cavix, an AI code reviewer. Read `HANDOFF.md`,
> `README.md` and `CHANGELOG.md` first, then `ARCHITECTURE.md` for the seams.
>
> Stages 0 through 5 and 7 through 11 already run on real pull requests. What is
> left is listed in HANDOFF.md. Build **item 1: Stage 6, CI/CD telemetry and
> regression prediction, live.** The roadmap calls it the one genuinely empty
> lane in the whole competitive set: nobody else warns that a change will slow a
> build or degrade a hot path before it merges.
>
> `packages/telemetry/` has the store, a `RegressionPredictor` and a sandbox
> benchmark runner, and nothing imports it. Wire it the way Stage 5 was wired
> (`services/orchestrator/src/orggraph/`): an injected step that fails soft, work
> that is not on the critical path running after the review is posted, the
> orchestrator computing and the control-plane storing.
>
> Specifically:
> 1. Ingestion. Start with GitHub Actions: workflow-run durations, job durations,
>    test counts, failures. Decide whether it is pulled after a review or pushed
>    by a webhook, and say why.
> 2. Storage with a retention window. Postgres is already a control-plane
>    dependency; ClickHouse is the eventual answer and is not needed yet.
> 3. A review-time prediction that becomes a finding when it is worth one. The
>    product is the sentence "this touches a path whose p95 has been climbing for
>    two weeks", not a dashboard nobody opens.
>
> Before writing anything, audit what is actually in `packages/telemetry` and
> tell me the plan, including anything that will not survive contact with real CI
> data. Do not start building until I have seen it. While you are in there, sweep
> the repo for bugs and tell me what you find.
>
> House rules, all enforced by tests: no emoji anywhere Cavix posts, no em or en
> dashes, the Scope module never states a number that was not measured, and every
> new stage fails soft rather than costing a customer their review. Add tests
> that need no infrastructure, and keep `npm test`, `npx tsc --noEmit` and
> `cd services/edge && go test ./...` green.
>
> A warning from the last two sessions: the packages in this repo are written and
> tested but were never run against real input, and every one I have wired so far
> had bugs that only appeared on realistic data. Probe it with a realistic
> fixture before you trust it.
