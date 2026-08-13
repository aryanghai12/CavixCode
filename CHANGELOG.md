# Changelog

All notable changes to Cavix are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). Dates are ISO-8601.

## [Unreleased]

### Fixed: four bugs found by auditing the last two releases

None of these were caught by a test. All four were found by re-reading the code
that shipped, which is the point worth recording.

- **The heartbeat could keep a dead claim alive for two hours.** A review that
  throws never reaches the clear on the success path. The failure path releases
  the claim, but if that was the call that could not reach the control-plane, the
  timer kept beating and kept refreshing a dead run's claim. That is a worse
  version of the exact wedge the heartbeat was added to prevent. It now stops the
  moment the control-plane says the claim is no longer ours, and a network blip
  still never kills a live review's claim.
- **The critic downgraded legitimate off-diff findings.** It reasoned "the diff
  only reaches line 40, so line 400 is suspicious" whenever the file's real
  length was unknown. That punishes exactly the findings worth keeping: a change
  that breaks a caller further down the file anchors outside the diff, and in a
  500-line file whose diff touches lines 1 to 8, every correct finding looked
  suspicious. The range check now runs only where the length is a fact.
- **A deferred command promised a retry that nothing performed.** It said the
  review "runs on its own in a moment". Returning normally takes the job off the
  queue, so nothing brought it back. It now asks the person to comment again,
  which is true.
- **"Since your last push" reported a meaningless file count.** It was derived
  from the whole `base...head` diff, so on the tenth push of a forty-file pull
  request the review claimed it had re-read forty files. Technically true and
  useless: it said the same thing on every push whatever anybody did.

### Re-reviews know which files a push actually changed

Cavix now fetches the diff between the previous review's commit and this one, and
classifies every file in the pull request as hot (this push changed it), warm
(untouched, but carrying an open finding) or cold (untouched, nothing open).

The verdict domain is never narrowed. `hot + warm + cold` is always the complete
pull request, because the merge introduces all of it, and the check run still
gates on everything the ledger holds open. Only the *description* of what
happened gets more precise: "4 files re-read, 6 unchanged since the last review"
is now a measurement instead of a restatement of the pull request's size.

Every case where narrowing would be unsound falls back to reading everything and
says why: a rebase or force-push, an explicit `@cavixcode review`, a delta that
could not be computed, or two diffs that disagree about which files changed.


### Fixed: a model refusal was being posted as a clean pass

Seen on a live pull request. The model answered:

> I cannot review this pull request as the prompt only asks for a general review
> without a specific question. Please ask a specific question about the code.

It said that inside a well-formed JSON object, with an empty `findings` array.
Zero findings is a valid review, so Cavix took it at face value: it posted "Clean
pass. Nothing to raise", put a green check on the pull request, and spliced the
refusal itself into the description block as the executive summary. Because that
block is rewritten in place, the visible effect was an old comment quietly
changing rather than a new review appearing, which is why it looked like Cavix
had edited its previous review instead of writing a new one.

The reader sees a reviewed, passing pull request. Nothing read a line of it. That
is the worst output this product can produce, because the green check is what
somebody merges on.

A reply that declines is now a failure, not a result. It posts a neutral check
and a comment saying plainly that the model refused, that Cavix did not find zero
problems but did not look, and that the fix is usually a stronger model under
**AI & BYOK**. It is treated as permanent, because asking the same model the same
thing three more times gets the same answer three times slower.

The check is deliberately conservative and needs two signals before it fires: no
findings AND no walkthrough, plus refusal phrasing anchored near the start of the
summary. A review that found something looked, whatever its prose says, and
"Callers cannot retry safely" is a finding, not a refusal.


### Fixed: a stuck review made a pull request unreviewable, and nothing said so

Reported from a live run: a review started, never finished, and every
`@cavixcode review` after it did nothing at all. Three separate mistakes, all
introduced together with the single-in-flight-review slot.

- **A person asking is not a duplicate webhook.** Coalescing exists so two
  deliveries of one push do not produce two reviews. It was also being applied to
  somebody typing `@cavixcode review`, so once a run got stuck holding the slot
  for a commit, every retry of that commit was refused as a duplicate. The person
  kept asking and kept getting silence. An explicit command now takes the slot.
  It still will not interrupt a review that has begun posting.
- **Nothing reported that a review was still alive.** The claim's timestamp was
  set once and never refreshed, so "has the holder gone quiet?" really asked "has
  it been running a while?". A working review now reports in every thirty
  seconds, which lets the stale window drop from twenty minutes to three: a
  holder whose process was restarted or redeployed frees the pull request in
  minutes instead of wedging it, and a legitimately slow review keeps its slot
  instead of having it taken.
- **The refusal was invisible.** A command that produces neither a review nor a
  word is indistinguishable from a broken product. Cavix now says the review is
  queued behind an earlier one, and a skipped job logs `job skipped` with a
  reason instead of `job complete` with zero findings, which read exactly like a
  successful empty review and is how the wedge went unnoticed.


### GitHub asks people which repositories it may read, instead of silently signing them in

Reported: *"I click Connect GitHub and nothing happens. CodeRabbit shows me a
proper screen where I pick my repositories. Cavix just logs me in."*

Nothing was broken. Cavix was walking through the wrong door.

GitHub has two independent permissions, and it says so in as many words:
*"You can install a GitHub App without authorizing the app. Similarly, you can
authorize the app without installing the app."*

- **Authorize** grants access to the signed-in *person*: their name, their email.
  There is no repository picker on that screen and there never has been. Once
  granted, GitHub honours it and redirects straight back, which is OAuth working
  exactly as designed.
- **Install** grants access to *repositories*, and always renders the account
  chooser, the "All repositories / Only select repositories" control and the
  permission list. It re-renders every time, because an installation is a
  configuration rather than a one-time exchange.

"Continue with GitHub" only ever ran the first one.

- The primary action is now `GET /api/github/connect`, which sends people to the
  install screen. `?target_id=` skips the account chooser when they already chose
  an organisation inside Cavix.
- `GET /api/github/setup` catches the return trip, which previously landed
  nowhere at all. It **never trusts** `installation_id` from the query string:
  GitHub's own documentation warns that bad actors can hit that URL with a
  spoofed id, so the installation is verified by enumerating what the user can
  actually see.
- Signing in with zero installations now routes to the install flow rather than
  dropping somebody on a dashboard with an empty Repositories page.
- Every organisation row has a "Change repositories" link to GitHub's configure
  page, which is the only place an existing installation's selection can be
  changed. Without it there was no way back to the picker after the first
  install, which is most of what "it never asks me anything" actually was.
- `installation`, `installation_repositories` and `installation_target` webhooks
  are consumed. Repository access used to be discovered only by polling the next
  time somebody opened the dashboard, so between two page loads Cavix's idea of
  its own reach and GitHub's could disagree with nothing anywhere noticing.
- The dead `scope=repo` parameter is gone. A GitHub App's user token does not use
  scopes, so GitHub discarded it on arrival: it read like an access control and
  was not one. `prompt=select_account` and PKCE were added.
- Disconnect revokes the grant properly, and says plainly that this does **not**
  uninstall the app, because only an account owner can do that.

**This needs four settings on the GitHub App itself**, or the code is inert. See
SETUP_KEYS.md section 4b: Callback URL, Setup URL, "Request user authorization
(OAuth) during installation", and "Redirect on update".

### A push during a review no longer posts two reviews

A second push while a review was running produced two reviews seconds apart. The
older one was computed against a commit that no longer exists, so every line
number in it pointed at whatever had since moved into that position, and the two
raced to write the finding ledger; whichever landed last won.

There is now at most one review of a pull request in flight, held in the
control-plane. A newer commit supersedes the older run, which discards its work
rather than posting it. Three rules keep it honest:

- A run that has begun **posting** is never interrupted. A pull request carrying
  three inline comments and no review body is worse than a late review.
- A run whose worker stopped reporting is taken over after twenty minutes and
  recorded as *failed*, not superseded: nothing newer replaced it, it died, and
  those read very differently when working out why a review never appeared.
- A failed review releases its slot immediately, keyed on its commit so it cannot
  free a newer review's claim. Without that, one failure wedged the pull request
  for the whole stale window and the retry that would have fixed it was turned
  away as a duplicate.

A control-plane that cannot be reached never blocks a review. The cost of that
choice is the old behaviour, which is far better than reviewing nothing.

### Findings are no longer cleared by an edit somewhere else in the file

A finding at line 40 was marked "fixed" when somebody edited line 900 of the same
file and the reviewer happened not to mention it again. The file moved. The
finding's code did not, and that was always the question being asked.

Digests are now taken per region, keyed by the enclosing symbol git writes into
the hunk header. A hunk git could not name falls back to the whole-file digest,
which is exactly the behaviour that shipped, so this is strictly safer and never
worse.

Two more paths that silently emptied the ledger are closed:

- **Rebase and force-push.** Every hunk differs after a rebase because the base
  moved, so every open finding used to clear at once without a line of anybody's
  code being fixed. Detected now, and the review says so out loud rather than
  leaving the author to wonder why their fix went unacknowledged.
- **Renames.** A renamed file made every finding in it simultaneously "fixed" and
  "newly raised", so a review claimed credit for four fixes on a push that
  renamed a file. Findings now follow their file, with the identity recomputed
  exactly or not at all.

### One inline comment per finding, not one per push

Six pushes on a three-finding pull request left eighteen inline comments, all
saying the same three things, and the only way to tell which were current was to
read the timestamps. The ledger could be perfectly correct while the page was
nonsense, and the reader believes the page.

Every inline comment now carries a hidden fingerprint of the finding it was
written for. A later review leaves an existing comment exactly where it is, posts
only what is new, and removes a comment whose finding the ledger **cleared**.
Silence is still not resolution: a finding nobody mentioned keeps its comment,
for the same reason the ledger keeps the finding.

Comments Cavix did not write, and comments from before fingerprints existed, are
never touched.

### A reviewer that cannot cite a line it invented

Three hallucination classes are now caught by a program rather than by a model,
so they cost nothing and never vary: a finding in a file the change does not
touch, a line past the end of a file, and a symbol that exists nowhere in the
code the review actually read.

The screen runs **before** clustering, and that ordering is the point.
Adjudication treats independent agreement as confirmation and raises confidence
for it; for models of one family reading one context that independence is largely
fictional. They agree on the same hallucination and the bonus used to push it
past the threshold. Agreement is evidence about the models, not about the code.

A cited symbol that resolves nowhere is treated as *repairable*, not
*unsupported*: the claim may well be true and the corpus simply incomplete, so it
is trusted less and still posted. Deterministic findings and policy findings are
never touched by the critic. A linter does not hallucinate.

### Reviews know the team's own rules

Cavix knew a great deal about the code and nothing about the team. It could see
that a handler builds a SQL string; it could not know this repository decided
handlers never touch SQL, wrote it down, and has been enforcing it by hand in
every review since.

`.cavix/rules/*.md` are read, and so are `CLAUDE.md`, `AGENTS.md`,
`CONVENTIONS.md`, `CONTRIBUTING.md` and `.cursorrules`, because teams have been
writing those for years and asking for a second copy means the second copy
drifts. Selection is a glob match against the changed paths and nothing else: the
same change loads the same rules, every time.

Rules sit above every piece of code context and below only the diff, and they are
never compressed. Paraphrasing somebody's standard through a cheap model and then
enforcing the paraphrase is indefensible.

Enforcement defaults to advisory, so a rule file landing in a repository cannot
start holding merges the moment it arrives.

### Model routing follows the work, not the worker

The tier map routed on who was asking: a security agent was always frontier, a
standards agent always cheap, whatever they were looking at. Most diffs are
boring in every category, and a few are dangerous in categories nobody marked as
expensive.

Routing now escalates a cheap agent on measured signals: blast radius, a
security-sensitive path, concurrency, an exported signature change. It is
one-directional by design. Nothing demotes a frontier agent, because quietly
demoting a security review on a quiet diff to save a fraction of a cent is how a
security review comes back clean with nobody good having read it.

### The review comment answers four more questions

- **Since your last push** sits under the verdict: what cleared, what is new,
  what is still open, and how many files were *not* re-read. That last row is
  what earns trust in incremental review.
- **Impact Scope** states what the change reaches, and always discloses how the
  edges were resolved. It never prints a zero: "0 call sites" reads as "nothing
  calls this", which is exactly the wrong thing to say when the truth is that the
  indexer did not run.
- **Security Risks** is separated out for a different reader with different
  urgency, and restates rather than relocates.
- **Architectural Feedback** is last, capped at three, and never blocking.
  Design opinions above defects train people to skim past the defects.

The footer now names the tier mix, so cost is legible without printing token
counts nobody can act on.

### Fixed

- `**` in a glob now matches zero directories as well as several, so
  `src/**/auth/*.ts` matches `src/auth/token.ts`. A glob that matches nothing was
  indistinguishable from one nobody configured.
- The diff parser understands `rename from` / `rename to` and git's similarity
  index, including a pure rename with no content change, which produces no
  `---`/`+++` lines at all and was previously dropped entirely.


### Founder access: identity that does not silently drift, and a default that fails closed

Reported: *"I set my email in `CAVIX_ADMIN_EMAILS` on Render, it is the same email
I log in with via GitHub, and the Admin console still does not appear."*

It was not the same email. GitHub returns no address for an account with **"Keep
my email addresses private"** turned on, or for an OAuth authorization granted
before the `user:email` scope existed, and the callback fell back to
`<login>@users.noreply.github.com` **without a word anywhere**. That is the
address the admin check matches, so the variable was comparing against something
the founder had no way to know about.

#### Fixed
- **`CAVIX_ADMIN_EMAILS` now accepts a GitHub login**, written `@octocat`, next to
  or instead of emails. A login is stable; an email is not, and an identifier
  that can silently change is the wrong key for the permission that controls
  every organization on the platform.
- **The guard resolves the ACCOUNT, not the session cookie.** It read `s.email`
  from the signed cookie, so a login in the variable could never have matched
  even once logins were understood. It now looks the user up, which also means
  granting or revoking admin takes effect on the next **request** rather than the
  next sign-in.
- **The noreply fallback is logged**, naming both the address that was stored and
  the `@login` to use instead. The fallback itself is fine; being silent about it
  is what cost an afternoon.
- **Unset now means NOBODY in production.** It used to mean `demo@cavix.dev`
  everywhere — a default admin address published in this repository, on a
  deployment that starts with an empty store and open sign-up. Anyone who
  registered it owned every org on the platform. Development is unchanged, so the
  console still works out of the box on a local box with no database; `CAVIX_DEMO=true`
  restores the old behaviour deliberately. Forgetting the variable now costs a
  minute, and the failure is in the recoverable direction.
- The Admin console footer now prints **the email and login you are actually
  signed in as**, so the next person to hit this can compare it with the variable
  without going near an API.

### GitHub only, on the dashboard

A go-to-market decision, not a technical one. The Integrations panel now offers
**GitHub alone** and shows GitLab, Bitbucket Cloud, Bitbucket Data Center and
Azure DevOps as `soon`, so the product opens up with one host to support rather
than five.

Nothing is switched off to achieve it, and nothing here reaches the orchestrator.
Every client, normalizer, differ, edge route and credential path for the other
four is intact, tested and running; `services/edge` still accepts their webhooks
and `main.ts` still builds their clients. One `Set` in `app.js` decides who is
invited to connect a new one, and adding a key to it is the entire change when a
host is opened.

Two things it deliberately does not do:

- **A workspace that has already connected one still reads "connected"**, and
  keeps its Replace button. Its merge requests are genuinely being reviewed, and
  marking a live connection `soon` is the same failure as advertising a host that
  does not work, pointing the other way. Note this reverses only the PRESENTATION
  of the fix below it, never the honesty rule behind it.
- **The token API is unchanged**, so a host can still be connected directly for
  testing. The panel decides what is offered, not what is possible.

### The merge verdict now has a memory, and a pull request has a review budget

Reported from real use: *"I push a fix for one of the suggestions Cavix made, it
re-reviews, and it gives me a green pass for merging even though the other
suggestions are still there."*

The diagnosis in the report was that Cavix re-reviewed only the pushed commit. It
did not: `fetchPullDiff` has always returned the whole `base...head` diff. The
real cause was worse. **Every review computed its verdict from its own findings
alone.** `shouldRequestChanges` saw one run of a model, `check.finish` closed the
check on that, and nothing anywhere remembered that a finding had ever been
raised. A model is not a function: the same diff reviewed twice does not reliably
produce the same findings, and a merge gate built on one run of one is a coin
toss. Push a fix for one of three findings, have the next pass go quiet about the
other two, and the check went green with two criticals still on the page.

`packages/review-session` had held the right idea since it was written and was
**imported by nothing outside its own tests**.

#### Added
- **`packages/review-session/src/ledger.ts`** — the per-pull-request finding
  ledger. Every finding raised on a pull request, tracked across every review it
  receives, with one rule that makes the rest safe: **a finding is never cleared
  by silence.** It clears when the code moved AND the reviewer then did not raise
  it again. If the file is byte-identical to when the finding was raised, the
  finding cannot have been fixed, and no amount of model silence says otherwise.
- **"The code moved" is measured, not guessed:** a digest of that file's hunks in
  the unified diff. No extra API call, no second diff, no line-shift arithmetic,
  and identical on all five hosts because by that point every one of them has
  produced a unified diff.
- **Identity excludes the line number.** A fix earlier in a file shifts every
  finding below it, and a line-sensitive identity reported that as a resolution
  plus a brand-new finding on every push.
- **`packages/review-session/src/budget.ts`** — reviews per pull request. Free is
  a fixed 10 that a maintainer **cannot** raise; that is the tier boundary, and a
  free limit somebody can raise is not a limit. Paid defaults to 50 and the
  maintainer owns it, from **Review settings**. The old daily allowance protected
  the workspace's budget; this protects everybody else's pull requests from one
  of them, because a single pull request pushed to thirty times used to spend a
  free workspace's entire day on repositories that had nothing to do with it.
- **Reaching the cap never changes a verdict.** The check run is not touched: not
  created, not closed, not turned neutral. Whatever the last review concluded
  still stands. If running out of budget could turn a red check green, exhausting
  the quota would be a way to merge past an open finding.
- **"Still open from earlier reviews"** on the review comment, a Scope row, and
  the check-run title, plus **"Cleared by this push"**. The second matters as
  much as the first: a reviewer that lists only what is still wrong looks like one
  that did not notice the fix.
- Storage in the control-plane, not the orchestrator. The orchestrator is a
  restartable, horizontally scaled worker; a ledger in its memory would be lost
  on the next deploy and invisible to its siblings, so a redeploy mid-pull-request
  would silently clear every open finding.

#### Fixed
- **"Clean pass" while findings were open.** It is a claim about the pull
  request, not about one run, and it is the sentence a reader acts on.
- **`@cavixcode resolve` half-worked.** It dismissed the review and deleted the
  inline comments and left the ledger alone, so the next push carried every one
  of those findings straight back. It now closes them, and reports how many.
- **A blocking check that could not say what was blocking it.** On the run where
  every blocking finding is a carried one, "a finding at or above your blocking
  severity was posted" sent the reader hunting through a review containing no
  findings at all.
- **A failed ledger read would have wiped the ledger.** A failed read hands back
  an empty ledger, because that is the only honest answer to "what came before";
  folding a review into that and saving it would replace a ledger holding five
  open findings with one holding this review's, and reset the counter with it.
  One unreachable control-plane would have cleared every open finding on the pull
  request. Caught by its own test before it shipped; the write is now gated on
  the read having succeeded, so an outage costs one review's memory and nothing
  permanent.
- **A review that cannot ask no longer claims a clean pass.** A deployment with
  no control-plane at all still says "clean pass", because it has no cross-review
  memory by configuration and that is as complete a statement as it can make. One
  that HAS a ledger and could not reach it says so instead.
- **`updateSettings` has an allowlist**, so the new per-PR limit would have
  silently dropped on the way in. A free workspace now gets a 403 with the reason
  rather than a 200 and a setting that never applies, which is the failure this
  codebase has already shipped three times.

### Azure DevOps and Bitbucket Data Center: all five hosts, and a real differ

The last two platforms, and the one that was never mechanical. Every other host
hands Cavix a unified diff; Azure's `diffs/commits` API returns a list of CHANGED
PATHS and no content, so the diff has to be produced locally, and everything
downstream treats it as exact: which lines an inline comment may anchor to, what
line number a finding carries, and where the sandbox reproduces a bug.

#### Added
- **`packages/differ`**, Myers' published O(ND) algorithm over lines, plus a
  unified-diff writer. Verified line for line against `git diff --no-index -U3`
  on ten cases before a line of the Azure client was written: insertions,
  deletions, added and deleted files, distant and adjacent hunks, reindents, a
  file with no trailing newline, and a repeated-line file (the case a greedy scan
  gets wrong). It is exact and minimal, not "close enough": an approximate diff
  does not fail, it silently anchors findings to the wrong lines.
- **Bounded, and it REFUSES rather than approximating.** Past the edit budget,
  the line budget, or on binary content, a file is left out of the review and
  **named on it**, under a "Not Reviewed" section and a Scope row. A review that
  quietly skipped two files is claiming coverage it does not have.
- **`RestAzureClient`**, `AZURE_CAPABILITIES`, an edge normalizer, and one line
  in `main.ts`. The seam held for a fourth and fifth platform with no workflow
  change.
- **`RestBitbucketServerClient`** for Bitbucket Server / Data Center, which
  shares nothing with Cloud but the name: a different REST surface, different
  payload shapes, different anchors, different state vocabulary, and optimistic
  locking on every write.
- **`ReviewPlatform.diffLimitations(ref)`**, returning `[]` on the four hosts
  that hand over a real diff. Keyed by pull request rather than held on the
  client, because one client serves every concurrent review.
- Edge ingestion for Azure on the same `/webhook`. Azure service hooks SIGN
  NOTHING, so the only credential they can carry is HTTP Basic; it is compared in
  constant time, against its own secret, before the body is parsed.

#### The refusals, which are the design
- **Neither takes chat commands.** A command must be authorized before it spends
  a customer's model budget, and neither host lets a review bot answer "may this
  arbitrary user push here?" without organisation-level scopes it should not
  hold. `commandsAllowed` returns false on both and the edge mints no command
  job, exactly as for Bitbucket Cloud. Automatic reviews work fully.
- **Azure declares `blockingReview: false`.** A bot can only vote on a pull
  request it was added as a reviewer to. Blocking is a pull request status a
  branch policy can require, and the review says so rather than letting an owner
  believe there is a gate that is not there.

### Stage 12 closed on both ends: the learning loop now moves the sandbox

`ARCHITECTURE.md` described Stage 12 as feeding Stage 9's threshold **and**
Stage 10's verify gate. Only Stage 9 was wired.

#### Added
- **`OrgCalibration.verifyByCategory`**, derived from the same decisions and
  riding the same `review-config` call, so closing the second half costs zero
  additional round trips per pull request.
- **`"always"`**: where a workspace's accepts and rejects overlap at every
  confidence level, no threshold separates them, Stage 9 correctly refuses to
  move the bar, and execution is the only instrument left. The sandbox now runs
  there, including on findings the default gate would skip as nits.
- **`"never"`**: where they accept essentially everything, a proof changes no
  decision they were going to make, and a sandbox run is the most expensive thing
  in a review.
- **Critical, high and security are proven regardless.** They are checked before
  the learned policy is consulted, because their proof is the product's own
  claim. A test asserts no volume of accepts can turn it off, and that no policy
  can make Cavix "verify" a deterministic fact either.
- A second Learnings panel showing where proof moved and why, in the team's own
  numbers, next to the one showing where the bar moved.

### Fixed
- **Every file and line permalink in a review pointed at `github.com`.** The
  poster hardcoded the host, so on GitLab and Bitbucket, which have had users
  since they shipped, a reader who clicked a finding's line number left for a
  github.com repository that does not exist, and a GitHub Enterprise reader left
  their own network. `ReviewPlatform.webUrl` now carries the browser root and the
  poster builds each host's own URL grammar; all four differ, and none is
  derivable from another. A host it cannot name renders paths as plain text
  rather than as a wrong link.
- **A deleted file lost its name in `parseUnifiedDiff`.** git writes
  `+++ /dev/null` for a deletion, so the only place the path survives is the
  `---` line, which was ignored. The walkthrough rendered an empty code span for
  every deleted file, and `subsystem("")` filed each one under the repository
  root and inflated the traversed-subsystem count with it.
- **The secret scanner reported only the FIRST match per pattern per file.** A
  file committing one key on line 12 and another on line 400 reported the first
  and said nothing about the second, and the one nobody is told about is the one
  nobody rotates. Capped per file so a fixture cannot flood a review.
- **The air-gap egress guard followed redirects without checking them.** An
  allowed host answering `307 Location: https://evil.example` made the runtime
  re-send the request, body and all, to a host the policy forbids: the guard's
  one check passed and the prompt left the cluster. Redirects are now followed by
  hand, one host check per hop, bounded at five.
- **The Docker sandbox interpolated paths into a shell string and did not
  confine them to the workspace.** The paths reaching it come from findings,
  which come from a model reading somebody else's diff, and one apostrophe in a
  filename closed the quote. It also let a traversal through, where the Local
  backend has always refused one: two implementations of one port disagreeing
  about that is a port that cannot be swapped.
- **The dashboard's Integrations panel advertised Bitbucket and Azure DevOps as
  "soon"** for months after Bitbucket Cloud went live. All four token-based hosts
  now have a real Connect button driven by one generic endpoint.
- **`services/control-plane/test` is now inside the tsconfig `include`.** That
  directory sitting outside it is how `requireOrgMember` shipped: called twice,
  defined nowhere, answering 500 from the day it landed. `scripts/` is in too;
  `npx tsc --noEmit` now covers everything shippable.

### Observability: `/metrics` on both services

Stage 13 is "teardown, zero retention, observability, cost accounting". Three of
those four were live. There was no metrics surface at all, which is why every bug
the last five sessions found was found by reading code rather than by an alert.

#### Added
- **`packages/metrics`**, a dependency-free Prometheus registry. Counters,
  gauges, cumulative histograms and the text exposition format, which is the
  whole of what is needed and smaller than the dependency would have been.
- **`/metrics` on the orchestrator**, on the health port that is already open,
  and **on the control-plane**. Pull-based with nothing outbound, so it exists in
  an air-gapped cluster. Nothing is computed until something scrapes.
- **`cavix_stage_failures_total{stage}`**, which is the reason for the item.
  Every stage in Cavix degrades rather than failing, on purpose, so a stage can
  be broken one hundred per cent of the time for a week while every review still
  posts and nothing says so. This is the only surface it appears on.
- Review outcome and duration, per-stage duration, queue depth (from
  `XINFO GROUPS`, so lag and pending together), model spend, findings by
  surfaced/suppressed, and the control-plane's own request and record counters.
  The last of those matters because a dashboard rejecting every record looks
  perfectly healthy from the orchestrator, which logs a warning and carries on.

#### The cardinality trap, designed out
No label carries a repository, org, path, branch, commit, finding or model. All
are unbounded, which is one time series per value in a store that keeps them for
a year, and three of them are customer data in an endpoint usually less protected
than the database. Series are **capped per metric**: past the cap further label
combinations fold into one `overflow="true"` series rather than being created, so
a future mistake is a visible wrong series an operator can act on rather than a
slow memory leak here and a slow ingestion failure over there. A test asserts the
whole exposition uses only `le`, `outcome`, `stage` and `version`.

### Bitbucket Cloud, live

The third platform, and the one that tests whether the seam generalises past a
lucky second. It does: `RestBitbucketClient` implements the same
`ReviewPlatform` port, the edge ingests its webhooks on the same `/webhook`
endpoint with its own HMAC secret, and the workflow did not change.

#### What Bitbucket cannot do, all declared
- No comment reactions. There is no API for it.
- No repository tree listing: `/src` pages one directory at a time, so mapping a
  repository is one request per directory, spent before a review is posted.
  Reported false rather than implemented badly.
- **No chat commands, deliberately.** A command must be authorized before it
  spends a customer's model budget, and Bitbucket's permission lookup for an
  arbitrary commenter needs workspace-admin scope a review bot should not hold.
  `commandsAllowed` returns false and the edge has no note handler. The GitLab
  session in this repo already shipped one command path that could not check
  permission; this is that lesson applied before the fact.

Changes-requested IS real here and reversible, unlike GitLab, so blocking and
dismissal both work.

#### Fixed
- **`packages/platforms/` is gone.** It defined a second, two-method
  `ReviewPlatform` that no longer matched the real port, so two different types
  shared one name and the next person to wire a platform would have found the
  wrong one. Its URL shapes live on in the real clients.
- **Bitbucket's PR update would have blanked the title.** The endpoint takes the
  whole object, so sending a description alone clears the title, which is the one
  field the author cares most about. It is read and echoed back.

### Zero-retention, live

`packages/zero-retention/` proved no customer code persists after a review, and
ran in exactly one place: `scripts/airgap-demo.ts`. The real teardown path
destroyed the sandbox and never verified anything was gone. So the claim that
sells Cavix to a bank was demonstrated by a demo script and asserted everywhere
else, and a security review asking for evidence would have ended the conversation.

#### The audit finding that changed the design
The original residual check asked whether `sandbox.workdir` still existed on the
host. That is a real question on the LOCAL backend, whose workdir is a host temp
directory. It is meaningless on Docker, where the workdir is `/work` inside a
container and no such host path was ever created: the check looked, found
nothing, and reported clean. **On the only backend a customer actually runs, the
zero-retention proof verified precisely nothing.** A proof that cannot fail is
not a proof.

#### Added
- **A per-backend check that can come back false.** Local asks the filesystem;
  Docker asks the daemon whether the container is still listed, and says so.
- **`unverifiable` as a first-class outcome**, distinct from clean. A backend
  that exposes nothing inspectable after teardown (Cloudflare, Firecracker), or
  a Docker daemon that cannot be reached, reports that rather than a pass. "We
  could not check" and "we checked and it was gone" are different claims and
  collapsing them is how a proof becomes a slogan.
- **A per-review attestation**, not a boolean: how many sandboxes the review
  provisioned, which backend ran each, the check that ran in words a reader can
  evaluate, and a verdict of proven / partial / unverified / violated. One
  surviving sandbox outweighs every clean one; a mixed deployment is `partial`
  rather than rounded to either end.
- **It runs in the real path.** `VerifyContext.onTeardown` fires after each
  sandbox is destroyed, the workflow collects them, and the attestation goes to
  the control-plane with the review.
- **`GET /api/reviews/:id/retention`**, and a row on the review card. An auditor
  asking about a review from four months ago gets the artefact, and a review
  from before this shipped gets an honest 404 rather than an invented pass.

#### What it does not contain, by construction
No path, file name, commit, repository or code: counts, backend names, a verdict
and sentences Cavix wrote. A retention proof carrying a workspace path from the
machine that read a customer's private repository is itself a retention problem,
and the kind that sits in a database for years because nobody thought of it as
data. A test asserts the wire payload contains none of it, and the control-plane
narrows the record on arrival rather than storing whatever turns up. The verdict
is recomputed server-side and never taken from the wire, because a caller that
could assert "proven" over checks that do not support it could manufacture the
one claim this artefact exists to make.

#### Fail-soft, like every other stage
A check that throws costs its entry in the attestation and nothing else. A
violation is logged at error level and recorded, and does not fail the review:
the review is already on the pull request and the customer got what they paid
for. What has gone wrong is our cleanup, which is our problem to fix and theirs
to be told about.

#### Fixed
- **The attestation's review id would have named the repository.** The
  orchestrator's only candidate was `owner/repo#12@sha`. The control-plane stamps
  its own id when it stores the record instead.
- The air-gapped demo printed `clean=undefined` after the shape changed. It now
  prints the same sentence a customer sees, plus the check behind it.

### GitLab, live

`packages/platforms/` has held GitLab, Bitbucket and Azure DevOps adapters since
Phase 3, and the orchestrator imported none of them: it had its own
`RestGitHubClient` and the whole workflow was typed against `GitHubClient`. The
README's "5 platforms" was true of the packages directory and false of the
product, and every non-GitHub prospect was a demo Cavix could not give.

#### The seam, which was the actual work
The port is now `ReviewPlatform` and it stayed WHOLE rather than being carved
into a core plus optional methods. Carving it is the obvious design and the wrong
one: it turns every call site into a `?.` with a fallback, and invites a quieter
bug where the fallback is silently worse than the real thing. The risky methods
already had a documented "I could not do this" return, because GitHub itself
refuses them routinely (a PAT cannot write a check run; a COMMENTED review cannot
be dismissed by anyone). What was missing was a way to SAY which are real, so
every client now declares `platform` and `capabilities`.

#### Added
- **`RestGitLabClient`**: merge requests, discussions anchored by diff position,
  commit statuses, award emoji, pipelines, and the repository tree. One API for
  gitlab.com and every self-managed CE/EE instance, so `baseUrl` is the whole of
  self-hosting.
- **GitLab ingestion on the same edge endpoint**, told apart by `X-Gitlab-Event`,
  authenticated with its own secret. One URL for operators to configure, and two
  secrets, because a GitLab project hook must not be able to forge a GitHub
  delivery.
- **`platform` on the canonical `ReviewJob`**, in Go and TypeScript. Absent means
  GitHub, which is why the schema version did not move: a bump would have turned
  every job already queued into a poison message on the deploy that introduced
  the second platform.
- **Per-workspace GitLab tokens** in the control-plane, encrypted with the same
  AES-GCM path as a BYOK key, owner/admin only, never echoed back. Not one token
  per deployment: that would read every customer's repositories.
- `CAVIX_GITLAB`, `CAVIX_GITLAB_URL`, and `CAVIX_GITLAB_WEBHOOK_SECRET`.

#### What GitLab cannot do, and how the review says so
There is no bot-blocking review: nothing a bot posts can hold GitLab's merge
button. So a workspace with blocking switched on gets an ordinary comment AND a
sentence in the verdict callout saying nothing was gated and naming the commit
status that can be. An owner who turned blocking on and was never told it did not
happen would believe there is a gate in front of their default branch that is not
there, which is worse than the missing feature. Reactions and dismissal are
skipped rather than attempted and swallowed.

#### Fixed
- **A GitLab command from any commenter would have run a review.** GitHub's
  webhook carries the commenter's association with the repository, so the edge
  refuses a passer-by before anything is queued. GitLab's note payload has no
  such field, so the first version enqueued the job marked `GITLAB_UNVERIFIED`
  and nothing downstream checked it: anyone who could see a merge request could
  have spent a customer's model budget by typing "@cavixcode review" in a loop.
  `ReviewPlatform.commandsAllowed` now asks the API (`members/all`, access level
  30 = Developer), fails closed on a lookup error, and gates the free commands
  too, because a passer-by who can `pause` Cavix has turned it off for the people
  who do have access. GitHub answers true without a request: the edge already
  decided.
- **`refFromJob` split the repository full name at the FIRST slash**, so a nested
  GitLab group ("acme/platform/billing") gave owner `acme` and repo `platform`,
  silently dropping the project and pointing every API call at a repository that
  is not the one under review. Harmless on GitHub, where a full name has exactly
  one slash, and it would have broken every subgroup customer on day one.
- **A shared client held per-review state.** The first version counted refused
  inline anchors on the instance, and one client serves every review this
  orchestrator runs concurrently, so the count named whichever merge request
  finished last. It is logged now, not stored.
- **The review re-read the merge request it had just fetched.** `/changes`
  already returns the diff refs a discussion position needs, so they are kept
  from there, keyed on the head SHA so a new push cannot reuse a stale position.
  One fewer round trip per review.
- An inline comment now carries a hidden `<!-- cavix:inline -->` marker. GitHub
  finds its own inline comments through the review they belong to; no other
  platform has a review to belong to.

### Call-flow diagrams in the review

The dashboard has carried a "Sequence diagram" toggle marked "soon" since the
settings page was written, `OrgSettings.reviewSections.sequenceDiagram` has been
stored and served the whole time, and nothing generated one. GitHub renders
Mermaid natively in a comment, and the one thing a reviewer cannot get from a
diff is the order in which the changed files now call each other.

#### Added
- **A Mermaid `sequenceDiagram` of the traced call path**, in the PR description
  under the walkthrough. It describes what the change DOES, which is still true
  after the author fixes every finding, so it follows the same rule as the rest
  of that block and falls back into the review comment on a fork PR by the same
  path, with no second code path.
- **`CodeIndex.callSitesFrom`**, which is what made it possible. `resolveEdges`
  folds every call site into a `Set<string>`, the right shape for "what does this
  reach" and the wrong one for a sequence: it throws away the order and the line.
  The ordered data was always in `FileRecord.calls`; nothing had asked for it.
- **`traceSequence`** in `packages/analyzer`: a depth-first walk in call-site
  order from the symbols the diff touched, with roots first so the diagram starts
  where the flow starts.
- The dashboard toggle is live, and `coerce()` in the orchestrator now knows the
  field it had been dropping.

#### What it will not do
No model draws it, and none could: a flow inferred from a diff is a guess with
arrows on it, and a diagram mixing measured arrows with guessed ones is worth
less than none because the reader cannot tell them apart. So every arrow is a
call the graph resolved between two files it parsed. Stage 4 indexes the changed
files, so a call into an untouched file is not drawn even when the import is
right there. A single-file change gets nothing: one lifeline is a list. Fewer
than two interactions gets nothing: that is a sentence, and the walkthrough is
made of those. It is capped at 6 lifelines and 14 arrows, and the caption says
when it was cut.

#### Fixed
- **Two more dashboard toggles that changed nothing.** `policyEnabled` was a live
  switch in the Automation panel duplicating the real one in Pre-merge checks,
  which is the field the orchestrator actually reads; the duplicate is gone.
  `airgapped` was a live switch for a control enforced by the gateway's
  `EgressGuard` and a Kubernetes NetworkPolicy, both process-wide, neither of
  which has ever read the field. It is now derived from the deployment on read
  and is not patchable, because a dashboard that can set it can show a security
  control as ON while the process makes outbound calls.
- **`mermaidText` exceeded the width cap it enforced**, returning `max + 2`
  characters by appending an ellipsis to `max - 1`.

#### Found by probing before trusting
Two defects that only a realistic fixture showed, both in the first version:

- **Local helper calls crowded out the flow.** Drawing every same-file call as a
  self-message filled the step budget with `handler.ts ->> handler.ts` rows on
  any realistic handler. Past about fifteen helpers it removed every cross-file
  arrow, leaving one lifeline and therefore no diagram, on exactly the changes
  most worth one. Local calls are now walked THROUGH and never drawn, and a
  helper that reaches another file is attributed to the file its call site is
  written in.
- **A non-ASCII identifier was mangled, not sanitised.** The first allow-list
  turned `über()` into `ber()`, which is not a safe label but a wrong one: the
  reader cannot find `ber` in their own file. Unicode letters are allowed
  through; the ASCII punctuation Mermaid assigns meaning to still is not.

### Stage 12 closed: the learning loop actually learns

Every accept and reject a team made was stored, shown back to them, and changed
nothing about the next review. `packages/learning` had the calibration code and
nothing imported it; `DeepReviewOptions.confidenceThreshold` was plumbed into
Stage 9 and never set. The gap between those two facts was the whole of the
retention argument: a competitor starts cold, and so did Cavix.

#### Added
- **A per-category confidence bar, derived from the workspace's own decisions**,
  fed into Stage 9's `adjudicate()`. A category absent from the map keeps the
  default, because "this team has taught us nothing here" and "their bar happens
  to equal the default" are different claims and only one of them is measurable.
- **It rides on the review-config fetch the workflow already makes.** No extra
  round trip per review, no second endpoint in front of every pull request, and
  the same object the Learnings page is shown, so the page cannot describe a
  calibration different from the one running.
- **Computed in the control-plane**, where the decisions live, and cached until
  the next decision, which is the only thing that changes it. The alternative
  was shipping every decision a workspace ever made over the wire on every pull
  request so a stateless worker could reduce them to a dozen numbers.
- **The Learnings page says what changed, in the team's own numbers**: the bar
  per category, the decisions it rests on, and one sentence of why. A category
  whose bar did NOT move says why not, rather than going quiet.
- `GET /api/orgs/:org/calibration`, scoped to the workspace.
- `StoredFinding.confidence`, and `confidence` plus `agent` on `/api/decisions`.

#### The design decision that matters
The threshold acts on confidence; an accept rate does not mention it. So nothing
is derived from the accept rate alone. Each bar is the lowest cut that would have
held back at least 60% of that category's rejections while costing at most 20% of
its accepts, and when no cut does that, the bar does not move and the page says
so. On real data that refusal is the common case, not an error: a team rejecting
findings an agent was confidently wrong about cannot be helped by a confidence
threshold, and pretending otherwise drops the good findings at the same rate.

Four guards: a 90-day window so a bad week ages out; ten decisions before a
category earns an opinion and twenty before the workspace does; and a ceiling of
base + 0.25 that is a refusal rather than a cap, so a category can be made
quieter and never silenced.

#### Fixed
- **The confidence a decision was made about was thrown away on arrival.** The
  orchestrator sent it on every finding; `StoredFinding` had no such field. Every
  confidence-threshold derivation was therefore impossible from the only real
  source of decisions in the product, and nothing surfaced it.
- **`listDecisions()` dropped `agent` too**, the other field `DecisionRecord`
  declares.
- **`requireOrgMember` was called twice and defined nowhere**, so
  `GET /api/orgs/:org/analytics` threw a ReferenceError on every request and the
  Reports page has been answering 500 since it shipped.
- **`services/control-plane` was missing from the tsconfig `include` list**, which
  is why the above could ship. `npx tsc --noEmit` now checks it. (The
  control-plane's own tests are still outside it; they need an `await res.json()`
  cleanup that is not this change's business.)
- **An unrecognised severity string made `reviewerHoursSaved` NaN** for a whole
  workspace, because the ROI model looks its minutes up by severity and
  `StoredFinding.severity` is a bare string off the wire. Narrowed at the
  boundary.

#### Removed
- The `Calibration` class and its `filterFindings`. It was a second thresholding
  path parallel to Stage 9's, and two places that drop findings is how the Scope
  module's dropped count starts disagreeing with reality. It also derived its
  threshold from the accept rate, and multiplied a finding's confidence by
  `0.5 + acceptRate`, so a trusted category had its bar lowered and its
  confidence raised for one signal, counted twice.

### Stage 6 live: CI telemetry and regression warnings

`packages/telemetry` was written, tested and imported by nothing. The roadmap
calls this the one genuinely empty lane in the competitive set, because static
analysis sees the code and not its consequences: a change can be correct,
well-tested and well-reviewed and still be the one that takes the build from four
minutes to nine, which nobody notices for a month and nobody can then attribute
to anything.

#### Added
- **Ingestion from GitHub Actions**, pulled rather than pushed. A webhook is the
  obvious design and the wrong one to start with: it needs the Go edge to learn a
  second event type and a second job shape, and it only ever sees runs from after
  the App was installed, so a new customer's first weeks of reviews have no
  history to compare against. One pull returns the last sixty completed runs, so
  the very first review already has a baseline. Runs after the review is posted,
  on a six-hour staleness gate.
- **The warning.** A pipeline that has slowed by 20% AND by at least 30 seconds
  becomes a finding with the numbers ("the last 10 runs averaged 7m 1s, against
  3m 52s across the 14 before them"). A pipeline failing 30% of recent runs gets
  its own. Both anchor to the workflow file.
- **It states plainly that it is not blaming the pull request**, because it
  cannot: the trend is measured on the default branch, over runs that finished
  before the branch existed. Claiming causation from that data would be exactly
  the confident wrongness this product exists to avoid.
- `listWorkflowRuns` on the GitHub client, and `baseRef` on `PullMeta` so the
  trend is measured on the branch the pull request targets.
- CI history storage in the control-plane (`/api/internal/orgs/:org/telemetry`),
  capped at 400 runs per repository, with per-repository fetch timestamps.
- The Scope module's `CI Telemetry` row, from the real run count.
- `CAVIX_CI_TELEMETRY=off` turns the stage off. It fails soft either way.

#### Fixed
Four bugs in `packages/telemetry`, all of which would have shipped:

- **A test that broke and was fixed was marked flaky forever.** Outcomes were
  grouped by test name across all of history and the commit was ignored, despite
  the code comment saying otherwise. Cavix tells a reviewer to treat a flaky
  test's failures with caution, so saying that about a test which had just caught
  a real regression is how a real failure gets waved through. Flaky now means
  both outcomes at the same commit.
- **`p95` returned the maximum.** Indexing at `floor(p * n)` lands one past the
  mark and gave the largest sample for any count up to twenty. p95 exists
  precisely so one unlucky run does not set the number.
- **`recordBuild` was write-only.** Runs went in and nothing could read them, so
  the roadmap's headline example had no implementation at all. Added
  `workflows()` and `buildTrend()`, which compare a recent window against the
  runs before it, per workflow, excluding cancelled and timed-out runs (both are
  fast or slow for reasons that have nothing to do with the code).
- **The store was unbounded.** Append-only with no cap, so a busy repository grew
  it until the process died. Capped per repository, oldest out first.

And one found while wiring: a pipeline whose recent runs ALL failed produced no
trend at all, because there was no successful duration to average, which silenced
the failure warning in exactly the case it was written for. Durations are now
nullable and the failure rate is always reported.

### Stage 5 live: cross-repo impact on a real pull request

`packages/orggraph` was written, tested and imported by nothing. It now runs, in
two halves with different timing.

#### Added
- **The query.** Before a review is posted, a changed public interface is traced
  to its consumers in OTHER repositories, and each becomes one finding naming the
  repositories and the exact call sites. This is the finding no single-repo
  reviewer can produce: a change to `DELETE /orders/{id}` reads as a clean,
  well-tested diff inside the orders service, and the only thing wrong with it
  lives in a repository nobody in the pull request has open.
- **The indexer**, which runs AFTER the review is posted and only when this
  repository's slice of the graph has gone stale (12 hours). A tree listing and a
  few dozen file reads do not belong in front of somebody waiting for a review,
  and none of it changes the review that was just posted.
- **`listTree` on the GitHub client**: the repository's whole file list in one
  call, via the git trees API. Stage 5 has to FIND the contract files before it
  can read them, and there was no way to do that without cloning.
- **Graph storage in the control-plane** (`/api/internal/orgs/:org/graph`), with
  per-repository index timestamps so refreshes are incremental. The split is
  forced: only the orchestrator holds GitHub App installation tokens, which are
  the one credential that reads a private repository without borrowing a human's
  OAuth token, and only the control-plane has Postgres and knows which
  repositories a workspace connected. A graph naming a repository the workspace
  never connected is rejected.
- `CAVIX_CROSS_REPO=off` turns the whole stage off. It fails soft either way: a
  broken trace costs the cross-repo section, never the review.
- The Scope module's `Blast Radius` row now renders, from real call-site counts.

#### Fixed
Four bugs in `packages/orggraph`, all of which would have shipped:

- **A concrete call never matched a templated route.** A provider declares
  `/orders/{id}`, normalized to `/orders/*`; a caller writes `/orders/abc123`.
  Those were compared as strings, so they never matched, and that is the single
  most common shape in any real organisation. Paths are now compared segment by
  segment, aligned on their tails, with a variable on either side matching
  anything. A route made entirely of variables matches nothing rather than
  everything.
- **Removing an operation did not count as changing the path that owns it.**
  Deleting an endpoint from an OpenAPI document removes the `"delete": {}` line
  while `"/orders/{id}":` sits above it as unchanged context, so reading only
  changed lines saw a method with no path and concluded nothing had changed. The
  enclosing path is now tracked across context lines.
- **Generic method names manufactured consumers.** `redisClient.get(key)` and
  `dbClient.get(id)` were reported as callers of `orders.OrderService/Get`, so
  changing one RPC would have told three unrelated teams their code was about to
  break. That is precisely the noise this product exists to be incapable of. A
  gRPC match now requires the receiver to name the service, unless the method
  name is distinctive enough to stand alone.
- **One row per call site.** A monorepo importing one package from four hundred
  files produced four hundred identical edges, all held, persisted and shipped to
  every review. References now dedupe by what they are, keeping the first eight
  locations.

Also added: `toJSON`/`fromJSON` so a graph outlives the process that built it,
and `fromJSON` returns an empty graph for anything it does not recognise rather
than throwing.

#### Fixed elsewhere
- **`mutes` was missing from the store snapshot**, so every mute event was lost
  on restart. Added, along with the graph, and `restore` now resets both rather
  than leaving the previous process's data beside freshly loaded orgs.
- **A temporal dead zone crash in the control-plane router.** A new route used
  the shared `mm` match variable above its `let`, which threw on every request
  that reached it and 500'd every route below. Caught by the existing suite.

### Dashboard analytics, and the churn signals nobody was recording

#### Added
- **`@cavix/analytics` is wired into the control-plane.** The Reports page's ROI
  numbers now come from the package's explicit minutes-per-severity model rather
  than a second one hand-written in the store, so the dashboard and anything
  built on the package quote the same hours for the same month.
- **Mute tracking (`MuteEvent`).** A repository toggled off, or a pull request
  paused, is recorded and surfaced at the top of Reports. The roadmap calls this
  "your single most important leading indicator of churn" and nothing was
  capturing it.
- **Action-rate trend**, first half of the window against the second, in
  percentage points. A single action rate says how a team feels about Cavix; the
  direction says whether they are leaving. Returns 0 when either half decided
  nothing, so a quiet fortnight does not fire the alarm.
- **Cost, model, duration, verified and suppressed counts** on every recorded
  review. The workflow has had all of them since Phase 0 and threw them away at
  the recorder boundary, so the dashboard could report what Cavix found and never
  what finding it cost. Cost per review is computed over the reviews that
  actually reported one: "not measured" is not "free".
- **`GET /api/orgs/:org/analytics`** with daily series, per-repository rollup,
  ROI and mute log. `days` is clamped to 7..90.
- **`public/charts.js`**: dependency-free inline SVG (the site ships static with
  a strict CSP, so a CDN chart library is not an option). Series colours were
  validated against the dark card surface rather than chosen by eye.

#### Changed
- Severity is rendered as a labelled meter list, not a five-colour chart.
  critical/high/medium/low/info forces red, orange and yellow adjacent, and that
  trio cannot clear the normal-vision separation floor at any stepping (worst
  adjacent pair ΔE ~13 against a floor of 15). Name, geometric mark and count
  carry identity; length carries magnitude. That is the correct form for an
  ordered scale regardless.
- **The Learnings page showed a column of hashes.** `listDecisions` now carries
  the finding's title, path, severity, category, repo and verified flag, and the
  page leads with the categories a team keeps rejecting, which is the one thing
  on it that changes what Cavix does next.

#### Fixed
- **Tier limits and suspension were enforced after the money was spent.** The
  daily allowance and the suspended flag were checked only when a finished review
  was recorded, which is after the diff was fetched, the models were called and
  the comment was already on the pull request. A suspended workspace kept getting
  full reviews and simply stopped appearing on its own dashboard: the customer
  sees Cavix working and sees nothing to show for it, and the tokens are spent
  either way. Both are now decided at `/api/internal/repos/enabled`, before
  anything is spent, and the gate returns a `reason` so a command job says
  "this workspace is suspended" instead of "turn the repo on" for a repo whose
  toggle is already green.
- **The deep review path silently degraded on any pull request touching more
  than 12 files**, which is most real pull requests: it threw, and the workflow
  fell all the way back to a single model over the raw diff. It now indexes the
  files it can read and runs anyway (the agents read the DIFF, so they lose
  nothing), and reports `fullyScanned` so the Scope module withholds the
  Deterministic Pass row rather than claiming coverage it did not have.

### Stages 3 to 9 now run on real pull requests

#### Added
- **`makeDeepReviewStep`** wires `packages/pipeline` into `runReview`: the
  deterministic scanners (Stage 3), a call graph over the changed files (Stage
  4), context assembly and compression (Stage 7), seven specialist agents in
  parallel (Stage 8) and adjudication over all of it (Stage 9). Until now the
  live service reviewed every pull request with one model and one prompt over
  the raw diff, while the pipeline that does all of the above ran nowhere but its
  own tests. The eval harness has scored the two side by side the whole time:
  81.8% F1 and an 18.2% false-positive rate for the single pass, 95.7% and 8.3%
  for the pipeline.
- **`Reviewer.summarise`**, a cheap pass that produces only the summary,
  walkthrough and effort. The ensemble finds defects; nobody was left writing the
  prose the description needs, and running a second full review for it would have
  paid twice to find the same things.
- Fails soft, deliberately. The deep path reads files through the API and fans
  out to seven models; any error there falls back to the single-model pass rather
  than costing somebody their review. `CAVIX_DEEP_REVIEW=off` makes that fallback
  permanent and roughly halves the model spend per review.
- The Scope module's `AST Verification`, `Deterministic Pass` and `Ensemble` rows
  now render, fed by real counts from the stages that ran. They were built for
  this and had been dark since the module shipped.

#### Fixed
- **`runDeterministic` under-reported `toolsRun`.** The two always-on in-process
  scanners were excluded, so a deployment without semgrep installed reported that
  zero tools had scanned the change. `Phase1Result` now carries `toolsRun` and
  `toolsSkipped` through, so a caller stating "N tools ran" is stating what
  executed rather than counting findings.

### Command handling and four dead settings

#### Fixed
- **Every `@cavix` command ran a full, billable review.** The Go edge recognises
  eight commands and enqueues all of them; the orchestrator never read
  `job.command`. Typing `@cavixcode help` made a frontier-model call, ran the
  sandbox and posted a review comment, and `@cavixcode pause` started a review
  instead of stopping one. New `workflow/commands.ts` dispatches: `review` and
  `summary` reach a model, `ask` gets its own cheap prose path, and `resolve`,
  `pause`, `resume`, `configure` and `help` are repository operations that cost
  nothing.
- **`force_fresh` was never read**, so `@cavix review` stacked a new review on
  top of every earlier one. A fresh review now deletes Cavix's own inline
  comments and dismisses a stale blocking review first. Reviews are found by a
  hidden `REVIEW_MARKER` in the body rather than by bot login, which differs per
  deployment. GitHub does not permit deleting or dismissing a plain COMMENTED
  review, by anyone, so that limitation is documented rather than papered over.
- **`pathFilters` did nothing.** Stored, served to the orchestrator, ignored. Now
  applied to the diff *before* the model sees it, so an excluded directory is
  neither billed for nor disclosed to the provider. A pull request with nothing
  left after filtering closes the check as "Nothing to review" instead of posting
  an empty one.
- **`tone` did nothing.** It reached the settings page and the preview and never
  the model. Five voices now append a rule to the system prompt. None of them can
  change what is reported or how severe it is: tone is a voice control, not a
  leniency dial.
- **`autoReview` and `reviewDraftPRs` did nothing.** Both now suppress automatic
  triggers only. An explicit `@cavixcode review` overrides both, and a pause,
  because a human asking by name is the clearest signal there is.
- Pause state lives in a hidden marker on Cavix's own PR comment, not in worker
  memory: the orchestrator restarts and scales horizontally, so memory is the one
  place the setting could not survive.

#### Changed
- `OrgReviewConfig` carries `autoReview`, `reviewDraftPRs`, `tone` and
  `pathFilters`. Missing fields take the safe default, never `undefined`-as-false,
  so an older control-plane cannot silently stop reviews for everyone.
- README's stage table is now two columns, **Built** and **Live on a real PR**.
  They were not the same thing, and one table saying "Built" for both was the
  first dishonest claim in a product whose pitch is that it does not make those.
  Stage 11 said "5 platforms"; only GitHub is reachable from the running service.

### Cavix in the Checks box

#### Added
- **A `Cavix Review` check run on every pull request**, the way CodeRabbit and
  the other AI reviewers appear. It opens `in_progress` the moment the job is
  picked up, before the model is called, so a reviewer sees Cavix working rather
  than nothing at all. It closes `completed` when the review is posted, with the
  Review Scope table as its expanded output and a `details_url` pointing at the
  review. `createCheckRun` / `updateCheckRun` added to the orchestrator's
  `GitHubClient` port, with a REST implementation and a recording fake.
- **`ReviewCheck`**, a small lifecycle object in the workflow. The handler owns
  one per job and hands it to every attempt, so a self-heal that re-runs the
  review against a different model moves the existing row instead of opening a
  second one. Previously there was no row at all; naively adding one per attempt
  would have left three Cavix checks on a healed PR, two spinning until GitHub
  timed them out.
- Conclusions: `success` when the review posts and nothing the owner asked to
  block on failed, `failure` only when they turned blocking on and a nominated
  rule or severity failed, and **`neutral` when Cavix could not finish**. GitHub
  counts neutral as passing for a required check, which is the point: an expired
  API key must not silently block every merge in the org.
- Whole path is best-effort. A 403 (personal access token, or an install without
  `checks: write`), a 404, a 422 on a fork head SHA, or an exception all leave
  `checkRunId` at 0 and cost the status row only, never the review. New
  `checkRun.test.ts` covers the lifecycle, the conclusions, and every one of
  those degradations.
- GUIDE §Step 7 now names the check, documents the conclusion table, and explains
  why a missing row means the App lacks `Checks: Read & write`.

### Review output redesign

The posted review is the product demo, so it was rebuilt to read like a document
a staff engineer would forward rather than a bot comment.

#### Changed
- **The PR description carries no findings at all.** No verdict callout, no
  finding counts, no severities, not even a severity mark beside a file in the
  walkthrough. What a change does stays true until merge; what is wrong with it
  stops being true the moment the author pushes a fix, and nobody but Cavix can
  edit that block to correct it. The description block is now the executive
  summary plus the per-file walkthrough and nothing else, under its own heading
  (`## ◈ Cavix Summary`). The verdict, the Scope module and every finding live on
  the review comment, which is dated, supersedable, and marked outdated by GitHub
  once the lines move. `renderSummarySection` split into `renderNarrative` (the
  durable half) and the comment's own head.
- **No emoji anywhere in posted output.** The severity scale is geometric now
  (`◆` critical, `◈` high, `◇` medium, `▪` low, `▫` info), `⬢` marks anything
  proven by execution, `▲` marks attention, and `✓`/`✕` are the policy check
  states. A test scans every posted surface and fails the build if one emoji
  gets through.
- **New `Review Scope & Effort` module opens the review comment.** Deep Scan,
  Symbol Scope, Security Gate, Execution Proof, Policy Gate, Confidence Score
  and Review Effort, each a measurement. Rows with no data behind them are
  omitted rather than filled in, so nothing in the module is invented. Optional
  `ScopeSignals` on `PosterOptions` lets earlier pipeline stages contribute an
  AST Verification, Deterministic Pass, Ensemble or Blast Radius row.
- **No git stats in the review.** Files changed, lines added and lines removed
  are rendered by GitHub directly above the comment, so the size table and the
  per-file line columns are gone. Line counts are still computed internally, but
  only to estimate review effort when the model does not supply one.
- **Colour comes from GitHub-native rendering.** Findings are introduced by alert
  callouts coloured by severity (`CAUTION`, `WARNING`, `IMPORTANT`, `NOTE`),
  provenance is a row of `<kbd>` chips, and suggested fixes off the diff get a
  real language fence for syntax highlighting.
- **New "Fix these first" callout** above the findings tables, naming only the
  findings at high severity or above, capped at five.
- **The walkthrough is bullets, not a table**, and leads with what each file now
  does rather than how many lines moved.
- Dashboard sample-review preview and the landing page sample were updated to
  match, so neither has drifted from what actually gets posted.

#### Added
- **Bounded shields.io badge strip** above the Scope table, in muted hex
  (crimson, burnt amber, amber gold, slate, emerald). At most five per review,
  never one per finding. `CAVIX_REVIEW_BADGES=off` turns it off for air-gapped
  GitHub Enterprise, where the image proxy cannot reach shields.io; the same
  facts stay in the table underneath.
- Review prompt now specifies the summary as a 2 to 4 sentence executive summary
  written in architectural intent, and bans emoji in every model-written field.

### Phase 5 — production GitHub App + `@cavix` commands + competitor parity

#### Added
- **`@cavix` command handling (edge, Go)**: `issue_comment` webhooks are parsed
  for `@<handle> <command>` (review/re-review/resolve/pause/resume/help/summary/
  ask). Commands carry a unique per-comment idempotency key so they are **never
  deduplicated** (fresh every time); only OWNER/MEMBER/COLLABORATOR may trigger.
  Handle configurable via `CAVIX_BOT_HANDLE`.
- **GitHub App auth (`packages/platforms`)**: `AppTokenProvider` mints an RS256
  App JWT → per-installation access token (cached), plus **Check Runs**
  (create/update) and **review management** (list/dismiss own reviews, delete
  stale comments).
- **Review session (`packages/review-session`)**: fresh vs incremental planning;
  `@cavix review` dismisses stale reviews + deletes stale comments + **busts the
  cache** for a full re-review; incremental never reposts a finding.
- **Repo config (`packages/repoconfig`)**: `.cavix.yaml`/`.cavix.json` with auto-
  review toggle, path filters (globs), disabled agents, policy toggle, tone, and
  `failOn` severities — dependency-free YAML-subset parser.

#### Verified (acceptance gate)
- `@cavix review` on a PR triggers a fresh review that removes stale reviews/cache
  (edge command tests + review-session tests).
- Production install flow documented end-to-end (GitHub App create → install → run
  → event flow → commands → config → required check) in GUIDE §8B, with a
  CodeRabbit competitor-parity table.
- Full suite green: 190 TypeScript tests + the Go edge suite.

### Phase 4 — trusted automated engineer (fix-PRs, IDE, batch, lenses, ROI)

#### Added
- **Verified fix-PR agent (`packages/fixpr`)**: opens its own fix PRs, but ONLY
  when Stage 10 proves the fix (repro fails before, passes after, suite stays
  green). Always a DRAFT labeled `needs-human-approval`; Cavix never auto-merges.
- **IDE local review (`packages/ide`)** + VS Code/JetBrains plugin manifests:
  pre-PR review with the SAME engine (deterministic + legacy + optional ensemble),
  offline by default, served to editors over a localhost server.
- **Batch modernization (`packages/batch`)**: migration at scale where EACH change
  is independently gated through Stage 10; unverified migrations are excluded.
- **Review lenses (`packages/lenses`)**: a marketplace substrate — installable
  packs of English/policy rules + extra agents + a bundled per-org confidence
  model; validated and composed into the pipeline.
- **ROI analytics (`packages/analytics`)**: per-team action rate, defects caught
  (verified), and reviewer-hours saved via an explicit, tunable model.

#### Verified (acceptance gate)
- The fix-PR agent opens a draft PR whose fix is verified green; an unverifiable
  fix is NOT proposed (`npm run phase4-demo`; fixpr tests with a real sandbox).
- The IDE plugin returns a useful local review before a PR is opened (ide tests).
- ROI analytics produce reviewer-hours-saved and action-rate numbers (analytics
  tests + demo: 86% action rate, 6 defects caught, ~6 hours saved).
- Every autonomous action stays verification-gated and human-approvable.

### Phase 3 — enterprise deployability (self-host, air-gap, governance, legacy, compliance)

#### Added
- **Air-gapped mode (`packages/gateway`)**: `SelfHostedProvider` (OpenAI-compatible
  in-cluster model) + `EgressGuard` (allowlist; all other hosts throw) +
  `createAirgappedGateway`. Zero outbound calls; proven by tests + the air-gap demo.
- **Governance (`packages/governance`)**: SAML 2.0 assertion verification, SCIM 2.0
  provisioning → RBAC roles, and a tamper-evident hash-chained audit log.
- **Policy graduation (`packages/policy`)**: English-rule compiler → deterministic
  immutable checks, STANDARDS.md ingestion, per-repo overrides (still off by default).
- **Legacy languages (`packages/legacy`)**: located COBOL/PL-SQL/C-C++/Java/.NET/IaC
  analysis + a modernization mode that verifies migrations through Stage 10.
- **Zero-retention (`packages/zero-retention`)**: ephemeral review lifecycle with a
  verified purge + metadata-only persistence.
- **Offline licensing (`packages/license`)**: Ed25519-signed licenses verified
  offline (air-gap safe); seat + feature entitlements.
- **Self-host infra (`deploy/`)**: Helm chart with a deny-all-egress NetworkPolicy
  and hardened pods, Terraform, and cosign image signing.
- **Compliance (`docs/compliance/`)**: air-gapped data-flow proof, security
  hardening, SOC 2 / ISO 27001 control mapping.

#### Verified (acceptance gate)
- Air-gapped mode makes zero outbound calls: `npm run airgap-demo` reaches only the
  in-cluster model; anthropic/openai/github are blocked (NetworkPolicy + EgressGuard).
- SSO (SAML), SCIM provisioning, RBAC, and a tamper-evident audit trail all function.
- A custom English policy rule is enforced on a test repo (off by default).
- COBOL and PL/SQL PRs get meaningful, located reviews (named paragraphs/procedures).
- Zero-retention: customer code present during a review is gone after, verified.
- `helm lint`/`helm template … | kubectl apply --dry-run` validate the chart; a
  deny-all-egress NetworkPolicy with no `0.0.0.0/0` is the kernel-layer air-gap proof.

### Phase 2 — differentiators (Stages 10, 5, 6, 12 + platforms + free tier + benchmarks)

#### Added
- **Stage 10 — verifier (`packages/verifier`)**: execution-grounded verification.
  Detects build/test setup, generates a minimal failing test (or a PoC exploit
  for security findings), reproduces in a hardened sandbox (no egress, caps,
  ephemeral), optionally applies the fix and re-runs the suite. Marks
  VERIFIED/UNVERIFIED/INCONCLUSIVE; gate skips facts + trivial nits;
  `verifyAndFilter` surfaces VERIFIED + facts and suppresses proven false alarms.
  Real `node`-in-sandbox e2e tests + demo.
- **Stage 5 — orggraph (`packages/orggraph`)**: cross-repo impact. Extracts
  provided interfaces (OpenAPI, protobuf, GraphQL, package names) and consumer
  call sites; a contract-changing PR is traced to consumers in other repos with
  exact call sites.
- **Stage 6 — telemetry (`packages/telemetry`)**: CI/CD ingest (ClickHouse port),
  baselines + flaky detection, regression prediction (measured + predicted-risk),
  optional sandbox benchmark-vs-baseline; deterministic `telemetry` findings.
- **Stage 12 — learning (`packages/learning`)**: calibrate per-org thresholds from
  accept/reject decisions; feeds Stage 9 thresholds and the Stage 10 verify gate;
  lowers false positives.
- **Platforms (`packages/platforms`)**: one `ReviewPlatform` port + GitHub,
  GitLab, Bitbucket Cloud, Bitbucket Server/DC, and Azure DevOps adapters.
- **Free/OSS tier (`services/control-plane`)**: tiers, public-repo-only
  onboarding, per-tier rate limits, opt-in proven-catches feed (verified findings
  from public repos only).
- **Eval**: Phase 2 verification scoring, side-by-side competitor table, and
  Defects4J / SWE-bench / CVEfixes benchmark adapters.

#### Verified (acceptance gate)
- A planted bug is reproduced in the sandbox → VERIFIED; a non-reproducing false
  alarm → UNVERIFIED and suppressed (verifier tests + `npm run verify-demo`).
- A planted vulnerability gets a working PoC exploit test (real `node` run).
- A breaking change in repo A is flagged as impacting repo B with exact call
  sites (`npm run orggraph-demo`).
- A perf-regressing PR triggers a telemetry warning (telemetry tests).
- FP-rate drops and F1 rises vs Phase 1: **F1 95.7% → 100%, FP-rate 8.3% → 0%**
  (`npm run eval`). GitLab + Bitbucket Server + Azure each post a review
  (platform tests). The verification sandbox uses no egress + hard caps.

### Phase 1 — context-aware review (Stages 2, 3, 3c, 4, 7, 8, 9 + dashboard)

#### Added
- **Stage 4 — analyzer (`packages/analyzer`)**: heuristic JS/TS/Python/Go parsers
  behind a `Parser` port; whole-repo `CodeIndex` with cross-file call resolution;
  `blastRadiusFromDiff` (changed symbols + transitive callers + touched files);
  incremental re-index; `Embedder` port + deterministic `FakeEmbedder` + cosine.
- **Stage 3 — deterministic (`packages/deterministic`)**: `SecretScanner`,
  `BuiltinRuleScanner` (15 in-process SAST rules + an SSRF data-flow rule), and a
  registry of 24 external linters/SAST selected by language and normalized from
  SARIF / semgrep-JSON. All normalized to the common `Finding` schema.
- **Stage 3c — policy gate (`packages/policy`)**: OFF by default; when enabled,
  emits `source=policy`, `immutable=true` findings (generic governance rules:
  endpoint-needs-auth (cross-file aware), banned-import). Not security-specific.
- **Stage 2 — sandbox (`packages/sandbox`)**: one `Sandbox` port, backends
  Local (dev) / Docker (isolation: no-egress, CPU/mem/pids caps, ro-rootfs) /
  Cloudflare (managed) + fake; `shallowClone` of the merge commit.
- **Stage 7 — context (`packages/context`)**: `ContextAssembler` (blast-radius
  caller snippets + past discussions + embedding neighbors), cheap-model
  compression, token-budgeted packing.
- **Stage 8 — ensemble (`packages/agents`)**: 7 specialized agents in parallel
  with abstention, cited cross-file evidence, and a cheap/frontier model router.
- **Stage 9 — adjudicator (`packages/adjudicator`)**: dedupe + vote + threshold;
  immutable policy findings pass through untouched; deterministic facts survive.
- **`packages/pipeline`**: composes the stages into `runPhase1Review`; a demo
  indexes this repo and shows a cross-file catch + policy off/on.
- **`services/control-plane`**: org/repo onboarding, recent reviews, and
  per-finding accept/reject decisions (the Phase 2 learning-loop signal) + a
  minimal HTML dashboard.
- **Eval**: Phase 1 predictor (real deterministic + real adjudication + fixtured
  ensemble) with a before/after table.

#### Verified (acceptance gate)
- Indexing a real medium repo completes (this monorepo: 85 files / 193 symbols /
  265 edges in ~9ms) and re-indexes incrementally on push (~2ms / file).
- A review references cross-file context: the api-breaking finding cites
  `routes.ts` for a change in `auth.ts` (shown by `npm run phase1`).
- Policy gate ENABLED emits an immutable finding that survives adjudication;
  OFF (default) forces nothing (pipeline + adjudicator tests, `npm run phase1`).
- Eval F1 beats the Phase 0 baseline by a clear margin: **81.8% → 95.7%**
  (recall 81.8% → 100%, FP-rate 18.2% → 8.3%).
- Dashboard records accept/reject decisions (control-plane tests).

### Phase 0 — end-to-end skeleton (Stages 0 + 1)

#### Added
- Monorepo foundation: `.gitignore`, `README.md`, `docker-compose.yml`
  (Postgres + Redis), GitHub Actions CI (lint + typecheck + test for both the
  Go and Node toolchains, plus an eval F1 gate).
- **Stage 0 — edge (Go, `services/edge`)**: GitHub App webhook receiver.
  Constant-time HMAC-SHA256 verification (fail-closed); strict normalization of
  `pull_request` payloads to a canonical `ReviewJob`; idempotency dedupe keyed on
  (repo, PR, action, head SHA); enqueue-then-ACK with a ~1ms 202 response
  (<100ms budget); `queue.Producer` port with an in-memory fake and a Redis
  Streams (`XADD`) implementation over a **zero-dependency, stdlib-only RESP
  client** (air-gapped buildable); structured JSON logs with secret redaction;
  graceful shutdown.
- **Gateway (`packages/gateway`)**: single LLM chokepoint. `LLMProvider` port
  with a fetch-based `AnthropicProvider` (no SDK) and a deterministic
  `FakeProvider`; **per-org BYOK** key resolution (key never logged, only a
  sha256 fingerprint); per-request **token + USD cost ledger** with a
  configurable pricing table (Stage 13 cost accounting).
- **Shared core (`packages/core`)**: canonical `ReviewJob` (+ validation),
  `Finding`/`ReviewResult` types, and a dependency-free unified-diff parser with
  commentable-line extraction.
- **Stage 1 — orchestrator (`services/orchestrator`)**: durable review workflow.
  `WorkflowEngine` port (InlineEngine with retry/backoff + lazy BullMqEngine,
  Temporal-swappable); `GitHubClient` port (REST + capturing fake); single-model
  `Reviewer` through the BYOK gateway with a robust JSON finding parser; poster
  that anchors findings to diff lines, renders GitHub `suggestion` blocks, and
  buckets a summary by severity; Stage 0→1 bridge consuming the Redis Stream via
  a consumer group (poison-ack / unacked-on-failure semantics) over a stdlib TS
  RESP client; `main.ts` production wiring and a `demo` that posts a full review
  in ~2ms.
- **Eval (`eval/`)**: precision/recall/F1/false-positive-rate harness with
  location-based matching, 10 gold-labeled seed PRs (real diffs), fixture +
  live modes, a results table, and a CI F1 regression gate.

#### Verified (acceptance gate)
- PR → posted review: `npm run demo` posts a 2-comment review (with a one-click
  fix) in ~2ms (budget 60s), exercised end-to-end through the stream bridge in
  the e2e test.
- Eval prints precision/recall/F1 on the seed set: **F1 81.8%, FPR 18.2%**.
- BYOK: swapping an org's key changes the billed key fingerprint (gateway test
  `BYOK: swapping an org's key changes which key is billed`).
- Tests: `go test ./...` (edge) and `npm test` (38 TS tests) green;
  `ARCHITECTURE.md` + `CHANGELOG.md` accurate.
