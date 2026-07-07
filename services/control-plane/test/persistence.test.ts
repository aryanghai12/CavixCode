import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore, wantSsl, type StoreSnapshot } from "@cavix/control-plane";

// The Postgres persistence works by JSON-snapshotting the store and restoring it.
// These tests prove that round-trip (through JSON, as the DB would) is lossless.

function populated(): InMemoryStore {
  const s = new InMemoryStore();
  s.createOrg("acme", { tier: "paid" });
  s.createUser({ email: "owner@acme.co", name: "Owner", password: "password123", org: "acme", role: "owner" });
  s.createRepo("acme", "widget", { visibility: "private" });
  s.updateSettings("acme", { llmModel: "claude-opus-4-8", preMergeChecks: { enabled: true, rules: ["auth check"] } });
  s.setApiKey("acme", "sk-ant-secret-key-123");
  const rec = s.saveReview({
    org: "acme", repo: "widget", pr: 7, title: "t",
    findings: [{ path: "a.js", line: 1, severity: "high", category: "security", title: "sqli", body: "", source: "sast", confidence: 0.9, verified: true }],
  });
  s.recordDecision(rec.findings[0].id, "accepted", "owner@acme.co");
  s.startTrial("acme", 14);
  return s;
}

test("snapshot → JSON → restore is lossless", () => {
  const original = populated();
  const snap = JSON.parse(JSON.stringify(original.snapshot())) as StoreSnapshot; // as the DB would
  const restored = new InMemoryStore();
  restored.restore(snap);

  // orgs, repos, users
  assert.equal(restored.listOrgs().length, 1);
  assert.equal(restored.getOrg("acme")?.tier, "paid");
  assert.equal(restored.listRepos("acme").length, 1);
  assert.equal(restored.listTeam("acme")[0].email, "owner@acme.co");

  // reviews + the finding's decision survived
  const reviews = restored.listReviews("acme");
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].findings[0].decision?.state, "accepted");

  // settings + trial
  assert.equal(restored.getSettings("acme").preMergeChecks.enabled, true);
  assert.ok(restored.listOrgsAdmin()[0].trialActive);

  // the encrypted BYOK key still decrypts after restore
  assert.equal(restored.getApiKey("acme"), "sk-ant-secret-key-123");
});

test("restore rebuilds shared finding refs (a new decision shows in listReviews)", () => {
  const snap = JSON.parse(JSON.stringify(populated().snapshot())) as StoreSnapshot;
  const s = new InMemoryStore();
  s.restore(snap);
  const fid = s.listReviews("acme")[0].findings[0].id;
  // login-verify still works (password hash preserved)
  assert.ok(s.verifyLogin("owner@acme.co", "password123"));
  // record a NEW decision via the findings map; it must be visible via listReviews too
  s.recordDecision(fid, "rejected", "owner@acme.co");
  assert.equal(s.listReviews("acme")[0].findings[0].decision?.state, "rejected");
});

test("isEmpty: true on a fresh store, false after data", () => {
  const s = new InMemoryStore();
  assert.equal(s.isEmpty(), true);
  s.createOrg("x");
  assert.equal(s.isEmpty(), false);
});

test("wantSsl: on for managed hosts, off for localhost", () => {
  assert.equal(wantSsl("postgres://u:p@db.neon.tech:5432/x"), true);
  assert.equal(wantSsl("postgres://u:p@localhost:5432/x"), false);
  assert.equal(wantSsl("postgres://u:p@127.0.0.1:5432/x"), false);
  assert.equal(wantSsl("postgres://u:p@somehost:5432/x?sslmode=require"), true);
});
