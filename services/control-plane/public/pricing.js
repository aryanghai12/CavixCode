// Cavix pricing, ONE source of truth for the whole site (landing + dashboard billing).
// Prices from PRODUCT_AND_BUSINESS_ROADMAP section 9. Edit here; both pages update
// together. The dashboard's billing page reads name, source, features, featured,
// custom, byok, managed, tierMatch and id off these objects, so none of those keys
// can be renamed without changing app.js too.
window.CAVIX_PRICING = {
  annualDiscount: 0.2,
  overage: "$0.40 per agent-minute",
  seatNote: "Only people who actually open pull requests count as seats, and annual saves about 20%",
  smbNote: "Smaller teams in India and similar markets can start on a flat plan from about $15 a month, which covers roughly 100 reviews.",
  tiers: [
    {
      id: "free", name: "Free and open source", tierMatch: "free",
      byok: 0, managed: 0, source: "Your own key",
      blurb: "For public repositories.",
      features: [
        "Unlimited public repos",
        "Around 50 private reviews a month",
        "The full 13 stage verification pass",
        "Commands and chat in the PR",
        "Community support",
      ],
      cta: "Start free",
    },
    {
      id: "team", name: "Team", tierMatch: "paid", featured: true,
      byok: 12, managed: 24, source: "Your key, or we buy the tokens",
      blurb: "For engineering teams finding their feet.",
      features: [
        "Unlimited private repos",
        "Cross repo impact graph",
        "Ensemble review and standards learning",
        "One click fixes you can commit",
        "Email support",
      ],
      cta: "Start 14 day trial",
    },
    {
      id: "pro", name: "Pro",
      byok: 39, managed: 39, source: "Your key, or we buy the tokens",
      blurb: "Verification on every single pull request.",
      features: [
        "Verification on every PR, not just the risky ones",
        "CI and CD regression prediction",
        "Pre merge checks and test generation",
        "Fix PRs it has already proven",
        "Priority support and higher caps",
      ],
      cta: "Start 14 day trial",
    },
    {
      id: "enterprise", name: "Enterprise", custom: true, priceLabel: "Custom",
      source: "$30 to $60 a seat, or a site licence",
      blurb: "For regulated and air gapped organisations.",
      features: [
        "Self host, your VPC, or fully air gapped",
        "SSO and SAML, plus SCIM and RBAC",
        "Audit log and zero retention",
        "Legacy languages and modernisation",
        "Dedicated support with an SLA",
      ],
      cta: "Talk to us",
    },
  ],
};

// Display price for a tier given the current toggles.
window.cavixPrice = function (tier, cycle, source) {
  if (tier.custom) return { amount: tier.priceLabel || "Custom", per: "" };
  const base = source === "managed" ? tier.managed : tier.byok;
  if (base === 0) return { amount: "$0", per: "forever" };
  if (cycle !== "annual") return { amount: `$${base}`, per: "per seat / month", saved: 0 };
  // Prices are shown as whole dollars, so the annual figure is rounded and the
  // saving it actually delivers is NOT the headline 20%. Team on your own key is
  // the case that bites: $12 × 0.8 is $9.60, shown as $10, which is 17% off, and
  // a card reading "$10 / billed annually, save 20%" is a price claim that does
  // not survive its own arithmetic. Rounding can also land the other way ($24 →
  // $19 is 21%), so the saving is derived from the number on the card rather
  // than asserted alongside it.
  const monthly = Math.round(base * (1 - window.CAVIX_PRICING.annualDiscount));
  return { amount: `$${monthly}`, per: "per seat / month", saved: Math.round((1 - monthly / base) * 100) };
};

// Render the marketing pricing cards into a mount element.
window.renderMarketingPricing = function (mountId, state) {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // Enterprise sends people to the enterprise section rather than signup, because
  // a custom price has no checkout to send them to. The target is the landing
  // page's #enterprise section, which is what every other Enterprise link on the
  // site points at; /docs has no such anchor, so that href landed at the top of
  // the docs and left the reader to hunt for it.
  mount.innerHTML = window.CAVIX_PRICING.tiers.map((t) => {
    const p = window.cavixPrice(t, state.cycle, state.source);
    const save = t.custom ? "" : (state.cycle === "annual" && t.byok !== 0 ? `billed annually, save ${p.saved}%` : "billed monthly");
    const href = t.custom ? "/#enterprise" : "/signup";
    return `<div class="plan tilt${t.featured ? " plan-featured" : ""}">
      ${t.featured ? `<span class="plan-flag">Most popular</span>` : ""}
      <h3>${esc(t.name)}</h3>
      <p class="blurb">${esc(t.blurb)}</p>
      <div class="price">${esc(p.amount)}${p.per ? `<span>${esc(p.per)}</span>` : ""}${save ? `<span class="save">${esc(save)}</span>` : ""}</div>
      <div class="srcnote">${esc(t.source)}</div>
      <ul>${t.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
      <a href="${href}" class="btn ${t.featured ? "btn-primary" : "btn-glass"} btn-block">${esc(t.cta)}</a>
    </div>`;
  }).join("");
};
