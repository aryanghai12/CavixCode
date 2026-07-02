// Landing page: pricing (from the shared source) + toggles + review showcase tabs.
(function () {
  const state = { cycle: "monthly", source: "byok" };

  function renderPricing() {
    if (window.renderMarketingPricing) window.renderMarketingPricing("pricingCards", state);
  }
  renderPricing();

  // set overage + smb labels from the single source
  if (window.CAVIX_PRICING) {
    const ov = document.getElementById("overageLabel"); if (ov) ov.textContent = window.CAVIX_PRICING.overage;
    const smb = document.getElementById("smbLabel"); if (smb) smb.textContent = window.CAVIX_PRICING.smbNote;
  }

  function wire(segId, attr, key) {
    const seg = document.getElementById(segId);
    if (!seg) return;
    seg.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        seg.querySelectorAll("button").forEach((b) => b.classList.remove("on"));
        btn.classList.add("on");
        state[key] = btn.dataset[attr];
        renderPricing();
      });
    });
  }
  wire("cycleSeg", "cycle", "cycle");
  wire("sourceSeg", "source", "source");

  // review showcase tabs
  const tabs = document.getElementById("showcaseTabs");
  if (tabs) {
    tabs.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const which = btn.dataset.panel;
        tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
        document.querySelectorAll(".showcase-panel").forEach((p) => p.classList.toggle("on", p.dataset.panel === which));
      });
    });
  }
})();
