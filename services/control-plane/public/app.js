// Cavix dashboard — a dependency-free single-page app over the control-plane API.
(function () {
  const $ = (id) => document.getElementById(id);
  const content = $("content");
  let me = null;       // current user
  let org = null;

  // ---------- tiny helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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
    reviews: { title: "Reviews", crumb: "Findings from your pull requests — accept or reject to train Cavix", render: renderReviews },
    repos: { title: "Repositories", crumb: "Repositories Cavix is watching", render: renderRepos },
    feed: { title: "Proven catches", crumb: "Publicly verified findings across the community", render: renderFeed },
    byok: { title: "AI & BYOK", crumb: "Bring your own AI key — Cavix never marks up tokens", render: renderByok },
    settings: { title: "Review settings", crumb: "How Cavix reviews your pull requests", render: renderSettings },
    team: { title: "Team", crumb: "People in your workspace and their roles", render: renderTeam },
    billing: { title: "Plan & billing", crumb: "Your subscription and usage", render: renderBilling },
    admin: { title: "Admin console", crumb: "Founder controls — every org's tier, trial, limits & status", render: renderAdmin },
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
    content.innerHTML = `<div class="empty"><div class="big">⏳</div>Loading…</div>`;
    VIEWS[view].render().catch((err) => {
      content.innerHTML = `<div class="empty"><div class="big">⚠️</div>${esc(err.message)}</div>`;
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
        <div class="stat"><div class="label">🔬 Reviews run</div><div class="value">${s.reviews}</div><div class="delta">last 30 days</div></div>
        <div class="stat"><div class="label">✅ Verified findings</div><div class="value grad">${s.verified}</div><div class="delta">proven in a sandbox</div></div>
        <div class="stat"><div class="label">🎯 Action rate</div><div class="value">${Math.round(s.actionRate * 100)}%</div><div class="delta">accepted of decided</div></div>
        <div class="stat"><div class="label">⏱️ Reviewer-hours saved</div><div class="value">${s.hoursSaved}</div><div class="delta">est. this period</div></div>
      </div>
      <div class="grid grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Reviews — last 7 days</h2></div>
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
      content.innerHTML = `<div class="empty"><div class="big">🔬</div>No reviews yet. Connect a repo and open a pull request — findings will appear here.</div>`;
      return;
    }
    content.innerHTML = reviews.map((r) => {
      const findings = r.findings.map((f) => {
        const source = f.immutable ? `<span class="badge badge-policy">🔒 policy</span>` : `<span class="badge">${esc(f.source)}</span>`;
        const verified = f.verified ? `<span class="badge badge-verified">✅ verified</span>` : "";
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
          <div><div class="r-title">${esc(r.repo)} #${r.pr} — ${esc(r.title)}</div>
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
      toast(`Finding ${state} — Cavix will learn from this`);
    } catch (e) { toast(e.message); }
  };

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
          <p>Authorize Cavix to see your organizations and repositories, then enable reviews on the ones you choose — all from here.</p>
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
    catch (e) { $("repoList").innerHTML = `<div class="empty" style="padding:30px">⚠️ ${esc(e.message)}</div>`; }
  }
  function paintRepos(filter) {
    const q = (filter || "").toLowerCase();
    const repos = repoState.repos.filter((r) => r.name.toLowerCase().includes(q));
    const list = $("repoList");
    if (!repos.length) { list.innerHTML = `<div class="empty" style="padding:30px">No repositories match.</div>`; return; }
    list.innerHTML = repos.map((r) => `
      <div class="repo-row" data-full="${esc(r.fullName)}">
        <div class="r-ico">${r.private ? "🔒" : "📖"}</div>
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
      content.innerHTML = `<div class="empty"><div class="big">🏆</div>No proven catches yet. Verified findings from opted-in public repos appear here.</div>`;
      return;
    }
    content.innerHTML = `<div class="panel"><div class="panel-head"><h2>Proven catches</h2><span class="sub">Execution-verified findings, opted in by their owners</span></div>
      <table class="table"><thead><tr><th>Repository</th><th>Finding</th><th>Category</th><th>Severity</th><th>When</th></tr></thead><tbody>
      ${feed.map((f) => `<tr><td><b>${esc(f.org)}/${esc(f.repo)}</b></td><td>${esc(f.title)}</td><td><span class="badge">${esc(f.category)}</span></td><td>${sevBadge(f.severity)}</td><td style="color:var(--text-faint)">${new Date(f.at).toLocaleDateString()}</td></tr>`).join("")}
      </tbody></table></div>`;
  }

  // ---------- BYOK ----------
  async function renderByok() {
    const s = await api(`/api/orgs/${org}/settings`);
    const providers = ["anthropic", "openai", "google", "selfhosted"];
    const status = s.apiKeyFingerprint
      ? `<div class="key-box"><code>${esc(s.apiKeyFingerprint)}</code><span class="badge badge-verified">active</span></div>
         <div class="sr-desc" style="margin-top:8px">Set ${s.apiKeySetAt ? new Date(s.apiKeySetAt).toLocaleString() : ""}. Your key is encrypted at rest (AES-256-GCM) and never shown again.</div>`
      : `<div class="sr-desc">No key yet. Add one so Cavix can run reviews with your own AI account.</div>`;

    content.innerHTML = `
      <div class="panel">
        <div class="panel-head"><h2>AI provider &amp; model</h2><span class="sub">Model-agnostic — switch anytime</span></div>
        <div class="panel-body">
          <div class="grid grid-2" style="gap:16px">
            <div class="field" style="margin:0"><label>Provider</label><select id="provider">${providers.map((p) => `<option value="${p}"${p === s.llmProvider ? " selected" : ""}>${p}</option>`).join("")}</select></div>
            <div class="field" style="margin:0"><label>Model</label><input id="model" value="${esc(s.llmModel)}" placeholder="claude-opus-4-8"></div>
          </div>
          <button class="btn btn-primary btn-sm" id="saveModel" style="margin-top:16px">Save provider &amp; model</button>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>API key (BYOK)</h2><span class="sub">Encrypted at rest · only a fingerprint is ever displayed</span></div>
        <div class="panel-body">
          <div style="margin-bottom:16px">${status}</div>
          <div class="field" style="margin:0"><label>Paste a new key</label><input id="apiKey" type="password" placeholder="sk-ant-… / sk-… / your model token"></div>
          <button class="btn btn-primary btn-sm" id="saveKey" style="margin-top:14px">Save key securely</button>
          <p class="sr-desc" style="margin-top:14px">🔒 Cavix never logs your key and never marks up tokens — you pay your AI provider directly. For air-gapped installs, choose <b>selfhosted</b> and your in-cluster model is used with zero outbound calls.</p>
        </div>
      </div>`;

    $("saveModel").addEventListener("click", async () => {
      try { await api(`/api/orgs/${org}/settings`, { method: "PUT", body: JSON.stringify({ llmProvider: $("provider").value, llmModel: $("model").value.trim() }) }); toast("Provider & model saved"); }
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

    content.innerHTML = `
      <div class="panel">
        <div class="panel-head"><h2>Automation</h2><span class="sub">These mirror your <code>.cavix.yaml</code></span></div>
        <div class="panel-body" style="padding-top:6px">
          ${toggle("autoReview", "Auto-review pull requests", "Review automatically on open and every push.", s.autoReview)}
          ${toggle("reviewDraftPRs", "Review draft PRs", "Also review pull requests still marked as draft.", s.reviewDraftPRs)}
          ${toggle("policyEnabled", "Policy gate", "Enforce your plain-English org rules as non-bypassable checks.", s.policyEnabled)}
          ${toggle("airgapped", "Air-gapped mode", "Only reach the in-cluster model — zero outbound calls.", s.airgapped)}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Tone &amp; merge gate</h2></div>
        <div class="panel-body">
          <div class="settings-row"><div><div class="sr-label">Comment tone</div><div class="sr-desc">How detailed Cavix's comments are.</div></div>
            <select id="tone" style="width:160px"><option value="concise"${s.tone === "concise" ? " selected" : ""}>Concise</option><option value="detailed"${s.tone === "detailed" ? " selected" : ""}>Detailed</option></select></div>
          <div class="settings-row"><div><div class="sr-label">Fail the check on</div><div class="sr-desc">Severities that make the Cavix status check fail (and can block merge).</div></div>
            <div>${sevChecks}</div></div>
        </div>
      </div>
      <button class="btn btn-primary" id="saveSettings">Save settings</button>`;

    $("saveSettings").addEventListener("click", async () => {
      const patch = { tone: $("tone").value, failOn: [...document.querySelectorAll(".failOn:checked")].map((c) => c.value) };
      document.querySelectorAll("[data-key]").forEach((el) => { patch[el.dataset.key] = el.checked; });
      try { await api(`/api/orgs/${org}/settings`, { method: "PUT", body: JSON.stringify(patch) }); toast("Settings saved"); }
      catch (e) { toast(e.message); }
    });
  }

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
        <div class="settings-row"><div><div class="sr-label">Invite teammates</div><div class="sr-desc">Share your organization name <b>${esc(org)}</b> — teammates sign up and join automatically. Production connects this to SSO/SCIM.</div></div>
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
    const plans = [
      { id: "free", name: "Free / OSS", price: "$0", tierMatch: "free", features: ["Unlimited public repos", "~50 private reviews/mo", "Full verification engine", "BYOK only"] },
      { id: "team", name: "Team", price: "$12–24/seat/mo", tierMatch: "paid", features: ["Unlimited private repos", "Cross-repo impact", "Standards learning", "BYOK or managed"] },
      { id: "pro", name: "Pro", price: "$39/seat/mo", tierMatch: null, features: ["Verification every PR", "CI/CD regression prediction", "Verified fix PRs", "Higher caps"] },
      { id: "enterprise", name: "Enterprise", price: "Custom", tierMatch: null, features: ["Self-host / air-gapped", "SSO/SAML + SCIM", "Audit & zero-retention", "Legacy + modernization"] },
    ];
    content.innerHTML = `
      <div class="panel"><div class="panel-head"><h2>Current plan</h2></div>
        <div class="panel-body"><div class="settings-row"><div><div class="sr-label" style="text-transform:capitalize">${tier === "free" ? "Open Source (Free)" : tier === "paid" ? "Team" : "Enterprise"}</div><div class="sr-desc">Billing is illustrative in this trial build — wire Stripe for production.</div></div><span class="badge badge-verified">active</span></div></div>
      </div>
      <div class="pricing">
        ${plans.map((p) => `<div class="plan${p.id === "team" ? " featured" : ""}"><h3>${p.name}</h3><div class="price">${p.price}</div><ul>${p.features.map((f) => `<li>${f}</li>`).join("")}</ul>
          ${(p.tierMatch === tier) ? `<button class="btn btn-soft btn-block" disabled>Current plan</button>` : `<button class="btn ${p.id === "team" ? "btn-primary" : "btn-soft"} btn-block" onclick="cavixToast('Connect Stripe to enable upgrades')">${p.id === "enterprise" ? "Contact sales" : "Choose plan"}</button>`}
        </div>`).join("")}
      </div>
      <div class="overage" style="margin-top:22px">Verification overage billed at <code>$0.40 / agent-minute</code> beyond your included pool. Only active PR-authors count as seats · ~20% off annual.</div>`;
  }

  // ---------- ADMIN (founder / core team only) ----------
  async function renderAdmin() {
    const orgs = await api(`/api/admin/orgs`);
    const rows = orgs.map((o) => {
      const trial = o.trialActive ? `<span class="badge badge-verified">trial ${new Date(o.trialEndsAt).toLocaleDateString()}</span>` : "";
      const susp = o.suspended ? `<span class="badge badge-critical">suspended</span>` : "";
      const limit = o.effectiveReviewsPerDay >= 1000000 ? "∞" : o.effectiveReviewsPerDay;
      return `<tr data-org="${esc(o.name)}">
        <td><b>${esc(o.name)}</b><div style="color:var(--text-faint);font-size:12px">${o.members} member${o.members===1?"":"s"} · ${o.repos} repo${o.repos===1?"":"s"} · ${o.reviews} reviews</div></td>
        <td><select onchange="cavixAdmin('${esc(o.name)}',{tier:this.value})"><option value="free"${o.tier==="free"?" selected":""}>free</option><option value="paid"${o.tier==="paid"?" selected":""}>paid</option></select></td>
        <td>${trial} ${susp}</td>
        <td><b>${limit}</b>/day</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-soft btn-sm" onclick="cavixAdmin('${esc(o.name)}',{trialDays:14})">Start 14-day trial</button>
          <button class="btn btn-soft btn-sm" onclick="cavixAdminLimit('${esc(o.name)}')">Set limit</button>
          <button class="btn ${o.suspended?"btn-soft":"btn-danger"} btn-sm" onclick="cavixAdmin('${esc(o.name)}',{suspended:${!o.suspended}})">${o.suspended?"Unsuspend":"Suspend"}</button>
        </td>
      </tr>`;
    }).join("");
    content.innerHTML = `
      <div class="panel">
        <div class="panel-head"><h2>All organizations</h2><span class="sub">${orgs.length} total · you are a platform admin</span></div>
        <table class="table"><thead><tr><th>Organization</th><th>Tier</th><th>Status</th><th>Reviews / day</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      </div>
      <div class="panel"><div class="panel-body">
        <div class="sr-desc">🛡️ Only emails in <code>CAVIX_ADMIN_EMAILS</code> reach this console. Changing a tier, starting a trial, overriding the daily review limit, or suspending an org takes effect immediately for that org's reviews. See GUIDE.md §8E.</div>
      </div></div>`;
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
