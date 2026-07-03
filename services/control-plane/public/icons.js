// Cavix — one consistent line-icon set (replaces mismatched emoji everywhere).
(function () {
  const P = {
    overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    reviews: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-3.2-3.2"/><path d="M8.2 11l2 2 3.4-3.6"/>',
    repos: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2z"/><path d="M8 3v8l2.5-1.6L13 11V3"/>',
    reports: '<path d="M4 20V11"/><path d="M10 20V4"/><path d="M16 20v-6"/><path d="M2 20h20"/>',
    learnings: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.8 10.6c.6.5 1 1.2 1 2.4h5.6c0-1.2.4-1.9 1-2.4A6 6 0 0 0 12 3z"/>',
    feed: '<circle cx="12" cy="9" r="5.5"/><path d="M8.5 13.5L7 21l5-3 5 3-1.5-7.5"/>',
    byok: '<circle cx="7.5" cy="15.5" r="3.5"/><path d="M10 13l8.5-8.5"/><path d="M16 7l2 2"/><path d="M19 4l2 2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l1.7-1.3-2-3.4-2 .8a7.6 7.6 0 0 0-1.7-1l-.3-2.1h-4l-.3 2.1a7.6 7.6 0 0 0-1.7 1l-2-.8-2 3.4L4.6 11a7.6 7.6 0 0 0 0 2l-1.7 1.3 2 3.4 2-.8c.5.4 1.1.7 1.7 1l.3 2.1h4l.3-2.1c.6-.3 1.2-.6 1.7-1l2 .8 2-3.4z"/>',
    integrations: '<path d="M9 2v5"/><path d="M15 2v5"/><path d="M7 7h10v3a5 5 0 0 1-10 0z"/><path d="M12 15v7"/>',
    team: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6"/><path d="M17.5 14.4A5.5 5.5 0 0 1 20.5 19"/>',
    billing: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 9.5h19"/><path d="M6 15h4"/>',
    admin: '<path d="M12 3l8 3v6c0 4.6-3.3 7.9-8 9-4.7-1.1-8-4.4-8-9V6z"/><path d="M8.8 12l2.2 2.2L15.4 10"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    bolt: '<path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.6"/>',
    key: '<circle cx="7.5" cy="15.5" r="3.5"/><path d="M10 13l8.5-8.5"/><path d="M16 7l2 2"/>',
    shield: '<path d="M12 3l8 3v6c0 4.6-3.3 7.9-8 9-4.7-1.1-8-4.4-8-9V6z"/>',
    wrench: '<path d="M15.5 7a4 4 0 0 1-5.2 5.2L5 17.6 6.4 19l5.4-5.3A4 4 0 0 0 17 8.5z"/>',
    chat: '<path d="M4 5h16v10H9l-5 4z"/>',
    lock: '<rect x="4.5" y="10" width="15" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    diagram: '<rect x="3" y="4" width="6" height="5" rx="1"/><rect x="15" y="15" width="6" height="5" rx="1"/><path d="M6 9v5a3 3 0 0 0 3 3h6"/>',
    tag: '<path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8" cy="8" r="1.4"/>',
    link: '<path d="M9 15l6-6"/><path d="M11 6l1-1a4 4 0 0 1 6 6l-1 1"/><path d="M13 18l-1 1a4 4 0 0 1-6-6l1-1"/>',
    doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>',
    arrow: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  };
  window.CAVIX_ICONS = P;
  window.icon = function (name, cls) {
    const inner = P[name] || P.check;
    return '<svg class="ic' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" aria-hidden="true">' + inner + "</svg>";
  };
})();
