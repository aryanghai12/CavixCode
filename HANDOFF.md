# Handoff: where Cavix stands, and what is left

Paste the prompt at the bottom into a fresh Claude Code session in this repo.
Everything above it is the context that prompt assumes.

---

## Where the product stands

The live review path (`services/orchestrator/src/main.ts` → `runReview`) runs
**all thirteen stages** on a real pull request, on **all five code hosts**.

| Stage | Status |
|---|---|
| 0 Edge ingestion (Go) | live, all five hosts on one `/webhook` |
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
| 11 Synthesis and posting | live: **GitHub, GitLab, Bitbucket Cloud, Bitbucket Data Center, Azure DevOps** |
| 12 Learning loop | live, **both halves**: the confidence bar AND where proof is spent |
| 13 Teardown, retention, observability, cost | all four live |

Gates, all green as of this handoff:

```
npm test                    749 tests
npx tsc --noEmit            0 errors, and it now covers control-plane tests and scripts/
cd services/edge && go test ./...
npm run demo                npm run eval (F1 100%)  npm run airgap-demo  npm run phase4-demo
```

## What was built this session

### Azure DevOps, and the differ it needed

The seam held for a fourth and a fifth platform with no workflow change: a client
against `ReviewPlatform`, a `capabilities` declaration, a normalizer in the Go
edge, one line in `main.ts`. What did NOT carry over is the diff.

**`packages/differ` is the load-bearing part of this session.** Azure's
`diffs/commits` returns a list of changed PATHS and no content, so on Azure the
diff is computed from the two versions of each file. It is Myers' published
algorithm, exact and minimal, and it was checked line for line against
`git diff --no-index -U3` on ten cases BEFORE a line of the Azure client existed.
That comparison immediately caught a real bug (see below), which is the argument
for doing it in that order.

Four things a future session should know:

- **It refuses rather than approximating, and that is the design.** Everything
  downstream treats the diff as exact: which lines a comment may anchor to, what
  line a finding points at, where the sandbox reproduces a bug. An approximate
  diff does not fail, it silently moves findings onto the wrong lines. So past
  the edit budget, the line budget, or on binary content, the file is left out
  and NAMED on the review through `ReviewPlatform.diffLimitations`.
- **`diffLimitations` is keyed by pull request, not held on the client.** One
  client serves every review this orchestrator runs concurrently. A plain field
  there would report whichever pull request finished last, under somebody else's
  review, which is a bug this repo has already shipped once (the GitLab client's
  refused-anchor counter).
- **The memory bound is the `maxEdits` cap, not the line cap.** Myers needs one
  frontier per edit distance to backtrack, so memory is O(D²). The frontiers are
  stored at their live width rather than the worst case, which is the difference
  between kilobytes on a normal file and megabytes on every file.
- **Azure refuses chat commands, on purpose.** Same reason as Bitbucket:
  answering "may this arbitrary user push here?" needs organisation-level scopes
  a review bot should not hold. `commandsAllowed` returns false and the edge
  mints no command job.

One genuinely new thing at the edge: **Azure service hooks sign nothing.** HTTP
Basic is the only credential they can carry, so that is what is verified, in
constant time, before the body is parsed. It authenticates the sender but not the
body, which is why it has its own secret. Azure also sends no event header to
route on, so it is recognised by an optional `X-Cavix-Platform` header or by
elimination, and then authenticated against its own secret either way.

### Bitbucket Data Center

A separate client, not a base URL on the Cloud one, and worth saying why: the two
share only the name. Different REST surface (`/rest/api/1.0/projects/KEY/...`),
different payload shapes (`text` not `content.raw`), different anchors (`anchor`
not `inline`), different pagination, a build-status API on a different root, and
**optimistic locking on every write** (a stale `version` is a 409 rather than a
silent clobber). A shared class would have meant a branch in every method.

It can list a repository tree cheaply, which Cloud cannot, so Stage 5 works here.
It has no CI duration to trend, so `ciHistory` is false rather than reporting
plausible zeros.

### Stage 12's other half

`ARCHITECTURE.md` had described the learning loop as feeding both Stage 9's
threshold and Stage 10's verify gate. Only Stage 9 was wired. Now both are, on
the same `review-config` call, so it cost zero extra round trips.

The interesting property, and the reason it is worth having:

- **The case where a threshold is useless is exactly the case where execution is
  not.** When a workspace's accepts and rejects overlap at every confidence
  level, Stage 9 correctly refuses to move the bar. That refusal is a statement
  about CONFIDENCE, not a shrug: what separates a real finding from a plausible
  one there is whether it reproduces. So `verify: "always"` runs the sandbox on
  that category, including on findings the default gate would skip as nits.
- `verify: "never"` where they accept essentially everything, because a proof
  changes no decision they were going to make and a sandbox run is the most
  expensive thing in a review.
- **Critical, high and security are proven regardless.** They are checked BEFORE
  the learned policy is consulted. Their proof is the product's own claim, and no
  volume of accepts is a reason to stop making it. There is a test.
- Like the retention hook, the policy rides on the per-review `VerifyContext` and
  never on the `Verifier`, which is built once at boot and shared by every
  concurrent review.

## Bugs found and fixed this session

The warning at the bottom of this file held again. Seven, six of them live:

- **Every file and line permalink in a review pointed at `github.com`.** The
  poster hardcoded the host. GitLab and Bitbucket have had users since they
  shipped, and on both of them a reader who clicked a finding's line number left
  for a github.com repository that does not exist; on GitHub Enterprise they left
  their own network. Fixed with `ReviewPlatform.webUrl` plus per-host URL
  grammars, which all four differ in and none of which is derivable from another.
  A host that cannot be named renders paths as plain text rather than a wrong link.
- **A deleted file lost its name in `parseUnifiedDiff`.** git writes
  `+++ /dev/null` for a deletion, so the only place the path survives is the
  `---` line, which the parser ignored. Every deleted file rendered as an empty
  code span in the walkthrough, and `subsystem("")` filed each one under the
  repository root and inflated the traversed-subsystem count with it.
- **The secret scanner reported only the FIRST match per pattern per file.** A
  bare `exec` returns one match and stops, so a file leaking a key on line 12 and
  another on line 400 reported the first and said nothing about the second. The
  one nobody is told about is the one nobody rotates.
- **The air-gap egress guard followed redirects without checking them.** An
  allowed host answering `307 Location: https://evil.example` made the runtime
  RE-SEND the request, body and all, to a host the policy forbids. The guard's
  one check passed, and the prompt left the cluster. Redirects are now followed
  by hand, one host check per hop, bounded at five.
- **The Docker sandbox interpolated paths into a shell string and did not confine
  them.** The paths reaching it come from findings, which come from a model
  reading somebody else's diff, and one apostrophe in a filename closed the
  quote. It also let a traversal through where the Local backend has always
  refused one: two implementations of one port disagreeing about that is a port
  that cannot be swapped, which is the entire reason it exists.
- **The dashboard's Integrations panel said "soon" for Bitbucket and Azure**, and
  had done for months after Bitbucket Cloud went live. A dashboard that
  understates the product fails the same way one that overstates it does: the
  page and the pull requests disagree, and the customer believes the page.

And one caught by the git comparison before it could ship, which is the whole
argument for writing the fixture first:

- **The Myers backtrack read past its own frontier at `d = 0`.** Storing each
  frontier at its live width (`-d..d`) is correct for every step except the
  first, where the backtrack reads diagonal `k+1` and that is the seed. Every
  hunk silently lost its leading context and every `@@` start line was wrong with
  it. Nothing about the output looked broken; it just did not match git.

## What is genuinely left

Nothing in the thirteen stages. What remains is smaller:

1. **`ReviewWorkflowDeps.github` should be renamed.** It is the default platform
   client and its type is right (`ReviewPlatform`); only the property name is
   historical, and it is now wrong on five hosts rather than two. Do it in a
   commit that does nothing else, because it touches every construction site in
   the service and in the tests.
2. **Azure's `diffs/commits` truncation is reported but not paged.** When Azure
   says `allChangesIncluded: false` the review says so honestly, which is the
   important half. Paging `$top`/`$skip` to get the rest is ordinary work.
3. **`packages/differ` has no move detection.** git does not do this by default
   either, so the output matches, but a large refactor that moves a function
   between files reads as a delete plus an add. It is a quality-of-diff question,
   not a correctness one.
4. **Bitbucket Data Center's `whoAmI` costs a request** (`X-AUSERNAME` off a
   `/projects?limit=1` probe), and `setParticipantStatus` calls it each time. Only
   on the blocking and dismiss paths, so it is a handful of requests per review at
   worst, but it could be cached per client with a short TTL.
5. **The IDE extension (`editors/vscode`) is excluded from `tsc`**, because it
   type-checks against the `vscode` module's own types, which this repo does not
   install. It has its own build. Everything else shippable is now under the gate.

## Things to know before you start

- **The house style is enforced.** No emoji anywhere Cavix posts (there is a test
  that fails the build). No em dashes or en dashes. Geometric marks: `◆` critical,
  `◈` high, `◇` medium, `▪` low, `▫` info, `⬢` proven, `▲` attention.
- **The Scope module never states a number it did not measure.** Rows render only
  when their stage actually ran and covered what it claims. The newest example is
  the `Diff Coverage` row and the `Not Reviewed` section, which exist so an Azure
  review cannot quietly claim to have read a file it could not diff.
- **Every new stage must fail soft.** `deepReview`, `verify`, `blastRadius`,
  `regression` and `indexGraph` are all injected steps whose failure falls back
  rather than costing a customer their review. Copy that shape.
- **The PR description carries no findings.** Only what the change does. Findings
  go on the review comment, which is dated and supersedable.
- **Per-review state never lives on a client or a `Verifier`.** Both are built
  once at boot and shared by every concurrent review. Key it by ref, or put it on
  the per-review context. This has been the source of two separate bugs.
- **A platform that cannot do something says so on the review.** `capabilities`
  exists so the product can say it, not so the code can branch: the workflow
  branches on a capability in exactly two places and both change what a human is
  told rather than what the pipeline computes.
- Tests run with zero infrastructure. Keep it that way.

## Where the seams are, if you are adding a sixth platform

Five worked examples now. In order:

1. `services/orchestrator/src/<host>/rest.ts` implementing `ReviewPlatform`, with
   an honest `capabilities` object.
2. `commandsAllowed` must WORK or return false. GitHub answers true because the
   edge already decided from the webhook's association. GitLab asks the members
   API. Bitbucket (both) and Azure refuse. There is no fourth option.
3. A normalizer in `services/edge/internal/webhook/`, with its own secret, routed
   by its own header before the body is parsed.
4. `PlatformName`, the `canonical.Platform*` constant, `PLATFORM_LABEL` in the
   poster, and the `blobUrl` grammar.
5. One block in `main.ts`, and the platform's key in the control-plane's
   `TokenPlatform`.

---

## The prompt

> I am continuing work on Cavix, an AI code reviewer. Read `HANDOFF.md`,
> `README.md` and `CHANGELOG.md` first, then `ARCHITECTURE.md` for the seams.
>
> All thirteen stages run on real pull requests, on all five code hosts, and the
> learning loop is closed on both ends. There is no large feature outstanding.
> What is left is listed in HANDOFF.md under "What is genuinely left", and item 1
> (renaming `ReviewWorkflowDeps.github`) is the one worth doing first, in a commit
> that does nothing else.
>
> So the real task is the one this codebase rewards most: **pick a package, probe
> it with a realistic fixture, and tell me what breaks.** Every package here was
> written and tested and then, in most cases, never run against real input, and
> every single one that has been wired so far had bugs that only appeared on
> realistic data. Eight sessions have found forty-one between them, including
> matching logic that reported nothing at all, a metric that told reviewers to
> ignore real failures, a page that had been returning 500 since it shipped,
> three dashboard switches a customer could flip that changed nothing, a command
> path anyone on the internet could have driven, a compliance proof that could not
> fail on the only backend customers run, every permalink in every non-GitHub
> review pointing at a repository that does not exist, and an egress guard that
> would follow a redirect straight out of an air-gapped cluster.
>
> The packages with the least real-input exposure are, roughly in order:
> `packages/context` (Stage 7's assembler and compressor), `packages/orggraph`
> (Stage 5's contract and consumer extraction), `packages/telemetry` (Stage 6's
> regression predictor), `packages/analyzer`'s heuristic parsers, and
> `packages/agents`' prompt and parse layer. Any of those, probed properly, is
> worth more than a new feature.
>
> Write the fixture before you write or change any code, and make it realistic:
> a real-shaped OpenAPI file, a real monorepo path layout, a three-month run of
> CI timings with the variance real pipelines have. If the fixture shows the code
> is right, say so and move on; a session that proves a package works is a good
> session.
>
> House rules, all enforced by tests: no emoji anywhere Cavix posts, no em or en
> dashes, the Scope module never states a number that was not measured, every
> stage fails soft rather than costing a customer their review, and per-review
> state never lives on an object built at boot. Add tests that need no
> infrastructure, and keep `npm test`, `npx tsc --noEmit` and
> `cd services/edge && go test ./...` green.
