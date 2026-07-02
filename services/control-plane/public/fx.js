// Cavix — lightweight, dependency-free motion (reactbits-inspired, adapted to vanilla).
// Effects: code-rain background, scroll reveal, cursor spotlight, count-up.
(function () {
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- code-rain background ----------
  const canvas = document.getElementById("codebg");
  if (canvas && !reduce) {
    const ctx = canvas.getContext("2d");
    const glyphs = "01{}[]()<>/=;+*$#_ƒλ→abcdef01!&|".split("");
    let cols = [], w = 0, h = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
      w = canvas.width = Math.floor(innerWidth * dpr);
      h = canvas.height = Math.floor(innerHeight * dpr);
      canvas.style.width = innerWidth + "px"; canvas.style.height = innerHeight + "px";
      const fontSize = 14 * dpr;
      ctx.font = `${fontSize}px "JetBrains Mono", monospace`;
      const n = Math.floor(w / (fontSize * 1.1));
      cols = Array.from({ length: n }, () => Math.random() * h);
    }
    resize();
    addEventListener("resize", resize);
    let last = 0;
    function draw(t) {
      if (t - last > 55) { // throttle ~18fps for a slow, calm rain
        last = t;
        ctx.fillStyle = "rgba(6,6,7,0.16)";
        ctx.fillRect(0, 0, w, h);
        const fontSize = 14 * dpr;
        for (let i = 0; i < cols.length; i++) {
          const x = i * fontSize * 1.1;
          const y = cols[i];
          const g = glyphs[(Math.random() * glyphs.length) | 0];
          ctx.fillStyle = Math.random() > 0.985 ? "rgba(210,210,220,0.55)" : "rgba(120,120,130,0.16)";
          ctx.fillText(g, x, y);
          cols[i] = y > h + Math.random() * 400 ? 0 : y + fontSize;
        }
      }
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
  }

  // ---------- scroll reveal ----------
  const reveals = document.querySelectorAll(".reveal");
  if (reveals.length) {
    if (reduce || !("IntersectionObserver" in window)) {
      reveals.forEach((el) => el.classList.add("in"));
    } else {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
      }, { threshold: 0.12 });
      reveals.forEach((el) => io.observe(el));
    }
  }

  // ---------- cursor spotlight on .spot cards ----------
  document.querySelectorAll(".spot").forEach((el) => {
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${e.clientX - r.left}px`);
      el.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
  });

  // ---------- count-up (data-count="86" data-suffix="%") ----------
  const counters = document.querySelectorAll("[data-count]");
  if (counters.length) {
    const run = (el) => {
      const target = parseFloat(el.dataset.count);
      const suffix = el.dataset.suffix || "";
      const dur = 1100; const start = performance.now();
      const step = (t) => {
        const p = Math.min(1, (t - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = (Number.isInteger(target) ? Math.round(target * eased) : (target * eased).toFixed(1)) + suffix;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    if (reduce || !("IntersectionObserver" in window)) counters.forEach(run);
    else {
      const io2 = new IntersectionObserver((entries) => {
        entries.forEach((e) => { if (e.isIntersecting) { run(e.target); io2.unobserve(e.target); } });
      }, { threshold: 0.5 });
      counters.forEach((el) => io2.observe(el));
    }
  }
})();
