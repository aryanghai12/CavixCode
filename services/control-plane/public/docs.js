// Docs sidebar: highlight the section you're currently reading.
//
// The stylesheet has always defined `.docs-nav a.active`, but nothing set the
// class, so the sidebar gave no feedback about where you were on the page.
(function () {
  const links = [...document.querySelectorAll(".docs-nav a[href^='#']")];
  if (!links.length) return;

  const byId = new Map();
  for (const a of links) {
    const el = document.getElementById(decodeURIComponent(a.hash.slice(1)));
    if (el) byId.set(el, a);
  }
  if (!byId.size) return;

  const setActive = (a) => {
    for (const l of links) l.classList.toggle("active", l === a);
  };

  // Track which headings are above the fold line (just under the sticky nav).
  // The active section is the last one whose heading has passed that line.
  const LINE = 96;
  const headings = [...byId.keys()];
  const update = () => {
    let current = headings[0];
    for (const h of headings) {
      if (h.getBoundingClientRect().top <= LINE) current = h;
    }
    // At the very bottom the last section may never cross the line, so pin it.
    const atEnd = innerHeight + scrollY >= document.body.scrollHeight - 2;
    setActive(byId.get(atEnd ? headings[headings.length - 1] : current));
  };

  addEventListener("scroll", update, { passive: true });
  addEventListener("resize", update);
  update();

  // Clicking a link should win immediately, without waiting for smooth scroll.
  for (const a of links) a.addEventListener("click", () => setActive(a));
})();
