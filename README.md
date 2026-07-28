# Cavix

**AI code review that proves its findings before it speaks.**

Cavix is a bot you install on your GitHub organisation. When someone opens a pull
request, it reads the change, works out what could go wrong, and then does the
part most review tools skip: it runs the code in a locked-down sandbox to check
whether the bug it thinks it found is actually real. Anything it cannot reproduce
never gets posted. What lands on your pull request is a review with receipts.

It runs on your own servers if you want it to (including with no internet access
at all), and uses your own AI provider key so your code never touches ours.
GitLab, Bitbucket and Azure DevOps adapters are written and tested in
[packages/platforms/](packages/platforms/) but are not yet reachable from the
running service, so today the live product is GitHub only.

---

## New to this? Start here

A few terms used throughout, in plain English:

| Term | What it means |
|---|---|
| **PR** | Pull request. The GitHub page where someone proposes a code change and other people review it before it gets merged. |
| **Diff** | The list of lines a change adds and removes. This is what Cavix reads. |
| **Finding** | One problem Cavix reports, at one file and line, with a severity. |
| **Verified finding** | A finding Cavix reproduced by actually running the code. It wrote a failing test, ran it, watched it fail, applied its own suggested fix, and watched it pass. |
| **Sandbox** | A throwaway container with no network access where that code gets run. Nothing escapes it and nothing is kept afterwards. |
| **BYOK** | Bring Your Own Key. You paste your Anthropic, OpenAI or Google API key into the Cavix dashboard, and Cavix calls that provider as you. You pay them directly, and we never hold your key's spend. |
| **Air-gapped** | A deployment with no route to the public internet. Common in banks, defence and healthcare. Cavix runs there with a self-hosted model. |
| **Control plane** | The Cavix dashboard: where you connect repositories, set the review rules, and see past reviews. |
| **Orchestrator** | The service that does the actual reviewing, one pull request at a time. |

### Why "proves its findings" matters

Every AI reviewer produces false positives. A tool that is wrong often enough
gets muted, and a muted tool is worth nothing. So Cavix does not post a finding
just because a model was confident about it.

For a suspected bug, Cavix writes a test that fails only if the bug is real,
runs it in the sandbox, applies its suggested fix and runs it again. For a
suspected security hole, it writes a proof-of-concept exploit and tries it. If
the bug does not reproduce, the finding is thrown away and the review says how
many were thrown away. If it does reproduce, the transcript goes on the comment
so you can check the work yourself.

That is the whole pitch. Fewer comments, all of them true.

---

## What a review actually looks like

Cavix writes to four places on a pull request, each with a different job.

### 0. The Checks box

The first thing that happens, before any model is called, is that Cavix appears
in the pull request's Checks box next to your CI, under the name `Cavix Review`.
It shows as running while the model reads the diff and the sandbox reproduces
what it found, then closes with the outcome:

```
Cavix Review   in progress   Reviewing this pull request
Cavix Review   success       Review complete. 1 finding, highest critical, 1 verified by execution
```

Expand it and you get the same Review Scope table the review comment opens with,
and a Details link straight to the review. The point is that nobody has to wonder
whether Cavix is running. Silence means the webhook never arrived, and the Checks
box says so.

An org can mark `Cavix Review` a required check under branch protection to gate
merges on it. It concludes:

| Conclusion | When |
|---|---|
| success | The review posted and nothing you asked Cavix to block on failed |
| failure | You turned blocking on, and a pre-merge rule failed or a finding hit your blocking severity |
| neutral | Cavix could not finish (a bad key, a provider outage). GitHub counts neutral as passing |

That last row is on purpose. A red cross for a Cavix outage would mean an expired
API key silently blocks every merge in the org, so a run that never happened never
blocks anyone. The check title says plainly that no review was completed.

Check runs need a GitHub App with the `Checks: Read & write` permission. On a
deployment running a personal access token there is simply no row, and the review
posts exactly as normal.

### 1. The pull request description

Cavix owns a marked-off block inside the description and rewrites only that
block, so whatever the author wrote stays exactly as they wrote it. The block
carries a short summary of what the change does and why, and one bullet per
changed file. That is all it carries.

```markdown
## ◈ Cavix Summary

Routes Stripe charge.refunded webhooks straight into issueRefund and writes an
audit row for every refund. The refund path is not idempotent, so a re-delivered
webhook can refund the same charge twice.

---

### What Changed

- `services/payments/refund.ts` · Issue the refund against the original charge
- `services/payments/webhook.ts` · Handle Stripe retry deliveries
- `test/refund.test.ts` · New retry regression test
```

**No findings go here.** No verdict, no counts, no severities, not even a
severity mark next to a file. This is deliberate and it matters.

What a change does is durable. It is true on the first push and still true at
merge. What is wrong with the change is not: the author reads the review, pushes
a fix, and thirty seconds later a description that still says "1 critical" is
lying to every person who opens the page afterwards. They cannot correct it
either, because the block belongs to Cavix, not to them. So findings live on the
review comment, which is dated, can be superseded by a fresh review, and gets
marked outdated by GitHub on its own once the lines move.

No line counts either, no "files changed" totals, no plus-and-minus columns.
GitHub already prints all of that a few pixels above, and repeating it wastes the
most valuable space on the page.

### 2. The review comment

This is where the whole review lives: the scope module, the verdict, and every
finding. It opens with the **Review Scope & Effort** module, which says something
no other tool on the page says: how far the analysis reached, what the security
and policy gates read, how much of the result stands on executed evidence, and
how much human attention is left to spend.

```markdown
### ◈ Review Scope & Effort

| | Signal | Reading |
| :--: | :--- | :--- |
| ◇ | **Deep Scan** | 2 subsystems traversed · 3 changed regions · TypeScript |
| ◇ | **Symbol Scope** | `issueRefund`, `onWebhook` |
| ⬢ | **AST Verification** | 128 symbols resolved, cross-file impact mapped |
| ▲ | **Security Gate** | ◆ 1 exposure, highest **critical** |
| ⬢ | **Execution Proof** | 1 of 4 findings reproduced in a sealed sandbox, 1 discarded |
| ▲ | **Policy Gate** | 1 of 3 org rules failing |
| ◇ | **Confidence Score** | ●●●●○ 73% mean across the findings below |
| ◇ | **Review Effort** | ◆◆◆◇◇ **3 of 5**, a focused read |
```

Above the table sits a small strip of coloured badges carrying the same facts.
Below it comes the verdict callout, then a "Fix these first" callout naming only
the findings at high severity or above, so a reviewer opening a thirty-finding PR
knows which two matter before they start scrolling. Then the findings, grouped by
file.

If Cavix cannot write the description at all, which happens on a fork PR or when
someone revokes the permission, the summary and walkthrough fold into this
comment instead of being lost.

Every number in that module is measured. A row whose stage did not run is left
out rather than filled with something plausible. If Stage 4 never ran, there is
no AST Verification row. One invented statistic is enough to make somebody stop
believing the proof claims, and the proof claims are the product.

### 3. Inline comments

The detail hangs on the line at fault, introduced by a GitHub alert callout
whose colour is the severity, followed by the sandbox transcript and a one-click
suggested fix.

````markdown
> [!CAUTION]
> **◆ Refund amount is taken from the untrusted webhook body**
>
> <kbd>⬢ verified</kbd> <kbd>critical</kbd> <kbd>security</kbd> <kbd>confidence 94%</kbd>

A forged webhook body sets the refund amount, and nothing checks it against the
original charge.

**⬢ Execution proof.** The PoC exploit ran against this code in a sealed sandbox:

```text
[repro] node --test webhook.exploit.test.mjs → exit 0   exploit succeeded
[suite] node --test                          → exit 0   existing suite still green
```

```suggestion
  if (!refund.isSettled(id)) await charge.refund(amount);
```
````

---

## The output design rules

These are enforced in code, in [services/orchestrator/src/poster/poster.ts](services/orchestrator/src/poster/poster.ts),
and covered by tests. A review gets forwarded to people who never asked for it,
so it has to hold up as a document.

**No emoji. Not one.** A comment sprinkled with robots and rockets reads like a
toy, and this one gets forwarded to a VP. The visual language is geometric
instead:

| Mark | Means |
|---|---|
| `◆` | critical |
| `◈` | high |
| `◇` | medium, and the neutral row mark |
| `▪` | low |
| `▫` | info |
| `⬢` | proven by execution |
| `▲` | needs attention |
| `✓` `✕` | a policy check passed or failed |
| `●●●●○` | a meter, filled to hollow |

There is a test that scans every surface Cavix posts and fails the build if a
single emoji gets in.

**Colour comes from things GitHub renders natively.** Alert callouts
(`> [!CAUTION]`, `> [!WARNING]`, `> [!IMPORTANT]`, `> [!NOTE]`) draw a coloured
vertical border, so the weight of a comment lands before the first word is read.
Fenced `diff`, `ts` and `go` blocks carry syntax highlighting. `<kbd>` draws a
bordered chip for the severity and confidence line. Colour is never carried by
an emoji.

**A small badge strip, and only there.** Up to five shields.io badges sit above
the Scope table in muted hex: crimson, burnt amber, amber gold, slate, emerald.
Never one badge per finding, because a hundred-finding review would then load
like a web page from 2008. Set `CAVIX_REVIEW_BADGES=off` for an air-gapped
GitHub Enterprise, where the image proxy cannot reach shields.io. The same facts
stay in the table underneath, so all you lose is the colour.

**Typography.** One H2 per surface, H3 for a section, H4 for a file, nothing
larger. Sections separated by a horizontal rule with a blank line each side.
Table rows are two lines at most, the second one small and dim.

**Plain punctuation.** No em dashes or en dashes anywhere, including in text the
model wrote. A `plain()` pass rewrites them on the way out along with smart
quotes and ellipsis characters, because they read as machine-written the moment
a human skims the comment.

---

## How it works

Thirteen stages, from webhook to posted review.

Two columns, because they are two different questions. **Built** means the code
exists and is tested. **Live** means it runs when a real pull request is opened.
They are not the same thing yet, and saying otherwise would be the first
dishonest claim in a product whose whole pitch is that it does not make those.

| # | Stage | Built | Live on a real PR |
|---|-------|:---:|---|
| 0 | Edge ingestion and concurrency (Go webhook receiver, priority queue) | yes | yes |
| 1 | Durable job orchestration (BullMQ today, Temporal-swappable) | yes | yes |
| 2 | Ephemeral sandbox provisioning, no network egress | yes | yes (Local, Docker, Cloudflare) |
| 3 | Deterministic pre-analysis: linters, SAST, secret scan | yes | **yes** |
| 3c | Optional org policy gate | yes | yes |
| 4 | AST plus intra-repo semantic graph | yes (heuristic parsers) | **yes**, over the changed files |
| 5 | Cross-repo and microservice impact graph | yes | not yet |
| 6 | CI/CD telemetry and regression prediction | yes | not yet |
| 7 | Context retrieval and compression | yes | **yes** |
| 8 | Multi-agent ensemble with model routing | yes (7 agents) | **yes** |
| 9 | Adjudication: dedupe, vote, calibrate, threshold | yes | **yes** |
| 10 | Execution-grounded verification: reproduce, PoC, fix-and-run | yes | **yes** |
| 11 | Synthesis and posting | yes (5 platforms) | yes, GitHub only |
| 12 | Feedback and learning loop | yes | decisions are recorded, nothing consumes them yet |
| 13 | Teardown, zero retention, observability, cost accounting | yes | sandbox teardown and cost accounting |

Stages 3 through 9 are composed by [packages/pipeline/](packages/pipeline/) and
run on every pull request. If any of it fails, the review falls back to a single
model pass over the diff rather than failing: `CAVIX_DEEP_REVIEW=off` makes that
fallback the permanent behaviour and roughly halves the model spend per review.

Stage 4 indexes the files this pull request changed, not the whole repository. A
full-repo index belongs to an onboarding job, not to a hot path that has to
answer while somebody is looking at the page.

The path a pull request takes:

1. GitHub sends a webhook to the Go edge service, which verifies the signature,
   drops duplicates and pushes a job onto a Redis Stream.
2. The orchestrator picks the job up and immediately opens the `Cavix Review`
   check run, so the pull request shows work in progress before anything slow
   starts. Then it fetches the diff and asks the control plane what this
   organisation's settings are.
3. If the owner enabled the policy gate, plain-English rules compile into
   deterministic checks and run over the changed files first. These are facts,
   not model output, so they skip the sandbox and cannot be dropped later.
4. The diff goes to the model through the BYOK gateway.
5. Every finding the model is confident about goes to the sandbox. Anything that
   fails to reproduce is dropped, and the count of dropped findings is stated on
   the review.
6. The summary and the walkthrough are written into the pull request
   description. The verdict, the scope module and the findings go into a review
   comment, and the detail into inline comments.
7. The check run closes with its conclusion and a link to the review.
8. The review is recorded on the dashboard, where accepting or rejecting a
   finding feeds the calibration loop.

Cavix posts as a plain comment by default and never blocks a merge. Blocking is
off unless an owner turns it on, and even then it only escalates for a failing
policy rule or a finding at or above the severity they picked.

---

## Quick start

You need Node 22.7 or newer, Go 1.21 or newer, and Docker for the local
Postgres and Redis.

```bash
# 1. Infrastructure
docker compose up -d

# 2. The Go edge service
cd services/edge && go test ./... && go run ./cmd/edge

# 3. Everything else
npm install
npm test        # 428 tests, no infrastructure needed
npm run demo    # prints a full review with no API key and no network
```

`npm run demo` is the fastest way to see the output. It wires the real workflow
against in-process fakes, runs a real local sandbox, and prints the exact payload
that would go to GitHub.

Every unit test runs with zero infrastructure. Redis, Postgres, GitHub and the
model providers all sit behind interfaces with in-process fakes, and the tests
that need real infrastructure are gated behind environment variables.

### Other demos

| Command | What it shows |
|---|---|
| `npm run demo` | A full Phase 0 review, from webhook job to posted comment |
| `npm run phase1` | A cross-file catch and the policy gate |
| `npm run verify-demo` | A real bug reproduced plus a PoC exploit, in a real sandbox |
| `npm run orggraph-demo` | A cross-repo impact trace |
| `npm run airgap-demo` | Proof of no egress, an offline licence, and zero retention |
| `npm run phase4-demo` | A verified fix PR, an IDE review, and ROI numbers |
| `npm run eval` | Precision, recall and F1 across Phase 0, 1 and 2, side by side |
| `npm run eval:bench` | External benchmarks (SWE-bench, Defects4J, CVEFixes) |

---

## What an owner controls

All of this lives on the dashboard, under Review settings. The orchestrator
fetches it once per review and obeys. If the dashboard is unreachable, it falls
back to safe defaults rather than to "off": verification on, summary in the
description, blocking off.

| Setting | Default | What it does |
|---|---|---|
| Verify findings | On | Reproduce findings in a sandbox before posting, and drop the ones that fail |
| Summary location | Description | Whether the summary and walkthrough go in the PR description or the review comment. Findings stay on the comment either way |
| Let Cavix request changes | Off | Post as Request Changes instead of a comment, which blocks merge on a protected branch |
| Blocking severities | critical | Which severities count as a failure while blocking is on |
| Pre-merge checks | Off | Plain-English org rules compiled into deterministic, non-bypassable gates |
| Summary | On | The plain-English description of the change |
| Changed-files walkthrough | On | One bullet per changed file saying what it now does |
| Review Scope & Effort | On | The module that opens the review comment |
| Inline findings | On | Line-level comments. Turning this off moves every explanation into the review comment |
| Verification proof | On | The sandbox transcript, commands and exit codes |
| Comment tone | Concise | concise, detailed, educational, assertive or chill |
| Path filters | None | Globs for which files get reviewed |

Repositories can also carry a `.cavix.yaml` or `.cavix.json` for per-repo path
filters, disabled agents, tone and `failOn` severities.

## Talking to Cavix on a pull request

Anyone with write access to the repository can mention Cavix in a comment.

| Command | What it does | Costs a model call |
|---|---|:---:|
| `@cavixcode review` | Full review of the current head. Deletes Cavix's earlier inline comments first, dismisses a stale blocking review, and lifts a pause. | yes |
| `@cavixcode summary` | Rewrites just the summary in the description. No findings, no inline comments. | yes, one cheap pass |
| `@cavixcode <question>` | Answers a question about the change, for example `@cavixcode does this handle a webhook retry?` | yes, one cheap pass |
| `@cavixcode resolve` | Dismisses Cavix's blocking review and removes its inline comments. | no |
| `@cavixcode pause` | Stops automatic reviews on this pull request. | no |
| `@cavixcode resume` | Starts them again. | no |
| `@cavixcode configure` | Points at the dashboard. | no |
| `@cavixcode help` | The table above, posted on the PR. | no |

The pause is stored as a hidden marker in Cavix's own comment on the pull
request, not in a database. The orchestrator is a restartable, horizontally
scaled worker, so anything held in its memory is lost on the next deploy and
invisible to its siblings. GitHub is already the shared, durable store both of
them can see.

Cavix adds an eyes reaction to your comment the moment it picks the command up,
so silence always means the webhook never arrived rather than "it is thinking".

One thing GitHub does not allow, so neither can we: a review posted as a plain
comment can be neither dismissed nor deleted through the API, by anyone,
including the account that posted it. `review` and `resolve` therefore clear the
inline comments and dismiss a blocking review, and GitHub collapses the old
review bodies as outdated on its own once the lines move.

---

## Repository layout

```
services/
  edge/            Stage 0. Go webhook receiver, writes to a Redis Stream
  orchestrator/    Stage 1. The durable workflow: diff, model pass, sandbox, post
  control-plane/   The dashboard API and UI: onboarding, settings, past reviews
packages/
  core/            Shared domain types and the unified-diff parser
  gateway/         The BYOK-first model gateway, with token and cost logging
  sandbox/         Stage 2. One sandbox port, three backends
  deterministic/   Stage 3. Secret scanning, SAST, and a 24-linter registry
  policy/          Stage 3c. The optional, off-by-default org policy gate
  analyzer/        Stage 4. Code graph, blast radius, incremental index
  context/         Stage 7. RAG context assembly and cheap-model compression
  agents/          Stage 8. The 7-agent ensemble and model routing
  adjudicator/     Stage 9. Dedupe, vote, threshold, policy immunity
  verifier/        Stage 10. Execution-grounded verification
  orggraph/        Stage 5. Cross-repo impact, contracts to consumer call sites
  telemetry/       Stage 6. CI/CD telemetry and regression prediction
  learning/        Stage 12. The accept and reject calibration loop
  platforms/       Stage 11. GitHub, GitLab, Bitbucket and Azure adapters
  governance/      SSO/SAML, SCIM, RBAC, tamper-evident audit log
  zero-retention/  Stage 13. Verified proof that no customer code persists
  license/         Offline Ed25519 signed licences
  legacy/          COBOL, PL/SQL, C, C++, Java, .NET and IaC modernization
  fixpr/           The verified fix-PR agent. Always a draft, never auto-merged
  ide/             Pre-PR local review engine, for the VS Code and JetBrains plugins
  batch/           Modernization at scale, verification-gated per change
  lenses/          The review-lens marketplace and per-org confidence models
  analytics/       ROI: action rate, defects caught, reviewer-hours saved
  review-session/  Fresh vs incremental reviews, and stale-review removal
  repoconfig/      The .cavix.yaml and .cavix.json parser
  pipeline/        Composes stages 3, 3c, 4, 7, 8 and 9 into runPhase1Review
eval/              Gold-labelled PRs, competitor comparison, external benchmarks
deploy/            Helm chart with deny-all egress, Terraform, cosign signing
docs/compliance/   Air-gapped data flow, hardening, SOC 2 and ISO 27001 mapping
editors/           The VS Code and JetBrains plugin manifests
```

---

## Configuration

The orchestrator reads everything from the environment. The ones you are most
likely to touch:

| Variable | Default | Purpose |
|---|---|---|
| `CAVIX_REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection. A single URL, or the discrete `CAVIX_REDIS_HOST` and friends |
| `CAVIX_APP_ID` | none | GitHub App id. Required in production |
| `CAVIX_APP_PRIVATE_KEY_FILE` | none | Path to the App's .pem. Prefer this over the inline variable, since hosting dashboards mangle multi-line values |
| `CAVIX_CONTROL_PLANE_URL` | none | Where to fetch org settings and record reviews. Without it, reviews never reach the dashboard |
| `CAVIX_INTERNAL_TOKEN` | none | Shared secret between the orchestrator and the control plane |
| `CAVIX_LLM_PROVIDER` | `anthropic` | Fallback provider when an org has not chosen one |
| `CAVIX_LLM_MODEL` | `claude-opus-5` | Fallback model. Reviews are the product, so capability wins over cost, and BYOK means the org pays their provider directly |
| `CAVIX_SUMMARY_IN_DESCRIPTION` | on | Set to `off` to keep the summary in the review comment |
| `CAVIX_REVIEW_BADGES` | on | Set to `off` for air-gapped GitHub Enterprise, where the image proxy cannot reach shields.io |
| `CAVIX_DEEP_REVIEW` | on | Set to `off` to review with a single model pass instead of stages 3 to 9. Halves the model spend per review, at 81.8% F1 instead of 95.7% |
| `CAVIX_VERIFY` | on | Set to `off` to post findings without reproducing them in a sandbox first |
| `CAVIX_BOT_HANDLE` | `cavixcode` | The handle people type to trigger a command |

See [SETUP_KEYS.md](SETUP_KEYS.md) for how to get each credential, and
[GUIDE.md](GUIDE.md) §8B for the full production install walkthrough.

---

## Running it yourself

Cavix is built to run on your infrastructure, including with no internet access.

- [deploy/README.md](deploy/README.md) has the Helm chart, which ships with a
  deny-all egress network policy, plus Terraform and cosign image signing.
- [docs/compliance/AIR_GAPPED_DATA_FLOW.md](docs/compliance/AIR_GAPPED_DATA_FLOW.md)
  traces every byte in an air-gapped install and shows how the no-egress claim is
  tested rather than asserted.
- [docs/compliance/SECURITY_HARDENING.md](docs/compliance/SECURITY_HARDENING.md)
  and [docs/compliance/SOC2_ISO27001_READINESS.md](docs/compliance/SOC2_ISO27001_READINESS.md)
  cover the control mapping for a security review.

Run `npm run airgap-demo` to watch it prove no egress, validate an offline
licence and verify that nothing was retained.

---

## Further reading

- [ARCHITECTURE.md](ARCHITECTURE.md) for why each seam is where it is
- [GUIDE.md](GUIDE.md) for the operator's walkthrough, from zero to a live install
- [CHANGELOG.md](CHANGELOG.md) for what shipped when
- [SETUP_KEYS.md](SETUP_KEYS.md) for the credentials you need and where to get them
