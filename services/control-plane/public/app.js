// Cavix dashboard, a dependency-free single-page app over the control-plane API.
(function () {
  const $ = (id) => document.getElementById(id);
  const content = $("content");
  let me = null;       // current user
  let org = null;

  // ---------- tiny helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ic = (n, c) => (window.icon ? window.icon(n, c) : "");
  async function api(path, opts) {
    const res = await fetch(path, Object.assign({ headers: { "content-type": "application/json" } }, opts));
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.ok) return data;
    // An expired GitHub connection is not an expired session. It arrives as a
    // 401 too, so it has to be checked first: bouncing the user to /login over
    // it would sign them out of Cavix because GitHub timed them out.
    if (data && data.reconnect) {
      const err = new Error(data.error || "Reconnect your GitHub account.");
      err.reconnect = true;
      throw err;
    }
    if (res.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
    throw new Error((data && data.error) || `request failed (${res.status})`);
  }
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2600);
  }
  const sevBadge = (s) => `<span class="badge badge-${esc(s)}">${esc(s)}</span>`;

  const VIEWS = {
    overview: { title: "Overview", crumb: "Your review activity at a glance", render: renderOverview },
    reviews: { title: "Reviews", crumb: "Findings from your pull requests, accept or reject to train Cavix", render: renderReviews },
    sample: { title: "Sample review", crumb: "Preview the review comment your settings produce", render: renderSample },
    repos: { title: "Repositories", crumb: "Connect GitHub and choose repos to review", render: renderRepos },
    reports: { title: "Reports", crumb: "ROI and quality across your workspace", render: renderReports },
    learnings: { title: "Learnings", crumb: "What Cavix has learned from your accept/reject decisions", render: renderLearnings },
    feed: { title: "Proven catches", crumb: "Publicly verified findings across the community", render: renderFeed },
    byok: { title: "AI & BYOK", crumb: "Bring your own AI key, Cavix never marks up tokens", render: renderByok },
    settings: { title: "Review settings", crumb: "How Cavix reviews your pull requests", render: renderSettings },
    integrations: { title: "Integrations", crumb: "Source control, chat and issue trackers", render: renderIntegrations },
    team: { title: "Team", crumb: "People in your workspace and their roles", render: renderTeam },
    billing: { title: "Plan & billing", crumb: "Your subscription and usage", render: renderBilling },
    admin: { title: "Admin console", crumb: "Founder controls, every org's tier, trial, limits & status", render: renderAdmin },
  };

  // ---------- boot ----------
  (async function boot() {
    try {
      const data = await api("/api/auth/me");
      me = data.user;
      org = me.org;
    } catch { location.href = "/login"; return; }

    $("userName").textContent = me.name;
    $("userOrg").textContent = `${me.org} · ${me.role}`;
    $("avatar").textContent = (me.name || me.email)[0].toUpperCase();
    if (me.platformAdmin) document.querySelectorAll(".admin-only").forEach((el) => el.classList.remove("hidden"));
    // Consistent SVG nav icons (view name maps 1:1 to an icon).
    if (window.icon) document.querySelectorAll(".nav-item").forEach((el) => { const s = el.querySelector(".ni-ico"); if (s) s.innerHTML = window.icon(el.dataset.view); });
    $("logout").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST" }); location.href = "/"; });
    $("menuBtn").addEventListener("click", () => $("sidebar").classList.toggle("open"));
    $("topAction").addEventListener("click", (e) => { e.preventDefault(); go("repos"); });

    document.querySelectorAll(".nav-item").forEach((el) => el.addEventListener("click", () => go(el.dataset.view)));
    window.addEventListener("hashchange", () => go(location.hash.slice(1) || "overview", true));

    // Returning from the GitHub App install flow (GitHub appends installation_id).
    const q = new URLSearchParams(location.search);
    if (q.has("installation_id") || q.get("setup_action") === "install") {
      history.replaceState(null, "", "/app#repos");
      setTimeout(() => toast("Cavix installed. Toggle the repositories you want reviewed."), 400);
      go("repos", true);
      return;
    }
    go(location.hash.slice(1) || "overview", true);
  })();

  function go(view, fromHash) {
    if (!VIEWS[view]) view = "overview";
    if (!fromHash) location.hash = view;
    document.querySelectorAll(".nav-item").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
    $("viewTitle").textContent = VIEWS[view].title;
    $("viewCrumb").textContent = VIEWS[view].crumb;
    $("sidebar").classList.remove("open");
    content.innerHTML = `<div class="empty">Loading…</div>`;
    VIEWS[view].render().catch((err) => {
      // Any page that needed GitHub and found the connection dead offers the way
      // back, rather than showing the raw API error it used to.
      content.innerHTML = err.reconnect ? connectHero(err.message) : `<div class="empty">${esc(err.message)}</div>`;
    });
  }

  // ---------- OVERVIEW ----------
  /**
   * Severity as labelled meters, not a five-colour chart.
   *
   * critical/high/medium/low/info forces red, orange and yellow next to each
   * other, and that trio cannot clear the normal-vision separation floor at any
   * stepping. So the name, the geometric mark (the same one the posted review
   * uses) and the count carry identity, and length carries magnitude.
   */
  const SEV_ROWS = [
    { key: "critical", mark: "◆", color: "#F0857E" },
    { key: "high", mark: "◈", color: "#E6B45F" },
    { key: "medium", mark: "◇", color: "#C98500" },
    { key: "low", mark: "▪", color: "#8FBCFF" },
    { key: "info", mark: "▫", color: "#7C93B5" },
  ];
  const severityMeters = (bySeverity) =>
    CavixCharts.meters(
      SEV_ROWS.map((r) => ({ label: r.key, mark: r.mark, color: r.color, value: bySeverity[r.key] || 0 })),
    );

  async function renderOverview() {
    const [s, a] = await Promise.all([
      api(`/api/orgs/${org}/stats`),
      api(`/api/orgs/${org}/analytics?days=30`),
    ]);

    content.innerHTML = `
      <div class="stat-grid">
        ${CavixCharts.tile("Reviews run", s.reviews, { note: "all time" })}
        ${CavixCharts.tile("Verified findings", s.verified, { note: "proven in a sandbox" })}
        ${CavixCharts.tile("Action rate", `${Math.round(s.actionRate * 100)}%`, {
          delta: a.actionRateTrend,
          unit: "pt",
          note: a.actionRateTrend ? "vs the previous fortnight" : "accepted of decided",
        })}
        ${CavixCharts.tile("Reviewer-hours saved", a.reviewerHoursSaved, { note: "last 30 days" })}
      </div>
      <div class="grid grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Activity, last 30 days</h2></div>
          <div class="panel-body">${CavixCharts.trend(a.days)}</div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Findings by severity</h2></div>
          <div class="panel-body">${severityMeters(s.bySeverity)}</div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Getting started</h2><span class="sub">${s.reposConnected} repositor${s.reposConnected === 1 ? "y" : "ies"} connected</span></div>
        <div class="panel-body">
          <div class="settings-row"><div><div class="sr-label">1 · Add your AI key (BYOK)</div><div class="sr-desc">Plug in your Claude, GPT, or Gemini key so reviews can run.</div></div><button class="btn btn-soft btn-sm" onclick="location.hash='byok'">Add key</button></div>
          <div class="settings-row"><div><div class="sr-label">2 · Connect a repository</div><div class="sr-desc">Point Cavix at a repo to start reviewing its pull requests.</div></div><button class="btn btn-soft btn-sm" onclick="location.hash='repos'">Connect repo</button></div>
          <div class="settings-row"><div><div class="sr-label">3 · Open a pull request</div><div class="sr-desc">Cavix reviews it automatically and posts a ✓/✗ check.</div></div><a class="btn btn-soft btn-sm" href="https://github.com" target="_blank">Open GitHub</a></div>
        </div>
      </div>`;
  }

  // ---------- REVIEWS ----------
  //
  // One card per reviewed pull request, newest first. Findings are ordered worst
  // first inside a card, the same order the PR comment uses, so the two surfaces
  // read the same way round.
  const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  const rel = (iso) => {
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (!Number.isFinite(mins)) return "";
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
    if (mins < 20160) return `${Math.round(mins / 1440)}d ago`;
    return new Date(iso).toLocaleDateString();
  };

  async function renderReviews() {
    const reviews = await api(`/api/reviews?org=${encodeURIComponent(org)}`);
    if (!reviews.length) {
      content.innerHTML = `
        <div class="empty">
          <div class="big">◈</div>
          <div><b>No reviews yet.</b></div>
          <div style="margin-top:6px">Connect a repository and open a pull request. Every review Cavix posts shows up here with its findings.</div>
          <div style="margin-top:16px"><button class="btn btn-soft btn-sm" onclick="location.hash='repos'">Connect a repository</button></div>
        </div>`;
      return;
    }

    content.innerHTML = reviews.map((r) => {
      const sorted = [...r.findings].sort(
        (a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0) || a.line - b.line,
      );
      const findings = sorted.map((f) => {
        const source = f.immutable ? `<span class="badge badge-policy">policy</span>` : `<span class="badge">${esc(f.source)}</span>`;
        const verified = f.verified ? `<span class="badge badge-verified">✓ verified</span>` : "";
        const decided = f.decision ? `<span class="decided ${esc(f.decision.state)}">${esc(f.decision.state)} by ${esc(f.decision.user)}</span>` : "";
        const actions = f.decision ? decided : `
          <button class="btn btn-soft btn-sm" onclick="cavixDecide('${esc(f.id)}','accepted',this)">Accept</button>
          <button class="btn btn-danger btn-sm" onclick="cavixDecide('${esc(f.id)}','rejected',this)">Reject</button>`;
        return `<div class="finding" data-fid="${esc(f.id)}">
          ${sevBadge(f.severity)}
          <div class="f-body">
            <div class="f-title">${esc(f.title)}</div>
            <div class="f-loc">${esc(f.path)}:${f.line}</div>
            <div class="f-tags">${source}${verified}<span class="badge">${esc(f.category)}</span></div>
          </div>
          <div class="f-actions">${actions}</div>
        </div>`;
      }).join("");

      // A clean review is a result, not an empty card: say so rather than
      // showing a heading with nothing under it.
      const bodyHtml = findings || `<div class="finding"><span class="badge badge-verified">✓ clean</span>
        <div class="f-body"><div class="f-title">No issues found</div>
        <div class="f-loc">Cavix reviewed this pull request and had nothing to raise.</div></div></div>`;

      const verified = r.findings.filter((f) => f.verified).length;
      const meta = [
        `${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}`,
        ...(verified ? [`${verified} verified in a sandbox`] : []),
        rel(r.createdAt),
      ].join(" · ");
      const title = `${esc(r.repo)} <span style="color:var(--text-faint)">#${Number(r.pr)}</span> ${esc(r.title)}`;

      return `<div class="review">
        <div class="review-head">
          <div>
            <div class="r-title">${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" style="color:inherit">${title}</a>` : title}</div>
            <div class="r-meta">${esc(meta)}</div>
          </div>
          ${r.url ? `<a class="btn btn-soft btn-sm" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Open PR</a>` : `<span class="badge">${esc(new Date(r.createdAt).toLocaleDateString())}</span>`}
        </div>${bodyHtml}
      </div>`;
    }).join("");
  }

  // exposed for inline onclick
  window.cavixDecide = async function (id, state, btn) {
    try {
      // The server attributes the decision to the signed-in session, so the
      // label here comes back from it rather than being guessed client-side.
      const updated = await api(`/api/findings/${id}/decision`, { method: "POST", body: JSON.stringify({ state }) });
      const row = btn.closest(".finding").querySelector(".f-actions");
      const who = (updated && updated.decision && updated.decision.user) || me.email;
      row.innerHTML = `<span class="decided ${esc(state)}">${esc(state)} by ${esc(who)}</span>`;
      toast(`Finding ${state}, Cavix will learn from this`);
    } catch (e) { toast(e.message); }
  };

  // ---------- SAMPLE REVIEW (live preview of the configured comment) ----------
  //
  // This has to match what the orchestrator's poster actually renders. If you
  // change the shape of the posted review, change it here too — a preview that
  // has drifted from reality is worse than no preview.
  async function renderSample() {
    const s = await api(`/api/orgs/${org}/settings`);
    const rs = s.reviewSections || {};
    const pm = s.preMergeChecks || { enabled: false, rules: [] };
    // Compile status is needed here too — landing on this page directly must not
    // show an uncompilable rule as a passing check.
    if (pm.enabled && pm.rules.length) {
      settingsRules = [...pm.rules];
      await checkRuleCompilation();
    }
    const toneBlurb = {
      concise: "Refund flow refactor. One verified high-severity issue; one nit suppressed.",
      detailed: "This PR refactors the refund flow and adds retry handling to the payments service. One high-severity correctness issue was verified (double-refund on webhook retry) and one nit was suppressed as unverifiable.",
      educational: "This PR refactors the refund flow. Idempotency matters here because payment webhooks can be delivered more than once, so a non-guarded refund path can charge twice. One verified high-severity issue was found and one nit suppressed.",
      assertive: "Refactors the refund flow. There is a verified double-refund on webhook retry that must be fixed before merge. One nit was suppressed.",
      chill: "Nice refund flow cleanup! One thing worth a look: a double-refund on retries (verified). Skipped a tiny nit, nothing blocking.",
    };

    // Where the summary block lands is itself a setting.
    const target = s.summaryInDescription ? "pull request description" : "review comment";

    // The walkthrough is bullets, not a table. No line counts (GitHub prints
    // those a few pixels above) and no finding counts: the description has to
    // still be true after the author pushes a fix, and a count is not.
    const walkthrough = rs.changedFiles ? `<h4>What Changed</h4><ul class="wt-list">
        <li><code>services/payments/refund.ts</code> · Add idempotency guard before issuing a refund</li>
        <li><code>services/payments/webhook.ts</code> · Handle Stripe retry deliveries</li>
        <li><code>test/refund.test.ts</code> · New retry regression test</li></ul>` : "";

    // The verdict callout, the same alert GitHub renders at the top of the post.
    // It lives on the review COMMENT, never in the description.
    const verdict = `<div class="gh-alert warning">
        <div class="ga-title">2 findings across 1 file</div>
        <div class="ga-body"><span class="badge badge-high">◈ 1 high</span> <span class="badge badge-low">▪ 1 low</span>${s.requestChangesOnFail ? ` · <b>changes requested</b>` : ""}</div>
      </div>`;

    // The description block: what the change does, and nothing about what is
    // wrong with it. Findings get fixed within the hour and the author cannot
    // edit Cavix's block to correct a stale count, so none of that goes here.
    const summaryCard = (rs.summary || rs.changedFiles) ? `
      <div class="summary-card" style="margin-bottom:18px">
        <div class="sc-head"><span class="logo-mark" style="width:22px;height:22px;font-size:12px"><img class="lm-svg" src="/cavix-mark.svg?v=13" alt="" aria-hidden="true"></span><span class="who">cavix</span> <span class="badge">${esc(target)}</span> <span class="ago">preview</span></div>
        <div class="sc-body">
          ${rs.summary ? `<h4>Summary</h4><p>${esc(toneBlurb[s.tone] || toneBlurb.concise)}</p>` : ""}
          ${walkthrough}
        </div>
      </div>` : "";

    // The Review Scope & Effort module: the block that opens the review comment.
    // Every row is a measurement, never an estimate dressed up as one, so a row
    // with no data behind it simply is not here.
    const scopeCard = rs.reviewEffort ? `
      <div class="scope-strip">
        <span class="sbadge sb-sev">Security · 1 high</span>
        ${s.verifyFindings ? `<span class="sbadge sb-ok">Execution Proof · 1 verified</span>` : ""}
        <span class="sbadge sb-ok">Confidence · 86%</span>
        <span class="sbadge">Review Effort · 3 of 5</span>
      </div>
      <h4 style="margin-top:14px">◈ Review Scope &amp; Effort</h4>
      <table class="changes-table"><thead><tr><th></th><th>Signal</th><th>Reading</th></tr></thead><tbody>
        <tr><td>◇</td><td style="font-family:var(--font)"><b>Deep Scan</b></td><td>2 subsystems traversed · 9 changed regions · TypeScript</td></tr>
        <tr><td>◇</td><td style="font-family:var(--font)"><b>Symbol Scope</b></td><td><code>issueRefund</code>, <code>onWebhook</code></td></tr>
        <tr><td><span class="mark-att">▲</span></td><td style="font-family:var(--font)"><b>Security Gate</b></td><td><span class="mark-high">◈</span> 1 exposure, highest <b>high</b></td></tr>
        ${s.verifyFindings ? `<tr><td><span class="mark-ok">⬢</span></td><td style="font-family:var(--font)"><b>Execution Proof</b></td><td>1 of 2 findings reproduced in a sealed sandbox, 1 discarded as unreproducible</td></tr>` : ""}
        <tr><td>◇</td><td style="font-family:var(--font)"><b>Confidence Score</b></td><td>●●●●○ 86% mean across the findings below</td></tr>
        <tr><td>◇</td><td style="font-family:var(--font)"><b>Review Effort</b></td><td>◆◆◆◇◇ <b>3 of 5</b>, a focused read</td></tr>
      </tbody></table>
      <div style="height:18px"></div>` : "";

    // The gate panel only exists if the owner turned it on and wrote rules.
    const gateCard = (pm.enabled && pm.rules.length) ? `
      <div class="premerge" style="margin-bottom:18px">
        <div class="pm-head"><div><b>Pre-merge Checks</b> <span class="badge badge-policy">your org's rules</span></div>
          <span class="badge ${s.requestChangesOnFail ? "badge-high" : ""}">${s.requestChangesOnFail ? "a failure blocks merge" : "reporting only"}</span></div>
        ${pm.rules.slice(0, 4).map((r) => {
          // Three states, not two: an unknown compile status means we have not
          // heard back yet, and showing that as a pass is the one thing a gate
          // preview must never do.
          const c = ruleCompile[r];
          const state = !c ? "pending" : c.ok ? "pass" : "skipped";
          // Same glyphs the poster uses on the pull request: pass, fail, did not run.
          const ico = { pending: "…", pass: "✓", skipped: "◇" }[state];
          const sub = {
            pending: "checking whether this compiles into a check…",
            pass: "3 changed files scanned · pass",
            skipped: "does not compile into a check, it will not run",
          }[state];
          return `<div class="pm-row ${state === "pass" ? "pass" : ""}"><span class="pm-ico">${ico}</span><div class="pm-rule">${esc(r)}<div class="pm-sub">${sub}</div></div><span class="badge ${state === "pass" ? "badge-verified" : ""}">${state === "pending" ? "checking…" : state}</span></div>`;
        }).join("")}
      </div>` : "";

    const findingsCard = `
      <div class="summary-card" style="margin-bottom:18px">
        <div class="sc-head"><span class="logo-mark" style="width:22px;height:22px;font-size:12px"><img class="lm-svg" src="/cavix-mark.svg?v=13" alt="" aria-hidden="true"></span><span class="who">cavix</span> <span class="badge">review comment</span> <span class="ago">preview</span></div>
        <div class="sc-body">
          ${scopeCard}
          ${verdict}
          <h4>Findings</h4>
          <div class="gh-alert warning">
            <div class="ga-title">Fix these first</div>
            <div class="ga-body"><span class="mark-high">◈</span> <b>Refund can double-apply on retry</b> · <code>services/payments/refund.ts</code> line 87</div>
          </div>
          <h4><span class="mark-high">◈</span> services/payments/refund.ts · 2 findings</h4>
          <table class="changes-table"><thead><tr><th></th><th>Line</th><th>Finding</th><th>Detail</th></tr></thead><tbody>
            <tr><td><span class="mark-high">◈</span></td><td>87</td><td style="font-family:var(--font)"><b>Refund can double-apply on retry</b>${rs.proof ? ` <span class="mark-ok">⬢</span>` : ""}<div class="t-faint">high · correctness · confidence 86%</div></td><td>${rs.inlineFindings ? "▸ inline" : "▾ below"}</td></tr>
            <tr><td>▪</td><td>12</td><td style="font-family:var(--font)"><b>Duplicated retry constant</b><div class="t-faint">low · maintainability · confidence 52%</div></td><td>${rs.inlineFindings ? "▸ inline" : "▾ below"}</td></tr>
          </tbody></table>
        </div>
      </div>`;

    const inlineCard = rs.inlineFindings ? `
      <div class="cr-window">
        <div class="cr-head"><span class="fname">services/payments/refund.ts</span> <span class="pill-sm">line 87</span></div>
        <div class="cr-code">
<div class="cr-line del"><span class="ln">87</span><span class="k">  await</span> charge.<span class="f">refund</span>(amount)</div>
<div class="cr-line add"><span class="ln">87</span><span class="k">  if</span> (!refund.<span class="f">isSettled</span>(id)) <span class="k">await</span> charge.<span class="f">refund</span>(amount)</div>
        </div>
        <div class="cr-comment">
          <div class="cc-head"><span class="logo-mark" style="width:22px;height:22px;font-size:12px"><img class="lm-svg" src="/cavix-mark.svg?v=13" alt="" aria-hidden="true"></span><span class="cc-bot">cavix</span>${rs.proof ? `<span class="badge badge-verified">⬢ verified</span>` : ""}<span class="badge badge-high">high</span></div>
          <div class="cc-body"><b><span class="mark-high">◈</span> Refund can double-apply on retry</b>
            <div class="t-faint" style="margin:4px 0 8px">${rs.proof ? "⬢ verified · " : ""}high · correctness · confidence 86%</div>
            On a webhook re-delivery this path issues a second refund.</div>
          ${rs.proof ? `<div class="cc-proof"><b style="font-family:var(--font)">⬢ Execution proof.</b> Reproduced in a sealed sandbox:

<span class="t-purple">[repro]</span>     node --test refund.retry.test.mjs → <span class="t-red">exit 1</span>  bug reproduced
<span class="t-purple">[after-fix]</span> node --test refund.retry.test.mjs → <span class="t-green">exit 0</span>  fix resolves it
<span class="t-purple">[suite]</span>     node --test                      → <span class="t-green">exit 0</span>  suite still green</div>` : ""}
        </div>
      </div>` : "";

    const verifyNote = s.verifyFindings
      ? `Findings are reproduced in a sandbox before posting; anything that can't be reproduced is dropped.`
      : `Verification is <b>off</b>, so findings post unproven and nothing gets suppressed.`;

    content.innerHTML = `
      <div class="panel"><div class="panel-body" style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
        <div><div class="sr-label">What Cavix will post on a pull request</div><div class="sr-desc">Built live from your Review settings. Tone: <b>${esc(s.tone)}</b> · summary goes in the <b>${esc(target)}</b>. ${verifyNote}</div></div>
        <a class="btn btn-soft btn-sm" onclick="location.hash='settings'">Edit structure &amp; tone</a>
      </div></div>
      <div style="max-width:860px">${summaryCard}${gateCard}${findingsCard}${inlineCard}</div>`;
  }

  // ---------- REPOS (GitHub App installations → per-repo enable toggles) ----------
  const GH_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

  /**
   * The one way back from "we have no working GitHub credential", whether that
   * is a first-time connect or a token GitHub expired underneath us.
   */
  function connectHero(message) {
    return `
      <div class="panel"><div class="connect-hero">
        <div class="gh-badge">${GH_SVG}</div>
        <h2>Connect your GitHub account</h2>
        <p>${esc(message || "Sign in with GitHub to see your organizations and repositories, then enable reviews on the ones you choose, all from here.")}</p>
        <a class="btn btn-github" href="/api/auth/github/start">${GH_SVG} Continue with GitHub</a>
      </div></div>`;
  }

  async function renderRepos() {
    const status = await api(`/api/github/status`);

    // Real mode but no usable credential → prompt to connect (or reconnect).
    if (status.configured && !status.connected) {
      content.innerHTML = connectHero();
      return;
    }

    const data = await api(`/api/github/installations`);
    const connectedNote = data.demo ? `<span class="badge">demo data</span>` : `<span class="badge badge-verified">connected as ${esc(status.login || "you")}</span>`;

    const orgCards = data.orgs.map((o) => {
      if (!o.installed) {
        return `<div class="panel">
          <div class="panel-head">
            <div class="ao-name"><span class="ao-av">${esc(o.login[0].toUpperCase())}</span><div>${esc(o.login)}${o.isUser ? " (you)" : ""}<div class="ao-meta">Cavix isn't installed here yet</div></div></div>
            <a class="btn btn-primary btn-sm" href="${esc(data.installUrl)}" target="_blank" rel="noopener">${GH_SVG} Install Cavix</a>
          </div>
        </div>`;
      }
      const rows = o.repos.length ? o.repos.map((r) => `
        <div class="repo-row">
          <div class="r-ico">${r.private ? ic("lock") : ic("repos")}</div>
          <div class="r-main">
            <div class="r-name">${esc(r.name)} <span class="badge">${r.private ? "private" : "public"}</span></div>
            <div class="r-desc">${esc(r.description || "No description")}</div>
          </div>
          ${r.language ? `<span class="r-lang">${esc(r.language)}</span>` : ""}
          <label class="switch"><input type="checkbox" ${r.enabled ? "checked" : ""} onchange="cavixToggleRepo('${esc(r.fullName)}', ${!r.private}, this)"><span class="slider"></span></label>
        </div>`).join("") : `<div class="empty" style="padding:24px">No repositories granted to this installation. <a href="${esc(data.installUrl)}" target="_blank">Adjust repo access ↗</a></div>`;
      return `<div class="panel">
        <div class="panel-head">
          <div class="ao-name"><span class="ao-av">${esc(o.login[0].toUpperCase())}</span><div>${esc(o.login)}${o.isUser ? " (you)" : ""}<div class="ao-meta">${o.repos.filter((r) => r.enabled).length} of ${o.repos.length} enabled</div></div></div>
          <span class="badge badge-verified">installed</span>
        </div>
        <div class="repo-list" style="border:none">${rows}</div>
      </div>`;
    }).join("");

    content.innerHTML = `
      <div class="panel"><div class="panel-body" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div><div class="sr-label">${GH_SVG} Your GitHub organizations</div><div class="sr-desc">Install Cavix on an org, then toggle the repos it should review. Only enabled repos are reviewed.</div></div>
        <div style="display:flex;gap:10px;align-items:center">${connectedNote}<a class="btn btn-soft btn-sm" href="${esc(data.installUrl)}" target="_blank" rel="noopener">Manage installation ↗</a></div>
      </div></div>
      ${orgCards || `<div class="empty" style="padding:40px">No organizations found.</div>`}`;
  }
  window.cavixToggleRepo = async function (fullName, isPublic, el) {
    try {
      if (el.checked) { await api(`/api/github/repos`, { method: "POST", body: JSON.stringify({ fullName, private: !isPublic }) }); toast(`Enabled ${fullName}`); }
      else { await api(`/api/github/repos?fullName=${encodeURIComponent(fullName)}`, { method: "DELETE" }); toast(`Disabled ${fullName}`); }
    } catch (e) { el.checked = !el.checked; toast(e.message); }
  };

  // ---------- PROVEN FEED ----------
  async function renderFeed() {
    const feed = await api(`/api/feed/proven`);
    if (!feed.length) {
      content.innerHTML = `<div class="empty">No proven catches yet. Verified findings from opted-in public repositories appear here.</div>`;
      return;
    }
    content.innerHTML = `<div class="panel"><div class="panel-head"><h2>Proven catches</h2><span class="sub">Execution-verified findings, opted in by their owners</span></div>
      <table class="table"><thead><tr><th>Repository</th><th>Finding</th><th>Category</th><th>Severity</th><th>When</th></tr></thead><tbody>
      ${feed.map((f) => `<tr><td><b>${esc(f.org)}/${esc(f.repo)}</b></td><td>${esc(f.title)}</td><td><span class="badge">${esc(f.category)}</span></td><td>${sevBadge(f.severity)}</td><td style="color:var(--text-faint)">${new Date(f.at).toLocaleDateString()}</td></tr>`).join("")}
      </tbody></table></div>`;
  }

  // ---------- BYOK ----------
  const PROVIDERS = { anthropic: "Anthropic (Claude)", openai: "OpenAI (GPT)", google: "Google (Gemini)", selfhosted: "Self-hosted / open model" };
  const MODELS = {
    anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-4-6"],
    openai: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "o4-mini"],
    google: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
    selfhosted: ["llama-3.1-70b-instruct", "qwen2.5-coder-32b", "deepseek-coder-v2", "mistral-large"],
  };
  // MODELS above is only the FALLBACK, used before a key is saved or if the
  // provider's listing endpoint is unreachable. The real list comes from the
  // provider and reflects what this specific key is entitled to call, so we
  // never offer a model that is retired or gated off the user's plan.
  let liveModels = null;   // [{id,label,contextWindow}] once loaded
  let liveNote = "";       // why the live list is unavailable, if it is

  function modelList(provider) {
    if (liveModels && liveModels.length) return liveModels;
    return (MODELS[provider] || []).map((id) => ({ id }));
  }
  function modelLabel(m) {
    const ctx = m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}K ctx` : "";
    return m.label && m.label !== m.id ? `${m.label} (${m.id})${ctx}` : `${m.id}${ctx}`;
  }
  function modelOptions(provider, selected) {
    const list = modelList(provider);
    const known = list.map((m) => `<option value="${esc(m.id)}"${m.id === selected ? " selected" : ""}>${esc(modelLabel(m))}</option>`).join("");
    const isCustom = selected && !list.some((m) => m.id === selected);
    return known + `<option value="__custom__"${isCustom ? " selected" : ""}>Custom…</option>`;
  }
  /** Ask the server which models this org's key can actually use. */
  async function loadModels(provider) {
    liveModels = null; liveNote = "";
    try {
      const r = await api(`/api/orgs/${org}/models?provider=${encodeURIComponent(provider)}`);
      if (r.source === "live" && r.models.length) liveModels = r.models;
      else liveNote = r.reason || "";
    } catch (e) { liveNote = e.message; }
  }
  function modelsHint(provider) {
    if (liveModels) return `<span class="badge badge-verified">${liveModels.length} available on your key</span>`;
    if (liveNote) return `<span class="sr-desc">Showing the built-in list. ${esc(liveNote)}</span>`;
    return `<span class="sr-desc">Save an API key to see the models it unlocks.</span>`;
  }
  async function renderByok() {
    const s = await api(`/api/orgs/${org}/settings`);
    await loadModels(s.llmProvider);
    const status = s.apiKeyFingerprint
      ? `<div class="key-box"><code>${esc(s.apiKeyFingerprint)}</code><span class="badge badge-verified">active</span></div>
         <div class="sr-desc" style="margin-top:8px">Set ${s.apiKeySetAt ? new Date(s.apiKeySetAt).toLocaleString() : ""}. Your key is encrypted at rest (AES-256-GCM) and never shown again.</div>`
      : `<div class="sr-desc">No key yet. Add one so Cavix can run reviews with your own AI account.</div>`;
    const customModel = !modelList(s.llmProvider).some((m) => m.id === s.llmModel);

    content.innerHTML = `
      <div class="panel">
        <div class="panel-head"><h2>AI provider &amp; model</h2><span class="sub">Model-agnostic, switch anytime</span></div>
        <div class="panel-body">
          <div class="grid grid-2" style="gap:16px">
            <div class="field" style="margin:0"><label>Provider</label><select id="provider">${Object.entries(PROVIDERS).map(([v, l]) => `<option value="${v}"${v === s.llmProvider ? " selected" : ""}>${l}</option>`).join("")}</select></div>
            <div class="field" style="margin:0"><label>Model</label><select id="model">${modelOptions(s.llmProvider, s.llmModel)}</select></div>
          </div>
          <div id="modelsHint" style="margin-top:10px">${modelsHint(s.llmProvider)}</div>
          <div class="field" id="customWrap" style="margin:14px 0 0;${customModel ? "" : "display:none"}"><label>Custom model id</label><input id="customModel" value="${customModel ? esc(s.llmModel) : ""}" placeholder="your-model-id"></div>
          <button class="btn btn-primary btn-sm" id="saveModel" style="margin-top:16px">Save provider &amp; model</button>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>API key (BYOK)</h2><span class="sub">Encrypted at rest · only a fingerprint is ever displayed</span></div>
        <div class="panel-body">
          <div style="margin-bottom:16px">${status}</div>
          <div class="field" style="margin:0"><label>Paste a new key</label><input id="apiKey" type="password" placeholder="sk-ant-… / sk-… / your model token"></div>
          <button class="btn btn-primary btn-sm" id="saveKey" style="margin-top:14px">Save key securely</button>
          <p class="sr-desc" style="margin-top:14px">Cavix never logs your key and never marks up tokens, you pay your AI provider directly. For air-gapped installs, choose <b>Self-hosted</b> and your in-cluster model is used with zero outbound calls.</p>
        </div>
      </div>`;

    const providerSel = $("provider"), modelSel = $("model");
    providerSel.addEventListener("change", async () => {
      $("modelsHint").innerHTML = `<span class="sr-desc">Checking which models your key can use…</span>`;
      await loadModels(providerSel.value);
      const first = modelList(providerSel.value)[0];
      modelSel.innerHTML = modelOptions(providerSel.value, first && first.id);
      $("modelsHint").innerHTML = modelsHint(providerSel.value);
      toggleCustom();
    });
    modelSel.addEventListener("change", toggleCustom);
    function toggleCustom() { $("customWrap").style.display = modelSel.value === "__custom__" ? "" : "none"; }

    $("saveModel").addEventListener("click", async () => {
      const model = modelSel.value === "__custom__" ? $("customModel").value.trim() : modelSel.value;
      if (!model) return toast("Enter a model id");
      try { await api(`/api/orgs/${org}/settings`, { method: "PUT", body: JSON.stringify({ llmProvider: providerSel.value, llmModel: model }) }); toast("Provider & model saved"); }
      catch (e) { toast(e.message); }
    });
    $("saveKey").addEventListener("click", async () => {
      const key = $("apiKey").value.trim();
      if (!key) return toast("Paste a key first");
      try { await api(`/api/orgs/${org}/apikey`, { method: "POST", body: JSON.stringify({ apiKey: key }) }); toast("Key saved securely"); go("byok"); }
      catch (e) { toast(e.message); }
    });
  }

  // ---------- REVIEW SETTINGS ----------
  async function renderSettings() {
    const s = await api(`/api/orgs/${org}/settings`);
    const toggle = (key, label, desc, checked) => `
      <div class="settings-row"><div><div class="sr-label">${label}</div><div class="sr-desc">${desc}</div></div>
      <label class="switch"><input type="checkbox" data-key="${key}"${checked ? " checked" : ""}><span class="slider"></span></label></div>`;
    const sevChecks = ["critical", "high", "medium", "low"].map((sev) =>
      `<label style="display:inline-flex;align-items:center;gap:6px;margin-right:14px"><input type="checkbox" class="failOn" value="${sev}"${s.failOn.includes(sev) ? " checked" : ""}> ${sevBadge(sev)}</label>`).join("");

    const tones = [["concise", "Concise, short and to the point"], ["detailed", "Detailed, thorough explanations"], ["educational", "Educational, teaches the why"], ["assertive", "Assertive, direct and prescriptive"], ["chill", "Chill, friendly, nits downplayed"]];
    const pm = s.preMergeChecks || { enabled: false, rules: [] };
    const pf = s.pathFilters || { include: [], exclude: [] };
    const rs = s.reviewSections || {};
    settingsRules = [...(pm.rules || [])];
    const rsToggle = (key, label, desc) => `
      <div class="settings-row"><div><div class="sr-label">${label}</div><div class="sr-desc">${desc}</div></div>
      <label class="switch"><input type="checkbox" data-rs="${key}"${rs[key] ? " checked" : ""}><span class="slider"></span></label></div>`;
    // Not built yet. Showing a live switch for these would promise something the
    // review does not do, so they are marked and disabled until they are real.
    const rsSoon = (label, desc) => `
      <div class="settings-row" style="opacity:.55"><div><div class="sr-label">${label} <span class="badge">soon</span></div><div class="sr-desc">${desc}</div></div>
      <label class="switch"><input type="checkbox" disabled><span class="slider"></span></label></div>`;

    content.innerHTML = `
      <div class="panel">
        <div class="panel-head"><h2>Automation</h2><span class="sub">These mirror your <code>.cavix.yaml</code></span></div>
        <div class="panel-body" style="padding-top:6px">
          ${toggle("autoReview", "Auto-review pull requests", "Review automatically on open and every push.", s.autoReview)}
          ${toggle("reviewDraftPRs", "Review draft PRs", "Also review pull requests still marked as draft.", s.reviewDraftPRs)}
          <div class="settings-row"><div><div class="sr-label">Air-gapped mode</div><div class="sr-desc">Whether this Cavix deployment can reach the internet at all. Set by whoever runs the service, not from here: it is enforced by the gateway's egress guard and a network policy, both of which apply to the whole process. A switch on this page could only ever disagree with them.</div></div>
            <span class="badge${s.airgapped ? " badge-verified" : ""}">${s.airgapped ? "air-gapped" : "standard"}</span></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h2>Proof &amp; placement</h2><span class="sub">What Cavix does before it speaks, and where it speaks</span></div></div>
        <div class="panel-body" style="padding-top:6px">
          ${toggle("verifyFindings", "Execution-grounded verification", "Reproduce each significant finding by running your code in a sealed, network-less sandbox before posting it, and drop the ones that don't reproduce. Turning this off is faster and cheaper, but every finding becomes a claim instead of a fact.", s.verifyFindings)}
          ${toggle("summaryInDescription", "Put the summary in the PR description", "The summary and file-by-file walkthrough are written into the pull request description, below whatever the author wrote. Off keeps them in the review comment instead.", s.summaryInDescription)}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Tone &amp; merge gate</h2></div>
        <div class="panel-body">
          <div class="settings-row"><div><div class="sr-label">Comment tone</div><div class="sr-desc">How Cavix writes its comments.</div></div>
            <select id="tone" style="min-width:280px">${tones.map(([v, l]) => `<option value="${v}"${s.tone === v ? " selected" : ""}>${l}</option>`).join("")}</select></div>
          ${toggle("requestChangesOnFail", "Let Cavix request changes", "When something below fails, post the review as <b>Request changes</b> instead of a comment, which blocks merge on a protected branch. Off by default, Cavix never blocks your team unless you say so.", s.requestChangesOnFail)}
          <div class="settings-row"><div><div class="sr-label">Blocking severities</div><div class="sr-desc">Which severities count as a failure. Only applies while "request changes" is on.</div></div>
            <div>${sevChecks}</div></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h2>Review comment structure</h2><span class="sub">What the posted PR review includes</span></div><a class="btn btn-soft btn-sm" onclick="location.hash='sample'">Preview</a></div>
        <div class="panel-body" style="padding-top:6px">
          ${rsToggle("summary", "Summary", "A plain-English description of what the change does.")}
          ${rsToggle("changedFiles", "Changed-files walkthrough", "A bullet for every changed file saying what it now does, in the pull request description.")}
          ${rsToggle("reviewEffort", "Review Scope &amp; Effort", "The module that opens the review comment: how far the scan reached, what the security and policy gates read, how much of it was proven by execution, and a 1 to 5 estimate of the review left to do.")}
          ${rsToggle("inlineFindings", "Inline findings", "Line-level comments with severity and one-click suggestions. Off moves every explanation into the review comment instead.")}
          ${rsToggle("proof", "Verification proof", "The sandbox transcript, commands and exit codes, that proves a verified finding.")}
          ${rsToggle("sequenceDiagram", "Call-flow diagram", "A Mermaid sequence diagram of the call path your change sits on, traced from the resolved call graph and drawn in the pull request description. Only appears when the change crosses more than one file, because a sequence diagram of one file is a list.")}
          ${rsSoon("Labels &amp; linked issues", "Auto labels and linked tickets (Jira / Linear).")}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h2>Path filters</h2><span class="sub">Which files Cavix reviews</span></div></div>
        <div class="panel-body">
          <div class="settings-row" style="align-items:flex-start"><div style="flex:1">
            <div class="sr-label">Include</div><div class="sr-desc">If set, only these globs are reviewed. Leave empty to review everything.</div>
            <div class="chips" id="pfIncList" style="margin-top:12px"></div>
            <div class="chip-input"><input id="pfIncInput" placeholder="src/**"><button class="btn btn-soft" id="pfIncAdd">Add</button></div>
          </div></div>
          <div class="settings-row" style="align-items:flex-start;border-bottom:none"><div style="flex:1">
            <div class="sr-label">Exclude</div><div class="sr-desc">These globs are always skipped.</div>
            <div class="chips" id="pfExcList" style="margin-top:12px"></div>
            <div class="chip-input"><input id="pfExcInput" placeholder="**/*.min.js"><button class="btn btn-soft" id="pfExcAdd">Add</button></div>
          </div></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h2>Pre-merge checks</h2><span class="sub">Optional gate · off by default</span></div>
          <label class="switch"><input type="checkbox" id="pmEnabled"${pm.enabled ? " checked" : ""}><span class="slider"></span></label></div>
        <div class="panel-body">
          <p class="sr-desc" style="margin-bottom:16px">Write rules in plain English. Each one is compiled into a deterministic check that runs over the files a pull request changes, no model gets a vote on whether it passed. Cavix tells you below whether a rule compiled, because a rule that silently never runs is worse than no rule.</p>
          <div id="rulesList"></div>
          <div class="chip-input"><input id="ruleInput" placeholder="e.g. Every new endpoint must have an authentication check"><button class="btn btn-primary" id="addRule">Add rule</button></div>
          <details style="margin-top:16px"><summary class="sr-desc" style="cursor:pointer">Rule shapes Cavix can compile today</summary>
            <ul class="sr-desc" style="margin:10px 0 0 18px;line-height:1.9">
              <li>Every new endpoint must have an authentication check</li>
              <li>Disallow calls to <code>console.log</code></li>
              <li>Ban the <code>request</code> module / package</li>
              <li>No TODO or FIXME markers in committed code</li>
              <li>Files must be under 500 lines</li>
              <li>Every file requires a license header</li>
            </ul>
          </details>
        </div>
      </div>
      <button class="btn btn-primary" id="saveSettings">Save settings</button>`;

    pfInc = [...(pf.include || [])]; pfExc = [...(pf.exclude || [])]; settingsRules = [...(pm.rules || [])];
    repaintSettings();
    checkRuleCompilation();
    const addFrom = (inputId, arr) => { const v = $(inputId).value.trim(); if (!v) return; arr.push(v); $(inputId).value = ""; repaintSettings(); if (arr === settingsRules) checkRuleCompilation(); };
    $("pfIncAdd").addEventListener("click", () => addFrom("pfIncInput", pfInc));
    $("pfExcAdd").addEventListener("click", () => addFrom("pfExcInput", pfExc));
    $("addRule").addEventListener("click", () => addFrom("ruleInput", settingsRules));
    [["pfIncInput", "pfIncAdd"], ["pfExcInput", "pfExcAdd"], ["ruleInput", "addRule"]].forEach(([inp, btn]) =>
      $(inp).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $(btn).click(); } }));

    $("saveSettings").addEventListener("click", async () => {
      // Start from what is stored so the not-yet-built sections (which have no
      // switch on the page) keep their values instead of being dropped.
      const reviewSections = Object.assign({}, rs);
      document.querySelectorAll("[data-rs]").forEach((el) => { reviewSections[el.dataset.rs] = el.checked; });
      const patch = {
        tone: $("tone").value,
        failOn: [...document.querySelectorAll(".failOn:checked")].map((c) => c.value),
        pathFilters: { include: pfInc, exclude: pfExc },
        preMergeChecks: { enabled: $("pmEnabled").checked, rules: settingsRules },
        reviewSections,
      };
      document.querySelectorAll("[data-key]").forEach((el) => { patch[el.dataset.key] = el.checked; });
      try { await api(`/api/orgs/${org}/settings`, { method: "PUT", body: JSON.stringify(patch) }); toast("Settings saved"); }
      catch (e) { toast(e.message); }
    });
  }

  /**
   * Ask the server which rules actually compiled into a runnable check. Shown
   * per rule so an owner never believes a gate is protecting them when the
   * sentence produced nothing.
   */
  async function checkRuleCompilation() {
    if (!settingsRules.length) { ruleCompile = {}; return; }
    try {
      const results = await api(`/api/orgs/${org}/policy/compile`, { method: "POST", body: JSON.stringify({ rules: settingsRules }) });
      ruleCompile = {};
      results.forEach((r) => { ruleCompile[r.text] = r; });
      repaintSettings();
    } catch { /* status is an aid, never a blocker for editing rules */ }
  }

  let pfInc = [], pfExc = [], settingsRules = [], ruleCompile = {};
  function chipHtml(arr, kind, emptyMsg) {
    return arr.length ? arr.map((v, i) => `<span class="chip"><code>${esc(v)}</code><span class="x" onclick="cavixChipDel('${kind}',${i})">×</span></span>`).join("") : `<span class="chips-empty">${emptyMsg}</span>`;
  }
  function repaintSettings() {
    if ($("pfIncList")) $("pfIncList").innerHTML = chipHtml(pfInc, "inc", "Reviewing everything.");
    if ($("pfExcList")) $("pfExcList").innerHTML = chipHtml(pfExc, "exc", "Nothing excluded.");
    const rl = $("rulesList");
    if (rl) rl.innerHTML = settingsRules.length
      ? settingsRules.map((r, i) => {
          const c = ruleCompile[r];
          const status = !c
            ? `<span class="badge">checking…</span>`
            : c.ok
              ? `<span class="badge badge-verified" title="Compiles to ${esc(c.ruleId)}">✓ compiles</span>`
              : `<span class="badge badge-critical" title="${esc(c.error || "")}">✕ won't run</span>`;
          return `<div class="rule-row"><span class="mono-badge" style="width:24px;height:24px;font-size:11px">${i + 1}</span><span class="rule-txt">${esc(r)}</span>${status}<button class="btn btn-danger btn-sm" onclick="cavixChipDel('rule',${i})">Remove</button></div>`;
        }).join("")
      : `<div class="chips-empty" style="padding:6px 0">No rules yet, add one below.</div>`;
  }
  window.cavixChipDel = function (kind, i) {
    const a = kind === "inc" ? pfInc : kind === "exc" ? pfExc : settingsRules;
    a.splice(i, 1);
    repaintSettings();
  };

  // ---------- TEAM ----------
  async function renderTeam() {
    const team = await api(`/api/orgs/${org}/team`);
    const canManage = me.role === "owner" || me.role === "admin";
    const roles = ["owner", "admin", "reviewer", "member"];
    const rows = team.map((u) => {
      const roleCell = canManage && u.id !== me.id
        ? `<select onchange="cavixSetRole('${u.id}',this.value)">${roles.map((r) => `<option value="${r}"${r === u.role ? " selected" : ""}>${r}</option>`).join("")}</select>`
        : `<span class="badge">${esc(u.role)}</span>`;
      return `<tr><td><div style="display:flex;align-items:center;gap:10px"><div class="avatar" style="width:28px;height:28px;font-size:12px">${esc((u.name || u.email)[0].toUpperCase())}</div><div><b>${esc(u.name)}</b>${u.id === me.id ? ' <span class="badge">you</span>' : ""}</div></div></td><td style="color:var(--text-dim)">${esc(u.email)}</td><td>${roleCell}</td><td style="color:var(--text-faint)">${new Date(u.createdAt).toLocaleDateString()}</td></tr>`;
    }).join("");

    content.innerHTML = `
      <div class="panel">
        <div class="panel-head"><h2>Members</h2><span class="sub">${team.length} in ${esc(org)}</span></div>
        <table class="table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th></tr></thead><tbody>${rows}</tbody></table>
      </div>
      <div class="panel"><div class="panel-body">
        <div class="settings-row"><div><div class="sr-label">Invite teammates</div><div class="sr-desc">Share your organization name <b>${esc(org)}</b>, teammates sign up and join automatically. Production connects this to SSO/SCIM.</div></div>
        <button class="btn btn-soft btn-sm" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(org)}');cavixToast('Org name copied')">Copy org name</button></div>
      </div></div>`;
  }
  window.cavixSetRole = async function (id, role) {
    try { await api(`/api/orgs/${org}/team/${id}/role`, { method: "POST", body: JSON.stringify({ role }) }); toast("Role updated"); }
    catch (e) { toast(e.message); go("team"); }
  };
  window.cavixToast = toast;

  // ---------- BILLING ----------
  async function renderBilling() {
    const orgs = await api(`/api/orgs`);
    const current = orgs.find((o) => o.name === org) || { tier: "free" };
    const tier = current.tier;
    const P = window.CAVIX_PRICING;
    const price = (t) => t.custom ? "Custom" : (t.byok === 0 ? "$0" : (t.byok === t.managed ? `$${t.byok}/seat/mo` : `$${t.byok}-${t.managed}/seat/mo`));
    content.innerHTML = `
      <div class="panel"><div class="panel-head"><h2>Current plan</h2></div>
        <div class="panel-body"><div class="settings-row"><div><div class="sr-label">${tier === "free" ? "Free / OSS" : tier === "paid" ? "Team / Pro" : "Enterprise"}</div><div class="sr-desc">Billing is illustrative in this trial build, connect Stripe for production charging.</div></div><span class="badge badge-verified">active</span></div></div>
      </div>
      <div class="pricing">
        ${P.tiers.map((t) => `<div class="plan${t.featured ? " featured" : ""}"><h3>${esc(t.name)}</h3><div class="price">${price(t)}</div><div class="srcnote">${esc(t.source)}</div><ul>${t.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
          ${(t.tierMatch === tier) ? `<button class="btn btn-soft btn-block" disabled>Current plan</button>` : `<button class="btn ${t.featured ? "btn-primary" : "btn-soft"} btn-block" onclick="cavixToast('Connect Stripe to enable upgrades')">${t.id === "enterprise" ? "Contact sales" : "Choose plan"}</button>`}
        </div>`).join("")}
      </div>
      <div class="overage" style="margin-top:22px">Verification overage billed at <code>${esc(P.overage)}</code> beyond your included pool. ${esc(P.seatNote)}.</div>`;
  }

  // ---------- REPORTS (ROI + quality) ----------
  /** The window the Reports page is showing. Persists while the tab is open. */
  let reportDays = 30;

  async function renderReports() {
    const [s, a] = await Promise.all([
      api(`/api/orgs/${org}/stats`),
      api(`/api/orgs/${org}/analytics?days=${reportDays}`),
    ]);
    const decided = s.accepted + s.rejected;
    const money = (n) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);

    // Mutes lead when there are any. A repo switched off is the earliest churn
    // signal there is, and it is worth more than any number below it.
    const mutes = a.muteEvents.filter((mm) => !mm.restored);
    const muteCard = mutes.length
      ? `<div class="panel" style="border-color:rgba(240,133,126,.35)">
          <div class="panel-head"><div><h2>Cavix was switched off</h2><span class="sub">${mutes.length} time${mutes.length === 1 ? "" : "s"} in the last ${reportDays} days</span></div><span class="badge badge-high">worth a look</span></div>
          <div class="panel-body">
            ${mutes.slice(0, 8).map((mm) => `<div class="mute-row"><span class="mark-att">▲</span><code>${esc(mm.target)}</code><span class="badge">${esc(mm.scope === "repo" ? "repository" : "pull request")}</span><span class="mr-when">${new Date(mm.at).toLocaleDateString()}</span></div>`).join("")}
            <div class="ch-note">A team turning Cavix off is the first thing that happens before they stop paying for it. Worth asking why while the reason is still fresh.</div>
          </div>
        </div>`
      : "";

    content.innerHTML = `
      <div class="panel"><div class="panel-body" style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
        <div><div class="sr-label">Reporting window</div><div class="sr-desc">Trends, ROI and the per-repository rollup are computed over this period.</div></div>
        <div style="display:flex;gap:8px">
          ${[7, 30, 90].map((d) => `<button class="btn ${d === reportDays ? "btn-primary" : "btn-soft"} btn-sm" data-days="${d}">${d} days</button>`).join("")}
        </div>
      </div></div>

      <div class="stat-grid">
        ${CavixCharts.tile("Action rate", `${Math.round(a.actionRate * 100)}%`, {
          delta: a.actionRateTrend,
          unit: "pt",
          note: a.actionRateTrend ? "vs the first half of the window" : "acted on, of everything posted",
        })}
        ${CavixCharts.tile("Defects caught", a.defectsCaught, { note: "proven by execution" })}
        ${CavixCharts.tile("Reviewer-hours saved", a.reviewerHoursSaved, { note: `over ${reportDays} days` })}
        ${CavixCharts.tile("Cost per review", a.costPerReview ? money(a.costPerReview) : "not reported", {
          note: a.totalCostUsd ? `${money(a.totalCostUsd)} total` : "older reviews predate cost reporting",
        })}
      </div>

      ${muteCard}

      <div class="panel">
        <div class="panel-head"><div><h2>Reviews and proven findings</h2><span class="sub">Per day, over the window</span></div></div>
        <div class="panel-body">${CavixCharts.trend(a.days)}</div>
      </div>

      <div class="grid grid-2">
        <div class="panel">
          <div class="panel-head"><div><h2>Where the findings are</h2><span class="sub">By repository</span></div></div>
          <div class="panel-body">${CavixCharts.ranked(
            a.repos.map((r) => ({ label: r.repo, value: r.findings, display: `${r.findings}` })),
            { emptyText: "No reviews in this window." },
          )}</div>
        </div>
        <div class="panel">
          <div class="panel-head"><div><h2>Hours saved</h2><span class="sub">By repository</span></div></div>
          <div class="panel-body">${CavixCharts.ranked(
            [...a.repos].sort((x, y) => y.hoursSaved - x.hoursSaved).map((r) => ({ label: r.repo, value: r.hoursSaved, display: `${r.hoursSaved}h` })),
            { emptyText: "No reviews in this window." },
          )}</div>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="panel"><div class="panel-head"><h2>Findings by severity</h2></div><div class="panel-body">${severityMeters(s.bySeverity)}</div></div>
        <div class="panel"><div class="panel-head"><h2>Quality</h2></div><div class="panel-body">
          <div class="settings-row"><div class="sr-label">Accepted</div><b style="color:var(--green)">${s.accepted}</b></div>
          <div class="settings-row"><div class="sr-label">Rejected</div><b style="color:var(--red)">${s.rejected}</b></div>
          <div class="settings-row"><div class="sr-label">False-positive rate</div><b>${decided ? Math.round(s.falsePositiveRate * 100) : 0}%</b></div>
          <div class="settings-row"><div class="sr-label">Verified share of findings</div><b>${Math.round(a.verifiedShare * 100)}%</b></div>
          <div class="settings-row"><div class="sr-label">Repositories connected</div><b>${s.reposConnected}</b></div>
        </div></div>
      </div>

      <div class="panel"><div class="panel-body"><div class="ch-note">
        Reviewer-hours saved uses an explicit per-severity model: how long a human would have spent finding and confirming an issue of that severity, less the overhead a false alarm costs. It is the same model the analytics package exports, so this page and any report built on it quote the same number.
        ${decided === 0 ? " Accept or reject some findings on the Reviews page to populate action rate." : ""}
      </div></div></div>`;

    content.querySelectorAll("[data-days]").forEach((b) =>
      b.addEventListener("click", () => {
        reportDays = Number(b.dataset.days);
        renderReports();
      }),
    );
  }

  // ---------- LEARNINGS ----------
  async function renderLearnings() {
    // Two calls, deliberately: the decisions are the raw history, the
    // calibration is what Cavix DID about it. The second is the same object the
    // orchestrator is handed on every review, so this page cannot describe a
    // calibration that differs from the one running on the pull requests.
    const [decisions, cal] = await Promise.all([
      api(`/api/decisions`),
      api(`/api/orgs/${encodeURIComponent(org)}/calibration`).catch(() => null),
    ]);
    const mine = decisions.slice(0, 100);
    const accepted = mine.filter((d) => d.state === "accepted").length;
    const rejected = mine.length - accepted;

    // What the team keeps rejecting is the single most useful thing on this
    // page: it is the category Cavix should stop raising for them, stated in
    // their own data rather than asserted.
    const byCategory = {};
    for (const d of mine) {
      if (d.state !== "rejected") continue;
      byCategory[d.category] = (byCategory[d.category] || 0) + 1;
    }
    const noisiest = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 5);

    const sevMark = (s) => (SEV_ROWS.find((r) => r.key === s) || { mark: "▫", color: "#7C93B5" });

    // What actually changed on your pull requests. Everything here is a number
    // this workspace produced: a bar that moved says which decisions moved it,
    // and a bar that did not says why not, rather than going quiet.
    const moved = cal ? cal.categories.filter((c) => c.moved) : [];
    const held = cal ? cal.categories.filter((c) => !c.moved) : [];
    const pct = (n) => `${Math.round(n * 100)}%`;
    const barRow = (c, live) => `
      <div class="settings-row">
        <div class="sr-label">
          <b>${esc(c.category)}</b>
          <div class="t-faint" style="margin-top:4px;max-width:640px">${esc(c.reason)}</div>
        </div>
        <div style="text-align:right;white-space:nowrap">
          <b style="color:${live ? (c.threshold > cal.base ? "var(--amber, #C99A2E)" : "var(--green)") : "var(--text-dim)"}">${pct(c.threshold)}</b>
          <div class="t-faint">${c.samples} decided</div>
        </div>
      </div>`;

    const calibrationPanel = !cal
      ? ""
      : `<div class="panel">
        <div class="panel-head"><div><h2>What your decisions changed</h2>
          <span class="sub">${cal.active
            ? `Live on your pull requests now. Standard bar ${pct(cal.base)}, from the last ${cal.windowDays} days.`
            : `Not applied yet. ${cal.decisionsUntilActive} more decided findings and Cavix starts tuning to you.`}</span></div></div>
        <div class="panel-body">
          ${moved.length
            ? `<p class="sr-desc" style="margin-bottom:16px">A finding in these categories now has to clear <b>your</b> bar, not the default one.${cal.active ? "" : " These are what <i>would</i> apply once there is enough history."}</p>${moved.map((c) => barRow(c, cal.active)).join("")}`
            : `<div class="empty" style="padding:24px">No bar has moved yet. Cavix only changes one when your rejections sit at a different confidence from your accepts, because a threshold that cannot tell them apart drops the good findings too.</div>`}
          ${held.length
            ? `<div style="margin-top:24px"><div class="t-faint" style="margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;font-size:11px">Measured, left alone</div>${held.map((c) => barRow(c, false)).join("")}</div>`
            : ""}
        </div>
      </div>`;

    content.innerHTML = `
      <div class="stat-grid" style="grid-template-columns:repeat(3,1fr)">
        ${CavixCharts.tile("Preferences learned", mine.length, { note: "from your accept and reject history" })}
        ${CavixCharts.tile("Confirmed real", accepted, { note: "raised again without hesitation" })}
        ${CavixCharts.tile("Told to stop", rejected, { note: "the bar Cavix is calibrating to" })}
      </div>

      ${calibrationPanel}

      ${noisiest.length ? `<div class="panel">
        <div class="panel-head"><div><h2>What your team keeps rejecting</h2><span class="sub">Cavix weights these down first</span></div></div>
        <div class="panel-body">${CavixCharts.ranked(noisiest.map(([c, n]) => ({ label: c, value: n })), { limit: 5 })}</div>
      </div>` : ""}

      <div class="panel">
        <div class="panel-head"><div><h2>Every decision</h2><span class="sub">Newest first</span></div></div>
        <div class="panel-body">
          <p class="sr-desc" style="margin-bottom:16px">Every accept and reject tunes Cavix to <b>your</b> team's bar. What it changed is in the panel above, in your own numbers. A competitor starts cold; Cavix starts tuned.</p>
          ${mine.length ? `<table class="table"><thead><tr><th>Finding</th><th>Where</th><th>Source</th><th>Decision</th><th>By</th></tr></thead><tbody>
            ${mine.map((d) => {
              const sv = sevMark(d.severity);
              return `<tr>
                <td><b style="color:${sv.color}">${sv.mark}</b> ${esc(d.title)}${d.verified ? ` <span class="mark-ok" title="proven by execution">⬢</span>` : ""}<div class="t-faint">${esc(d.severity)} · ${esc(d.category)}</div></td>
                <td class="mono" style="color:var(--text-faint);font-size:12px">${esc(d.repo)}<div>${esc(d.path)}:${d.line}</div></td>
                <td><span class="badge">${esc(d.source)}</span></td>
                <td><span class="decided ${esc(d.state)}">${esc(d.state)}</span></td>
                <td style="color:var(--text-dim)">${esc(d.user)}</td>
              </tr>`;
            }).join("")}
          </tbody></table>` : `<div class="empty" style="padding:40px">No learnings yet. Accept or reject findings on the Reviews page and they'll appear here.</div>`}
        </div>
      </div>`;
  }

  // ---------- INTEGRATIONS ----------
  async function renderIntegrations() {
    // If status itself fails, say "not connected" rather than claiming a demo
    // connection that does not exist.
    const gh = await api(`/api/github/status`).catch(() => ({ connected: false, demo: false }));
    const row = (mono, name, desc, state, action) => `<div class="repo-row"><div class="mono-badge">${esc(mono)}</div><div class="r-main"><div class="r-name">${esc(name)}</div><div class="r-desc">${esc(desc)}</div></div>${state}${action || ""}</div>`;
    const connected = `<span class="badge badge-verified">connected</span>`;
    const soon = `<span class="badge">soon</span>`;
    content.innerHTML = `
      <div class="panel">
        <div class="panel-head"><h2>Source control</h2><span class="sub">Where Cavix reviews pull requests</span></div>
        <div class="repo-list" style="border:none">
          ${row(
            "GH",
            "GitHub",
            gh.demo
              ? "Sample data. Configure a GitHub App to connect real repositories."
              : gh.connected
                ? "Connected, reviews & checks active"
                : "Sign in to connect your orgs and repos",
            gh.demo ? `<span class="badge">demo data</span>` : gh.connected ? connected : soon,
            gh.connected && !gh.demo ? "" : `<a class="btn btn-soft btn-sm" href="/api/auth/github/start">Connect</a>`,
          )}
          ${row("GL", "GitLab", "Merge-request reviews (adapter ready)", soon)}
          ${row("BB", "Bitbucket", "PR reviews incl. Server (adapter ready)", soon)}
          ${row("AZ", "Azure DevOps", "PR reviews (adapter ready)", soon)}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Chat &amp; issues</h2><span class="sub">Notifications and ticket linking</span></div>
        <div class="repo-list" style="border:none">
          ${row("SL", "Slack", "Post review summaries to a channel", soon)}
          ${row("JR", "Jira", "Link PRs to issues in the summary", soon)}
          ${row("LN", "Linear", "Link PRs to Linear tickets", soon)}
        </div>
      </div>`;
  }

  // ---------- ADMIN (founder / core team only) ----------
  //
  // The operator's whole picture on one page: who signed up, who is actually
  // using it, whose trial is about to run out, what that is worth, and the
  // controls to act on any of it without leaving the row.
  let adminSort = "activity";

  async function renderAdmin() {
    const [stats, orgs] = await Promise.all([api(`/api/admin/stats`), api(`/api/admin/orgs`)]);
    adminOrgs = orgs;

    const money = (n) => `$${n.toLocaleString()}`;
    const tile = (label, value, sub, cls) =>
      `<div class="admin-tile${cls ? " " + cls : ""}"><div class="t-lbl">${label}</div><div class="t-val">${value}</div>${sub ? `<div class="t-sub">${sub}</div>` : ""}</div>`;

    const maxDay = Math.max(1, ...stats.reviews.perDay14);
    const spark = stats.reviews.perDay14
      // Buckets end at now, so the last one is the trailing 24h — i.e. today.
      .map((n, i) => {
        const daysAgo = 13 - i;
        const when = daysAgo === 0 ? "today" : `${daysAgo} day${daysAgo === 1 ? "" : "s"} ago`;
        return `<div class="bar" style="height:${Math.round((n / maxDay) * 100)}%" title="${n} reviews, ${when}"></div>`;
      })
      .join("");

    // Things that need a human today, stated plainly rather than buried in a table.
    const attention = [];
    if (stats.orgs.trialExpiring7d) attention.push(`<b>${stats.orgs.trialExpiring7d}</b> trial${stats.orgs.trialExpiring7d === 1 ? "" : "s"} end within 7 days`);
    const noKey = orgs.filter((o) => !o.apiKeySet && o.repos > 0);
    if (noKey.length) attention.push(`<b>${noKey.length}</b> org${noKey.length === 1 ? " has" : "s have"} repos connected but no AI key — every review fails until they add one`);
    const atLimit = orgs.filter((o) => o.usagePct >= 90 && o.effectiveReviewsPerDay < 1000000);
    if (atLimit.length) attention.push(`<b>${atLimit.length}</b> org${atLimit.length === 1 ? " is" : "s are"} at 90%+ of the daily review limit`);
    if (stats.orgs.suspended) attention.push(`<b>${stats.orgs.suspended}</b> suspended`);

    content.innerHTML = `
      <div class="admin-tiles">
        ${tile("Organizations", stats.orgs.total, `${stats.orgs.new7d} new this week · ${stats.orgs.activeLast7d} active`, "accent")}
        ${tile("People", stats.users.total, `${stats.users.new7d} new this week · ${stats.users.withGithub} via GitHub`)}
        ${tile("Active trials", stats.orgs.trialActive, `${stats.orgs.trialExpiring7d} ending in 7d · ${stats.orgs.trialExpired} expired`)}
        ${tile("Est. MRR", money(stats.revenue.estimatedMrr), `${stats.revenue.paidSeats} paid seats @ ${money(stats.revenue.pricePerSeat)} · ${money(stats.revenue.pipelineMrr)} in trial`)}
      </div>
      <div class="admin-tiles">
        ${tile("Reviews", stats.reviews.total, `${stats.reviews.last24h} today · ${stats.reviews.last7d} this week`)}
        ${tile("Verified findings", stats.findings.verified, `of ${stats.findings.total} total findings`)}
        ${tile("Repositories", stats.repos.enabled, `${stats.repos.private} private · ${stats.repos.public} public`)}
        ${tile("BYOK configured", `${stats.orgs.withApiKey}/${stats.orgs.total}`, "orgs with a working AI key")}
      </div>

      ${attention.length ? `<div class="panel"><div class="panel-head"><h2>Needs attention</h2></div><div class="panel-body" style="padding-top:6px">
        ${attention.map((a) => `<div class="settings-row"><div class="sr-desc" style="font-size:14px">${a}</div></div>`).join("")}
      </div></div>` : ""}

      <div class="panel">
        <div class="panel-head"><div><h2>Platform activity</h2><span class="sub">reviews per day, last 14 days</span></div>
          <span class="badge">${stats.findings.accepted} accepted · ${stats.findings.rejected} rejected</span></div>
        <div class="panel-body"><div class="spark">${spark}</div>
          <div style="display:flex;justify-content:space-between;color:var(--text-faint);font-size:12px;margin-top:10px"><span>14d ago</span><span>today</span></div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><div><h2>All organizations</h2><span class="sub">${orgs.length} total · you are a platform admin</span></div>
          <div style="display:flex;gap:8px;align-items:center">
            <select id="adminSort" style="max-width:170px">
              <option value="activity">Most recently active</option>
              <option value="reviews">Most reviews</option>
              <option value="members">Most members</option>
              <option value="trial">Trial ending soonest</option>
              <option value="name">Name (A→Z)</option>
            </select>
            <input id="adminSearch" placeholder="Search orgs…" style="max-width:200px">
          </div></div>
        <div id="adminRows"></div>
      </div>
      <div class="panel"><div class="panel-body"><div class="sr-desc">Only emails in <code>CAVIX_ADMIN_EMAILS</code> reach this console. Tier, trial, limit and suspend take effect on that org's very next review. MRR is an <b>estimate</b> (seats × <code>CAVIX_PRICE_PER_SEAT</code>), not billed revenue, connect Stripe for real numbers. See GUIDE.md §8E.</div></div></div>`;

    $("adminSort").value = adminSort;
    $("adminSort").addEventListener("change", (e) => { adminSort = e.target.value; paintAdminRows($("adminSearch").value); });
    $("adminSearch").addEventListener("input", (e) => paintAdminRows(e.target.value));
    paintAdminRows("");
  }

  let adminOrgs = [];
  function paintAdminRows(query) {
    const q = (query || "").toLowerCase();
    const sorters = {
      activity: (a, b) => (b.lastActivityAt || "").localeCompare(a.lastActivityAt || ""),
      reviews: (a, b) => b.reviews - a.reviews,
      members: (a, b) => b.members - a.members,
      trial: (a, b) => (a.trialDaysLeft ?? 1e9) - (b.trialDaysLeft ?? 1e9),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    const rows = adminOrgs
      .filter((o) => o.name.toLowerCase().includes(q))
      .sort(sorters[adminSort] || sorters.activity)
      .map(adminRow)
      .join("");
    const el = $("adminRows");
    if (!el) return;
    el.innerHTML = rows || `<div class="empty" style="padding:32px">No organizations match “${esc(query)}”.</div>`;

    // Handlers are bound here, not written into onclick attributes. The org name
    // is user-chosen text: interpolating it into inline JS lets a workspace named
    // with a quote run script in a platform admin's session.
    el.querySelectorAll("[data-org-action]").forEach((node) => {
      const org = node.dataset.org;
      const action = node.dataset.orgAction;
      if (action === "tier") {
        node.addEventListener("change", () => window.cavixAdmin(org, { tier: node.value }));
      } else if (action === "trial") {
        node.addEventListener("click", () => window.cavixAdminTrial(org));
      } else if (action === "limit") {
        node.addEventListener("click", () => window.cavixAdminLimit(org));
      } else if (action === "suspend") {
        node.addEventListener("click", () => window.cavixAdmin(org, { suspended: node.dataset.suspend === "true" }));
      }
    });
  }

  function adminRow(o) {
    const status = o.suspended
      ? `<span class="badge badge-critical">suspended</span>`
      : o.trialActive
        ? `<span class="badge badge-verified">trial · ${o.trialDaysLeft}d left</span>`
        : o.trialDaysLeft !== undefined && o.trialDaysLeft <= 0
          ? `<span class="badge badge-high">trial ended</span>`
          : `<span class="badge">${esc(o.tier)}</span>`;
    const limit = o.effectiveReviewsPerDay >= 1000000 ? "∞" : o.effectiveReviewsPerDay;
    const usage = o.effectiveReviewsPerDay >= 1000000
      ? `<span style="color:var(--text-faint);font-size:12px">${o.reviewsToday} today</span>`
      : `<div class="usage-bar" title="${o.reviewsToday} of ${limit} today"><span style="width:${o.usagePct}%"></span></div><span style="color:var(--text-faint);font-size:12px">${o.reviewsToday}/${limit}</span>`;
    const flags = [
      o.apiKeySet ? "" : `<span class="badge badge-high" title="No BYOK key saved, reviews will fail">no key</span>`,
      o.verifyFindings ? "" : `<span class="badge" title="Verification is off for this org">unverified</span>`,
    ].filter(Boolean).join(" ");
    const last = o.lastActivityAt ? `last review ${timeAgo(o.lastActivityAt)}` : "never reviewed";

    return `<div class="admin-org">
      <div class="ao-name"><span class="ao-av">${esc(o.name[0].toUpperCase())}</span><div>${esc(o.name)} ${flags}
        <div class="ao-meta">${o.members} member${o.members === 1 ? "" : "s"} · ${o.repos} repo${o.repos === 1 ? "" : "s"} · ${o.reviews} reviews · ${last}</div></div></div>
      <div><select data-org-action="tier" data-org="${esc(o.name)}"><option value="free"${o.tier === "free" ? " selected" : ""}>Free</option><option value="paid"${o.tier === "paid" ? " selected" : ""}>Paid</option></select></div>
      <div>${status}</div>
      <div style="display:flex;flex-direction:column;gap:4px;min-width:96px">${usage}</div>
      <div class="admin-actions">
        <button class="btn btn-soft btn-sm" data-org-action="trial" data-org="${esc(o.name)}">Trial…</button>
        <button class="btn btn-soft btn-sm" data-org-action="limit" data-org="${esc(o.name)}">Limit</button>
        <button class="btn ${o.suspended ? "btn-soft" : "btn-danger"} btn-sm" data-org-action="suspend" data-org="${esc(o.name)}" data-suspend="${!o.suspended}">${o.suspended ? "Unsuspend" : "Suspend"}</button>
      </div>
    </div>`;
  }

  function timeAgo(iso) {
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
    return `${Math.round(mins / 1440)}d ago`;
  }
  window.cavixAdmin = async function (org, patch) {
    try { await api(`/api/admin/orgs/${encodeURIComponent(org)}`, { method: "POST", body: JSON.stringify(patch) }); toast(`Updated ${org}`); go("admin"); }
    catch (e) { toast(e.message); go("admin"); }
  };
  window.cavixAdminLimit = function (org) {
    const v = prompt(`Reviews/day override for ${org}\n(number, or blank to clear the override)`, "");
    if (v === null) return;
    const n = v.trim() === "" ? null : Number(v);
    if (v.trim() !== "" && (isNaN(n) || n < 0)) return toast("Enter a non-negative number");
    window.cavixAdmin(org, { reviewsPerDay: n });
  };
  window.cavixAdminTrial = function (org) {
    const v = prompt(`Trial length in days for ${org}\n(a number to start or extend, or 0 to end the trial now)`, "14");
    if (v === null) return;
    const n = Number(v);
    if (isNaN(n) || n < 0) return toast("Enter a non-negative number of days");
    window.cavixAdmin(org, n === 0 ? { endTrial: true } : { trialDays: n });
  };
})();
