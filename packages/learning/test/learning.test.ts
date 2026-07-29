import { test } from "node:test";
import assert from "node:assert/strict";
import { calibrate, type DecisionRecord } from "@cavix/learning";

// A fixed clock, so the 90-day window is exercised rather than assumed.
const NOW = Date.parse("2026-07-28T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function rows(
  n: number,
  fields: { category: string; accepted: boolean; confidence?: number; agent?: string; age?: number },
): DecisionRecord[] {
  return Array.from({ length: n }, () => ({
    category: fields.category,
    source: "llm",
    accepted: fields.accepted,
    ...(fields.confidence !== undefined ? { confidence: fields.confidence } : {}),
    ...(fields.agent ? { agent: fields.agent } : {}),
    at: daysAgo(fields.age ?? 5),
  }));
}

/** Enough unrelated history to clear the workspace minimum. */
const ballast = (n = 20) => rows(n, { category: "ballast", accepted: true, confidence: 0.8 });

const cal = (d: DecisionRecord[]) => calibrate(d, { now: NOW });
const forCategory = (d: DecisionRecord[], c: string) =>
  cal(d).categories.find((x) => x.category === c);

// ---------------------------------------------------------------------------
// The bar only moves on measured separation
// ---------------------------------------------------------------------------

test("a category whose rejections sit below its accepts gets a bar between them", () => {
  const decisions = [
    ...ballast(),
    ...rows(12, { category: "maintainability", accepted: false, confidence: 0.62 }),
    ...rows(10, { category: "maintainability", accepted: true, confidence: 0.88 }),
  ];
  const out = cal(decisions);
  const bar = out.thresholdByCategory.maintainability;
  assert.ok(bar !== undefined, "the bar moved");
  assert.ok(bar > 0.62 && bar <= 0.88, `bar ${bar} separates the rejections from the accepts`);
  assert.match(out.categories.find((c) => c.category === "maintainability")!.reason, /100% of them/);
});

test("rejections the standard bar already caught do not earn a new one", () => {
  // The whole category was rejected, but every rejection sat at 0.40, which the
  // default 0.50 was already suppressing. Nothing was learned, and the reason
  // has to say that rather than invent a change.
  const decisions = [...ballast(), ...rows(12, { category: "style", accepted: false, confidence: 0.4 })];
  const out = cal(decisions);
  assert.equal(out.thresholdByCategory.style, undefined);
  assert.match(forCategory(decisions, "style")!.reason, /already holding 100% of them back/);
});

test("a category whose rejections sit at the SAME confidence as its accepts is left alone", () => {
  // This is the case the accept-rate approach would have moved on, and moving it
  // would have dropped the accepted findings at exactly the same rate.
  const decisions = [
    ...ballast(),
    ...rows(10, { category: "correctness", accepted: false, confidence: 0.7 }),
    ...rows(10, { category: "correctness", accepted: true, confidence: 0.7 }),
  ];
  const out = cal(decisions);
  assert.equal(out.thresholdByCategory.correctness, undefined, "no bar is fed to Stage 9");
  const detail = out.categories.find((c) => c.category === "correctness")!;
  assert.equal(detail.moved, false);
  assert.match(detail.reason, /No bar separates them/);
});

test("a category rejected outright gets the smallest bar that would have caught it", () => {
  const decisions = [...ballast(), ...rows(14, { category: "style", accepted: false, confidence: 0.6 })];
  const out = cal(decisions);
  // Not the ceiling: the smallest bar that clears every rejection. Raising
  // further would suppress findings the team has never expressed a view on.
  assert.equal(out.thresholdByCategory.style, 0.61);
});

test("a category the team accepts outright gets a lower bar", () => {
  const decisions = [...ballast(), ...rows(12, { category: "security", accepted: true, confidence: 0.8 })];
  const out = cal(decisions);
  assert.equal(out.thresholdByCategory.security, 0.35, "base 0.50 less the 0.15 drop");
  assert.match(out.categories.find((c) => c.category === "security")!.reason, /12 of 12 accepted/);
});

test("a raise that would cost accepted findings is not taken", () => {
  // The rejections are low-confidence, but so are half the accepts. Clearing the
  // rejections would take the accepts with them, so the bar stays put.
  const decisions = [
    ...ballast(),
    ...rows(10, { category: "performance", accepted: false, confidence: 0.4 }),
    ...rows(8, { category: "performance", accepted: true, confidence: 0.42 }),
    ...rows(4, { category: "performance", accepted: true, confidence: 0.9 }),
  ];
  const out = cal(decisions);
  assert.equal(out.thresholdByCategory.performance, undefined);
});

// ---------------------------------------------------------------------------
// The four guards
// ---------------------------------------------------------------------------

test("three decisions do not buy a threshold", () => {
  const decisions = [...ballast(), ...rows(3, { category: "style", accepted: false, confidence: 0.4 })];
  const out = cal(decisions);
  assert.equal(out.thresholdByCategory.style, undefined);
  assert.match(forCategory(decisions, "style")!.reason, /3 decided so far.*7 more decisions to go/s);
});

test("a workspace below the minimum gets no calibration at all, and is told how far off it is", () => {
  const decisions = rows(12, { category: "style", accepted: false, confidence: 0.65 });
  const out = cal(decisions);
  assert.equal(out.active, false);
  assert.equal(out.decisionsUntilActive, 8);
  assert.deepEqual(out.thresholdByCategory, {}, "nothing reaches Stage 9 yet");
  // The per-category work still happened, so the page can show what WOULD apply.
  assert.equal(forCategory(decisions, "style")!.moved, true);
});

test("one bad week ages out of the window on its own", () => {
  const badWeek = rows(15, { category: "style", accepted: false, confidence: 0.5, age: 120 });
  const out = cal([...ballast(), ...badWeek]);
  assert.equal(out.thresholdByCategory.style, undefined, "120 days old is not evidence about today");
  assert.equal(out.sampleCount, 20, "and it is not counted at all");
});

test("a category can be made quieter but never silenced", () => {
  // Rejected at very high confidence. The bar that would separate them is above
  // the ceiling, so nothing moves. Capping to the ceiling instead would apply a
  // bar of 0.75 that suppresses NONE of these 0.99-confidence findings, while
  // the page claimed it held back all of them.
  const decisions = [...ballast(), ...rows(20, { category: "style", accepted: false, confidence: 0.99 })];
  const out = cal(decisions);
  assert.equal(out.thresholdByCategory.style, undefined, "left alone, not capped to a bar that does nothing");
  assert.match(forCategory(decisions, "style")!.reason, /need a bar above 0\.75/);
  assert.match(forCategory(decisions, "style")!.reason, /not a confidence problem/);
});

test("a two-point gap between accepts and rejects is noise, not separation", () => {
  // The shape the realistic probe surfaced: accepts and rejects a hair apart. A
  // cut at 0.59 fits the history perfectly and predicts nothing, because the
  // next finding lands on either side of it by chance.
  const decisions = [
    ...ballast(),
    ...rows(11, { category: "correctness", accepted: true, confidence: 0.6 }),
    ...rows(9, { category: "correctness", accepted: false, confidence: 0.58 }),
  ];
  const out = cal(decisions);
  assert.equal(out.thresholdByCategory.correctness, undefined);
  assert.match(forCategory(decisions, "correctness")!.reason, /separated by less than 0\.05/);
});

// ---------------------------------------------------------------------------
// What real decision data actually looks like
// ---------------------------------------------------------------------------

test("decisions with no recorded confidence cannot set a confidence bar", () => {
  // Every decision made before the store kept `confidence` looks like this. They
  // are real decisions and they count for the accept rates, but a bar derived
  // from them would be derived from nothing.
  const undated = rows(30, { category: "style", accepted: false }).map((d) => {
    delete (d as { confidence?: number }).confidence;
    return d;
  });
  const out = cal(undated);
  assert.equal(out.sampleCount, 30);
  assert.equal(out.usableCount, 0);
  assert.equal(out.active, false);
  assert.deepEqual(out.thresholdByCategory, {});
  assert.ok(out.categoryAcceptRate.style < 0.1, "the accept rate is still reported");
});

test("a confidence that is not a number in [0,1] is an absent one, not a low one", () => {
  const junk: DecisionRecord[] = [
    ...ballast(),
    ...rows(10, { category: "style", accepted: false, confidence: 0.5 }),
  ];
  junk.push(
    { category: "style", source: "llm", accepted: false, confidence: Number.NaN, at: daysAgo(1) },
    { category: "style", source: "llm", accepted: false, confidence: 4, at: daysAgo(1) },
    { category: "style", source: "sast", accepted: false, confidence: -1, at: daysAgo(1) },
  );
  assert.equal(forCategory(junk, "style")!.samples, 10, "the three junk rows are not evidence");
});

test("accept rates are still reported per category and per agent, for the page", () => {
  const decisions = [
    ...rows(10, { category: "security", accepted: true, confidence: 0.8, agent: "security" }),
    ...rows(10, { category: "style", accepted: false, confidence: 0.5, agent: "standards" }),
  ];
  const out = cal(decisions);
  assert.ok(out.categoryAcceptRate.security > 0.8);
  assert.ok(out.categoryAcceptRate.style < 0.2);
  assert.ok(out.agentAcceptRate.standards < 0.2);
  assert.equal(out.agentAcceptRate.nobody, undefined);
});

test("an empty history is a valid answer, not a crash", () => {
  const out = cal([]);
  assert.equal(out.active, false);
  assert.equal(out.sampleCount, 0);
  assert.deepEqual(out.thresholdByCategory, {});
  assert.deepEqual(out.verifyByCategory, {});
  assert.deepEqual(out.categories, []);
  assert.equal(out.decisionsUntilActive, 20);
});

// ---------------------------------------------------------------------------
// The Stage 10 half: where the same history moves the SANDBOX
// ---------------------------------------------------------------------------
//
// A threshold decides what a model is trusted to SAY. This decides where proof
// is worth SPENDING, and the two answer different questions about the same
// decisions. The interesting property is that the case where a threshold is
// useless is exactly the case where execution is not.

test("a category no bar can separate is proved by execution instead", () => {
  // The same fixture as "left alone" above. Stage 9 correctly refuses to move
  // the bar, which is precisely why Stage 10 has to step in: what tells a real
  // finding from a plausible one here is whether it reproduces.
  const decisions = [
    ...ballast(),
    ...rows(10, { category: "correctness", accepted: false, confidence: 0.7 }),
    ...rows(10, { category: "correctness", accepted: true, confidence: 0.7 }),
  ];
  const out = cal(decisions);
  assert.equal(out.thresholdByCategory.correctness, undefined, "no bar moved");
  assert.equal(out.verifyByCategory.correctness, "always", "so the sandbox does");
  assert.match(forCategory(decisions, "correctness")!.verifyReason!, /proves this category by execution/);
});

test("a category the team accepts outright stops paying for proof", () => {
  const decisions = [...ballast(), ...rows(12, { category: "style", accepted: true, confidence: 0.8 })];
  const out = cal(decisions);
  assert.equal(out.verifyByCategory.style, "never");
  assert.match(forCategory(decisions, "style")!.verifyReason!, /changes nothing you were going to do/);
  // ...and the sentence has to name the exception, because the exception is what
  // keeps the product's own claim intact.
  assert.match(forCategory(decisions, "style")!.verifyReason!, /critical, high or security/);
});

test("a category with a measured bar has no opinion about proof", () => {
  // Separation exists, so the threshold is the right instrument and there is
  // nothing to say about the sandbox. An absent entry and an entry that happens
  // to match the default mean different things to a reader.
  const decisions = [
    ...ballast(),
    ...rows(12, { category: "maintainability", accepted: false, confidence: 0.62 }),
    ...rows(10, { category: "maintainability", accepted: true, confidence: 0.88 }),
  ];
  const out = cal(decisions);
  assert.ok(out.thresholdByCategory.maintainability !== undefined);
  assert.equal(out.verifyByCategory.maintainability, undefined);
});

test("a workspace below the minimum spends no sandbox differently either", () => {
  // Same guard as the threshold half. Ten decisions is not a mandate to change
  // where a customer's money goes.
  const decisions = rows(12, { category: "correctness", accepted: false, confidence: 0.7 }).concat(
    rows(12, { category: "correctness", accepted: true, confidence: 0.7 }),
  );
  const out = calibrate(decisions, { now: NOW, minOrgDecisions: 100 });
  assert.equal(out.active, false);
  assert.deepEqual(out.verifyByCategory, {}, "nothing reaches Stage 10 yet");
  // The per-category work still happened, so the Learnings page can show what
  // WOULD apply, exactly as it does for a bar that has not gone live.
  assert.equal(out.categories.find((c) => c.category === "correctness")!.verify, "always");
});
