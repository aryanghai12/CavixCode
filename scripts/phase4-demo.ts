// Phase 4 demo — the "trusted automated engineer": a verification-gated fix-PR
// (verified vs unverifiable), a pre-PR IDE local review, and ROI analytics.
// Real sandbox execution; no API key.   node scripts/phase4-demo.ts

import type { Finding } from "@cavix/core";
import { LocalSandboxBackend } from "@cavix/sandbox";
import { Verifier, FakeTestGenerator } from "@cavix/verifier";
import { FixPrAgent, FakeFixPrTarget } from "@cavix/fixpr";
import { localReview } from "@cavix/ide";
import { InMemoryAnalyticsStore, computeOrgRollup, type ReviewEvent } from "@cavix/analytics";

const BUGGY = `export function lastN(arr, n) {\n  const out = [];\n  for (let i = arr.length - n; i <= arr.length; i++) out.push(arr[i]);\n  return out;\n}\n`;
const FIXED = BUGGY.replace("i <= arr.length", "i < arr.length");
const REPRO = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { lastN } from "./calc.mjs";\ntest("lastN", () => { assert.deepEqual(lastN([1,2,3,4],2), [3,4]); });\n`;
const finding: Finding = { path: "calc.mjs", line: 3, severity: "high", category: "correctness", title: "off-by-one in lastN", body: "loop uses <= arr.length", source: "llm", confidence: 0.7, ruleId: "demo/offbyone" };

function bar(t: string) { console.log("\n" + "─".repeat(70) + "\n" + t + "\n" + "─".repeat(70)); }

async function main() {
  const verifier = new Verifier({
    sandbox: new LocalSandboxBackend(),
    testGen: new FakeTestGenerator(() => ({ testPath: "calc.repro.test.mjs", testCode: REPRO, fix: { path: "calc.mjs", content: FIXED }, semantics: "test-fails-on-bug" })),
  });
  const target = new FakeFixPrTarget();
  const agent = new FixPrAgent({ verifier, target });

  bar("1. Verified fix-PR agent — opens a PR only when Stage 10 proves the fix");
  const ok = await agent.propose({ finding, repo: "acme/widget", org: "acme", files: [{ path: "calc.mjs", content: BUGGY }] });
  console.log(`real bug:  proposed=${ok.proposed}  status=${ok.verification.status}  fixWorks=${ok.verification.fixWorks}  suiteGreen=${ok.verification.suitePasses}`);
  console.log(`           → ${ok.pr ? `DRAFT PR ${ok.pr.url} (labels: needs-human-approval)` : "no PR"}`);

  const bad = await agent.propose({ finding, repo: "acme/widget", org: "acme", files: [{ path: "calc.mjs", content: FIXED }] });
  console.log(`false alarm: proposed=${bad.proposed}  → ${bad.reason}`);
  console.log(`PRs opened total: ${target.opened.length} (only the verified one). Cavix never auto-merges.`);

  bar("2. IDE pre-PR local review — same engine, offline, before any PR");
  const review = await localReview([
    { path: "src/db.js", content: 'function get(id){ return db.query("SELECT * FROM t WHERE id=" + id); }' },
    { path: "app/auth.py", content: "import hashlib\nhashlib.md5(pw).hexdigest()" },
    { path: "payroll.cob", content: "       PROCEDURE DIVISION.\n       MAIN-PARA.\n           GO TO END-PARA.\n" },
  ]);
  console.log(review.summary);
  for (const d of review.diagnostics) console.log(`  ${d.severity.toUpperCase().padEnd(7)} ${d.path}:${d.line}  [${d.ruleId}] ${d.message.slice(0, 60)}`);

  bar("3. ROI analytics — action rate, defects caught, reviewer-hours saved");
  const store = new InMemoryAnalyticsStore();
  const mk = (over: Partial<ReviewEvent>): ReviewEvent => ({ team: "payments", repo: "payments/api", reviewId: "r", findingId: "f" + Math.random(), severity: "high", source: "llm", verified: false, fixPrOpened: false, decision: "none", at: new Date().toISOString(), ...over });
  for (let i = 0; i < 3; i++) store.ingest(mk({ severity: "critical", verified: true, decision: "accepted", fixPrOpened: i < 2 }));
  for (let i = 0; i < 2; i++) store.ingest(mk({ severity: "high", verified: true, decision: "accepted" }));
  store.ingest(mk({ severity: "medium", decision: "rejected" }));
  store.ingest(mk({ team: "search", severity: "high", verified: true, decision: "accepted" }));
  const roll = computeOrgRollup(store);
  console.log(`org: ${roll.totalFindings} findings across ${roll.teams.length} teams`);
  console.log(`  action rate:          ${(roll.actionRate * 100).toFixed(0)}%`);
  console.log(`  defects caught:       ${roll.defectsCaught} (execution-verified)`);
  console.log(`  reviewer-hours saved: ${roll.reviewerHoursSaved}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
