# Handoff: what is left to build in Cavix

Paste the prompt at the bottom into a fresh Claude Code session in this repo.
Everything above it is the context that prompt assumes.

---

## Where the product stands

The live review path (`services/orchestrator/src/main.ts` → `runReview`) now runs
stages 0 through 11 and part of 13 on a real pull request.

| Stage | Status |
|---|---|
| 0 Edge ingestion (Go) | live |
| 1 Durable orchestration (BullMQ) | live |
| 2 Sandbox | live |
| 3 Deterministic scanners | live |
| 3c Org policy gate | live |
| 4 AST + call graph | live, over the changed files only |
| 5 Cross-repo impact graph | live |
| 6 CI/CD telemetry | live |
| 7 Context + compression | live |
| 8 Seven-agent ensemble | live |
| 9 Adjudication | live |
| 10 Execution verification | live |
| 11 Synthesis and posting | live, GitHub only |
| 12 Learning loop | decisions recorded and surfaced; nothing feeds them back |
| 13 Teardown, cost accounting | sandbox teardown and cost live; zero-retention package unwired |

Run `npm test` (540 tests), `npx tsc --noEmit`, `npm run demo`, `npm run eval`,
and `cd services/edge && go test ./...`. All green as of this handoff.

## How stages 5 and 6 were wired, since the next ones should copy it

Both followed the same shape, and it is worth knowing before you add another:

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
  Postgres and knows which repositories a workspace connected.
- **Bounded reads and bounded storage.** Twelve contract files and forty source
  files per repository, shallowest first; four hundred CI runs per repository,
  oldest out first. This runs on somebody else's rate limit and in our memory.
- **Say only what was measured.** Both stages refuse to claim causation they
  cannot demonstrate. The CI warning states in the finding body that it is not
  blaming the pull request, because the trend is measured on a branch that
  predates it.

## What is left, in the order I would do it

### 1. Stage 12 closed: make the learning loop actually learn

Decisions are captured, stored, and now shown on the Learnings page with the
categories a team keeps rejecting. Nothing reads them back. `packages/learning/`
has the calibration code.

The loop closes when a per-org confidence threshold, derived from that history,
is passed into `adjudicate()` at review time.
`DeepReviewOptions.confidenceThreshold` is already plumbed for exactly this and
is currently never set.

### 2. Mermaid sequence diagrams in the review

The dashboard has had a "Sequence diagram" toggle marked "soon" since the
settings page was written, and `reviewSections.sequenceDiagram` is stored and
served. Nothing generates one. GitHub renders Mermaid natively in comments.

### 3. The other four platforms

`packages/platforms/` has GitLab, Bitbucket and Azure DevOps adapters, written
and tested. The orchestrator has its own GitHub client and imports none of them,
so the live product is GitHub only. This is an adapter seam, not new logic.

### 4. Zero-retention, live

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
> Stages 0 through 11 already run on real pull requests. What is left is listed
> in HANDOFF.md. Build **item 1: close the learning loop (Stage 12).**
>
> Right now every accept and reject a team makes is stored, and shown back to
> them on the Learnings page, and changes nothing about the next review. That is
> the difference between a feature and a moat: the roadmap's whole retention
> argument is that a competitor starts cold while Cavix starts tuned, and today
> Cavix starts cold too.
>
> `packages/learning/` has the calibration code and nothing imports it.
> `DeepReviewOptions.confidenceThreshold` is already plumbed into Stage 9's
> `adjudicate()` and is never set. The gap between those two facts is the work.
>
> Specifically:
> 1. Derive a per-org confidence threshold, and ideally per-category, from that
>    workspace's accept and reject history. A team that rejects every
>    maintainability nit should stop being shown them; a team that accepts every
>    security finding should see them at a lower bar.
> 2. Feed it into the review path. Decide where it is computed and cached, and
>    say why. It must not add a round trip to every review.
> 3. Make it visible. The Learnings page should say what changed as a result, in
>    the team's own numbers, because an invisible moat does not retain anyone.
> 4. Guard against the obvious failure: a workspace with three decisions must not
>    get a threshold derived from three decisions, and one bad week must not
>    silence a category permanently.
>
> Before writing anything, audit `packages/learning` and tell me the plan,
> including anything that will not survive contact with real decision data. Do
> not start building until I have seen it. While you are in there, sweep the repo
> for bugs and tell me what you find.
>
> House rules, all enforced by tests: no emoji anywhere Cavix posts, no em or en
> dashes, the Scope module never states a number that was not measured, and every
> new stage fails soft rather than costing a customer their review. Add tests
> that need no infrastructure, and keep `npm test`, `npx tsc --noEmit` and
> `cd services/edge && go test ./...` green.
>
> A warning worth taking seriously: every package in this repo was written and
> tested and then never run against real input, and every single one I have wired
> so far had bugs that only appeared on realistic data. The last two sessions
> found eight between them, including matching logic that reported nothing at all
> and a metric that told reviewers to ignore real failures. Probe it with a
> realistic fixture before you trust a line of it.
