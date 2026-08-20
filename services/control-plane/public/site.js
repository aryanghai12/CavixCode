/* ============================================================================
   CAVIX — marketing site behaviour.

   Replaces landing.js and fx.js. Classic script, no modules, no dependencies.

   THE CONTRACT EVERY EFFECT IN HERE HONOURS
   -----------------------------------------
   The page must be complete and fully legible with this file deleted. Nothing
   below creates content, and nothing below is allowed to leave text dimmer
   than its static state. Every reveal works by ADDING a dimming class first
   and then removing it — so if the script dies halfway, or never runs at all,
   the words are simply bright. The particle field draws to a canvas that sits
   at z-index -2 behind an opaque content layer, and it switches itself off on
   reduced-motion, on a hidden tab, and the moment the hero scrolls away.
   ========================================================================== */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var finePointer = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };

  /* ==========================================================================
     1. PARTICLE FIELD
     A dome: an annulus of fine particles with a dark elliptical void at its
     centre, dense at the rim and thinning outward, cut off toward the bottom
     so it reads as an arch rather than a ring. The void is the important part
     — it is what keeps the headline sitting on empty black.

     HOW IT IS DRAWN, AND WHY IT IS DONE THIS WAY
     The look needs on the order of twenty thousand points. Moving and filling
     that many per frame is not affordable, and a count low enough to animate
     per-point (~1500) does not read as a dome at all — it reads as dust.

     So the field is baked ONCE into an offscreen bitmap and the bitmap is what
     moves: one drawImage per frame, rotated a fraction of a degree and scaled
     into the ellipse. A few hundred live particles are drawn on top for the
     twinkle the bitmap cannot have. Two draw calls plus a small loop, at any
     density.

     Because the bitmap rotates, the arch cannot be baked into it (the dark
     half would rotate up into view), so the bottom is erased per frame with a
     destination-out gradient in screen space, which stays put.

     Everything else is a cost gate: the loop stops when the hero is off screen
     or the tab is hidden, DPR is capped at 1.75, and reduced-motion skips the
     whole thing.
     ====================================================================== */
  function startField() {
    var canvas = document.getElementById("field");
    if (!canvas || reduceMotion) return;

    var ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    var W = 0, H = 0, dpr = 1;
    var off = null, R = 0;            /* the baked field and its radius       */
    var live = [];                    /* the handful that twinkle on top      */
    var theta = 0;                    /* the field's slow rotation            */
    var pointerX = 0, pointerY = 0;   /* -1..1, drives the parallax           */
    var driftX = 0, driftY = 0;

    /* Geometry of the dome, in viewport terms. The centre sits low and the
       ellipse is wide, which puts the crown of the band near the top of the
       screen and leaves the void behind the headline. */
    function rxOf() { return W * 0.52; }
    function ryOf() { return H * 0.58; }
    function cyOf() { return H * 0.60; }
    var INNER = 0.44;                 /* where the void ends, 0..1 of the ring */

    function build() {
      dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      bake();

      /* The live layer is small by design: enough to catch the eye, few
         enough that the per-frame loop stays trivial. */
      var liveCount = Math.max(90, Math.min(Math.round((W * H) / 7000), 260));
      live = new Array(liveCount);
      for (var i = 0; i < liveCount; i++) live[i] = seedLive();
    }

    /* ---- the bake --------------------------------------------------------
       A circular annulus drawn once at 1x into an offscreen canvas. It is
       circular, not elliptical, because it gets rotated: the ellipse is
       applied as a scale at draw time, so the rotation stays true. */
    function bake() {
      R = Math.round(Math.max(rxOf(), ryOf()) * 1.06) || 600;
      var D = R * 2;

      off = document.createElement("canvas");
      off.width = D;
      off.height = D;
      var o = off.getContext("2d");
      if (!o) { off = null; return; }

      /* Density is per unit area of the ring, so a big screen gets a bigger
         ring at the same visual grain rather than a sparser one. */
      var area = Math.PI * R * R * (1 - INNER * INNER);
      var count = Math.max(6000, Math.min(Math.round(area / 26), 26000));

      for (var i = 0; i < count; i++) {
        var a = Math.random() * Math.PI * 2;
        /* pow > 1 crowds t near 0, which is what gives the void a defined rim
           rather than a soft smudge. The jitter afterwards takes the hard
           cut-out edge off it again — without it the void reads as a circle
           punched out of a texture. */
        var t = Math.pow(Math.random(), 1.65);
        var r = (INNER + t * (1 - INNER)) * R + (Math.random() - 0.5) * R * 0.05;

        var x = R + Math.cos(a) * r;
        var y = R + Math.sin(a) * r;

        /* Thin toward the outer edge so the field dissolves into black
           rather than stopping at a visible circle. */
        var alpha = (0.16 + Math.random() * 0.84) * (1 - Math.pow(t, 2.3));
        if (alpha < 0.02) continue;

        var s = t < 0.25 ? (0.6 + Math.random() * 1.5) : (0.5 + Math.random() * 1.0);
        o.fillStyle = (Math.random() < 0.26 ? "rgba(150,190,255," : "rgba(255,255,255,")
                    + alpha.toFixed(3) + ")";
        o.fillRect(x, y, s, s);
      }
    }

    function seedLive() {
      var t = Math.pow(Math.random(), 1.9);
      return {
        a: Math.random() * Math.PI * 2,
        t: t,
        s: 0.9 + Math.random() * 1.6,
        b: 0.5 + Math.random() * 0.5,
        p: Math.random() * Math.PI * 2,
        w: 0.0007 + Math.random() * 0.0018,
        c: Math.random() < 0.3
      };
    }

    function draw(now) {
      ctx.clearRect(0, 0, W, H);

      var cx = W * 0.5 + driftX;
      var cy = cyOf() + driftY;
      var rx = rxOf(), ry = ryOf();

      /* --- the baked field, rotated and squashed into the ellipse --------- */
      if (off) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(rx / R, ry / R);
        ctx.rotate(theta);
        ctx.drawImage(off, -R, -R);
        ctx.restore();
      }

      /* --- the live twinkle on top --------------------------------------- */
      for (var i = 0; i < live.length; i++) {
        var p = live[i];
        var r = INNER + p.t * (1 - INNER);
        var ang = p.a + theta;
        var x = cx + Math.cos(ang) * rx * r;
        var y = cy + Math.sin(ang) * ry * r;
        if (x < -8 || x > W + 8 || y < -8 || y > H + 8) continue;

        var alpha = p.b * (1 - Math.pow(p.t, 2.3)) * (0.55 + 0.45 * Math.sin(now * p.w + p.p));
        if (alpha < 0.03) continue;
        ctx.fillStyle = (p.c ? "rgba(170,205,255," : "rgba(255,255,255,") + alpha.toFixed(3) + ")";
        ctx.fillRect(x, y, p.s, p.s);
      }

      /* --- carve the ring back into an arch ------------------------------
         Done in screen space, after the rotation, so the dark half stays at
         the bottom of the viewport instead of turning with the field. */
      var g = ctx.createLinearGradient(0, H * 0.30, 0, H * 0.86);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(0.55, "rgba(0,0,0,.55)");
      g.addColorStop(1, "rgba(0,0,0,1)");
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";

      theta += 0.000045;
    }

    /* ---- the run gate ----------------------------------------------------
       Three independent reasons to stop, all of which must be clear before a
       frame is scheduled: the tab is visible, the hero is on screen, and the
       user has not asked for reduced motion (checked at startup). */
    var visible = !document.hidden;
    var onScreen = true;
    var running = false;

    function tick(now) {
      if (!visible || !onScreen) { running = false; return; }
      /* ease the parallax toward the pointer rather than snapping to it */
      driftX += (pointerX * 26 - driftX) * 0.045;
      driftY += (pointerY * 18 - driftY) * 0.045;
      draw(now || performance.now());
      raf(tick);
    }
    function kick() {
      if (running || !visible || !onScreen) return;
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

    /* The hero owns the field. Once the hero is gone the loop stops (painting
       it would be waste) AND the canvas fades out — without the fade its last
       painted frame would hang behind every section below, which is the exact
       opposite of keeping the content on clean ground.

       Driven by scroll position rather than by observing the hero, because the
       canvas is position:fixed and what actually matters is where the VIEWPORT
       is, not whether some element is technically on screen. One number, no
       observer to mis-fire. */
    function gate() {
      /* On a phone the hero is one tall stacked column, so copy scrolls up
         through the band almost immediately. There the field is treated as a
         first-impression only: the page moves, the field goes. On desktop the
         text sits beside the void and the field can stay for the full hero. */
      var narrow = window.innerWidth <= 860;
      var limit = narrow ? 40 : window.innerHeight * 0.85;
      var past = window.scrollY > limit;
      canvas.classList.toggle("field-off", past);
      onScreen = !past;
      if (onScreen) kick();
    }
    window.addEventListener("scroll", gate, { passive: true });
    gate();
  }

  /* ==========================================================================
     2. CUSTOM POINTER
     A dot, a ring that trails it, and a label plate over anything carrying
     data-cursor. Only ever built on a fine pointer, and it never intercepts
     input: all three nodes are pointer-events:none in CSS.
     ====================================================================== */
  function startCursor() {
    var dot = document.querySelector(".cursor");
    var ring = document.querySelector(".cursor-ring");
    var label = document.querySelector(".cursor-label");
    if (!dot || !ring || !label || !finePointer || reduceMotion) return;

    var mx = window.innerWidth / 2, my = window.innerHeight / 2;
    var rx = mx, ry = my;
    var live = false;

    window.addEventListener("mousemove", function (e) {
      mx = e.clientX; my = e.clientY;
      if (!live) {
        live = true;
        rx = mx; ry = my;
        document.body.classList.add("cursor-on");
      }
    }, { passive: true });

    /* Leaving the window hides the whole rig, so it never sits frozen in a
       corner of a screenshot. */
    document.addEventListener("mouseleave", function () { document.body.classList.remove("cursor-on"); });
    document.addEventListener("mouseenter", function () { if (live) document.body.classList.add("cursor-on"); });

    function follow() {
      /* The dot is exact; the ring lags, which is the whole effect. */
      dot.style.transform = "translate3d(" + mx + "px," + my + "px,0)";
      rx += (mx - rx) * 0.16;
      ry += (my - ry) * 0.16;
      ring.style.transform = "translate3d(" + rx + "px," + ry + "px,0)";
      label.style.transform = "translate3d(" + (mx + 22) + "px," + (my - 10) + "px,0)" +
                              (label.classList.contains("on") ? " scale(1)" : " scale(.7)");
      raf(follow);
    }
    raf(follow);

    /* Delegated, so cards rendered later (the pricing plans) are covered too. */
    document.addEventListener("mouseover", function (e) {
      var host = e.target.closest ? e.target.closest("[data-cursor]") : null;
      if (host) {
        label.textContent = host.getAttribute("data-cursor");
        label.classList.add("on");
        ring.classList.add("grow");
        return;
      }
      var hit = e.target.closest ? e.target.closest("a, button, .card, .plan, .stage, .wall span") : null;
      if (hit) ring.classList.add("grow");
    });

    document.addEventListener("mouseout", function (e) {
      var to = e.relatedTarget;
      var stillOn = to && to.closest && to.closest("[data-cursor]");
      if (!stillOn) label.classList.remove("on");
      var stillHit = to && to.closest && to.closest("a, button, .card, .plan, .stage, .wall span, [data-cursor]");
      if (!stillHit) ring.classList.remove("grow");
    });
  }

  /* ==========================================================================
     3. HEADLINE REVEAL
     Words land one after another. The dimming class goes on FIRST and comes
     off word by word, so the failure mode is a fully bright headline, and a
     hard failsafe lights everything after 2.6s no matter what.
     ====================================================================== */
  function startReveal() {
    var host = document.querySelector("[data-reveal]");
    if (!host) return;
    var words = host.querySelectorAll(".w");
    if (!words.length) return;

    if (reduceMotion) return;          /* CSS already keeps them bright */

    host.classList.add("reveal-on");

    var i = 0;
    function light() {
      if (i >= words.length) return;
      words[i].classList.add("lit");
      i++;
      setTimeout(light, 55);
    }
    /* One frame of the soft state before lighting, or the transition has
       nothing to animate from. */
    raf(function () { raf(function () { setTimeout(light, 90); }); });

    /* Failsafe. Short on purpose: whatever happens — a stalled timer, a
       backgrounded tab, a slow first paint — the headline is fully bright
       about a second in, and stays that way. */
    setTimeout(function () {
      for (var k = 0; k < words.length; k++) words[k].classList.add("lit");
    }, 1100);
  }

  /* ==========================================================================
     4. SECTION RISE
     Purely additive: `.in` starts a short entrance animation on an element
     that was already visible. Nothing here can hide anything, so a browser
     without IntersectionObserver, a script error, or an observer that simply
     never fires all degrade to "the section is just there" rather than to a
     blank page.

     The bottom rootMargin is POSITIVE, so the observer fires ~90px before the
     element actually reaches the viewport. That way the animation starts from
     opacity 0 while the element is still off screen, and no one ever catches
     the frame where it was visible at full opacity first.
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

    items.forEach(function (el) { io.observe(el); });
  }

  /* ==========================================================================
     5. NAV
     ====================================================================== */
  function startNav() {
    var nav = document.getElementById("nav");
    if (!nav) return;
    function onScroll() { nav.classList.toggle("stuck", window.scrollY > 24); }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ==========================================================================
     6. SAMPLE-REVIEW TABS
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
     7. PRICING
     The numbers live in pricing.js, which is the single source shared with the
     dashboard's billing page. This only drives the toggles.
     ====================================================================== */
  function startPricing() {
    if (!window.renderMarketingPricing) return;
    var state = { cycle: "monthly", source: "byok" };

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
    startCursor();
    startField();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
