/* ============================================================================
   CAVIX MOTION, the shared animation engine.

   Loaded by every page, marketing and dashboard alike, so the whole site moves
   the same way. Page specific behaviour (nav, tabs, pricing, the dashboard
   router) lives elsewhere; this file only ever animates what is already there.

   THE CONTRACT
   The page must be complete and fully legible with this file deleted. Nothing
   here creates content, and nothing here is allowed to leave text dimmer than
   its static state. Reveals work by ADDING a class that plays an animation on
   an already visible element, never by hiding something and hoping an observer
   switches it back on.

   REDUCED MOTION
   Honoured, but not as an off switch. Travel is dropped (particles, parallax,
   3D tilt, the drifting field) while fades and staggers survive as opacity
   only, because a page with every transition stripped reads as broken rather
   than as calm. The CSS half of that decision is at the foot of theme.css.
   ========================================================================== */
(function () {
  "use strict";

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var fine   = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
  var hasIO = "IntersectionObserver" in window;

  /* Expose the flags so page scripts can make the same decisions. */
  window.CavixMotion = { reduce: reduce, fine: fine };

  /* ---- one scroll pump feeds everything that cares about scroll position -- */
  var jobs = [];
  function onScroll(fn) { jobs.push(fn); }
  function runJobs() { for (var i = 0; i < jobs.length; i++) jobs[i](); }
  (function () {
    var queued = false;
    function run() { queued = false; runJobs(); }
    function queue() { if (queued) return; queued = true; raf(run); }
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", queue, { passive: true });
  })();

  /* ==========================================================================
     1. SPLIT TEXT
     Headings arrive word by word. The split walks text nodes so inline markup
     survives, and any element flagged grad-text or no-split is kept whole,
     because a gradient clipped to text cannot be cut into separate boxes
     without the gradient restarting inside each one.

     Each word carries its index as --i, and the CSS derives the delay from
     that, so a heading of any length staggers correctly with no per element
     timing in JS.
     ====================================================================== */
  function splitText(host) {
    if (host.dataset.splitDone) return 0;
    var index = 0;

    function walk(node) {
      var kids = [].slice.call(node.childNodes);
      kids.forEach(function (child) {
        if (child.nodeType === 3) {                     /* text */
          var text = child.nodeValue;
          if (!text.trim()) return;
          var frag = document.createDocumentFragment();
          /* Split on spaces but KEEP them, so the gaps between words are part
             of a word box and the line never loses its spacing. */
          text.split(/(\s+)/).forEach(function (piece) {
            if (!piece) return;
            if (!piece.trim()) { frag.appendChild(document.createTextNode(piece)); return; }
            var span = document.createElement("span");
            span.className = "wd";
            span.style.setProperty("--i", index++);
            span.textContent = piece;
            frag.appendChild(span);
          });
          node.replaceChild(frag, child);
        } else if (child.nodeType === 1) {              /* element */
          if (child.classList.contains("grad-text") || child.classList.contains("no-split")) {
            child.classList.add("wd");
            child.style.setProperty("--i", index++);
            return;
          }
          if (child.tagName === "BR") return;
          walk(child);
        }
      });
    }

    walk(host);
    host.dataset.splitDone = "1";
    return index;
  }

  /* ONE observer for every heading, held in a module level variable.

     The first version built a fresh IntersectionObserver per heading inside the
     loop, each referenced only by its own callback closure. Nothing outside
     that cycle held onto them, and they were collected before they ever
     delivered a single entry, so not one heading animated. Observers need to be
     rooted somewhere that outlives the function that created them. */
  var splitIO = hasIO ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      splitIO.unobserve(e.target);
      playSplit(e.target);
    });
  }, { rootMargin: "0px 0px -40px 0px", threshold: 0 }) : null;

  function playSplit(host) {
    /* Two classes, one flush apart. `split-on` sets the pre-arrival state and
       `go` starts the animation; the browser has to see the first state before
       the second, or there is nothing to animate from.

       That separation is done with a synchronous style read, NOT with nested
       requestAnimationFrame. rAF only runs when the browser is actually
       producing frames, so anything gated on it silently never happens in a
       background tab or any other frameless context: the heading would be left
       holding its pre-arrival state until the failsafe stripped it. Reading
       offsetWidth forces the style flush right here, on this line, always. */
    host.classList.add("split-on");
    void host.offsetWidth;
    host.classList.add("go");

    /* Failsafe. Belt and braces now that the above cannot stall, but if `go`
       is ever missing the pre-arrival class comes back off and the heading is
       plain, bright text. */
    setTimeout(function () {
      if (!host.classList.contains("go")) host.classList.remove("split-on");
    }, 3000);
  }

  function startSplit(root) {
    if (!splitIO) return;                  /* no observer, leave headings plain */
    (root || document).querySelectorAll("[data-split], .display").forEach(function (host) {
      if (host.dataset.splitBound) return;
      if (host.closest && host.closest("[data-no-split]")) return;
      if (!splitText(host)) return;
      host.dataset.splitBound = "1";
      splitIO.observe(host);
    });
  }

  /* ==========================================================================
     2. RISE
     Purely additive. The positive bottom rootMargin fires the observer about
     100px before the element reaches the viewport, so the animation starts
     from zero opacity while it is still off screen and nobody catches the
     frame where it was already visible.
     ====================================================================== */
  var riseIO = hasIO ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      riseIO.unobserve(e.target);
    });
  }, { rootMargin: "0px 0px 100px 0px", threshold: 0 }) : null;

  function startRise(root) {
    if (!riseIO) return;
    (root || document).querySelectorAll(".rise").forEach(function (el) {
      if (el.classList.contains("in") || el.dataset.riseBound) return;
      el.dataset.riseBound = "1";
      riseIO.observe(el);
    });
  }

  /* ==========================================================================
     3. TERMINAL PRINT
     Output scrolls into view the way a real one does. Implemented as a clip
     rather than by retyping the markup, so the syntax colouring inside the
     block survives untouched.
     ====================================================================== */
  var termIO = (hasIO && !reduce) ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      termIO.unobserve(e.target);
      e.target.classList.add("print");
    });
  }, { threshold: 0.25 }) : null;

  function startTerminals(root) {
    if (!termIO) return;
    (root || document).querySelectorAll(".terminal").forEach(function (t) {
      if (t.dataset.printBound) return;
      t.dataset.printBound = "1";
      termIO.observe(t);
    });
  }

  /* ==========================================================================
     4. COUNTERS
     The final value is already in the markup, so this only ever replaces a
     correct number with the same correct number at the end of a short ramp.
     ====================================================================== */
  var countIO = hasIO ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      countIO.unobserve(e.target);
      ramp(e.target);
    });
  }, { threshold: 0.4 }) : null;

  function startCounters(root) {
    if (!countIO) return;
    (root || document).querySelectorAll("[data-count]").forEach(function (el) {
      if (el.dataset.countBound) return;
      el.dataset.countBound = "1";
      countIO.observe(el);
    });
  }

  function ramp(el) {
    var target = parseFloat(el.getAttribute("data-count"));
    if (!isFinite(target)) return;
    if (reduce) { el.textContent = String(target); return; }
    var start = performance.now(), dur = 1000;
    (function step(now) {
      var t = Math.min(1, (now - start) / dur);
      el.textContent = String(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf(step); else el.textContent = String(target);
    })(start);
  }

  /* ==========================================================================
     5. TILT AND SPOTLIGHT
     A panel leans toward the pointer and a soft light follows it across the
     surface. Both are written as CSS variables, so with no script they stay at
     their resting values: zero degrees, and a highlight at zero opacity.
     ====================================================================== */
  function startTilt(root) {
    if (!fine || reduce) return;
    var scope = root || document;
    var cards = scope.querySelectorAll(".tilt, .card, .plan, .panel");

    cards.forEach(function (el) {
      if (el.dataset.tiltBound) return;
      el.dataset.tiltBound = "1";

      el.addEventListener("mousemove", function (e) {
        var r = el.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width;
        var py = (e.clientY - r.top) / r.height;
        el.style.setProperty("--mx", (e.clientX - r.left) + "px");
        el.style.setProperty("--my", (e.clientY - r.top) + "px");
        if (el.classList.contains("tilt")) {
          el.classList.add("tracking");
          el.style.setProperty("--ry", ((px - 0.5) * 9).toFixed(2) + "deg");
          el.style.setProperty("--rx", ((0.5 - py) * 9).toFixed(2) + "deg");
        }
      }, { passive: true });

      el.addEventListener("mouseleave", function () {
        el.classList.remove("tracking");
        el.style.setProperty("--rx", "0deg");
        el.style.setProperty("--ry", "0deg");
      });
    });
  }
  window.CavixMotion.bindTilt = startTilt;   /* for views rendered later */

  /* ==========================================================================
     6. PARALLAX
     Elements drift at a fraction of the scroll rate. Small numbers on purpose:
     the point is depth, not a fairground ride, and anything above about 0.1
     starts to detach the element from the text it belongs to.
     ====================================================================== */
  function startParallax() {
    if (reduce) return;
    var nodes = [].slice.call(document.querySelectorAll("[data-parallax]"));
    if (!nodes.length) return;

    onScroll(function () {
      var y = window.scrollY;
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var rate = parseFloat(el.getAttribute("data-parallax")) || 0.05;
        el.style.transform = "translate3d(0," + (-y * rate).toFixed(1) + "px,0)";
      }
    });
  }

  /* ==========================================================================
     7. AURORA
     Full strength behind the hero, dialled back below it so no paragraph is
     ever read over a bright colour mass.
     ====================================================================== */
  function startAurora() {
    var aurora = document.getElementById("aurora");
    if (!aurora) return;
    onScroll(function () {
      aurora.classList.toggle("calm", window.scrollY > window.innerHeight * 0.6);
    });
  }

  /* ==========================================================================
     8. CUSTOM POINTER
     ====================================================================== */
  function startCursor() {
    var dot = document.querySelector(".cursor");
    var ring = document.querySelector(".cursor-ring");
    if (!dot || !ring || !fine || reduce) return;

    var mx = window.innerWidth / 2, my = window.innerHeight / 2;
    var rx = mx, ry = my, awake = false;

    window.addEventListener("mousemove", function (e) {
      mx = e.clientX; my = e.clientY;
      if (!awake) { awake = true; rx = mx; ry = my; document.body.classList.add("cursor-on"); }
    }, { passive: true });

    document.addEventListener("mouseleave", function () { document.body.classList.remove("cursor-on"); });
    document.addEventListener("mouseenter", function () { if (awake) document.body.classList.add("cursor-on"); });

    (function follow() {
      dot.style.transform = "translate3d(" + mx + "px," + my + "px,0)";
      rx += (mx - rx) * 0.17;
      ry += (my - ry) * 0.17;
      ring.style.transform = "translate3d(" + rx + "px," + ry + "px,0)";
      raf(follow);
    })();

    var HOT = "a, button, .card, .plan, .stage, .chip, .nav-item, .repo-row, input, select, .switch";
    document.addEventListener("mouseover", function (e) {
      if (e.target.closest && e.target.closest(HOT)) ring.classList.add("grow");
    });
    document.addEventListener("mouseout", function (e) {
      var to = e.relatedTarget;
      if (!(to && to.closest && to.closest(HOT))) ring.classList.remove("grow");
    });
  }

  /* ==========================================================================
     9. PARTICLE FIELD
     A dome: an annulus of fine particles with a soft void at its centre, which
     is what lets the aurora glow through behind the headline.

     The look needs on the order of twenty thousand points, far too many to
     move and fill individually every frame. So the field is baked ONCE into an
     offscreen bitmap and the bitmap is what moves: one drawImage per frame,
     rotated a fraction of a degree and squashed into the ellipse, with a few
     hundred live particles on top for the twinkle a bitmap cannot have.

     Because the bitmap rotates, the arch cannot be baked into it (the dark
     half would swing up into view), so the bottom is erased each frame with a
     destination-out gradient in screen space, which stays put.
     ====================================================================== */
  function startField() {
    var canvas = document.getElementById("field");
    if (!canvas || reduce) return;
    var ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    var W = 0, H = 0, dpr = 1, off = null, R = 0, live = [], theta = 0;
    var px = 0, py = 0, dx = 0, dy = 0;
    var INNER = 0.46;

    function rxOf() { return W * 0.54; }
    function ryOf() { return H * 0.58; }
    function cyOf() { return H * 0.58; }

    function build() {
      dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bake();
      var n = Math.max(70, Math.min(Math.round((W * H) / 9000), 200));
      live = new Array(n);
      for (var i = 0; i < n; i++) live[i] = seed();
    }

    function bake() {
      R = Math.round(Math.max(rxOf(), ryOf()) * 1.06) || 600;
      off = document.createElement("canvas");
      off.width = off.height = R * 2;
      var o = off.getContext("2d");
      if (!o) { off = null; return; }

      var area = Math.PI * R * R * (1 - INNER * INNER);
      var count = Math.max(5000, Math.min(Math.round(area / 34), 20000));

      for (var i = 0; i < count; i++) {
        var a = Math.random() * Math.PI * 2;
        /* pow > 1 crowds t near zero, giving the void a defined rim; the
           jitter afterwards takes the hard cut-out edge back off it. */
        var t = Math.pow(Math.random(), 1.7);
        var r = (INNER + t * (1 - INNER)) * R + (Math.random() - 0.5) * R * 0.05;
        var alpha = (0.14 + Math.random() * 0.72) * (1 - Math.pow(t, 2.2));
        if (alpha < 0.02) continue;
        var s = t < 0.25 ? (0.6 + Math.random() * 1.4) : (0.5 + Math.random() * 0.9);
        var roll = Math.random();
        var rgb = roll < 0.24 ? "168,176,188" : roll < 0.46 ? "214,220,228" : roll < 0.66 ? "176,183,194" : "255,255,255";
        o.fillStyle = "rgba(" + rgb + "," + alpha.toFixed(3) + ")";
        o.fillRect(R + Math.cos(a) * r, R + Math.sin(a) * r, s, s);
      }
    }

    function seed() {
      return {
        a: Math.random() * Math.PI * 2, t: Math.pow(Math.random(), 1.7),
        s: 1 + Math.random() * 1.6, b: 0.5 + Math.random() * 0.5,
        p: Math.random() * Math.PI * 2, w: 0.0008 + Math.random() * 0.0018,
        c: Math.random() < 0.45
      };
    }

    function draw(now) {
      ctx.clearRect(0, 0, W, H);
      var cx = W * 0.5 + dx, cy = cyOf() + dy, rx = rxOf(), ry = ryOf();

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
        var r = INNER + p.t * (1 - INNER), ang = p.a + theta;
        var x = cx + Math.cos(ang) * rx * r, y = cy + Math.sin(ang) * ry * r;
        if (x < -8 || x > W + 8 || y < -8 || y > H + 8) continue;
        var alpha = p.b * (1 - Math.pow(p.t, 2.2)) * (0.5 + 0.5 * Math.sin(now * p.w + p.p));
        if (alpha < 0.03) continue;
        ctx.fillStyle = (p.c ? "rgba(150,235,255," : "rgba(255,255,255,") + alpha.toFixed(3) + ")";
        ctx.fillRect(x, y, p.s, p.s);
      }

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

    var visible = !document.hidden, active = true, running = false;
    function tick(now) {
      if (!visible || !active) { running = false; return; }
      dx += (px * 30 - dx) * 0.045;
      dy += (py * 20 - dy) * 0.045;
      draw(now || performance.now());
      raf(tick);
    }
    function kick() { if (running || !visible || !active) return; running = true; raf(tick); }

    build(); kick();

    var t;
    window.addEventListener("resize", function () {
      clearTimeout(t); t = setTimeout(function () { build(); kick(); }, 180);
    }, { passive: true });
    document.addEventListener("visibilitychange", function () { visible = !document.hidden; kick(); });

    if (fine) {
      window.addEventListener("mousemove", function (e) {
        px = (e.clientX / window.innerWidth) * 2 - 1;
        py = (e.clientY / window.innerHeight) * 2 - 1;
      }, { passive: true });
    }

    /* The field belongs to the hero. Once the viewport has moved past it the
       loop stops and the canvas fades, so the sections below get clean ground
       rather than a stale frame hanging behind them. Scroll position drives
       this rather than an observer, because the canvas is fixed and what
       matters is where the viewport is. On a phone the hero stacks and copy
       passes through the band almost at once, so there it is a first
       impression only. */
    onScroll(function () {
      var limit = window.innerWidth <= 860 ? 40 : window.innerHeight * 0.8;
      var past = window.scrollY > limit;
      canvas.classList.toggle("field-off", past);
      active = !past;
      if (active) kick();
    });
  }

  /* ==========================================================================
     10. DYNAMIC VIEWS
     The dashboard is a single page app: app.js replaces the whole of #content
     on every navigation, so anything bound at boot is gone the moment the
     reader clicks a nav item. Rather than have app.js call back into this file
     (and have to remember to, in every one of its views), the subtree is
     watched and new nodes are bound as they arrive.

     Every bind function marks what it has already seen with a data attribute,
     so re-running them cannot stack duplicate observers or listeners onto
     anything that survived the re-render.
     ====================================================================== */
  function startDynamic() {
    var host = document.getElementById("content");
    if (!host || !window.MutationObserver) return;

    /* The dashboard's markup is generated by app.js and carries no animation
       hooks of its own, so the top level blocks of a freshly rendered view get
       .rise added here. Adding the class is safe in a way that removing one
       never is: .rise on its own has no styles, so the worst case is a panel
       that simply does not animate. */
    function tagArrivals() {
      host.querySelectorAll(".panel, .stat, .connect-hero, .admin-tiles").forEach(function (el) {
        if (!el.classList.contains("rise") && !el.dataset.riseBound) el.classList.add("rise");
      });
    }

    var pending = null;
    new MutationObserver(function () {
      clearTimeout(pending);
      pending = setTimeout(function () {
        tagArrivals();
        startRise(host);
        startTerminals(host);
        startCounters(host);
        startTilt(host);
      }, 60);
    }).observe(host, { childList: true, subtree: true });
  }

  /* ---------------------------------------------------------------- boot -- */
  function boot() {
    startSplit();
    startRise();
    startTerminals();
    startCounters();
    startTilt();
    startParallax();
    startAurora();
    startCursor();
    startField();
    startDynamic();

    /* Run every scroll handler once now. Without this a page opened at a deep
       link, or restored by the browser at an old scroll position, keeps its
       hero state until the reader happens to scroll. */
    runJobs();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
