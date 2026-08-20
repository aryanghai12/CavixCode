/* ============================================================================
   CAVIX, marketing site behaviour.

   Classic script, no modules, no dependencies.

   THE CONTRACT EVERY EFFECT IN HERE HONOURS
   The page must be complete and fully legible with this file deleted. Nothing
   below creates content, and nothing below is allowed to leave text dimmer
   than its static state. Reveals work by ADDING a class that plays an
   animation on an already visible element, never by hiding something and
   hoping an observer switches it back on. The particle field draws to a canvas
   pinned behind the content layer, and it switches itself off on reduced
   motion, on a hidden tab, and the moment the hero scrolls away.
   ========================================================================== */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var finePointer  = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };

  /* A single scroll listener feeds everything that cares about scroll position.
     Handlers are cheap and run on a rAF tick rather than on every event. */
  var scrollJobs = [];
  function onScroll(fn) { scrollJobs.push(fn); }
  function runScrollJobs() { for (var i = 0; i < scrollJobs.length; i++) scrollJobs[i](); }
  (function scrollPump() {
    var queued = false;
    function run() { queued = false; runScrollJobs(); }
    function queue() { if (queued) return; queued = true; raf(run); }
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", queue, { passive: true });
  })();

  /* ==========================================================================
     1. PARTICLE FIELD
     A dome: an annulus of fine particles with a soft void at its centre. The
     void is the important part, because the aurora glows through it and the
     headline sits on that glow rather than on a texture.

     HOW IT IS DRAWN
     The look needs on the order of twenty thousand points, which is far too
     many to move and fill individually every frame. So the field is baked ONCE
     into an offscreen bitmap and the bitmap is what moves: a single drawImage
     per frame, rotated a fraction of a degree and squashed into the ellipse. A
     few hundred live particles are drawn on top for the twinkle a bitmap
     cannot have. Two draw calls and a small loop, at any density.

     Because the bitmap rotates, the arch cannot be baked into it (the dark
     half would swing up into view), so the bottom is erased each frame with a
     destination-out gradient in screen space, which stays put.
     ====================================================================== */
  function startField() {
    var canvas = document.getElementById("field");
    if (!canvas || reduceMotion) return;

    var ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    var W = 0, H = 0, dpr = 1;
    var off = null, R = 0;
    var live = [];
    var theta = 0;
    var pointerX = 0, pointerY = 0;
    var driftX = 0, driftY = 0;

    function rxOf() { return W * 0.54; }
    function ryOf() { return H * 0.58; }
    function cyOf() { return H * 0.58; }
    var INNER = 0.46;

    function build() {
      dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width  = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width  = W + "px";
      canvas.style.height = H + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      bake();

      var liveCount = Math.max(70, Math.min(Math.round((W * H) / 9000), 200));
      live = new Array(liveCount);
      for (var i = 0; i < liveCount; i++) live[i] = seedLive();
    }

    /* A circular annulus, baked once at 1x. Circular rather than elliptical
       because it gets rotated; the ellipse is applied as a scale at draw time
       so the rotation stays true. */
    function bake() {
      R = Math.round(Math.max(rxOf(), ryOf()) * 1.06) || 600;
      var D = R * 2;

      off = document.createElement("canvas");
      off.width = D; off.height = D;
      var o = off.getContext("2d");
      if (!o) { off = null; return; }

      var area = Math.PI * R * R * (1 - INNER * INNER);
      var count = Math.max(5000, Math.min(Math.round(area / 34), 20000));

      for (var i = 0; i < count; i++) {
        var a = Math.random() * Math.PI * 2;
        /* pow > 1 crowds t near zero, which gives the void a defined rim. The
           jitter afterwards takes the hard cut out edge back off it. */
        var t = Math.pow(Math.random(), 1.7);
        var r = (INNER + t * (1 - INNER)) * R + (Math.random() - 0.5) * R * 0.05;

        var x = R + Math.cos(a) * r;
        var y = R + Math.sin(a) * r;

        var alpha = (0.14 + Math.random() * 0.72) * (1 - Math.pow(t, 2.2));
        if (alpha < 0.02) continue;

        var s = t < 0.25 ? (0.6 + Math.random() * 1.4) : (0.5 + Math.random() * 0.9);

        /* Tinted to the palette rather than plain white, so the field belongs
           to the same colour system as the aurora behind it. */
        var roll = Math.random();
        var rgb = roll < 0.22 ? "124,108,255" : roll < 0.42 ? "56,224,208" : roll < 0.62 ? "140,180,255" : "255,255,255";

        o.fillStyle = "rgba(" + rgb + "," + alpha.toFixed(3) + ")";
        o.fillRect(x, y, s, s);
      }
    }

    function seedLive() {
      return {
        a: Math.random() * Math.PI * 2,
        t: Math.pow(Math.random(), 1.7),
        s: 1 + Math.random() * 1.6,
        b: 0.5 + Math.random() * 0.5,
        p: Math.random() * Math.PI * 2,
        w: 0.0008 + Math.random() * 0.0018,
        c: Math.random() < 0.45
      };
    }

    function draw(now) {
      ctx.clearRect(0, 0, W, H);

      var cx = W * 0.5 + driftX;
      var cy = cyOf() + driftY;
      var rx = rxOf(), ry = ryOf();

      if (off) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(rx / R, ry / R);
        ctx.rotate(theta);
        ctx.drawImage(off, -R, -R);
        ctx.restore();
      }

      for (var i = 0; i < live.length; i++) {
        var p = live[i];
        var r = INNER + p.t * (1 - INNER);
        var ang = p.a + theta;
        var x = cx + Math.cos(ang) * rx * r;
        var y = cy + Math.sin(ang) * ry * r;
        if (x < -8 || x > W + 8 || y < -8 || y > H + 8) continue;

        var alpha = p.b * (1 - Math.pow(p.t, 2.2)) * (0.5 + 0.5 * Math.sin(now * p.w + p.p));
        if (alpha < 0.03) continue;
        ctx.fillStyle = (p.c ? "rgba(150,235,255," : "rgba(255,255,255,") + alpha.toFixed(3) + ")";
        ctx.fillRect(x, y, p.s, p.s);
      }

      /* Carve the ring back into an arch, in screen space so the dark half
         stays at the bottom of the viewport instead of turning with the field. */
      var g = ctx.createLinearGradient(0, H * 0.26, 0, H * 0.84);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(0.55, "rgba(0,0,0,.55)");
      g.addColorStop(1, "rgba(0,0,0,1)");
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";

      theta += 0.00005;
    }

    var visible = !document.hidden;
    var active = true;
    var running = false;

    function tick(now) {
      if (!visible || !active) { running = false; return; }
      driftX += (pointerX * 30 - driftX) * 0.045;
      driftY += (pointerY * 20 - driftY) * 0.045;
      draw(now || performance.now());
      raf(tick);
    }
    function kick() {
      if (running || !visible || !active) return;
      running = true;
      raf(tick);
    }

    build();
    kick();

    var resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { build(); kick(); }, 180);
    }, { passive: true });

    document.addEventListener("visibilitychange", function () {
      visible = !document.hidden;
      kick();
    });

    if (finePointer) {
      window.addEventListener("mousemove", function (e) {
        pointerX = (e.clientX / window.innerWidth) * 2 - 1;
        pointerY = (e.clientY / window.innerHeight) * 2 - 1;
      }, { passive: true });
    }

    /* The field belongs to the hero. Once the viewport has moved past it the
       loop stops and the canvas fades, so the sections below get clean ground
       instead of a stale frame hanging behind them. Driven by scroll position
       rather than by observing an element, because the canvas is fixed and
       what matters is where the viewport is.

       On a phone the hero stacks into one column and copy passes through the
       band almost at once, so there the field is a first impression only. */
    onScroll(function () {
      var narrow = window.innerWidth <= 860;
      var limit = narrow ? 40 : window.innerHeight * 0.8;
      var past = window.scrollY > limit;
      canvas.classList.toggle("field-off", past);
      active = !past;
      if (active) kick();
    });
  }

  /* ==========================================================================
     2. AURORA
     Full strength behind the hero, dialled back below it so no section of body
     copy is ever read over a bright colour mass. Pure class toggle; the CSS
     owns the animation.
     ====================================================================== */
  function startAurora() {
    var aurora = document.getElementById("aurora");
    if (!aurora) return;
    onScroll(function () {
      aurora.classList.toggle("calm", window.scrollY > window.innerHeight * 0.62);
    });
  }

  /* ==========================================================================
     3. NAV
     Capsule state, read progress, active section, and the mobile sheet.
     ====================================================================== */
  function startNav() {
    var nav = document.getElementById("nav");
    if (!nav) return;

    var progress = document.getElementById("navProgress");
    var burger = document.getElementById("burger");
    var sheet = document.getElementById("navSheet");
    var links = [].slice.call(nav.querySelectorAll(".nav-links a[href^='#']"));

    onScroll(function () {
      var y = window.scrollY;
      nav.classList.toggle("stuck", y > 20);

      if (progress) {
        var max = document.documentElement.scrollHeight - window.innerHeight;
        progress.style.width = (max > 0 ? Math.min(100, (y / max) * 100) : 0) + "%";
      }
    });

    if (burger && sheet) {
      burger.addEventListener("click", function () {
        var open = sheet.classList.toggle("open");
        burger.classList.toggle("open", open);
        burger.setAttribute("aria-expanded", open ? "true" : "false");
      });
      /* Any navigation closes it, otherwise the sheet stays over the section
         the reader just asked to see. */
      sheet.addEventListener("click", function (e) {
        if (e.target.tagName !== "A") return;
        sheet.classList.remove("open");
        burger.classList.remove("open");
        burger.setAttribute("aria-expanded", "false");
      });
    }

    /* Highlight whichever section is currently under the masthead. */
    if (links.length && "IntersectionObserver" in window) {
      var byId = {};
      links.forEach(function (a) { byId[a.getAttribute("href").slice(1)] = a; });

      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          links.forEach(function (a) { a.classList.remove("on"); });
          var a = byId[entry.target.id];
          if (a) a.classList.add("on");
        });
      }, { rootMargin: "-45% 0px -50% 0px", threshold: 0 });

      Object.keys(byId).forEach(function (id) {
        var el = document.getElementById(id);
        if (el) io.observe(el);
      });
    }
  }

  /* ==========================================================================
     4. HEADLINE REVEAL
     Words settle in one after another. The soft state stays white, never grey,
     and a short failsafe lights everything regardless of what else happens.
     ====================================================================== */
  function startReveal() {
    var host = document.querySelector("[data-reveal]");
    if (!host || reduceMotion) return;
    var words = host.querySelectorAll(".w");
    if (!words.length) return;

    host.classList.add("reveal-on");

    var i = 0;
    function light() {
      if (i >= words.length) return;
      words[i].classList.add("lit");
      i++;
      setTimeout(light, 62);
    }
    raf(function () { raf(function () { setTimeout(light, 90); }); });

    setTimeout(function () {
      for (var k = 0; k < words.length; k++) words[k].classList.add("lit");
    }, 1100);
  }

  /* ==========================================================================
     5. SECTION RISE
     Purely additive: `.in` starts an entrance animation on an element that was
     already visible. A browser without IntersectionObserver, a script error, or
     an observer that never fires all degrade to "the section is simply there".

     The bottom rootMargin is positive so the observer fires about 90px before
     the element reaches the viewport, which means the animation starts from
     zero opacity while it is still off screen.
     ====================================================================== */
  function startRise() {
    var items = document.querySelectorAll(".rise");
    if (!items.length || reduceMotion || !("IntersectionObserver" in window)) return;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px 90px 0px", threshold: 0 });

    items.forEach(function (el) { if (!el.classList.contains("in")) io.observe(el); });
  }

  /* ==========================================================================
     6. STAT COUNT UP
     The final value is already in the markup, so this only ever replaces a
     correct number with the same correct number at the end of a short ramp.
     ====================================================================== */
  function startCounters() {
    var nodes = document.querySelectorAll("[data-count]");
    if (!nodes.length || reduceMotion || !("IntersectionObserver" in window)) return;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        io.unobserve(entry.target);
        ramp(entry.target);
      });
    }, { threshold: 0.4 });

    nodes.forEach(function (el) { io.observe(el); });

    function ramp(el) {
      var target = parseInt(el.getAttribute("data-count"), 10);
      if (!isFinite(target)) return;
      var start = performance.now();
      var dur = 900;
      (function step(now) {
        var t = Math.min(1, (now - start) / dur);
        var eased = 1 - Math.pow(1 - t, 3);
        el.textContent = String(Math.round(target * eased));
        if (t < 1) raf(step);
        else el.textContent = String(target);
      })(start);
    }
  }

  /* ==========================================================================
     7. CARD SPOTLIGHT
     Feeds pointer coordinates to the card so its highlight can follow. Only on
     a fine pointer; with no script the CSS variables stay unset and the
     highlight sits at zero opacity, which is exactly the resting state.
     ====================================================================== */
  function startSpotlight() {
    if (!finePointer || reduceMotion) return;
    var cards = document.querySelectorAll(".card");
    if (!cards.length) return;

    cards.forEach(function (card) {
      card.addEventListener("mousemove", function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty("--mx", (e.clientX - r.left) + "px");
        card.style.setProperty("--my", (e.clientY - r.top) + "px");
      }, { passive: true });
    });
  }

  /* ==========================================================================
     8. CUSTOM POINTER
     ====================================================================== */
  function startCursor() {
    var dot = document.querySelector(".cursor");
    var ring = document.querySelector(".cursor-ring");
    if (!dot || !ring || !finePointer || reduceMotion) return;

    var mx = window.innerWidth / 2, my = window.innerHeight / 2;
    var rx = mx, ry = my;
    var live = false;

    window.addEventListener("mousemove", function (e) {
      mx = e.clientX; my = e.clientY;
      if (!live) { live = true; rx = mx; ry = my; document.body.classList.add("cursor-on"); }
    }, { passive: true });

    document.addEventListener("mouseleave", function () { document.body.classList.remove("cursor-on"); });
    document.addEventListener("mouseenter", function () { if (live) document.body.classList.add("cursor-on"); });

    (function follow() {
      dot.style.transform = "translate3d(" + mx + "px," + my + "px,0)";
      rx += (mx - rx) * 0.17;
      ry += (my - ry) * 0.17;
      ring.style.transform = "translate3d(" + rx + "px," + ry + "px,0)";
      raf(follow);
    })();

    document.addEventListener("mouseover", function (e) {
      if (e.target.closest && e.target.closest("a, button, .card, .plan, .stage, .chip")) ring.classList.add("grow");
    });
    document.addEventListener("mouseout", function (e) {
      var to = e.relatedTarget;
      if (!(to && to.closest && to.closest("a, button, .card, .plan, .stage, .chip"))) ring.classList.remove("grow");
    });
  }

  /* ==========================================================================
     9. SAMPLE REVIEW TABS
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
        document.querySelectorAll(".panel").forEach(function (p) {
          p.classList.toggle("on", p.dataset.panel === which);
        });
      });
    });
  }

  /* ==========================================================================
     10. PRICING
     The numbers live in pricing.js, the single source shared with the
     dashboard's billing page. This only drives the toggles.
     ====================================================================== */
  function startPricing() {
    if (!window.renderMarketingPricing) return;
    var state = { cycle: "monthly", source: "byok" };

    /* No spotlight re-bind here. The plans are re-rendered on every toggle but
       they are .plan, not .card, and only .card carries the pointer highlight.
       Calling startSpotlight() again would just attach a second, third, fourth
       mousemove listener to every capability card on the page. */
    function render() { window.renderMarketingPricing("pricingCards", state); }
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

  /* ---------------------------------------------------------------- boot -- */
  function boot() {
    startNav();
    startTabs();
    startPricing();
    startReveal();
    startRise();
    startCounters();
    startSpotlight();
    startCursor();
    startAurora();
    startField();

    /* Run every scroll handler once now. Without this, a page opened at a deep
       link (or restored by the browser at an old scroll position) keeps its
       hero state until the reader happens to scroll: the field would sit lit
       behind a section of body copy, and the nav would show no progress. */
    runScrollJobs();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
