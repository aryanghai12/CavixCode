import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, InMemoryStore } from "@cavix/control-plane";
import { EMPTY_LEDGER, FREE_REVIEWS_PER_PR, reconcile, type PrLedger } from "@cavix/review-session";

// The per-pull-request review budget, and the ledger it counts.
//
// Two promises are under test here, and they are different promises:
//
//   free   a fixed number, identical for every workspace on the tier, that a
//          maintainer cannot raise. A free limit somebody can raise is not a
//          limit.
//   paid   a default the maintainer owns and can change, because on a paid
//          workspace the cost is theirs and so is the judgement.
//
// And one rule that outranks both: running out of budget never changes a
// verdict. If it did, exhausting the quota would be a way to merge past an open
// finding, and the limit would be a bypass.

const TOKEN = "internal-token-for-tests";

async function serve(store: InMemoryStore) {
  process.env.CAVIX_INTERNAL_TOKEN = TOKEN;
  const server = createControlPlane(store);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface GateAnswer {
  enabled?: boolean;
  org?: string;
  reason?: string;
  capReached?: boolean;
}

async function gate(base: string, fullName: string, pr?: number): Promise<GateAnswer> {
  const url =
    `${base}/api/internal/repos/enabled?fullName=${encodeURIComponent(fullName)}` +
    (pr === undefined ? "" : `&pr=${pr}`);
  const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  return (await res.json()) as GateAnswer;
}

function seeded(tier: "free" | "paid"): InMemoryStore {
  const store = new InMemoryStore();
  store.createOrg("acme", { tier });
  // Public on free: the free tier refuses private repositories, and that rule is
  // not what these tests are about.
  store.createRepo("acme", "acme/api", { visibility: tier === "free" ? "public" : "private" });
  return store;
}

/** Spend `n` reviews on one pull request, the way a real review does. */
function spend(store: InMemoryStore, pr: number, n: number): void {
  let ledger: PrLedger = store.prLedger("acme", "acme/api", pr);
  for (let i = 0; i < n; i++) {
    ledger = reconcile({ prior: ledger, findings: [], diff: "", headSha: `sha${i}` }).ledger;
  }
  store.savePrLedger("acme", "acme/api", pr, ledger);
}

test("free tier: a pull request is cut off at the fixed limit, and says why", async () => {
  const store = seeded("free");
  const { base, close } = await serve(store);
  try {
    spend(store, 7, FREE_REVIEWS_PER_PR - 1);
    const nearly = await gate(base, "acme/api", 7);
    assert.equal(nearly.enabled, true, "one review left, so it still runs");

    spend(store, 7, 1);
    const spent = await gate(base, "acme/api", 7);
    assert.equal(spent.enabled, false);
    assert.equal(spent.capReached, true);
    assert.match(spent.reason ?? "", new RegExp(`all ${FREE_REVIEWS_PER_PR} of its Cavix reviews`));
    // The remedy has to be one a free workspace can actually take. Telling them
    // to raise a limit they are not allowed to move is worse than silence.
    assert.match(spent.reason ?? "", /cannot be raised/);
    assert.doesNotMatch(spent.reason ?? "", /Raise the per-pull-request limit/);
    // And it never claims the pull request was cleared.
    assert.match(spent.reason ?? "", /keeps the result of the last review/);
  } finally {
    await close();
  }
});

test("the budget is PER pull request: one busy PR does not silence the others", async () => {
  const store = seeded("free");
  const { base, close } = await serve(store);
  try {
    spend(store, 7, FREE_REVIEWS_PER_PR);
    assert.equal((await gate(base, "acme/api", 7)).enabled, false);
    // A different pull request in the same repository is untouched. This is the
    // whole reason the limit is counted per pull request and not only per day.
    assert.equal((await gate(base, "acme/api", 8)).enabled, true);
  } finally {
    await close();
  }
});

test("an orchestrator that sends no pr number is not refused", async () => {
  // A version skew must not start refusing reviews. The per-PR check is skipped
  // where it cannot be answered, never guessed at.
  const store = seeded("free");
  const { base, close } = await serve(store);
  try {
    spend(store, 7, FREE_REVIEWS_PER_PR * 3);
    assert.equal((await gate(base, "acme/api")).enabled, true);
  } finally {
    await close();
  }
});

/** Sign up and sign in, so a settings request carries a real session. */
async function signedIn(base: string): Promise<string> {
  const json = { "content-type": "application/json" };
  await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ email: "owner@acme.dev", password: "password123", name: "O", org: "acme" }),
  });
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ email: "owner@acme.dev", password: "password123" }),
  });
  return (login.headers.get("set-cookie") ?? "").split(";")[0];
}

async function patchSettings(base: string, cookie: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/orgs/acme/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

test("free tier: the dashboard refuses to save a per-PR limit, rather than ignoring it", async () => {
  const store = seeded("free");
  const { base, close } = await serve(store);
  try {
    const res = await patchSettings(base, await signedIn(base), { reviewsPerPullRequest: 500 });
    // A 403 with a reason, not a 200 and a setting that quietly never applies.
    // A switch a customer can flip that changes nothing is the failure mode this
    // codebase has already shipped three times.
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /fixed at \d+ on the free tier/);
    assert.equal(store.getSettings("acme").reviewsPerPullRequest, undefined);
  } finally {
    await close();
  }
});

test("paid tier: the dashboard saves the limit, clamped", async () => {
  const store = seeded("paid");
  const { base, close } = await serve(store);
  try {
    const cookie = await signedIn(base);
    assert.equal((await patchSettings(base, cookie, { reviewsPerPullRequest: 25 })).status, 200);
    assert.equal(store.effectiveReviewsPerPr("acme"), 25);

    // Out of bounds is clamped rather than refused: the intent is obvious and
    // there is a sane nearest answer. Zero would switch Cavix off by arithmetic.
    assert.equal((await patchSettings(base, cookie, { reviewsPerPullRequest: 0 })).status, 200);
    assert.equal(store.effectiveReviewsPerPr("acme"), 1);
  } finally {
    await close();
  }
});

test("the settings page is told whether this workspace may move the limit", async () => {
  const store = seeded("free");
  const { base, close } = await serve(store);
  try {
    const cookie = await signedIn(base);
    const res = await fetch(`${base}/api/orgs/acme/settings`, { headers: { cookie } });
    const body = (await res.json()) as { prBudget?: { limit: number; raisable: boolean } };
    // Without this the page would have to infer the tier and guess, and a
    // control that guesses whether it works is a control that lies.
    assert.equal(body.prBudget?.raisable, false);
    assert.equal(body.prBudget?.limit, FREE_REVIEWS_PER_PR);
  } finally {
    await close();
  }
});

test("paid tier: the maintainer's limit is honoured, and clamped to something sane", () => {
  const store = seeded("paid");
  store.updateSettings("acme", { reviewsPerPullRequest: 3 });
  assert.equal(store.effectiveReviewsPerPr("acme"), 3);

  spend(store, 7, 3);
  const budget = store.prBudget("acme", "acme/api", 7);
  assert.equal(budget.exhausted, true);
  assert.equal(budget.raisable, true);

  // Raising it puts the pull request straight back in business, with no other
  // action needed. That is what "the maintainer can increase the limit" means.
  store.updateSettings("acme", { reviewsPerPullRequest: 10 });
  assert.equal(store.prBudget("acme", "acme/api", 7).exhausted, false);
});

test("a downgrade drops back to the free limit and keeps nothing that was bought", () => {
  const store = seeded("paid");
  store.updateSettings("acme", { reviewsPerPullRequest: 500 });
  assert.equal(store.effectiveReviewsPerPr("acme"), 500);

  store.setTier("acme", "free");
  assert.equal(store.effectiveReviewsPerPr("acme"), FREE_REVIEWS_PER_PR);
});

test("a trial gets paid limits, and loses them when it ends", () => {
  const store = new InMemoryStore();
  store.createOrg("acme", { tier: "free" });
  store.startTrial("acme", 14);
  store.updateSettings("acme", { reviewsPerPullRequest: 200 });
  assert.equal(store.effectiveReviewsPerPr("acme"), 200);

  store.endTrial("acme");
  assert.equal(store.effectiveReviewsPerPr("acme"), FREE_REVIEWS_PER_PR);
});

test("the ledger survives a store snapshot and restore", () => {
  const store = seeded("paid");
  const first = reconcile({
    prior: EMPTY_LEDGER,
    findings: [
      {
        path: "src/a.ts",
        line: 4,
        severity: "critical",
        category: "security",
        title: "Hardcoded credential",
        body: "",
        source: "llm",
        confidence: 0.9,
      },
    ],
    diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n x\n+y\n",
    headSha: "aaa",
  });
  store.savePrLedger("acme", "acme/api", 7, first.ledger);

  // A redeploy. The orchestrator is restartable and horizontally scaled, so a
  // ledger held in ITS memory would be lost here and every open finding on
  // every live pull request would silently clear.
  const revived = new InMemoryStore();
  revived.restore(store.snapshot());

  const back = revived.prLedger("acme", "acme/api", 7);
  assert.equal(back.entries.length, 1);
  assert.equal(back.entries[0].state, "open");
  assert.equal(back.entries[0].title, "Hardcoded credential");
  assert.equal(back.reviewsUsed, 1);
});

test("the ledger endpoint refuses a repository the workspace never connected", async () => {
  const store = seeded("paid");
  const { base, close } = await serve(store);
  try {
    const res = await fetch(
      `${base}/api/internal/orgs/acme/pr-ledger?repo=${encodeURIComponent("someone-else/private")}&pr=1`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ ledger: { entries: [], reviewsUsed: 1 } }),
      },
    );
    // Otherwise anything holding the internal token could write open findings
    // against a repository this workspace has no relationship with, and those
    // findings would then hold up merges on it.
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test("the ledger endpoint needs the internal token", async () => {
  const store = seeded("paid");
  const { base, close } = await serve(store);
  try {
    const res = await fetch(`${base}/api/internal/orgs/acme/pr-ledger?repo=acme/api&pr=1`, {
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("a suspended workspace is still refused before the per-PR check is reached", async () => {
  // Ordering. The daily/suspension refusal is the more serious one and must not
  // be masked by a pull request that happens to have budget left.
  const store = seeded("paid");
  store.setSuspended("acme", true);
  const { base, close } = await serve(store);
  try {
    const answer = await gate(base, "acme/api", 7);
    assert.equal(answer.enabled, false);
    assert.equal(answer.capReached, undefined);
    assert.match(answer.reason ?? "", /suspended/);
  } finally {
    await close();
  }
});
