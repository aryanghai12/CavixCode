// Charts for the Cavix dashboard. Inline SVG, no library, no CDN.
//
// Two reasons it is hand-rolled rather than a charting package. The dashboard is
// served with a strict CSP and ships as static files with no build step, so a CDN
// script is not an option; and the whole of what is needed here is four forms.
//
// ── the palette, and why it is this small ────────────────────────────────────
//
// Series colours were validated against the dark card surface (#101A2E) rather
// than chosen by eye. Blue and green clear every gate: CVD separation ΔE 19.6,
// normal-vision ΔE 20.9, both inside the dark lightness band, both over 3:1 on
// the surface.
//
// There is deliberately NO five-colour severity palette. Severity runs critical,
// high, medium, low, info, which forces red, orange and yellow to sit next to
// each other, and that trio cannot clear the normal-vision floor at any stepping
// (worst adjacent pair ΔE ~13 against a floor of 15). Rather than ship colours
// that a third of readers cannot separate, severity is rendered as a labelled
// meter list: name, geometric mark and count carry the identity, and length
// carries the magnitude. That is the honest form for an ordered scale anyway.
window.CavixCharts = (() => {
  const SERIES_1 = "#3987e5"; // reviews, and the sequential ramp's full step
  const SERIES_2 = "#199e70"; // verified findings
  const INK_FAINT = "#94A7C6";
  const GRID = "#182642";

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  /** A day key (YYYY-MM-DD) as "4 Mar". */
  function dayLabel(iso) {
    const d = new Date(`${iso}T00:00:00Z`);
    return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`;
  }

  /**
   * Two series over time, as lines with a soft fill under the first.
   *
   * Hover is part of the chart, not a nice-to-have: a 30-point series cannot
   * carry a label per point, so the crosshair is how a reader gets the number
   * for a given day. Values sit in text colours; the coloured dot beside a label
   * carries identity, so nothing is encoded by colour alone.
   */
  function trend(points, opts = {}) {
    const w = 720;
    const h = 200;
    const padL = 34;
    const padR = 12;
    const padT = 12;
    const padB = 24;
    if (!points.length) return empty("No activity in this window yet.");

    const series = opts.series ?? [
      { key: "reviews", label: "Reviews", color: SERIES_1, fill: true },
      { key: "verified", label: "Verified findings", color: SERIES_2 },
    ];
    const max = Math.max(1, ...points.flatMap((p) => series.map((s) => p[s.key] ?? 0)));
    const x = (i) => padL + (i * (w - padL - padR)) / Math.max(1, points.length - 1);
    const y = (v) => padT + (h - padT - padB) * (1 - v / max);

    // Four gridlines, recessive. They exist to let someone read a value off the
    // chart, so they sit behind the marks and never compete with them.
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
    const grid = [...new Set(ticks)]
      .map(
        (v) =>
          `<line x1="${padL}" y1="${y(v)}" x2="${w - padR}" y2="${y(v)}" stroke="${GRID}" stroke-width="1"/>` +
          `<text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end" fill="${INK_FAINT}" font-size="10">${v}</text>`,
      )
      .join("");

    const paths = series
      .map((s) => {
        const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[s.key] ?? 0).toFixed(1)}`).join(" ");
        const area = s.fill
          ? `<path d="${d} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z" fill="${s.color}" opacity=".14"/>`
          : "";
        return `${area}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      })
      .join("");

    // One transparent hit column per point, wider than the mark, so hovering
    // anywhere in the day's band works rather than requiring pixel accuracy.
    const band = (w - padL - padR) / Math.max(1, points.length);
    const hits = points
      .map((p, i) => {
        const title = series.map((s) => `${s.label}: ${p[s.key] ?? 0}`).join("\n");
        return (
          `<g class="ch-hit"><rect x="${(x(i) - band / 2).toFixed(1)}" y="${padT}" width="${band.toFixed(1)}" height="${h - padT - padB}" fill="transparent"/>` +
          `<line x1="${x(i).toFixed(1)}" y1="${padT}" x2="${x(i).toFixed(1)}" y2="${h - padB}" stroke="${INK_FAINT}" stroke-width="1" opacity="0" class="ch-cross"/>` +
          series
            .map((s) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p[s.key] ?? 0).toFixed(1)}" r="4" fill="${s.color}" stroke="#101A2E" stroke-width="2" opacity="0" class="ch-dot"/>`)
            .join("") +
          `<title>${esc(dayLabel(p.date))}\n${esc(title)}</title></g>`
        );
      })
      .join("");

    const first = dayLabel(points[0].date);
    const last = dayLabel(points[points.length - 1].date);
    const legend = series
      .map((s) => `<span class="ch-key"><i style="background:${s.color}"></i>${esc(s.label)}</span>`)
      .join("");

    return `<div class="ch">
      <div class="ch-legend">${legend}</div>
      <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(series.map((s) => s.label).join(" and "))} per day" preserveAspectRatio="none">
        ${grid}${paths}${hits}
      </svg>
      <div class="ch-axis"><span>${esc(first)}</span><span>${esc(last)}</span></div>
    </div>`;
  }

  /**
   * An ordered breakdown as labelled meters. This is the severity chart.
   *
   * Every row states its own name and count, so the bar is reinforcement rather
   * than the only encoding. `mark` is the same geometric symbol the posted
   * review uses, which keeps the dashboard and the pull request speaking one
   * visual language.
   */
  function meters(rows) {
    const max = Math.max(1, ...rows.map((r) => r.value));
    if (!rows.some((r) => r.value > 0)) return empty("Nothing raised yet.");
    return `<div class="ch-meters">${rows
      .map(
        (r) => `<div class="ch-meter">
          <span class="ch-mlabel"><b style="color:${r.color ?? INK_FAINT}">${esc(r.mark ?? "")}</b> ${esc(r.label)}</span>
          <span class="ch-track"><i style="width:${Math.round((r.value / max) * 100)}%;background:${r.color ?? SERIES_1}"></i></span>
          <b class="ch-mval">${r.value}</b>
        </div>`,
      )
      .join("")}</div>`;
  }

  /**
   * Horizontal bars, one hue, longest first. Magnitude across named things is a
   * sequential job, so there is one colour and rank is carried by order and
   * length: colouring each repository differently would imply an identity that
   * a filter could then repaint.
   */
  function ranked(rows, opts = {}) {
    if (!rows.length) return empty(opts.emptyText ?? "Nothing to rank yet.");
    const max = Math.max(1, ...rows.map((r) => r.value));
    return `<div class="ch-meters">${rows
      .slice(0, opts.limit ?? 8)
      .map(
        (r) => `<div class="ch-meter ch-wide">
          <span class="ch-mlabel" title="${esc(r.label)}">${esc(r.label)}</span>
          <span class="ch-track"><i style="width:${Math.round((r.value / max) * 100)}%;background:${SERIES_1}"></i></span>
          <b class="ch-mval">${esc(r.display ?? r.value)}</b>
        </div>`,
      )
      .join("")}</div>`;
  }

  /**
   * A stat tile with an optional signed delta.
   *
   * `goodDown` is for the numbers where a fall is the good news (cost, false
   * positives). Colour never travels alone here: the arrow and the sign say the
   * same thing.
   */
  function tile(label, value, opts = {}) {
    const d = opts.delta;
    const has = typeof d === "number" && d !== 0;
    const better = has && (opts.goodDown ? d < 0 : d > 0);
    const arrow = has ? (d > 0 ? "▲" : "▼") : "";
    const colour = has ? (better ? SERIES_2 : "#F0857E") : INK_FAINT;
    return `<div class="stat">
      <div class="label">${esc(label)}</div>
      <div class="value">${esc(value)}</div>
      <div class="delta" style="color:${colour}">${has ? `${arrow} ${d > 0 ? "+" : ""}${d}${opts.unit ?? ""} ` : ""}${esc(opts.note ?? "")}</div>
    </div>`;
  }

  function empty(text) {
    return `<div class="ch-empty">${esc(text)}</div>`;
  }

  return { trend, meters, ranked, tile, dayLabel };
})();
