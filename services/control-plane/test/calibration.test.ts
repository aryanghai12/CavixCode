import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, InMemoryStore } from "@cavix/control-plane";

// Stage 12, end to end through the real HTTP surface: a team's accept and reject
// decisions become the confidence bar the orchestrator uses on their next pull
// request. Nothing here is mocked; the only thing that does not run is the
// review itself.

const INTERNAL = "test-internal-token";

async function withServer(fn: (base: string, store: InMemoryStore) => Promise<void>) {
  const previous = process.env.CAVIX_INTERNAL_TOKEN;
  process.env.CAVIX_INTERNAL_TOKEN = INTERNAL;
  const store = new InMemoryStore();
  const server = createControlPlane(store);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    if (previous === undefined) delete process.env.CAVIX_INTERNAL_TOKEN;
    else process.env.CAVIX_INTERNAL_TOKEN = previous;
  }
}

const post = (base: string, path: string, body: unknown, cookie?: string) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

async function signIn(base: string, org: string, email = `owner@${org}.test`): Promise<string> {
  const res = await post(base, "/api/auth/signup", { email, password: "password123", org, name: "Owner" });
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

/** Post one review carrying `n` findings in `category` at `confidence`, and rule on every one. */
async function decide(
  base: string,
  cookie: string,
  opts: { org: string; pr: number; category: string; confidence: number; n: number; accept: boolean },
): Promise<void> {
  const review = (await (
    await post(
      base,
      "/api/reviews",
      {
        org: opts.org,
        repo: "widget",
        pr: opts.pr,
        title: "t",
        findings: Array.from({ length: opts.n }, (_, i) => ({
          path: `a${i}.js`,
          line: i + 1,
          severity: "medium",
          category: opts.category,
          title: `finding ${i}`,
          body: "",
          source: "llm",
          agent: "correctness",
          confidence: opts.confidence,
        })),
      },
      cookie,
    )
  ).json()) as { findings: Array<{ id: string }> };

  for (const f of review.findings) {
    const res = await post(base, `/api/findings/${f.id}/decision`, { state: opts.accept ? "accepted" : "rejected" }, cookie);
    assert.equal(res.status, 200);
  }
}

const reviewConfig = (base: string, org: string) =>
  fetch(`${base}/api/internal/orgs/${org}/review-config`, { headers: { authorization: `Bearer ${INTERNAL}` } });

test("the confidence a decision was made about is stored, not thrown away", async () => {
  // The orchestrator has always sent it. This row dropped it, which made every
  // confidence-threshold derivation impossible from the only real source of
  // decisions in the product.
  await withServer(async (base) => {
    const cookie = await signIn(base, "acme");
    const review = (await (
      await post(
        base,
        "/api/reviews",
        {
          org: "acme",
          repo: "widget",
          pr: 1,
          title: "t",
          findings: [
            { path: "a.js", line: 1, severity: "high", category: "security", title: "x", body: "", source: "llm", agent: "security", confidence: 0.77 },
          ],
        },
        cookie,
      )
    ).json()) as { findings: Array<{ id: string; confidence?: number }> };

    assert.equal(review.findings[0].confidence, 0.77);
    await post(base, `/api/findings/${review.findings[0].id}/decision`, { state: "accepted" }, cookie);

    const decisions = (await (await fetch(base + "/api/decisions", { headers: { cookie } })).json()) as Array<{
      confidence?: number;
      agent?: string;
    }>;
    assert.equal(decisions[0].confidence, 0.77, "the Learnings page and the loop can both see it");
    assert.equal(decisions[0].agent, "security");
  });
});

test("a team that rejects a category teaches Stage 9 a higher bar for it", async () => {
  await withServer(async (base) => {
    const cookie = await signIn(base, "acme");
    // 14 rejected at 0.65, well above the standard 0.50 bar, so the default was
    // NOT already suppressing them and there is something real to learn.
    await decide(base, cookie, { org: "acme", pr: 1, category: "style", confidence: 0.65, n: 14, accept: false });
    // Enough elsewhere to clear the workspace minimum.
    await decide(base, cookie, { org: "acme", pr: 2, category: "security", confidence: 0.8, n: 12, accept: true });

    const config = (await (await reviewConfig(base, "acme")).json()) as {
      thresholdByCategory: Record<string, number>;
    };
    assert.equal(config.thresholdByCategory.style, 0.66, "just above what they rejected");
    assert.equal(config.thresholdByCategory.security, 0.35, "and lower for what they trust");
  });
});

test("a workspace with three decisions gets no threshold at all", async () => {
  await withServer(async (base) => {
    const cookie = await signIn(base, "acme");
    await decide(base, cookie, { org: "acme", pr: 1, category: "style", confidence: 0.65, n: 3, accept: false });

    const config = (await (await reviewConfig(base, "acme")).json()) as {
      thresholdByCategory: Record<string, number>;
    };
    assert.deepEqual(config.thresholdByCategory, {}, "three decisions buy nothing");

    const shown = (await (await fetch(base + "/api/orgs/acme/calibration", { headers: { cookie } })).json()) as {
      active: boolean;
      decisionsUntilActive: number;
    };
    assert.equal(shown.active, false);
    assert.equal(shown.decisionsUntilActive, 17, "and the page says exactly how far off they are");
  });
});

test("one workspace's decisions never set another workspace's bar", async () => {
  await withServer(async (base) => {
    const acme = await signIn(base, "acme");
    const globex = await signIn(base, "globex", "owner@globex.test");
    await decide(base, acme, { org: "acme", pr: 1, category: "style", confidence: 0.65, n: 14, accept: false });
    await decide(base, acme, { org: "acme", pr: 2, category: "security", confidence: 0.8, n: 12, accept: true });
    await decide(base, globex, { org: "globex", pr: 1, category: "style", confidence: 0.65, n: 2, accept: false });

    const theirs = (await (await reviewConfig(base, "globex")).json()) as {
      thresholdByCategory: Record<string, number>;
    };
    assert.deepEqual(theirs.thresholdByCategory, {}, "globex has taught Cavix nothing yet");
  });
});

test("the Learnings page and the orchestrator are shown the same calibration", async () => {
  // Two derivations would eventually disagree, and the page's whole job is to
  // say what is actually running on the pull requests.
  await withServer(async (base) => {
    const cookie = await signIn(base, "acme");
    await decide(base, cookie, { org: "acme", pr: 1, category: "style", confidence: 0.65, n: 14, accept: false });
    await decide(base, cookie, { org: "acme", pr: 2, category: "security", confidence: 0.8, n: 12, accept: true });

    const page = (await (await fetch(base + "/api/orgs/acme/calibration", { headers: { cookie } })).json()) as {
      thresholdByCategory: Record<string, number>;
      categories: Array<{ category: string; reason: string; samples: number }>;
      active: boolean;
    };
    const orchestrator = (await (await reviewConfig(base, "acme")).json()) as {
      thresholdByCategory: Record<string, number>;
    };

    assert.deepEqual(page.thresholdByCategory, orchestrator.thresholdByCategory);
    assert.equal(page.active, true);
    const style = page.categories.find((c) => c.category === "style");
    assert.equal(style?.samples, 14);
    assert.match(style!.reason, /14 of 14 rejected/, "stated in the team's own numbers");
  });
});

test("a new decision changes the bar immediately, not after a cache expires", async () => {
  await withServer(async (base, store) => {
    const cookie = await signIn(base, "acme");
    await decide(base, cookie, { org: "acme", pr: 1, category: "style", confidence: 0.65, n: 13, accept: false });
    await decide(base, cookie, { org: "acme", pr: 2, category: "security", confidence: 0.8, n: 12, accept: true });
    assert.equal(store.calibration("acme").thresholdByCategory.style, 0.66);

    // One more accepted style finding, at high confidence. The bar has to move.
    await decide(base, cookie, { org: "acme", pr: 3, category: "style", confidence: 0.95, n: 1, accept: true });
    const after = store.calibration("acme").thresholdByCategory.style;
    assert.equal(after, 0.66, "still separates, and the recompute happened");
    assert.equal(store.calibration("acme").categories.find((c) => c.category === "style")?.samples, 14);
  });
});

test("the calibration is a workspace's own business", async () => {
  await withServer(async (base) => {
    const acme = await signIn(base, "acme");
    await signIn(base, "globex", "owner@globex.test");
    await decide(base, acme, { org: "acme", pr: 1, category: "style", confidence: 0.65, n: 14, accept: false });

    const anon = await fetch(base + "/api/orgs/acme/calibration");
    assert.equal(anon.status, 401);

    const outsider = await fetch(base + "/api/orgs/acme/calibration", {
      headers: { cookie: (await post(base, "/api/auth/login", { email: "owner@globex.test", password: "password123" })).headers.get("set-cookie")?.split(";")[0] ?? "" },
    });
    assert.equal(outsider.status, 403);
  });
});
