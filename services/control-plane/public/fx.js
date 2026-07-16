// Cavix page effects.
//
// This file used to run a canvas "code rain" background, scroll-triggered
// reveals, a cursor-tracking spotlight on cards, and count-up stat numbers.
// All of it was removed: the numbers are static facts (they don't need to
// animate to be read), and the rest was decoration that made the site look
// generated rather than built. The stylesheet no longer defines those effects,
// so the matching classes are inert.
//
// Kept as a no-op: the pages still load /fx.js, and a 404 on every page view is
// worse than an empty file. Loaded as a classic script, so no module syntax.
