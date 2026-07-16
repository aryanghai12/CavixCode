// Cavix pricing, ONE source of truth for the whole site (landing + dashboard billing).
// Prices from PRODUCT_AND_BUSINESS_ROADMAP §9. Edit here; both pages update together.
window.CAVIX_PRICING = {
  annualDiscount: 0.2,
  overage: "$0.40 / agent-minute",
  seatNote: "Only active PR-authors count as seats · 20% off annual",
  smbNote: "India / SMB: flat small-team plan from ₹ / $15 / mo (~100 reviews).",
  tiers: [
    {
      id: "free", name: "Free / OSS", tierMatch: "free",
      byok: 0, managed: 0, source: "BYOK only",
      blurb: "For public repositories.",
      features: ["Unlimited public repos", "~50 private reviews / mo", "Full 13-stage verification", "@cavix commands & chat", "Community support"],
      cta: "Start free",
    },
    {
      id: "team", name: "Team", tierMatch: "paid", featured: true,
      byok: 12, managed: 24, source: "BYOK or managed",
      blurb: "For growing engineering teams.",
      features: ["Unlimited private repos", "Cross-repo impact graph", "Ensemble + standards learning", "Committable one-click fixes", "Email support"],
      cta: "Start 14-day trial",
    },
    {
      id: "pro", name: "Pro",
      byok: 39, managed: 39, source: "BYOK or managed",
      blurb: "Verification on every PR.",
      features: ["Verification (gated) every PR", "CI/CD regression prediction", "Pre-merge checks & test-gen", "Verified fix PRs", "Priority support & higher caps"],
      cta: "Start 14-day trial",
    },
    {
      id: "enterprise", name: "Enterprise", custom: true, priceLabel: "Custom",
      source: "$30-60/seat or site license",
      blurb: "For regulated & air-gapped orgs.",
      features: ["Self-host / VPC / air-gapped", "SSO / SAML + SCIM + RBAC", "Audit log & zero-retention", "Legacy languages + modernization", "Dedicated support & SLA"],
      cta: "Contact sales",
    },
  ],
};

// Display price for a tier given the current toggles.
window.cavixPrice = function (tier, cycle, source) {
  if (tier.custom) return { amount: tier.priceLabel || "Custom", per: "" };
  const base = source === "managed" ? tier.managed : tier.byok;
  if (base === 0) return { amount: "$0", per: "/forever" };
  const monthly = cycle === "annual" ? Math.round(base * (1 - window.CAVIX_PRICING.annualDiscount)) : base;
  return { amount: `$${monthly}`, per: "/seat / mo" };
};

// Render the marketing pricing cards into a mount element.
window.renderMarketingPricing = function (mountId, state) {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  mount.innerHTML = window.CAVIX_PRICING.tiers.map((t) => {
    const p = window.cavixPrice(t, state.cycle, state.source);
    const save = t.custom ? "" : (state.cycle === "annual" && !(t.byok === 0) ? "billed annually · save 20%" : "billed monthly");
    return `<div class="plan${t.featured ? " featured" : ""} spot">
      <h3>${esc(t.name)}</h3>
      <div class="price">${esc(p.amount)}<span>${esc(p.per)}</span>${save ? `<span class="save">${esc(save)}</span>` : ""}</div>
      <div class="srcnote">${esc(t.source)}</div>
      <ul>${t.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
      <a href="/signup" class="btn ${t.featured ? "btn-primary" : "btn-soft"} btn-block">${esc(t.cta)}</a>
    </div>`;
  }).join("");
};
