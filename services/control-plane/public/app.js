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
    if (res.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
    return data;
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
      content.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    });
  }

  // ---------- OVERVIEW ----------
  async function renderOverview() {
    const s = await api(`/api/orgs/${org}/stats`);
    const maxBar = Math.max(1, ...s.reviewsLast7Days);
    const bars = s.reviewsLast7Days.map((n) => `<div class="bar" style="height:${Math.round((n / maxBar) * 100)}%" title="${n} reviews"></div>`).join("");
    const sevRows = ["critical", "high", "medium", "low"].map((sev) => {
      const n = s.bySeverity[sev] || 0;
      return `<div class="settings-row"><div style="display:flex;align-items:center;gap:10px">${sevBadge(sev)}</div><b>${n}</b></div>`;
    }).join("");

    content.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="label">${ic("reviews")} Reviews run</div><div class="value">${s.reviews}</div><div class="delta">last 30 days</div></div>
        <div class="stat"><div class="label">${ic("check")} Verified findings</div><div class="value grad">${s.verified}</div><div class="delta">proven in a sandbox</div></div>
        <div class="stat"><div class="label">${ic("target")} Action rate</div><div class="value">${Math.round(s.actionRate * 100)}%</div><div class="delta">accepted of decided</div></div>
        <div class="stat"><div class="label">${ic("clock")} Reviewer-hours saved</div><div class="value">${s.hoursSaved}</div><div class="delta">est. this period</div></div>
      </div>
      <div class="grid grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Reviews, last 7 days</h2></div>
          <div class="panel-body"><div class="spark">${bars}</div>
            <div style="display:flex;justify-content:space-between;color:var(--text-faint);font-size:12px;margin-top:10px"><span>7d ago</span><span>today</span></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Findings by severity</h2></div>
          <div class="panel-body" style="padding-top:6px">${sevRows}</div>
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
  async function renderReviews() {
    const reviews = await api(`/api/reviews?org=${org}`);
    if (!reviews.length) {
      content.innerHTML = `<div class="empty">No reviews yet. Connect a repository and open a pull request, findings will appear here.</div>`;
      return;
    }
    content.innerHTML = reviews.map((r) => {
      const findings = r.findings.map((f) => {
        const source = f.immutable ? `<span class="badge badge-policy">policy</span>` : `<span class="badge">${esc(f.source)}</span>`;
        const verified = f.verified ? `<span class="badge badge-verified">verified</span>` : "";
        const decided = f.decision ? `<span class="decided ${esc(f.decision.state)}">${esc(f.decision.state)} by ${esc(f.decision.user)}</span>` : "";
        const actions = f.decision ? decided : `
          <button class="btn btn-soft btn-sm" onclick="cavixDecide('${f.id}','accepted',this)">Accept</button>
          <button class="btn btn-danger btn-sm" onclick="cavixDecide('${f.id}','rejected',this)">Reject</button>`;
        return `<div class="finding" data-fid="${f.id}">
          ${sevBadge(f.severity)}
          <div class="f-body">
            <div class="f-title">${esc(f.title)}</div>
            <div class="f-loc">${esc(f.path)}:${f.line}</div>
            <div class="f-tags">${source}${verified}<span class="badge">${esc(f.category)}</span></div>
          </div>
          <div class="f-actions">${actions}</div>
        </div>`;
      }).join("");
      return `<div class="review">
        <div class="review-head">
          <div><div class="r-title">${esc(r.repo)} #${r.pr}, ${esc(r.title)}</div>
          <div class="r-meta">${esc(r.org)} · ${r.findings.length} finding${r.findings.length === 1 ? "" : "s"} · ${new Date(r.createdAt).toLocaleString()}</div></div>
          <span class="badge">${new Date(r.createdAt).toLocaleDateString()}</span>
        </div>${findings}
      </div>`;
    }).join("");
  }

  // exposed for inline onclick
  window.cavixDecide = async function (id, state, btn) {
    try {
      await api(`/api/findings/${id}/decision`, { method: "POST", body: JSON.stringify({ state, user: me.email }) });
      const row = btn.closest(".finding").querySelector(".f-actions");
      row.innerHTML = `<span class="decided ${state}">${state} by ${esc(me.email)}</span>`;
      toast(`Finding ${state}, Cavix will learn from this`);
    } catch (e) { toast(e.message); }
  };

  // ---------- SAMPLE REVIEW (live preview of the configured comment) ----------
  async function renderSample() {
    const s = await api(`/api/orgs/${org}/settings`);
    const rs = s.reviewSections || {};
    const toneBlurb = {
      concise: "Refund flow refactor. One verified high-severity issue; one nit suppressed.",
      detailed: "This PR refactors the refund flow and adds retry handling to the payments service. It touches 3 files (+128 / −44). One high-severity correctness issue was verified (double-refund on webhook retry) and one nit was suppressed as unverifiable.",
      educational: "This PR refactors the refund flow. Idempotency matters here because payment webhooks can be delivered more than once, so a non-guarded refund path can charge twice. One verified high-severity issue was found and one nit suppressed.",
      assertive: "Refactors the refund flow. There is a verified double-refund on webhook retry that must be fixed before merge. One nit was suppressed.",
      chill: "Nice refund flow cleanup! One thing worth a look: a double-refund on retries (verified). Skipped a tiny nit, nothing blocking.",
    };
    const chips = [];
    if (rs.sequenceDiagram) chips.push("sequence diagram generated");
    if (rs.relatedIssues) chips.push("labels: payments, needs-review");
    if (rs.relatedIssues) chips.push("linked: JIRA PAY-142");
    const effort = rs.reviewEffort ? `<span class="badge">Review effort <span class="effort" style="margin-left:6px"><span class="dot2 on"></span><span class="dot2 on"></span><span class="dot2 on"></span><span class="dot2"></span><span class="dot2"></span></span> 3/5</span>` : "";

    const summaryCard = rs.summary ? `
      <div class="summary-card" style="margin-bottom:18px">
        <div class="sc-head"><span class="logo-mark" style="width:22px;height:22px;font-size:12px">◆</span><span class="who">cavix</span> <span class="badge">summary</span> <span class="ago">preview</span></div>
        <div class="sc-body">
          <h4>Summary</h4>
          <p>${esc((toneBlurb[s.tone] || toneBlurb.concise))}</p>
          ${rs.changedFiles ? `<h4>Changes</h4><table class="changes-table"><thead><tr><th>File</th><th>Summary</th></tr></thead><tbody>
            <tr><td>services/payments/refund.ts</td><td>Add idempotency guard before issuing a refund</td></tr>
            <tr><td>services/payments/webhook.ts</td><td>Handle Stripe retry deliveries</td></tr>
            <tr><td>test/refund.test.ts</td><td>New retry regression test</td></tr></tbody></table>` : ""}
          ${(chips.length || effort) ? `<div class="chip-row">${chips.map((c) => `<span class="badge">${esc(c)}</span>`).join("")}${effort}</div>` : ""}
        </div>
      </div>` : "";

    const inlineCard = rs.inlineFindings ? `
      <div class="cr-window">
        <div class="cr-head"><span class="fname">services/payments/refund.ts</span> <span class="pill-sm">✓ Cavix check passed with 1 verified finding</span></div>
        <div class="cr-code">
<div class="cr-line del"><span class="ln">87</span><span class="k">  await</span> charge.<span class="f">refund</span>(amount)</div>
<div class="cr-line add"><span class="ln">87</span><span class="k">  if</span> (!refund.<span class="f">isSettled</span>(id)) <span class="k">await</span> charge.<span class="f">refund</span>(amount)</div>
        </div>
        <div class="cr-comment">
          <div class="cc-head"><span class="logo-mark" style="width:22px;height:22px;font-size:12px">◆</span><span class="cc-bot">cavix</span><span class="badge badge-verified">verified</span><span class="badge badge-high">high</span></div>
          <div class="cc-body"><b>Refund can double-apply on retry.</b> On a webhook re-delivery this path issues a second refund.</div>
          ${rs.proof ? `<div class="cc-proof"><span class="t-purple">[repro]</span>     refund.retry.test.ts, <span class="t-red">exit 1</span>
<span class="t-purple">[after-fix]</span> refund.retry.test.ts, <span class="t-green">exit 0</span>
<span class="t-purple">[suite]</span>     42 tests, <span class="t-green">exit 0</span></div>` : ""}
        </div>
      </div>` : "";

    const empty = (!summaryCard && !inlineCard) ? `<div class="empty" style="padding:40px">Nothing enabled. Turn on sections in Review settings to see them here.</div>` : "";

    content.innerHTML = `
      <div class="panel"><div class="panel-body" style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
        <div><div class="sr-label">This is exactly what Cavix posts on a pull request</div><div class="sr-desc">Built live from your Review settings. Tone: <b>${esc(s.tone)}</b>.</div></div>
        <a class="btn btn-soft btn-sm" onclick="location.hash='settings'">Edit structure &amp; tone</a>
      </div></div>
      <div style="max-width:860px">${summaryCard}${inlineCard}${empty}</div>`;
  }

  // ---------- REPOS / CONNECT (CodeRabbit-style: providers → orgs → repos) ----------
  const GH_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
  let repoState = { org: null, repos: [] };

  async function renderRepos() {
    const status = await api(`/api/github/status`);
    const providerTabs = `
      <div class="provider-tabs">
        <div class="provider-tab active">${GH_SVG} GitHub</div>
        <div class="provider-tab soon">GitLab <span class="tag">soon</span></div>
        <div class="provider-tab soon">Bitbucket <span class="tag">soon</span></div>
        <div class="provider-tab soon">Azure DevOps <span class="tag">soon</span></div>
      </div>`;

    // Real mode but not connected → show the connect CTA.
    if (status.configured && !status.connected) {
      content.innerHTML = providerTabs + `
        <div class="panel"><div class="connect-hero">
          <div class="gh-badge">${GH_SVG}</div>
          <h2>Connect your GitHub account</h2>
          <p>Authorize Cavix to see your organizations and repositories, then enable reviews on the ones you choose, all from here.</p>
          <a class="btn btn-github" href="/api/auth/github/start">${GH_SVG} Continue with GitHub</a>
        </div></div>`;
      return;
    }

    const demoNote = status.demo ? `<span class="badge">demo data</span>` : `<span class="badge badge-verified">connected as ${esc(status.login || me.githubLogin || "you")}</span>`;
    const orgs = await api(`/api/github/orgs`);
    if (!repoState.org || !orgs.find((o) => o.login === repoState.org)) repoState.org = orgs[0] ? orgs[0].login : null;

    content.innerHTML = providerTabs + `
      <div class="panel">
        <div class="panel-head">
          <div><h2>Add repositories</h2><span class="sub">Pick an organization, then toggle the repos Cavix should review.</span></div>
          <div style="display:flex;gap:10px;align-items:center">${demoNote}<a class="btn btn-soft btn-sm" href="${esc(status.installUrl)}" target="_blank">Install GitHub App ↗</a></div>
        </div>
        <div class="panel-body">
          <div class="org-picker"><span class="sr-desc" style="margin:0">Organization:</span>
            <div class="org-select">${orgs.map((o) => `<button class="org-chip${o.login === repoState.org ? " active" : ""}" data-org="${esc(o.login)}"><span class="oa">${esc(o.login[0].toUpperCase())}</span>${esc(o.login)}${o.isUser ? " (you)" : ""}</button>`).join("")}</div>
          </div>
          <input class="field repo-search" id="repoSearch" placeholder="Search repositories…" style="padding:10px 13px;background:var(--bg-elev);border:1px solid var(--border);border-radius:9px;color:var(--text)">
          <div id="repoList" class="repo-list"><div class="empty" style="padding:30px">Loading repositories…</div></div>
        </div>
      </div>`;

    document.querySelectorAll(".org-chip").forEach((el) => el.addEventListener("click", () => { repoState.org = el.dataset.org; loadRepos(); paintOrgChips(); }));
    $("repoSearch").addEventListener("input", (e) => paintRepos(e.target.value));
    await loadRepos();
  }
  function paintOrgChips() {
    document.querySelectorAll(".org-chip").forEach((el) => el.classList.toggle("active", el.dataset.org === repoState.org));
  }
  async function loadRepos() {
    try { repoState.repos = await api(`/api/github/repos?org=${encodeURIComponent(repoState.org)}`); paintRepos(""); }
    catch (e) { $("repoList").innerHTML = `<div class="empty" style="padding:30px">${esc(e.message)}</div>`; }
  }
  function paintRepos(filter) {
    const q = (filter || "").toLowerCase();
    const repos = repoState.repos.filter((r) => r.name.toLowerCase().includes(q));
    const list = $("repoList");
    if (!repos.length) { list.innerHTML = `<div class="empty" style="padding:30px">No repositories match.</div>`; return; }
    list.innerHTML = repos.map((r) => `
      <div class="repo-row" data-full="${esc(r.fullName)}">
        <div class="r-ico">${r.private ? ic("lock") : ic("repos")}</div>
        <div class="r-main">
          <div class="r-name">${esc(r.name)} <span class="badge">${r.private ? "private" : "public"}</span></div>
          <div class="r-desc">${esc(r.description || "No description")}</div>
        </div>
        ${r.language ? `<span class="r-lang">${esc(r.language)}</span>` : ""}
        <label class="switch"><input type="checkbox" ${r.enabled ? "checked" : ""} onchange="cavixToggleRepo('${esc(r.fullName)}', ${!r.private}, this)"><span class="slider"></span></label>
      </div>`).join("");
  }
  window.cavixToggleRepo = async function (fullName, isPublic, el) {
    try {
      if (el.checked) { await api(`/api/github/repos`, { method: "POST", body: JSON.stringify({ fullName, private: !isPublic }) }); toast(`Enabled ${fullName}`); }
      else { await api(`/api/github/repos?fullName=${encodeURIComponent(fullName)}`, { method: "DELETE" }); toast(`Disabled ${fullName}`); }
      const r = repoState.repos.find((x) => x.fullName === fullName); if (r) r.enabled = el.checked;
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
    anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-opus-4-7"],
    openai: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "o4-mini"],
    google: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
    selfhosted: ["llama-3.1-70b-instruct", "qwen2.5-coder-32b", "deepseek-coder-v2", "mistral-large"],
  };
  function modelOptions(provider, selected) {
    const list = MODELS[provider] || [];
    const known = list.map((m) => `<option value="${esc(m)}"${m === selected ? " selected" : ""}>${esc(m)}</option>`).join("");
    const isCustom = selected && !list.includes(selected);
    return known + `<option value="__custom__"${isCustom ? " selected" : ""}>Custom…</option>`;
  }
  async function renderByok() {
    const s = await api(`/api/orgs/${org}/settings`);
    const status = s.apiKeyFingerprint
      ? `<div class="key-box"><code>${esc(s.apiKeyFingerprint)}</code><span class="badge badge-verified">active</span></div>
         <div class="sr-desc" style="margin-top:8px">Set ${s.apiKeySetAt ? new Date(s.apiKeySetAt).toLocaleString() : ""}. Your key is encrypted at rest (AES-256-GCM) and never shown again.</div>`
      : `<div class="sr-desc">No key yet. Add one so Cavix can run reviews with your own AI account.</div>`;
    const customModel = !(MODELS[s.llmProvider] || []).includes(s.llmModel);

    content.innerHTML = `
      <div class="panel">
        <div class="panel-head"><h2>AI provider &amp; model</h2><span class="sub">Model-agnostic, switch anytime</span></div>
        <div class="panel-body">
          <div class="grid grid-2" style="gap:16px">
            <div class="field" style="margin:0"><label>Provider</label><select id="provider">${Object.entries(PROVIDERS).map(([v, l]) => `<option value="${v}"${v === s.llmProvider ? " selected" : ""}>${l}</option>`).join("")}</select></div>
            <div class="field" style="margin:0"><label>Model</label><select id="model">${modelOptions(s.llmProvider, s.llmModel)}</select></div>
          </div>
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
    providerSel.addEventListener("change", () => { modelSel.innerHTML = modelOptions(providerSel.value, MODELS[providerSel.value][0]); toggleCustom(); });
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

    content.innerHTML = `
      <div class="panel">
        <div class="panel-head"><h2>Automation</h2><span class="sub">These mirror your <code>.cavix.yaml</code></span></div>
        <div class="panel-body" style="padding-top:6px">
          ${toggle("autoReview", "Auto-review pull requests", "Review automatically on open and every push.", s.autoReview)}
          ${toggle("reviewDraftPRs", "Review draft PRs", "Also review pull requests still marked as draft.", s.reviewDraftPRs)}
          ${toggle("policyEnabled", "Policy gate", "Enforce your plain-English org rules as non-bypassable checks.", s.policyEnabled)}
          ${toggle("airgapped", "Air-gapped mode", "Only reach the in-cluster model, zero outbound calls.", s.airgapped)}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Tone &amp; merge gate</h2></div>
        <div class="panel-body">
          <div class="settings-row"><div><div class="sr-label">Comment tone</div><div class="sr-desc">How Cavix writes its comments.</div></div>
            <select id="tone" style="min-width:280px">${tones.map(([v, l]) => `<option value="${v}"${s.tone === v ? " selected" : ""}>${l}</option>`).join("")}</select></div>
          <div class="settings-row"><div><div class="sr-label">Fail the check on</div><div class="sr-desc">Severities that make the Cavix status check fail (and can block merge).</div></div>
            <div>${sevChecks}</div></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h2>Review comment structure</h2><span class="sub">What the posted PR review includes</span></div><a class="btn btn-soft btn-sm" onclick="location.hash='sample'">Preview</a></div>
        <div class="panel-body" style="padding-top:6px">
          ${rsToggle("summary", "Summary", "A plain-English walkthrough of the change.")}
          ${rsToggle("changedFiles", "Changed-files table", "A table of files with one-line descriptions.")}
          ${rsToggle("sequenceDiagram", "Sequence diagram", "A diagram of the new flow when relevant.")}
          ${rsToggle("reviewEffort", "Review-effort estimate", "A 1 to 5 estimate of how much review this needs.")}
          ${rsToggle("relatedIssues", "Labels &amp; linked issues", "Auto labels and linked tickets (Jira / Linear).")}
          ${rsToggle("inlineFindings", "Inline findings", "Line-level comments with severity and suggestions.")}
          ${rsToggle("proof", "Verification proof", "The failing test that proves a verified bug.")}
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
          <p class="sr-desc" style="margin-bottom:16px">Write rules in plain English. When enabled, each becomes a deterministic, non-bypassable check that runs before merge, a failing rule fails the Cavix status check.</p>
          <div id="rulesList"></div>
          <div class="chip-input"><input id="ruleInput" placeholder="e.g. Every new endpoint must have an authentication check"><button class="btn btn-primary" id="addRule">Add rule</button></div>
        </div>
      </div>
      <button class="btn btn-primary" id="saveSettings">Save settings</button>`;

    pfInc = [...(pf.include || [])]; pfExc = [...(pf.exclude || [])]; settingsRules = [...(pm.rules || [])];
    repaintSettings();
    const addFrom = (inputId, arr) => { const v = $(inputId).value.trim(); if (!v) return; arr.push(v); $(inputId).value = ""; repaintSettings(); };
    $("pfIncAdd").addEventListener("click", () => addFrom("pfIncInput", pfInc));
    $("pfExcAdd").addEventListener("click", () => addFrom("pfExcInput", pfExc));
    $("addRule").addEventListener("click", () => addFrom("ruleInput", settingsRules));
    [["pfIncInput", "pfIncAdd"], ["pfExcInput", "pfExcAdd"], ["ruleInput", "addRule"]].forEach(([inp, btn]) =>
      $(inp).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $(btn).click(); } }));

    $("saveSettings").addEventListener("click", async () => {
      const reviewSections = {};
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
  let pfInc = [], pfExc = [], settingsRules = [];
  function chipHtml(arr, kind, emptyMsg) {
    return arr.length ? arr.map((v, i) => `<span class="chip"><code>${esc(v)}</code><span class="x" onclick="cavixChipDel('${kind}',${i})">×</span></span>`).join("") : `<span class="chips-empty">${emptyMsg}</span>`;
  }
  function repaintSettings() {
    if ($("pfIncList")) $("pfIncList").innerHTML = chipHtml(pfInc, "inc", "Reviewing everything.");
    if ($("pfExcList")) $("pfExcList").innerHTML = chipHtml(pfExc, "exc", "Nothing excluded.");
    const rl = $("rulesList");
    if (rl) rl.innerHTML = settingsRules.length
      ? settingsRules.map((r, i) => `<div class="rule-row"><span class="mono-badge" style="width:24px;height:24px;font-size:11px">${i + 1}</span><span class="rule-txt">${esc(r)}</span><button class="btn btn-danger btn-sm" onclick="cavixChipDel('rule',${i})">Remove</button></div>`).join("")
      : `<div class="chips-empty" style="padding:6px 0">No rules yet, add one below.</div>`;
  }
  window.cavixChipDel = function (kind, i) { const a = kind === "inc" ? pfInc : kind === "exc" ? pfExc : settingsRules; a.splice(i, 1); repaintSettings(); };

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
    const price = (t) => t.custom ? "Custom" : (t.byok === 0 ? "$0" : (t.byok === t.managed ? `$${t.byok}/seat/mo` : `$${t.byok}–${t.managed}/seat/mo`));
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
  async function renderReports() {
    const s = await api(`/api/orgs/${org}/stats`);
    const total = s.accepted + s.rejected;
    const bars = ["critical", "high", "medium", "low"].map((sev) => {
      const n = s.bySeverity[sev] || 0; const max = Math.max(1, ...Object.values(s.bySeverity));
      return `<div style="display:flex;align-items:center;gap:12px;margin:8px 0"><div style="width:70px">${sevBadge(sev)}</div><div style="flex:1;background:var(--bg-elev);border-radius:6px;height:10px;overflow:hidden"><div style="height:100%;width:${Math.round((n / max) * 100)}%;background:var(--brand-grad)"></div></div><b style="width:24px;text-align:right">${n}</b></div>`;
    }).join("");
    content.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="label">${ic("reviews")} Reviews</div><div class="value">${s.reviews}</div></div>
        <div class="stat"><div class="label">${ic("check")} Verified</div><div class="value grad">${s.verified}</div></div>
        <div class="stat"><div class="label">${ic("target")} Action rate</div><div class="value">${Math.round(s.actionRate * 100)}%</div></div>
        <div class="stat"><div class="label">${ic("clock")} Hours saved</div><div class="value">${s.hoursSaved}</div></div>
      </div>
      <div class="grid grid-2">
        <div class="panel"><div class="panel-head"><h2>Findings by severity</h2></div><div class="panel-body">${bars}</div></div>
        <div class="panel"><div class="panel-head"><h2>Decisions</h2></div><div class="panel-body">
          <div class="settings-row"><div class="sr-label">Accepted</div><b style="color:var(--green)">${s.accepted}</b></div>
          <div class="settings-row"><div class="sr-label">Rejected</div><b style="color:var(--red)">${s.rejected}</b></div>
          <div class="settings-row"><div class="sr-label">False-positive rate</div><b>${Math.round(s.falsePositiveRate * 100)}%</b></div>
          <div class="settings-row"><div class="sr-label">Repositories</div><b>${s.reposConnected}</b></div>
        </div></div>
      </div>
      <div class="panel"><div class="panel-body"><div class="sr-desc">Reviewer-hours saved uses a per-severity model (minutes to find + author a fix − false-alarm overhead). Export and per-team rollups ship in the analytics package; wire it to your BI tool for board-ready ROI. ${total === 0 ? "Accept or reject some findings to populate action rate." : ""}</div></div></div>`;
  }

  // ---------- LEARNINGS ----------
  async function renderLearnings() {
    const decisions = await api(`/api/decisions`);
    const mine = decisions.slice(0, 100);
    content.innerHTML = `
      <div class="panel">
        <div class="panel-head"><div><h2>What Cavix has learned</h2><span class="sub">${mine.length} preference${mine.length === 1 ? "" : "s"} from your accept/reject history</span></div><span class="badge badge-verified">personalization lock-in</span></div>
        <div class="panel-body">
          <p class="sr-desc" style="margin-bottom:16px">Every accept/reject tunes Cavix to <b>your</b> team's bar, thresholds, which nits to suppress, what's worth proving. A competitor starts cold; Cavix starts tuned.</p>
          ${mine.length ? `<table class="table"><thead><tr><th>Signal</th><th>Source</th><th>Decision</th><th>By</th></tr></thead><tbody>
            ${mine.map((d) => `<tr><td class="mono" style="color:var(--text-faint)">${esc(d.findingId)}</td><td><span class="badge">${esc(d.source)}</span></td><td><span class="decided ${esc(d.state)}">${esc(d.state)}</span></td><td style="color:var(--text-dim)">${esc(d.user)}</td></tr>`).join("")}
          </tbody></table>` : `<div class="empty" style="padding:40px">No learnings yet. Accept or reject findings on the Reviews page and they'll appear here.</div>`}
        </div>
      </div>`;
  }

  // ---------- INTEGRATIONS ----------
  async function renderIntegrations() {
    const gh = await api(`/api/github/status`).catch(() => ({ connected: false, demo: true }));
    const row = (mono, name, desc, state, action) => `<div class="repo-row"><div class="mono-badge">${esc(mono)}</div><div class="r-main"><div class="r-name">${esc(name)}</div><div class="r-desc">${esc(desc)}</div></div>${state}${action || ""}</div>`;
    const connected = `<span class="badge badge-verified">connected</span>`;
    const soon = `<span class="badge">soon</span>`;
    content.innerHTML = `
      <div class="panel">
        <div class="panel-head"><h2>Source control</h2><span class="sub">Where Cavix reviews pull requests</span></div>
        <div class="repo-list" style="border:none">
          ${row("GH", "GitHub", gh.connected ? "Connected, reviews & checks active" : "Sign in to connect your orgs and repos", gh.connected ? connected : soon, gh.connected ? "" : `<a class="btn btn-soft btn-sm" href="/api/auth/github/start">Connect</a>`)}
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

  // ---------- ADMIN (founder / core team only), redesigned ----------
  async function renderAdmin() {
    const orgs = await api(`/api/admin/orgs`);
    const totals = {
      orgs: orgs.length,
      trials: orgs.filter((o) => o.trialActive).length,
      suspended: orgs.filter((o) => o.suspended).length,
      reviews: orgs.reduce((a, o) => a + o.reviews, 0),
    };
    const rows = orgs.map((o) => {
      const status = o.suspended ? `<span class="badge badge-critical">suspended</span>` : o.trialActive ? `<span class="badge badge-verified">trial → ${new Date(o.trialEndsAt).toLocaleDateString()}</span>` : `<span class="badge">active</span>`;
      const limit = o.effectiveReviewsPerDay >= 1000000 ? "∞" : o.effectiveReviewsPerDay;
      return `<div class="admin-org">
        <div class="ao-name"><span class="ao-av">${esc(o.name[0].toUpperCase())}</span><div>${esc(o.name)}<div class="ao-meta">${o.members} member${o.members===1?"":"s"} · ${o.repos} repo${o.repos===1?"":"s"} · ${o.reviews} reviews</div></div></div>
        <div><select onchange="cavixAdmin('${esc(o.name)}',{tier:this.value})"><option value="free"${o.tier==="free"?" selected":""}>Free</option><option value="paid"${o.tier==="paid"?" selected":""}>Paid</option></select></div>
        <div>${status}</div>
        <div><b>${limit}</b> <span style="color:var(--text-faint);font-size:12px">/day</span></div>
        <div class="admin-actions">
          <button class="btn btn-soft btn-sm" onclick="cavixAdmin('${esc(o.name)}',{trialDays:14})">Trial 14d</button>
          <button class="btn btn-soft btn-sm" onclick="cavixAdminLimit('${esc(o.name)}')">Limit</button>
          <button class="btn ${o.suspended?"btn-soft":"btn-danger"} btn-sm" onclick="cavixAdmin('${esc(o.name)}',{suspended:${!o.suspended}})">${o.suspended?"Unsuspend":"Suspend"}</button>
        </div>
      </div>`;
    }).join("");
    content.innerHTML = `
      <div class="admin-tiles">
        <div class="admin-tile accent"><div class="t-lbl">Organizations</div><div class="t-val">${totals.orgs}</div></div>
        <div class="admin-tile"><div class="t-lbl">Active trials</div><div class="t-val">${totals.trials}</div></div>
        <div class="admin-tile"><div class="t-lbl">Suspended</div><div class="t-val">${totals.suspended}</div></div>
        <div class="admin-tile"><div class="t-lbl">Total reviews</div><div class="t-val">${totals.reviews}</div></div>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h2>All organizations</h2><span class="sub">you are a platform admin</span></div><input id="adminSearch" placeholder="Search orgs…" style="max-width:220px"></div>
        <div id="adminRows">${rows}</div>
      </div>
      <div class="panel"><div class="panel-body"><div class="sr-desc">Only emails in <code>CAVIX_ADMIN_EMAILS</code> reach this console. Tier, trial, limit and suspend changes take effect immediately for that org's reviews. See GUIDE.md §8E.</div></div></div>`;
    const search = $("adminSearch");
    if (search) search.addEventListener("input", (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll(".admin-org").forEach((el) => { el.style.display = el.querySelector(".ao-name").textContent.toLowerCase().includes(q) ? "" : "none"; });
    });
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
})();
