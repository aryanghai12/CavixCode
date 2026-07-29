import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry, createMetrics, makeRecorder, timed } from "@cavix/metrics";

/** Parse the exposition text into name{labels} -> value, for readable asserts. */
function parse(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const i = line.lastIndexOf(" ");
    out[line.slice(0, i)] = Number(line.slice(i + 1));
  }
  return out;
}

// ── the format ──────────────────────────────────────────────────────────────

test("a counter renders as Prometheus text a scraper will accept", () => {
  const r = new Registry();
  const c = r.counter("cavix_reviews_total", "Reviews by outcome.");
  c.inc({ outcome: "posted" });
  c.inc({ outcome: "posted" });
  c.inc({ outcome: "failed" });

  const text = r.render();
  assert.match(text, /# HELP cavix_reviews_total Reviews by outcome\./);
  assert.match(text, /# TYPE cavix_reviews_total counter/);
  const v = parse(text);
  assert.equal(v['cavix_reviews_total{outcome="posted"}'], 2);
  assert.equal(v['cavix_reviews_total{outcome="failed"}'], 1);
  assert.ok(text.endsWith("\n"), "the format requires a trailing newline");
});

test("histogram buckets are cumulative, or every quantile is wrong", () => {
  // The classic way to get this wrong is to count a value into exactly one
  // bucket. Prometheus reads buckets as "how many observations were <= le", so
  // per-bucket counts produce quantiles that are silently nonsense and no
  // dashboard flags it.
  const r = new Registry();
  const h = r.histogram("d_seconds", "d", [1, 5, 10]);
  h.observe(0.5);
  h.observe(3);
  h.observe(30);

  const v = parse(r.render());
  assert.equal(v['d_seconds_bucket{le="1"}'], 1);
  assert.equal(v['d_seconds_bucket{le="5"}'], 2, "0.5 and 3, cumulatively");
  assert.equal(v['d_seconds_bucket{le="10"}'], 2);
  assert.equal(v['d_seconds_bucket{le="+Inf"}'], 3, "and +Inf is everything");
  assert.equal(v.d_seconds_count, 3);
  assert.equal(v.d_seconds_sum, 33.5);
});

test("label order does not create two series for one thing", () => {
  const r = new Registry();
  const c = r.counter("x_total", "x");
  c.inc({ a: "1", b: "2" });
  c.inc({ b: "2", a: "1" });
  assert.equal(c.seriesCount, 1);
  assert.equal(parse(r.render())['x_total{a="1",b="2"}'], 2);
});

test("a label value that could break the format is escaped", () => {
  const r = new Registry();
  r.counter("x_total", "x").inc({ v: 'a"b\\c\nd' });
  const text = r.render();
  assert.match(text, /x_total\{v="a\\"b\\\\c\\nd"\} 1/);
});

// ── the cardinality cap, which is the point ─────────────────────────────────

test("an unbounded label folds into one overflow series instead of growing forever", () => {
  // The trap: `repo="acme/widget"` is one time series per repository, in a store
  // that keeps them for a year. On a deployment with ten thousand repositories
  // that is an outage in the monitoring system, and the repository names are
  // customer data in an endpoint that is usually less protected than the
  // database. A hard cap turns that mistake into one obviously-wrong series an
  // operator can see, rather than a slow leak here and a slow ingestion failure
  // over there.
  const r = new Registry();
  const c = r.counter("x_total", "x");
  for (let i = 0; i < 5000; i++) c.inc({ repo: `org/repo-${i}` });

  assert.ok(c.seriesCount <= 65, `${c.seriesCount} series survived the cap`);
  const v = parse(r.render());
  assert.ok(v['x_total{overflow="true"}'] > 4900, "and the excess is counted, not dropped");
});

test("the cap applies to histograms too", () => {
  const r = new Registry();
  const h = r.histogram("d_seconds", "d", [1]);
  for (let i = 0; i < 500; i++) h.observe(1, { k: String(i) });
  assert.ok(h.seriesCount <= 65);
  assert.match(r.render(), /d_seconds_count\{overflow="true"\}/);
});

test("a series already being tracked keeps working after the cap is reached", () => {
  // Folding an EXISTING series into overflow would make a real metric go flat
  // the moment an unrelated label exploded.
  const r = new Registry();
  const c = r.counter("x_total", "x");
  c.inc({ stage: "verify" });
  for (let i = 0; i < 500; i++) c.inc({ junk: String(i) });
  c.inc({ stage: "verify" });
  assert.equal(parse(r.render())['x_total{stage="verify"}'], 2);
});

// ── values that would corrupt the output ────────────────────────────────────

test("a counter refuses to go backwards, and NaN never reaches the wire", () => {
  const r = new Registry();
  const c = r.counter("x_total", "x");
  c.inc({}, 5);
  c.inc({}, -3);
  c.inc({}, Number.NaN);
  assert.equal(parse(r.render()).x_total, 5);
});

test("a gauge ignores NaN rather than emitting it", () => {
  const r = new Registry();
  const g = r.gauge("x", "x");
  g.set(4);
  g.set(Number.NaN);
  assert.equal(parse(r.render()).x, 4);
});

// ── the recorder ────────────────────────────────────────────────────────────

test("recording can never throw, because a metric is worth less than a review", () => {
  const m = createMetrics("1.0.0");
  const rec = makeRecorder(m);
  // Sabotage the underlying metric the way a future refactor might.
  (m.reviews as unknown as { inc: () => void }).inc = () => {
    throw new Error("boom");
  };
  assert.doesNotThrow(() => rec.review("posted", 12));
});

test("timed records the duration whether the stage succeeds or fails", async () => {
  // A verify step that takes ninety seconds and THEN throws is a different
  // problem from one that throws immediately, and the histogram is the only
  // place that difference shows.
  const m = createMetrics();
  const rec = makeRecorder(m);

  await timed(rec, "verify", async () => "ok");
  await assert.rejects(() =>
    timed(rec, "deep_review", async () => {
      throw new Error("provider outage");
    }),
  );

  const v = parse(m.registry.render());
  assert.equal(v['cavix_stage_duration_seconds_count{stage="verify"}'], 1);
  assert.equal(v['cavix_stage_duration_seconds_count{stage="deep_review"}'], 1, "the failure was still timed");
  assert.equal(v['cavix_stage_failures_total{stage="deep_review"}'], 1);
  assert.equal(v['cavix_stage_failures_total{stage="verify"}'], undefined, "and success is not a failure");
});

test("build info carries the version as a label, as Prometheus expects", () => {
  const m = createMetrics("2.3.4");
  assert.match(m.registry.render(), /cavix_build_info\{version="2\.3\.4"\} 1/);
});

test("the whole metric set names no customer, repository or path", () => {
  // The rule this endpoint lives by: it answers "is Cavix healthy", never "what
  // is customer X doing". A scraper that could reconstruct a customer's activity
  // from it would be a leak in a store retained for a year.
  const m = createMetrics();
  const rec = makeRecorder(m);
  rec.review("posted", 30);
  rec.stage("verify", 10);
  rec.stageFailed("cross_repo");
  rec.cost(0.42);
  rec.finding("surfaced", 3);
  rec.finding("suppressed", 1);
  rec.queue(7);

  const text = m.registry.render();
  // Only these label keys may ever appear.
  const keys = new Set([...text.matchAll(/\{([^}]*)\}/g)].flatMap((mm) =>
    mm[1].split(",").map((p) => p.split("=")[0]),
  ));
  assert.deepEqual([...keys].sort(), ["le", "outcome", "stage", "version"]);
});
