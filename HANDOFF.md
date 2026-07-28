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
| 12 Learning loop | live, per-category confidence bars from the org's own decisions |
| 13 Teardown, cost accounting | sandbox teardown and cost live; zero-retention package unwired |

Run `npm test` (567 tests), `npx tsc --noEmit`, `npm run demo`, `npm run eval`,
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

## How Stage 12 was wired, since it adds a rule to the list above

Same shape as 5 and 6, plus one that is new and worth keeping:

- **Ride an existing call rather than adding one.** The learned bars come back on
  `/api/internal/orgs/:org/review-config`, which the workflow already fetches once
  per review and caches for 30 seconds. Closing the loop cost zero extra round
  trips. A second endpoint would have been the obvious design and the wrong one.
- **The refusal branch is a feature.** Most of the work in `packages/learning` is
  deciding when NOT to move a bar, and the Learnings page renders that reason as
  prominently as a bar that moved. A calibration that always finds something to
  change is a calibration that is fitting to noise.

## What is left, in the order I would do it

### ~~1. Stage 12 closed: make the learning loop actually learn~~ DONE

Live. `store.calibration(org)` derives a per-category confidence bar from that
workspace's own decisions, it is served on the review-config call, and Stage 9
applies it. The Learnings page shows every bar with the decisions behind it.

Two things a future session should know:

- **The Stage 10 half is still open.** `ARCHITECTURE.md` describes Stage 12 as
  feeding both Stage 9's threshold and Stage 10's verify gate. Only Stage 9 is
  wired. Spending proof where a team's acceptance is genuinely mixed, and less
  where the answer is already obvious from history, is a real cost saving and
  the data to do it is now stored.
- **`services/control-plane/test` is still outside the tsconfig `include`.** The
  `src` half is now checked, which is what mattered (see below). The tests need
  an `await res.json()` typing cleanup first, roughly 150 sites.

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

## Bugs found and fixed in the Stage 12 session

The warning at the bottom of this file held. Five in the repo, four of them live:

- **`requireOrgMember` was called twice and defined nowhere.** `GET
  /api/orgs/:org/analytics` threw a ReferenceError on every request, so the
  Reports page has been answering `500 {"error":"requireOrgMember is not
  defined"}` since it shipped.
- **`services/control-plane` was not in the tsconfig `include` list**, which is
  why that could ship: `npx tsc --noEmit`, a documented gate, had never looked at
  the service. `src` is now included, and fixing what surfaced turned up the next
  one.
- **An unrecognised severity made `reviewerHoursSaved` NaN** for a whole
  workspace. `StoredFinding.severity` is a bare string off the wire and the ROI
  model looks its minutes up by severity, so one odd value poisons the sum.
- **`StoredFinding` dropped `confidence`**, which the orchestrator has always
  sent, and `listDecisions()` dropped `agent`. Both are fields `DecisionRecord`
  declares, so the learning package's inputs were unreachable from the only real
  source of decisions in the product.
- **`Calibration.filterFindings` was a second thresholding path** parallel to
  Stage 9's, and it double-counted: a trusted category had its threshold lowered
  AND each finding's confidence multiplied by up to 1.5, from one signal.
  Removed rather than wired.

Plus two in `calibrate()` itself that only a realistic fixture showed. Probing it
with a simulated three-month workspace before trusting it is the single highest
value thing done this session:

- **The ceiling was a cap, and the cap lied.** A category rejected at 0.78 got a
  bar of 0.75 (the ceiling), which suppresses none of them, under a sentence
  claiming it held back 100%. The ceiling is now a refusal: a category needing a
  higher bar is left alone and told why.
- **It fitted to a 0.02 gap.** Accepts at 0.80 and rejects at 0.78 produced a
  confident-looking cut at 0.79 that predicts nothing, because the next finding
  lands either side of it by chance. A minimum margin between the bar and the
  lowest finding the team kept now reads that as the noise it is.

---

## The prompt

> I am continuing work on Cavix, an AI code reviewer. Read `HANDOFF.md`,
> `README.md` and `CHANGELOG.md` first, then `ARCHITECTURE.md` for the seams.
>
> Stages 0 through 12 already run on real pull requests. What is left is listed
> in HANDOFF.md. Build **item 2: Mermaid sequence diagrams in the review.**
>
> The dashboard has had a "Sequence diagram" toggle marked "soon" since the
> settings page was written. `OrgSettings.reviewSections.sequenceDiagram` is
> stored and served, and nothing generates one, so a customer can switch on a
> section that does not exist. GitHub renders Mermaid natively in a comment, and
> the one thing a reviewer cannot get from a diff is the call order across files
> that the change alters.
>
> Specifically:
> 1. Generate a `sequenceDiagram` for the changed code path. Decide what it is a
>    diagram OF, and say why: a per-file diagram of everything is noise, and a
>    diagram of a path Cavix did not actually trace is a drawing.
> 2. Decide where it comes from. Stage 4's call graph over the changed files is
>    already built during a deep review and is a real, measured structure; a
>    model asked to draw one from the diff is not. If you use the model at all,
>    say which half is measured and which is written.
> 3. Wire the toggle. `reviewSections.sequenceDiagram` reaches the orchestrator
>    on the review-config call but is dropped by `coerce()` in
>    `services/orchestrator/src/byok/reviewConfig.ts`, which only knows five
>    sections. Off must mean off, and the section must be absent when the graph
>    had nothing to draw rather than rendering an empty diagram.
> 4. It must survive a reader. Mermaid that fails to parse renders as a red error
>    box on the pull request, so the output needs escaping for identifiers with
>    quotes, brackets and non-ASCII, and a size cap: a forty-participant diagram
>    is worse than no diagram.
>
> Before writing anything, tell me the plan, including what the diagram will look
> like on a real pull request and what it will do on a change where the graph
> resolves nothing. Do not start building until I have seen it. While you are in
> there, sweep the repo for bugs and tell me what you find.
>
> House rules, all enforced by tests: no emoji anywhere Cavix posts, no em or en
> dashes, the Scope module never states a number that was not measured, and every
> new stage fails soft rather than costing a customer their review. Add tests
> that need no infrastructure, and keep `npm test`, `npx tsc --noEmit` and
> `cd services/edge && go test ./...` green.
>
> A warning worth taking seriously: every package in this repo was written and
> tested and then never run against real input, and every single one I have wired
> so far had bugs that only appeared on realistic data. The last three sessions
> found fifteen between them, including matching logic that reported nothing at
> all, a metric that told reviewers to ignore real failures, and a page that has
> been returning 500 since it shipped. Probe it with a realistic fixture before
> you trust a line of it, and write the fixture before you write the code.
