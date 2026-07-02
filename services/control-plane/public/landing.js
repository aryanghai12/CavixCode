// Landing page: interactive pricing toggles (billing cycle + model sourcing).
(function () {
  let cycle = "monthly"; // monthly | annual
  let source = "byok";   // byok | managed

  function render() {
    document.querySelectorAll(".plan .amount").forEach((el) => {
      const base = Number(el.dataset[source] ?? el.dataset.byok);
      if (!base) return;
      const monthly = cycle === "annual" ? Math.round(base * 0.8) : base;
      el.textContent = `$${monthly}`;
    });
    document.querySelectorAll("[data-cycle-note]").forEach((el) => {
      el.textContent = cycle === "annual" ? "billed annually · save 20%" : "billed monthly";
    });
    const srcnote = document.querySelector("[data-srcnote]");
    if (srcnote) {
      srcnote.textContent = source === "byok"
        ? "Your key — you pay ~$2–8/seat model bill"
        : "We buy the tokens — model usage bundled in";
    }
  }

  function wire(segId, attr, set) {
    const seg = document.getElementById(segId);
    if (!seg) return;
    seg.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        seg.querySelectorAll("button").forEach((b) => b.classList.remove("on"));
        btn.classList.add("on");
        set(btn.dataset[attr]);
        render();
      });
    });
  }

  wire("cycleSeg", "cycle", (v) => { cycle = v; });
  wire("sourceSeg", "source", (v) => { source = v; });
  render();
})();
