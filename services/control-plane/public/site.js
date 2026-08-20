/* ============================================================================
   CAVIX MARKETING BEHAVIOUR.

   Loaded after motion.js, which owns every animation on the site. This file is
   page behaviour only: the nav capsule, the sample review tabs, and the
   pricing toggles. Classic script, no modules, no dependencies.

   Everything here no-ops when its element is absent, so the same file is safe
   to load on the landing page, the docs and the auth screens.
   ========================================================================== */
(function () {
  "use strict";

  var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };

  /* ==========================================================================
     NAV
     Capsule state, read progress, active section, and the mobile sheet.
     ====================================================================== */
  function startNav() {
    var nav = document.getElementById("nav");
    if (!nav) return;

    var progress = document.getElementById("navProgress");
    var burger = document.getElementById("burger");
    var sheet = document.getElementById("navSheet");
    var links = [].slice.call(nav.querySelectorAll(".nav-links a[href*='#']"));

    var queued = false;
    function update() {
      queued = false;
      var y = window.scrollY;
      nav.classList.toggle("stuck", y > 20);
      if (progress) {
        var max = document.documentElement.scrollHeight - window.innerHeight;
        progress.style.width = (max > 0 ? Math.min(100, (y / max) * 100) : 0) + "%";
      }
    }
    function queue() { if (queued) return; queued = true; raf(update); }
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", queue, { passive: true });
    update();

    if (burger && sheet) {
      burger.addEventListener("click", function () {
        var open = sheet.classList.toggle("open");
        burger.classList.toggle("open", open);
        burger.setAttribute("aria-expanded", open ? "true" : "false");
      });
      /* Any navigation closes it, otherwise the sheet stays parked over the
         section the reader just asked to see. */
      sheet.addEventListener("click", function (e) {
        if (e.target.tagName !== "A") return;
        sheet.classList.remove("open");
        burger.classList.remove("open");
        burger.setAttribute("aria-expanded", "false");
      });
    }

    /* Highlight whichever section is currently under the masthead. Only
       same-page anchors take part; a link to another page has no section here
       to observe. */
    if (links.length && "IntersectionObserver" in window) {
      var byId = {};
      links.forEach(function (a) {
        var href = a.getAttribute("href");
        var hash = href.indexOf("#") >= 0 ? href.slice(href.indexOf("#") + 1) : "";
        if (hash && document.getElementById(hash)) byId[hash] = a;
      });

      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          links.forEach(function (a) { a.classList.remove("on"); });
          var a = byId[entry.target.id];
          if (a) a.classList.add("on");
        });
      }, { rootMargin: "-45% 0px -50% 0px", threshold: 0 });

      Object.keys(byId).forEach(function (id) { io.observe(document.getElementById(id)); });
    }
  }

  /* ==========================================================================
     SAMPLE REVIEW TABS
     ====================================================================== */
  function startTabs() {
    var tabs = document.getElementById("showcaseTabs");
    if (!tabs) return;
    var buttons = tabs.querySelectorAll("button");
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var which = btn.dataset.panel;
        buttons.forEach(function (b) {
          var on = b === btn;
          b.classList.toggle("on", on);
          b.setAttribute("aria-selected", on ? "true" : "false");
        });
        document.querySelectorAll(".panel-tab").forEach(function (p) {
          p.classList.toggle("on", p.dataset.panel === which);
        });
      });
    });
  }

  /* ==========================================================================
     PRICING
     The numbers live in pricing.js, the single source shared with the
     dashboard's billing page. This only drives the toggles.
     ====================================================================== */
  function startPricing() {
    if (!window.renderMarketingPricing) return;
    var state = { cycle: "monthly", source: "byok" };

    function render() {
      window.renderMarketingPricing("pricingCards", state);
      /* The plans are brand new nodes on every toggle, so the tilt has to be
         bound again. bindTilt marks what it has already seen, so re-running it
         cannot stack duplicate listeners on anything. */
      if (window.CavixMotion && window.CavixMotion.bindTilt) {
        window.CavixMotion.bindTilt(document.getElementById("pricingCards"));
      }
    }
    render();

    if (window.CAVIX_PRICING) {
      var ov = document.getElementById("overageLabel");
      if (ov) ov.textContent = window.CAVIX_PRICING.overage;
      var smb = document.getElementById("smbLabel");
      if (smb) smb.textContent = window.CAVIX_PRICING.smbNote;
    }

    function wire(segId, attr, key) {
      var seg = document.getElementById(segId);
      if (!seg) return;
      var btns = seg.querySelectorAll("button");
      btns.forEach(function (btn) {
        btn.addEventListener("click", function () {
          btns.forEach(function (b) { b.classList.remove("on"); });
          btn.classList.add("on");
          state[key] = btn.dataset[attr];
          render();
        });
      });
    }
    wire("cycleSeg", "cycle", "cycle");
    wire("sourceSeg", "source", "source");
  }

  function boot() { startNav(); startTabs(); startPricing(); }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
