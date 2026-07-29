# Handoff: what is left to build in Cavix

Paste the prompt at the bottom into a fresh Claude Code session in this repo.
Everything above it is the context that prompt assumes.

---

## Where the product stands

The live review path (`services/orchestrator/src/main.ts` → `runReview`) now runs
stages 0 through 12 and part of 13 on a real pull request.

| Stage | Status |
|---|---|
| 0 Edge ingestion (Go) | live |
| 1 Durable orchestration (BullMQ) | live |
| 2 Sandbox | live |
| 3 Deterministic scanners | live |
| 3c Org policy gate | live |
| 4 AST + call graph | live, over the changed files only; also draws the call-flow diagram |
| 5 Cross-repo impact graph | live |
| 6 CI/CD telemetry | live |
| 7 Context + compression | live |
| 8 Seven-agent ensemble | live |
| 9 Adjudication | live |
| 10 Execution verification | live |
| 11 Synthesis and posting | live, **GitHub and GitLab** (incl. self-managed) |
| 12 Learning loop | live, per-category confidence bars from the org's own decisions |
| 13 Teardown, retention, cost | live: teardown verified per review with a retrievable attestation, plus cost. Observability still absent |

Run `npm test` (655 tests), `npx tsc --noEmit`, `npm run demo`, `npm run eval`,
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

### ~~2. Mermaid sequence diagrams in the review~~ DONE

Live. `traceSequence` in `packages/analyzer` walks Stage 4's graph from the
symbols the diff touched, and `poster/mermaid.ts` renders it into the PR
description under the walkthrough. The dashboard toggle is real.

Three things a future session should know:

- **The reach is the index's reach.** Stage 4 indexes the changed files and
  nothing else, so the diagram shows how the CHANGED FILES call each other, not
  how the change reaches the rest of the codebase. Widening it means fetching
  imported files during a review, which is API reads on the hot path, and the
  architecture deliberately puts a full-repo index in an onboarding job instead.
  If you widen it, widen `fetchSources`, not the trace.
- **Do not let a model near it.** Every arrow is a resolved call. The moment one
  arrow is inferred, a reader cannot tell which arrows are measured, and the
  diagram is worth less than nothing.
- **`@cavixcode summary` drops the diagram**, because summary mode never builds
  the graph and the block is rewritten whole. That is deliberate: republishing
  the previous diagram would show the code as it was before the push that
  prompted the refresh. Worth revisiting only if summary mode ever gets a graph.

### ~~3. The other four platforms~~ GITLAB DONE

Live. The port is `ReviewPlatform` with a `capabilities` declaration,
`RestGitLabClient` implements it, the edge ingests GitLab webhooks on the same
`/webhook` endpoint, and `platform` on the canonical `ReviewJob` routes each job
to its client.

Four things a future session should know:

- **Bitbucket and Azure DevOps are now mechanical, and that was the point.** The
  seam is proven by a second platform. A third means writing a client against
  `ReviewPlatform`, declaring its capabilities, adding a normalizer to the edge,
  and adding it to `platforms` in `main.ts`. No workflow change.
- **`packages/platforms/` is still unused and now actively misleading.** Its
  `ReviewPlatform` is a different, two-method interface that no longer matches
  the real port. Either port its Bitbucket and Azure adapters onto
  `services/orchestrator/src/github/client.ts` and delete the package, or delete
  the package. Leaving two types with the same name is how the next person wires
  the wrong one.
- **`ReviewWorkflowDeps.github` is the default client and is no longer only
  GitHub.** The type is right (`ReviewPlatform`), the property name is
  historical, and renaming it touches every construction site in the service. Do
  it in a commit that does nothing else.
- **GitLab commands are authorized in the ORCHESTRATOR, not the edge, and that
  asymmetry is permanent.** GitHub sends the commenter's association, so the edge
  refuses a passer-by before anything is queued. GitLab's note webhook says who
  commented and nothing about what they may do, so `ReviewPlatform.commandsAllowed`
  asks the API (`members/all`, access level >= 30 = Developer) and fails CLOSED.
  GitHub's implementation returns true without a request, because the edge
  already decided. Any third platform must implement this or it is an open door.

### 4. Bitbucket and Azure DevOps

Same seam, now proven by GitLab. A third platform is: a client against
`ReviewPlatform`, its `capabilities`, a normalizer in the Go edge, and an entry
in `platforms` in `main.ts`. No workflow change. Read the GitLab notes above
first, particularly `commandsAllowed`.

### ~~5. Zero-retention, live~~ DONE

Live. `checkPurged` runs after every sandbox the verifier tears down, the
workflow collects the checks into one attestation per review, and it is stored on
the review and served at `GET /api/reviews/:id/retention`.

Three things a future session should know:

- **`unverifiable` is not a bug to fix.** Cloudflare and Firecracker expose
  nothing this process can inspect after teardown, so their checks say so. The
  temptation will be to report those as clean because the backend's contract says
  they are; do not. The moment "we could not check" and "we checked" report the
  same thing, the artefact is worth nothing to the auditor it exists for.
- **Nothing about customer code may enter the attestation.** There is a test that
  asserts the wire payload contains no path, file name, commit or repository, and
  the control-plane narrows the record on arrival. A future field that seems
  harmless (a workspace id, a sandbox label carrying a repo name) is how this
  becomes the retention problem it exists to disprove.
- **The Docker check proves the container is gone, not that nothing was ever
  written to a disk.** The tmpfs argument is in the `check` string precisely so a
  reader can evaluate it themselves. If someone adds a bind-mounted backend, that
  sentence stops being true and the check has to change with it.

### 6. Observability, the other half of Stage 13

Stage 13 is "teardown, zero retention, observability, cost accounting". Teardown,
retention and cost are live. There is no metrics surface at all: no request
counts, no stage latencies, no queue depth, nothing an operator could put on a
dashboard or alert from. Every number the product has is either on a pull request
or on the customer's own dashboard, and none of it tells the person running
Cavix whether it is healthy.

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

## Bugs found and fixed in the zero-retention session

- **The retention proof verified nothing on the backend customers run.** The
  residual check asked whether `sandbox.workdir` existed on the host. Real on
  Local; on Docker the workdir is `/work` INSIDE the container and no host path
  was ever created, so the check looked, found nothing, and reported clean. A
  proof that cannot fail is not a proof, and this one could not fail anywhere it
  mattered.
- **The attestation's review id would have named the repository.** The
  orchestrator's only candidate was `owner/repo#12@sha`, which puts a repository
  name inside the artefact built to carry nothing about the customer's code. The
  control-plane stamps its own id instead.
- **The verdict was trusted from the wire.** A caller could have asserted
  "proven" over a set of checks that did not support it, manufacturing the exact
  claim the artefact exists to make. It is recomputed server-side now.
- **The air-gapped demo printed `clean=undefined`** once the attestation shape
  changed, which is the failure mode where a demo keeps running and stops
  demonstrating anything.

Plus one found while writing the tests: a fixture whose fake provider matched
`system.includes("test")` also matched the single-model review prompt, so it
returned a generated test instead of findings, nothing was ever verified, no
sandbox was provisioned, and the test asserting the sandbox was destroyed passed
against a review that never made one.

## Bugs found and fixed in the GitLab session

- **`refFromJob` split the repository full name at the FIRST slash.** Harmless on
  GitHub, where a full name has exactly one; on a nested GitLab group
  ("acme/platform/billing") it gave owner `acme` and repo `platform`, silently
  dropping the project so every API call named a repository that is not the one
  under review. It would have broken every subgroup customer on day one.
- **A GitLab command from anyone would have run a review.** The edge cannot check
  a GitLab commenter's permission (no association field in the payload), so the
  first version enqueued the job marked `GITLAB_UNVERIFIED` and nothing checked
  it downstream. Anyone who could see a merge request could have spent a
  customer's model budget in a loop. Closed with `commandsAllowed`, which fails
  closed and gates the free commands too: a passer-by who can `pause` Cavix has
  turned it off for the people who do have access.
- **A shared client held per-review state.** Refused inline anchors were counted
  on the instance, and one client serves every review this orchestrator runs
  concurrently, so the count named whichever merge request finished last.
- **The review re-read the merge request it had just fetched**, once per review,
  for three strings `/changes` already returns.

## Bugs found and fixed in the sequence-diagram session

Two live, two found by probing before trusting:

- **Two more dashboard toggles that changed nothing**, the same class as the
  `sequenceDiagram` one this item was about. `policyEnabled` was a live switch
  duplicating the real Pre-merge checks switch (the field the orchestrator
  actually reads); the duplicate is gone. `airgapped` was a live switch for a
  control enforced process-wide by the gateway's `EgressGuard` and a
  NetworkPolicy, neither of which has ever read the field. It is now derived from
  the deployment and is not patchable: a page that can set it can show a security
  control as ON while the process makes outbound calls.
- **`mermaidText` exceeded its own width cap**, returning `max + 2` characters.
- **Local helper calls crowded the flow out of the diagram.** Drawing every
  same-file call as a self-message filled the step budget on any realistic
  handler; past about fifteen helpers it removed every cross-file arrow and left
  no diagram at all, on exactly the changes most worth one.
- **A non-ASCII identifier was mangled rather than sanitised**: `über()` became
  `ber()`, a wrong label rather than a safe one.

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
> Stages 0 through 13 already run on real pull requests, on GitHub and GitLab.
> What is left is listed in HANDOFF.md. Build **item 6: observability, the other
> half of Stage 13.**
>
> Stage 13 is "teardown, zero retention, observability, cost accounting". Three
> of those four are live. There is no metrics surface at all: no stage latencies,
> no queue depth, no error rates, no counter anywhere. Every number Cavix
> produces is either on a customer's pull request or on their dashboard, and none
> of it tells the person RUNNING Cavix whether it is healthy.
>
> That gap is why every bug in the list above was found by reading code rather
> than by an alert. A page returning 500 since it shipped, a command path open to
> anyone, a retention proof that verified nothing: all of them were live, none of
> them was visible.
>
> Specifically:
> 1. Decide what an operator actually needs to see, and defend the list. A
>    metrics endpoint that exposes everything is a metrics endpoint nobody reads.
>    Latency per stage, queue depth and per-org error rate are candidates; say
>    which you chose and which you rejected.
> 2. Pick the surface and say why. Prometheus text on a `/metrics` endpoint is
>    the obvious answer; the orchestrator already has a health server. An
>    air-gapped install cannot ship telemetry anywhere, so whatever you choose
>    must work with nothing outbound.
> 3. It must carry NO customer code, repository names, paths or finding text. A
>    metrics endpoint is scraped, stored for a year and often less protected than
>    the database. Cardinality is the trap: one label per repository is a
>    time series per repository, which is both a leak and an outage.
> 4. It must cost nothing when nobody is scraping, and it must never be able to
>    fail a review. The same rule as every other stage.
>
> Before writing anything, tell me the plan, including the exact metric names and
> labels and what each one would let an operator diagnose that they cannot
> diagnose today. Do not start building until I have seen it. While you are in
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
> so far had bugs that only appeared on realistic data. The last six sessions
> found thirty between them, including matching logic that reported nothing at
> all, a metric that told reviewers to ignore real failures, a page that has been
> returning 500 since it shipped, three dashboard switches a customer could flip
> that changed nothing, a command path anyone on the internet could have driven,
> and a compliance proof that could not fail on the only backend customers run.
> Probe it with a realistic fixture before you trust a line of it, and write the
> fixture before you write the code.
